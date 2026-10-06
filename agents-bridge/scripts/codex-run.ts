#!/usr/bin/env bun

// codex-run — drives the Codex CLI for every agents-bridge skill.
//
// A run is a private directory that owns its resolved settings (run.json) and
// one sub-directory per turn. `start` and `resume` hand each turn to a detached
// supervisor that owns the codex process, its deadline and its result, so a
// turn outlives the 10-minute cap of a Claude Code Bash call; `wait` picks it
// up again. Every command prints one JSON envelope line on stdout, then, once
// the turn is over, a separator line and Codex's final message: stdout is a
// text protocol, not a JSON document.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = "read-only" | "write";

type Role = "coding" | "audit" | "bounded";

type RunConfig = {
  cwd: string;
  mode: Mode;
  role: Role | null;
  model: string | null;
  effort: string | null;
  add_dirs: string[];
  git_write: boolean;
  skip_git_repo_check: boolean;
  codex_version: string;
  thread_id: string | null;
  created_at: string;
};

type TurnSpec = {
  turn: number;
  effort: string | null;
  deadline_seconds: number;
  caller_schema: boolean;
  caller_type: string | null;
  caller_required: string[];
  started_at: string;
};

type Status = "running" | "completed" | "failed" | "blocked" | "deadline" | "cancelled";

type FinalStatus = Exclude<Status, "running">;

type Ending = "deadline" | "cancelled";

type BlockedItem = {
  action: string;
  cwd: string;
  rationale: string;
  cause: "review_denial" | "sandbox_failure";
};

type TurnResult = {
  status: FinalStatus;
  codex_exit: number | null;
  thread_id: string | null;
  error: string | null;
  blocked: BlockedItem[];
  ended_at: string;
};

type Envelope = {
  run_dir: string;
  turn: number;
  status: Status;
  thread_id: string | null;
  mode: Mode;
  model: string | null;
  effort: string | null;
  cwd: string;
  add_dirs: string[];
  codex_version: string;
  codex_exit: number | null;
  error: string | null;
  blocked: BlockedItem[];
  final_message_file: string;
};

type CatalogModel = { slug: string; efforts: string[]; defaultEffort: string; description: string };

type EventSummary = { threadId: string | null; completed: boolean; turnError: string | null };

type AnswerContract = { type: string | null; required: string[] };

type CallerSchema = { text: string; contract: AnswerContract };

type FinalMessage = { text: string; blocked: BlockedItem[] } | { error: string };

type PidFile = { state: "missing" } | { state: "invalid" } | { state: "valid"; pid: number };

type ProcessEntry = { pid: number; pgid: number; args: string };

type ProcessListing = { processes: ProcessEntry[]; ownGroup: number } | { error: string };

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROLES: Readonly<Record<Role, { model: string; effort: string }>> = {
  coding: { model: "gpt-6.1-sol", effort: "xhigh" },
  audit: { model: "gpt-6-astra", effort: "xhigh" },
  bounded: { model: "gpt-6-luna", effort: "max" },
};

export const WRITE_PREAMBLE = [
  "If sandbox restrictions block authorized work, request the narrowest required permissions.",
  "If auto-review denies a request, do not work around it.",
  "Your final message is a JSON object: `answer` is your report to the caller; `blocked` lists",
  "every action that stayed blocked, with the exact command or change, its working directory,",
  "the reviewer's or the sandbox's rationale, and its cause. `blocked` is empty when nothing was.",
].join("\n");

const BLOCKED_ITEM_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["action", "cwd", "rationale", "cause"],
  properties: {
    action: { type: "string" },
    cwd: { type: "string" },
    rationale: { type: "string" },
    cause: { type: "string", enum: ["review_denial", "sandbox_failure"] },
  },
});

const EXIT_BY_STATUS: Readonly<Record<Status, number>> = {
  completed: 0,
  failed: 1,
  running: 10,
  blocked: 11,
  deadline: 124,
  cancelled: 130,
};

const DEFAULT_WAIT_SECONDS = 540;

const DEFAULT_DEADLINE_SECONDS = 7200;

const INTERRUPT_GRACE_MS = 30_000;

const POLL_MS = 500;

const PID_T_MAX = 2 ** 31 - 1;

const PS_MAX_BUFFER = 64 * 1024 * 1024;

const KIND_PATTERN = /^[a-z][a-z0-9-]*$/u;

const FINAL_MESSAGE_MARKER = "--- final message ---";

const CODEX_BIN = process.env.AGENTS_BRIDGE_CODEX_BIN ?? join(import.meta.dir, "codex");

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function bridgeSchema(callerSchema: string | null): string {
  const answer = callerSchema ?? JSON.stringify({ type: "string" });

  return `{"type":"object","additionalProperties":false,"required":["answer","blocked"],"properties":{"answer":${answer},"blocked":{"type":"array","items":${BLOCKED_ITEM_SCHEMA}}}}`;
}

export function buildCodexArgs(run: RunConfig, spec: TurnSpec, turnDir: string): string[] {
  const parent = ["exec", ...(run.mode === "write" ? ["--approve-for-me"] : ["-s", "read-only"])];

  for (const dir of run.add_dirs) parent.push("--add-dir", dir);

  parent.push("-C", run.cwd);

  if (run.skip_git_repo_check) parent.push("--skip-git-repo-check");

  const turn: string[] = [];

  if (run.model !== null) turn.push("-m", run.model);

  const effort = spec.effort ?? run.effort;

  if (effort !== null) turn.push("-c", `model_reasoning_effort=${effort}`);

  turn.push("--json", "-o", join(turnDir, "codex-final.txt"));

  if (run.mode === "write" || spec.caller_schema) {
    turn.push("--output-schema", join(turnDir, "schema.json"));
  }

  turn.push("-");

  if (spec.turn === 1) return [...parent, ...turn];

  if (run.thread_id === null) throw new Error("cannot resume: run.json has no thread_id");

  return [...parent, "resume", run.thread_id, ...turn];
}

export function statusFor(
  ending: Ending | null,
  codexExit: number,
  events: EventSummary,
  blocked: BlockedItem[],
): FinalStatus {
  if (ending !== null) return ending;

  if (codexExit !== 0 || events.turnError !== null || !events.completed) return "failed";

  return blocked.length > 0 ? "blocked" : "completed";
}

// ---------------------------------------------------------------------------
// Boundary parsers: text written by codex, by the caller, or by an earlier call
// ---------------------------------------------------------------------------

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- this section IS the boundary parser those rules ask for: codex events, the codex model catalog, codex's final message, the caller's schema, ~/.codex/config.toml and our own state files arrive as text, and nothing past these functions sees them untyped. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const isRole = (value: unknown): value is Role =>
  value === "coding" || value === "audit" || value === "bounded";

const isMode = (value: unknown): value is Mode => value === "read-only" || value === "write";

const isFinalStatus = (value: unknown): value is FinalStatus =>
  value === "completed" ||
  value === "failed" ||
  value === "blocked" ||
  value === "deadline" ||
  value === "cancelled";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseBlockedItem(raw: unknown): BlockedItem | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 4 ||
    typeof raw.action !== "string" ||
    typeof raw.cwd !== "string" ||
    typeof raw.rationale !== "string" ||
    (raw.cause !== "review_denial" && raw.cause !== "sandbox_failure")
  ) {
    return null;
  }

  return { action: raw.action, cwd: raw.cwd, rationale: raw.rationale, cause: raw.cause };
}

const blockedList = (raw: unknown): BlockedItem[] =>
  Array.isArray(raw)
    ? raw.map((item) => parseBlockedItem(item)).filter((item) => item !== null)
    : [];

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";

  if (Array.isArray(value)) return "array";

  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";

  return typeof value;
}

// Only the schema's top-level `type` and `required` are checked here: codex holds
// the model's answer to the full schema, and this repository carries no JSON
// Schema validator.
function meetsContract(value: unknown, contract: AnswerContract): boolean {
  if (value === undefined) return false;

  const actual = jsonTypeOf(value);

  if (
    contract.type !== null &&
    actual !== contract.type &&
    !(contract.type === "number" && actual === "integer")
  ) {
    return false;
  }

  return (
    contract.required.length === 0 ||
    (isRecord(value) && contract.required.every((key) => Object.hasOwn(value, key)))
  );
}

function hasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));

  if (!isRecord(value)) return false;

  return Object.hasOwn(value, key) || Object.values(value).some((item) => hasKey(item, key));
}

export function parseFinalMessage(
  text: string,
  mode: Mode,
  contract: AnswerContract | null,
): FinalMessage {
  if (text.trim() === "") return { error: "codex wrote no final message" };

  if (mode === "read-only") {
    if (contract !== null && !meetsContract(parseJson(text), contract)) {
      return { error: "the final message does not match the schema's type and required keys" };
    }

    return { text, blocked: [] };
  }

  const decoded = parseJson(text);

  if (!isRecord(decoded) || !Array.isArray(decoded.blocked) || !Object.hasOwn(decoded, "answer")) {
    return { error: "the final message is not a bridge result object {answer, blocked}" };
  }

  if (Object.keys(decoded).length !== 2) {
    return { error: "the bridge result carries properties beyond answer and blocked" };
  }

  const blocked = blockedList(decoded.blocked);

  if (blocked.length !== decoded.blocked.length) {
    return { error: "a blocked item lacks action, cwd, rationale or a known cause" };
  }

  if (contract !== null) {
    if (!meetsContract(decoded.answer, contract)) {
      return { error: "answer does not match the schema's type and required keys" };
    }

    return { text: `${JSON.stringify(decoded.answer, null, 2)}\n`, blocked };
  }

  if (typeof decoded.answer !== "string") return { error: "answer is not a string" };

  return { text: decoded.answer, blocked };
}

export function summarizeEvents(jsonl: string): EventSummary {
  const summary: EventSummary = { threadId: null, completed: false, turnError: null };

  for (const line of jsonl.split("\n")) {
    const event = parseJson(line);

    if (!isRecord(event)) continue;

    if (event.type === "thread.started") summary.threadId = stringOrNull(event.thread_id);

    if (event.type === "turn.completed") summary.completed = true;

    if (event.type === "turn.failed") {
      const error = isRecord(event.error) ? stringOrNull(event.error.message) : null;

      summary.turnError = error ?? "turn failed";
    }
  }

  return summary;
}

function parseCatalog(text: string): CatalogModel[] {
  const decoded = parseJson(text);

  if (!isRecord(decoded) || !Array.isArray(decoded.models)) {
    throw new Error("codex debug models printed no models array");
  }

  const models: CatalogModel[] = [];

  for (const raw of decoded.models) {
    if (!isRecord(raw) || raw.visibility !== "list" || typeof raw.slug !== "string") continue;

    const efforts: string[] = [];

    for (const level of Array.isArray(raw.supported_reasoning_levels)
      ? raw.supported_reasoning_levels
      : []) {
      if (isRecord(level) && typeof level.effort === "string") efforts.push(level.effort);
    }

    models.push({
      slug: raw.slug,
      efforts,
      defaultEffort: stringOrNull(raw.default_reasoning_level) ?? "",
      description: stringOrNull(raw.description) ?? "",
    });
  }

  return models;
}

function userConfigDefaults(): string {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");

  if (!existsSync(path)) return "no config.toml, codex built-in defaults";

  const decoded: unknown = Bun.TOML.parse(readFileSync(path, "utf8"));
  const model = isRecord(decoded) ? stringOrNull(decoded.model) : null;
  const effort = isRecord(decoded) ? stringOrNull(decoded.model_reasoning_effort) : null;

  return `model ${model ?? "(unset)"}, effort ${effort ?? "(unset)"}`;
}

function readRun(runDir: string): RunConfig {
  const path = join(runDir, "run.json");

  if (!existsSync(path)) throw new UsageError(`${runDir} has no run.json: start it first`);

  const raw = parseJson(readFileSync(path, "utf8"));

  if (!isRecord(raw) || !isMode(raw.mode) || typeof raw.cwd !== "string") {
    throw new Error(`${path} is not a codex-run config`);
  }

  return {
    cwd: raw.cwd,
    mode: raw.mode,
    role: isRole(raw.role) ? raw.role : null,
    model: stringOrNull(raw.model),
    effort: stringOrNull(raw.effort),
    add_dirs: Array.isArray(raw.add_dirs)
      ? raw.add_dirs.filter((dir): dir is string => typeof dir === "string")
      : [],
    git_write: raw.git_write === true,
    skip_git_repo_check: raw.skip_git_repo_check === true,
    codex_version: stringOrNull(raw.codex_version) ?? "",
    thread_id: stringOrNull(raw.thread_id),
    created_at: stringOrNull(raw.created_at) ?? "",
  };
}

function readSpec(turnDir: string): TurnSpec {
  const raw = parseJson(readFileSync(join(turnDir, "turn.json"), "utf8"));

  if (!isRecord(raw) || typeof raw.turn !== "number" || typeof raw.deadline_seconds !== "number") {
    throw new Error(`${turnDir}/turn.json is not a turn spec`);
  }

  return {
    turn: raw.turn,
    effort: stringOrNull(raw.effort),
    deadline_seconds: raw.deadline_seconds,
    caller_schema: raw.caller_schema === true,
    caller_type: stringOrNull(raw.caller_type),
    caller_required: Array.isArray(raw.caller_required)
      ? raw.caller_required.filter((key): key is string => typeof key === "string")
      : [],
    started_at: stringOrNull(raw.started_at) ?? "",
  };
}

function readResult(turnDir: string): TurnResult | null {
  const path = join(turnDir, "result.json");

  if (!existsSync(path)) return null;

  const raw = parseJson(readFileSync(path, "utf8"));

  if (!isRecord(raw) || !isFinalStatus(raw.status)) throw new Error(`${path} is not a turn result`);

  return {
    status: raw.status,
    codex_exit: typeof raw.codex_exit === "number" ? raw.codex_exit : null,
    thread_id: stringOrNull(raw.thread_id),
    error: stringOrNull(raw.error),
    blocked: blockedList(raw.blocked),
    ended_at: stringOrNull(raw.ended_at) ?? "",
  };
}

function readCallerSchema(path: string, mode: Mode): CallerSchema {
  const text = readFileSync(path, "utf8");
  const decoded = parseJson(text);

  if (!isRecord(decoded)) throw new UsageError(`--output-schema: ${path} is not a JSON object`);

  if (mode === "write" && hasKey(decoded, "$ref")) {
    throw new UsageError(
      "--output-schema: write mode nests the schema under `answer`, where its $ref pointers would resolve against the bridge wrapper; inline the definitions",
    );
  }

  const required = Array.isArray(decoded.required)
    ? decoded.required.filter((key): key is string => typeof key === "string")
    : [];

  return { text: text.trim(), contract: { type: stringOrNull(decoded.type), required } };
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type */

// ---------------------------------------------------------------------------
// Files and processes
// ---------------------------------------------------------------------------

function writeJson(path: string, value: RunConfig | TurnSpec | TurnResult): void {
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

const turnDirOf = (runDir: string, turn: number): string => join(runDir, `turn-${turn}`);

function latestTurn(runDir: string): number {
  let latest = 0;

  for (const entry of readdirSync(runDir)) {
    const match = /^turn-(\d+)$/u.exec(entry);

    if (match?.[1] !== undefined) latest = Math.max(latest, Number(match[1]));
  }

  return latest;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

// killGroup(0) would signal codex-run's own process group and killGroup(1) every
// process the user owns; pid 1 is init, never a process codex-run started.
const isSignallable = (pid: number): boolean =>
  Number.isInteger(pid) && pid > 1 && pid <= PID_T_MAX;

function readPidFile(path: string): PidFile {
  if (!existsSync(path)) return { state: "missing" };

  const text = readFileSync(path, "utf8").trim();
  const pid = Number(text);

  return /^[1-9]\d*$/u.test(text) && isSignallable(pid)
    ? { state: "valid", pid }
    : { state: "invalid" };
}

function listProcesses(): ProcessListing {
  const result = spawnSync("ps", ["-A", "-ww", "-o", "pid=", "-o", "pgid=", "-o", "args="], {
    encoding: "utf8",
    maxBuffer: PS_MAX_BUFFER,
  });

  if (result.error !== undefined) return { error: `cannot run ps: ${result.error.message}` };

  if (result.status !== 0) return { error: `ps exited ${result.status}: ${result.stderr.trim()}` };

  const processes: ProcessEntry[] = [];

  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;

    const match = /^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/u.exec(line);

    if (match === null) {
      return {
        error: `ps printed a line that is not a pid, a process group and a command: ${line}`,
      };
    }

    processes.push({ pid: Number(match[1]), pgid: Number(match[2]), args: match[3] ?? "" });
  }

  const own = processes.find((entry) => entry.pid === process.pid);

  if (own === undefined) return { error: "ps did not list codex-run itself" };

  return { processes, ownGroup: own.pgid };
}

const readPid = (turnDir: string): PidFile => readPidFile(join(turnDir, "supervisor.pid"));

// Returns why the group could not be stopped; a group already gone (ESRCH) is success.
function killGroup(pid: number): string | null {
  try {
    process.kill(-pid, "SIGKILL");

    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return null;

    return `cannot stop codex's process group ${pid}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function readEnding(turnDir: string): Ending | null {
  const path = join(turnDir, "ending");

  if (!existsSync(path)) return null;

  return readFileSync(path, "utf8").trim() === "deadline" ? "deadline" : "cancelled";
}

function tail(path: string, count: number): string {
  if (!existsSync(path)) return "";

  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("Reading additional input"));

  return lines.slice(-count).join("\n");
}

function runCodex(args: string[]): string {
  const result = spawnSync(CODEX_BIN, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error !== undefined)
    throw new Error(`cannot run ${CODEX_BIN}: ${result.error.message}`);

  if (result.status !== 0) {
    throw new Error(`codex ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

function codexVersion(): string {
  const match = /(\d+\.\d+\.\d+\S*)/u.exec(runCodex(["--version"]));

  if (match?.[1] === undefined) throw new Error("codex --version printed no version");

  return match[1];
}

function validateModel(model: string, effort: string | null): void {
  const catalog = parseCatalog(runCodex(["debug", "models"]));
  const entry = catalog.find((candidate) => candidate.slug === model);

  if (entry === undefined) {
    const slugs = catalog.map((candidate) => candidate.slug).join(", ");

    throw new UsageError(`unknown model ${model}; the codex catalog lists: ${slugs}`);
  }

  if (effort !== null && !entry.efforts.includes(effort)) {
    throw new UsageError(
      `${model} does not support effort ${effort}; it supports ${entry.efforts.join(", ")}`,
    );
  }
}

function gitDirs(cwd: string): string[] {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
    { encoding: "utf8" },
  );

  if (result.status !== 0) throw new UsageError(`--git-write: ${cwd} is not in a git repository`);

  return result.stdout.split("\n").filter((line) => line !== "");
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function stopFoundGroup(pgid: number, ownGroup: number): string | null {
  if (pgid === ownGroup) return `process group ${pgid} is codex-run's own`;

  if (!isSignallable(pgid)) return `process group ${pgid} is not a valid pid`;

  return killGroup(pgid);
}

// With the supervisor dead no codex can start for this turn any more, and every codex
// command line names the turn's own -o file (buildCodexArgs): it identifies codex's group.
function stopCodexByTurnFile(turnFile: string): string {
  const listing = listProcesses();

  if ("error" in listing) {
    return `: codex may still be running, and codex-run could not list processes to find it (${listing.error}). Find it with \`ps -A -ww -o pgid,args | grep -F -- '${turnFile}'\`: a line that runs codex, not your search, starts with codex's process group. Stop codex and the commands it started with \`kill -KILL -- -<that group>\`.`;
  }

  const groups = [
    ...new Set(
      listing.processes
        .filter((entry) => entry.pid !== process.pid && ` ${entry.args} `.includes(` ${turnFile} `))
        .map((entry) => entry.pgid),
    ),
  ];

  if (groups.length === 0) return "; no codex process for this turn was running";

  const failures = groups.flatMap((pgid) => stopFoundGroup(pgid, listing.ownGroup) ?? []);

  const found = `codex-run found codex's process group${groups.length === 1 ? "" : "s"} ${groups.join(", ")} by its turn file`;

  return failures.length === 0
    ? `; ${found} and stopped it`
    : `; ${found}, but ${failures.join("; ")}: codex may still be running`;
}

// A dead supervisor leaves codex unwatched: stop it before declaring the turn over.
function stopUnwatchedCodex(turnDir: string): string {
  const lost = "the supervisor exited without writing a result";
  const pidPath = join(turnDir, "codex.pid");
  const codex = readPidFile(pidPath);

  if (codex.state === "valid") {
    const stopError = killGroup(codex.pid);

    return stopError === null ? lost : `${lost}; ${stopError}`;
  }

  // The supervisor opens events.jsonl right before it spawns codex.
  if (codex.state === "missing" && !existsSync(join(turnDir, "events.jsonl"))) return lost;

  const cause =
    codex.state === "missing"
      ? "after it began starting codex and before it recorded codex's pid"
      : `and ${pidPath} holds no valid pid`;

  return `${lost}, ${cause}${stopCodexByTurnFile(join(turnDir, "codex-final.txt"))}`;
}

function envelope(runDir: string): Envelope {
  const run = readRun(runDir);
  const turn = latestTurn(runDir);
  const turnDir = turnDirOf(runDir, turn);
  let result = readResult(turnDir);
  const supervisor = readPid(turnDir);

  if (result === null && supervisor.state === "valid" && !isAlive(supervisor.pid)) {
    const error = stopUnwatchedCodex(turnDir);

    result = readResult(turnDir) ?? {
      status: "failed",
      codex_exit: null,
      thread_id: null,
      error,
      blocked: [],
      ended_at: new Date().toISOString(),
    };
    writeJson(join(turnDir, "result.json"), result);
  }

  const spec = readSpec(turnDir);
  const supervisorUnknown = result === null && supervisor.state === "invalid";

  return {
    run_dir: runDir,
    turn,
    status: result?.status ?? "running",
    thread_id: result?.thread_id ?? run.thread_id,
    mode: run.mode,
    model: run.model,
    effort: spec.effort ?? run.effort,
    cwd: run.cwd,
    add_dirs: run.add_dirs,
    codex_version: run.codex_version,
    codex_exit: result?.codex_exit ?? null,
    error: supervisorUnknown
      ? `${join(turnDir, "supervisor.pid")} holds no valid pid: codex-run cannot tell whether the turn's supervisor still runs, and cancel cannot signal it. wait still returns the turn's result once the supervisor writes it.`
      : (result?.error ?? null),
    blocked: result?.blocked ?? [],
    final_message_file: join(turnDir, "final.md"),
  };
}

function report(current: Envelope): void {
  process.stdout.write(`${JSON.stringify(current)}\n`);

  if (current.status === "running" || !existsSync(current.final_message_file)) return;

  const text = readFileSync(current.final_message_file, "utf8");

  if (text !== "")
    process.stdout.write(`${FINAL_MESSAGE_MARKER}\n${text}${text.endsWith("\n") ? "" : "\n"}`);
}

async function waitFor(runDir: string, seconds: number): Promise<Envelope> {
  const until = Date.now() + seconds * 1000;
  let current = envelope(runDir);

  while (current.status === "running" && Date.now() < until) {
    await Bun.sleep(POLL_MS);
    current = envelope(runDir);
  }

  return current;
}

async function waitAndReport(runDir: string, seconds: number): Promise<number> {
  const current = await waitFor(runDir, seconds);

  report(current);

  return EXIT_BY_STATUS[current.status];
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function startTurn(
  runDir: string,
  run: RunConfig,
  spec: TurnSpec,
  promptFile: string,
  callerSchema: string | null,
  waitSeconds: number,
): Promise<number> {
  const turnDir = turnDirOf(runDir, spec.turn);
  const prompt = readFileSync(promptFile, "utf8");

  mkdirSync(turnDir);
  writeFileSync(
    join(turnDir, "prompt.md"),
    run.mode === "write" ? `${WRITE_PREAMBLE}\n\n${prompt}` : prompt,
  );

  if (run.mode === "write") {
    writeFileSync(join(turnDir, "schema.json"), `${bridgeSchema(callerSchema)}\n`);
  } else if (callerSchema !== null) {
    writeFileSync(join(turnDir, "schema.json"), `${callerSchema}\n`);
  }

  writeJson(join(turnDir, "turn.json"), spec);

  const supervisor = spawn(
    process.execPath,
    [import.meta.path, "__supervise", runDir, String(spec.turn)],
    {
      detached: true,
      stdio: "ignore",
    },
  );

  if (supervisor.pid === undefined) throw new Error("cannot spawn the codex-run supervisor");

  writeFileSync(join(turnDir, "supervisor.pid"), `${supervisor.pid}\n`);
  supervisor.unref();

  return waitAndReport(runDir, waitSeconds);
}

async function supervise(runDir: string, turn: number): Promise<void> {
  const run = readRun(runDir);
  const turnDir = turnDirOf(runDir, turn);
  const spec = readSpec(turnDir);
  const stdin = openSync(join(turnDir, "prompt.md"), "r");
  const stdout = openSync(join(turnDir, "events.jsonl"), "w");
  const stderr = openSync(join(turnDir, "stderr.log"), "w");
  let child: ChildProcess | null = null;
  let stopFailure: string | null = null;
  let giveUp: ((code: number) => void) | null = null;

  // The first reason is kept; every call still signals, so an interrupt
  // recorded before codex existed reaches it once it does.
  const interrupt = (reason: Ending): void => {
    if (readEnding(turnDir) === null) writeFileSync(join(turnDir, "ending"), `${reason}\n`);

    if (child === null) return;

    const target = child;

    target.kill("SIGINT");
    setTimeout(() => {
      if (target.pid === undefined || target.exitCode !== null) return;

      stopFailure = killGroup(target.pid);

      // codex outlived SIGINT and cannot be killed: waiting for its exit would never end.
      if (stopFailure !== null) giveUp?.(137);
    }, INTERRUPT_GRACE_MS).unref();
  };

  process.on("SIGINT", () => interrupt("cancelled"));
  process.on("SIGTERM", () => interrupt("cancelled"));

  // Its own process group, so one kill reaches the commands codex runs.
  const spawned = spawn(CODEX_BIN, buildCodexArgs(run, spec, turnDir), {
    cwd: run.cwd,
    detached: true,
    stdio: [stdin, stdout, stderr],
    env: { ...process.env, AGENTS_BRIDGE_CODEX_VERSION: run.codex_version },
  });

  child = spawned;

  if (spawned.pid !== undefined) writeFileSync(join(turnDir, "codex.pid"), `${spawned.pid}\n`);

  // cancel writes its request before it checks for this marker, so a request
  // made before the handlers existed is seen here, and one made after gets a signal.
  writeFileSync(join(turnDir, "ready"), "");

  if (existsSync(join(turnDir, "cancel-request")) || readEnding(turnDir) !== null)
    interrupt("cancelled");

  const deadline = setTimeout(() => interrupt("deadline"), spec.deadline_seconds * 1000);

  const codexExit = await new Promise<number>((done) => {
    giveUp = done;
    spawned.on("error", () => done(127));
    spawned.on("exit", (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });

  clearTimeout(deadline);

  // A turn is over only once nothing it started still runs.
  const stopError = stopFailure ?? (spawned.pid === undefined ? null : killGroup(spawned.pid));

  for (const fd of [stdin, stdout, stderr]) closeSync(fd);

  const ending = readEnding(turnDir);
  const events = summarizeEvents(readFileSync(join(turnDir, "events.jsonl"), "utf8"));
  const rawPath = join(turnDir, "codex-final.txt");
  const raw = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : "";
  let status = statusFor(ending, codexExit, events, []);
  let blocked: BlockedItem[] = [];
  let error: string | null = null;

  if (status === "completed") {
    const parsed = parseFinalMessage(
      raw,
      run.mode,
      spec.caller_schema ? { type: spec.caller_type, required: spec.caller_required } : null,
    );

    if ("error" in parsed) {
      status = "failed";
      error = parsed.error;
      writeFileSync(join(turnDir, "final.md"), raw);
    } else {
      blocked = parsed.blocked;
      status = statusFor(null, codexExit, events, blocked);
      writeFileSync(join(turnDir, "final.md"), parsed.text);
    }
  } else {
    writeFileSync(join(turnDir, "final.md"), raw);
    error =
      ending === "deadline"
        ? `deadline of ${spec.deadline_seconds} s reached; codex was interrupted`
        : ending === "cancelled"
          ? "cancelled"
          : (events.turnError ??
            `codex exited ${codexExit}: ${tail(join(turnDir, "stderr.log"), 5)}`);
  }

  if (stopError !== null) {
    status = "failed";
    error = stopError;
  }

  if (run.thread_id === null && events.threadId !== null) {
    writeJson(join(runDir, "run.json"), { ...run, thread_id: events.threadId });
  }

  writeJson(join(turnDir, "result.json"), {
    status,
    codex_exit: codexExit,
    thread_id: events.threadId ?? run.thread_id,
    error,
    blocked,
    ended_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function parseSeconds(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0)
    throw new UsageError(`${flag} takes a number of seconds`);

  return parsed;
}

function existingFile(path: string | undefined, flag: string): string {
  if (path === undefined) throw new UsageError(`${flag} is required`);

  const absolute = resolve(path);

  if (!existsSync(absolute) || !statSync(absolute).isFile())
    throw new UsageError(`${flag}: no file at ${absolute}`);

  return absolute;
}

function runDirArg(positionals: string[]): string {
  const dir = positionals[0];

  if (dir === undefined) throw new UsageError("the run directory is required");

  const absolute = resolve(dir);

  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new UsageError(`no run directory at ${absolute}`);
  }

  return absolute;
}

function commandNew(args: string[]): number {
  const kind = args[0] ?? "codex";

  if (!KIND_PATTERN.test(kind))
    throw new UsageError(`the run kind must match ${KIND_PATTERN.source}`);

  const root = join(homedir(), ".cache", "agents-bridge", kind);

  mkdirSync(root, { recursive: true, mode: 0o700 });
  process.stdout.write(`${mkdtempSync(join(root, "run."))}\n`);

  return 0;
}

function commandStart(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "prompt-file": { type: "string" },
      mode: { type: "string", default: "read-only" },
      role: { type: "string" },
      model: { type: "string", short: "m" },
      effort: { type: "string" },
      cwd: { type: "string", short: "C" },
      "add-dir": { type: "string", multiple: true, default: [] },
      "git-write": { type: "boolean", default: false },
      "skip-git-repo-check": { type: "boolean", default: false },
      "codex-version": { type: "string" },
      "output-schema": { type: "string" },
      deadline: { type: "string" },
      wait: { type: "string" },
    },
  });

  const runDir = runDirArg(positionals);

  if (existsSync(join(runDir, "run.json")))
    throw new UsageError(`${runDir} already started: use resume`);

  const promptFile = existingFile(values["prompt-file"], "--prompt-file");

  if (!isMode(values.mode)) throw new UsageError("--mode is read-only or write");

  const callerSchema =
    values["output-schema"] === undefined
      ? null
      : readCallerSchema(existingFile(values["output-schema"], "--output-schema"), values.mode);

  if (values.role !== undefined && !isRole(values.role)) {
    throw new UsageError(`--role is one of ${Object.keys(ROLES).join(", ")}`);
  }

  const role = values.role ?? null;
  const model = values.model ?? (role === null ? null : ROLES[role].model);
  const effort = values.effort ?? (role === null ? null : ROLES[role].effort);

  if (model !== null) validateModel(model, effort);

  const cwd = resolve(values.cwd ?? process.cwd());
  const addDirs = values["add-dir"].map((dir) => resolve(dir));

  if (values["git-write"]) addDirs.push(...gitDirs(cwd));

  const run: RunConfig = {
    cwd,
    mode: values.mode,
    role,
    model,
    effort,
    add_dirs: [...new Set(addDirs)],
    git_write: values["git-write"],
    skip_git_repo_check: values["skip-git-repo-check"],
    codex_version: values["codex-version"] ?? codexVersion(),
    thread_id: null,
    created_at: new Date().toISOString(),
  };

  writeJson(join(runDir, "run.json"), run);

  const spec: TurnSpec = {
    turn: 1,
    effort: null,
    deadline_seconds: parseSeconds(values.deadline, DEFAULT_DEADLINE_SECONDS, "--deadline"),
    caller_schema: callerSchema !== null,
    caller_type: callerSchema?.contract.type ?? null,
    caller_required: callerSchema?.contract.required ?? [],
    started_at: new Date().toISOString(),
  };

  return startTurn(
    runDir,
    run,
    spec,
    promptFile,
    callerSchema?.text ?? null,
    parseSeconds(values.wait, DEFAULT_WAIT_SECONDS, "--wait"),
  );
}

function commandResume(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "prompt-file": { type: "string" },
      effort: { type: "string" },
      "output-schema": { type: "string" },
      deadline: { type: "string" },
      wait: { type: "string" },
    },
  });

  const runDir = runDirArg(positionals);
  const current = envelope(runDir);

  if (current.status === "running") {
    throw new UsageError(`turn ${current.turn} is still running: wait for it or cancel it first`);
  }

  const run = readRun(runDir);

  if (run.thread_id === null)
    throw new UsageError("the first turn recorded no thread id: nothing to resume");

  if (values.effort !== undefined && run.model !== null) validateModel(run.model, values.effort);

  const promptFile = existingFile(values["prompt-file"], "--prompt-file");

  const callerSchema =
    values["output-schema"] === undefined
      ? null
      : readCallerSchema(existingFile(values["output-schema"], "--output-schema"), run.mode);

  const spec: TurnSpec = {
    turn: current.turn + 1,
    effort: values.effort ?? null,
    deadline_seconds: parseSeconds(values.deadline, DEFAULT_DEADLINE_SECONDS, "--deadline"),
    caller_schema: callerSchema !== null,
    caller_type: callerSchema?.contract.type ?? null,
    caller_required: callerSchema?.contract.required ?? [],
    started_at: new Date().toISOString(),
  };

  return startTurn(
    runDir,
    run,
    spec,
    promptFile,
    callerSchema?.text ?? null,
    parseSeconds(values.wait, DEFAULT_WAIT_SECONDS, "--wait"),
  );
}

function commandWait(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { timeout: { type: "string" } },
  });

  return waitAndReport(
    runDirArg(positionals),
    parseSeconds(values.timeout, DEFAULT_WAIT_SECONDS, "--timeout"),
  );
}

function commandCancel(args: string[]): Promise<number> {
  const runDir = runDirArg(args);
  const turnDir = turnDirOf(runDir, latestTurn(runDir));
  const supervisor = readPid(turnDir);

  if (envelope(runDir).status === "running") {
    writeFileSync(join(turnDir, "cancel-request"), "");

    if (supervisor.state === "valid" && existsSync(join(turnDir, "ready"))) {
      process.kill(supervisor.pid, "SIGINT");
    }
  }

  return waitAndReport(runDir, INTERRUPT_GRACE_MS / 1000 + 15);
}

function commandModels(): number {
  process.stdout.write(`~/.codex/config.toml: ${userConfigDefaults()}\n`);
  process.stdout.write(
    `roles: ${Object.entries(ROLES)
      .map(([role, { model, effort }]) => `${role} = ${model} ${effort}`)
      .join(" | ")}\n`,
  );

  try {
    for (const model of parseCatalog(runCodex(["debug", "models"]))) {
      process.stdout.write(
        `${model.slug} | default effort: ${model.defaultEffort} | efforts: ${model.efforts.join(",")} | ${model.description}\n`,
      );
    }
  } catch (error) {
    // The codex skill injects this output when it loads, and a failing injected
    // command aborts the whole skill: report the failure as text instead.
    process.stdout.write(
      `(model catalog unavailable: ${error instanceof Error ? error.message : String(error)})\n`,
    );
  }

  return 0;
}

const USAGE = `usage:
  codex-run.ts new [kind]
  codex-run.ts start <run-dir> --prompt-file F [--mode read-only|write] [--role coding|audit|bounded]
               [-m MODEL] [--effort E] [-C DIR] [--add-dir DIR]... [--git-write]
               [--skip-git-repo-check] [--codex-version X.Y.Z] [--output-schema F]
               [--deadline S] [--wait S]
  codex-run.ts resume <run-dir> --prompt-file F [--effort E] [--output-schema F] [--deadline S] [--wait S]
  codex-run.ts wait <run-dir> [--timeout S]
  codex-run.ts status <run-dir>
  codex-run.ts cancel <run-dir>
  codex-run.ts models
start, resume, wait and cancel exit with the turn status: 0 completed, 1 failed,
10 still running, 11 blocked, 124 deadline, 130 cancelled; 2 is a usage error.
status exits 0 once it has read the run.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case "new":
      return commandNew(args);
    case "start":
      return commandStart(args);
    case "resume":
      return commandResume(args);
    case "wait":
      return commandWait(args);
    case "status":
      report(envelope(runDirArg(args)));

      return 0;
    case "cancel":
      return commandCancel(args);
    case "models":
      return commandModels();
    case "__supervise":
      await supervise(resolve(args[0] ?? ""), Number(args[1]));

      return 0;
    default:
      throw new UsageError(
        command === undefined ? "a command is required" : `unknown command ${command}`,
      );
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // parseArgs reports an unknown or malformed flag as a TypeError with a code.
    const usage = error instanceof UsageError || (error instanceof TypeError && "code" in error);

    process.stderr.write(`codex-run: ${error instanceof Error ? error.message : String(error)}\n`);

    if (usage) process.stderr.write(`${USAGE}\n`);

    process.exitCode = usage ? 2 : 1;
  }
}
