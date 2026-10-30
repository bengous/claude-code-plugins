#!/usr/bin/env bun

/**
 * The review tier of a change: `low` lands once its checks are green, `human` waits for the human's word.
 *
 *   bun ./scripts/tier.ts [--base origin/dev] [--pr <n>] [--checkout <path>]   one line, low|human <reason>; exit 0
 *   bun ./scripts/tier.ts --history <n>                     the tier of each of dev's last n commits, bumps aside
 *   bun ./scripts/tier.ts --eval scripts/tier.cases.json    each case judged 3 times: agreement, false lows, 3/n
 *
 * The floor (`scripts/tier-floor.ts`) decides first, the risky paths read from the base's profile so a branch cannot
 * loosen them. Past it, Haiku reads the change, headless, with no tool, hook, setting file or MCP server, from a
 * private empty directory: a CLAUDE.md planted in the shared tmpdir would be read. With `--pr`, a change that reads low
 * is read again with the pull request's *Left open* section, which can thus raise the tier and never lower it. The judge answers only with the model and the prompt that
 * `scripts/tier.cases.json` was validated with; anything else, and any failure, answers `human` with its reason: the
 * safe direction, written.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { messageOf } from "../agent-hooks/errors.ts";
import { isRecord, stringField } from "../agent-hooks/json.ts";
import { withoutSessionIdentity } from "./lib/session-env.ts";
import { BASE, short } from "./review-verdict.ts";
import { VERSION_BUMP } from "./sample-review.ts";
import {
  type Change,
  changesOf,
  floorOf,
  linesOf,
  type RiskyRead,
  riskyOf,
  type Tier,
  type Verdict,
} from "./tier-floor.ts";

export const PROMPT_FILE = join(import.meta.dir, "tier.prompt.md");

export const CASES_FILE = join(import.meta.dir, "tier.cases.json");

const TIERS: readonly Tier[] = ["low", "human"];

const CLAUDE_TIMEOUT_MS = 120_000;

const RUNS_PER_CASE = 3;

const CONCURRENCY = 4;

const REASON_MAX = 300;

const CONTROL = /\p{Cc}/gu;

const LEFT_OPEN = /^#{1,6}\s*Left open\b/iu;

const HEADING = /^#{1,6}\s/u;

const SESSION_LINE = /^<!-- (?:opened|updated|executed)_by:/u;

const FENCE = /^\s*(`{3,}|~{3,})/u;

const SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: TIERS },
    reason: { type: "string" },
  },
  required: ["tier", "reason"],
  additionalProperties: false,
};

/** Where a change is read from: what `git diff` compares, the environment it runs in, the commits' messages. */
export interface Source {
  readonly cwd: string;
  readonly diff: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly messages: readonly string[];
}

/** What the floor and the judge read of a change. */
export interface Evidence {
  readonly changes: readonly Change[];
  readonly nameStatus: string;
  readonly stat: string;
  readonly patch: string;
  readonly lines: number;
  readonly messages: readonly string[];
}

/** The judge's answer to one change. */
export interface Answer {
  readonly tier: Tier;
  readonly reason: string;
  /** The model that answered, as `claude -p` names it; null when its output does not say. */
  readonly model: string | null;
  readonly costUsd: number;
}

export interface Case {
  readonly name: string;
  readonly expected: Tier;
  /** Judged only after the prompt's last revision, never tuned on: the cases that alone bound the false-low rate. */
  readonly heldOut: boolean;
  /** A commit whose own change is judged. */
  readonly sha?: string;
  /** Or a patch applied on `base`, judged with `message`. */
  readonly base?: string;
  readonly patch?: string;
  readonly message?: string;
}

/** The model and the prompt digest the cases were last judged with, null until a run of them is accepted. */
export interface Calibration {
  readonly model: string | null;
  readonly prompt: string | null;
  readonly cases: readonly Case[];
}

/** Asks `model` the tier of the change in `prompt`, under `system`; answers `claude -p --output-format json`'s stdout. */
export type Ask = (model: string, system: string, prompt: string) => Promise<string>;

export interface Judge {
  readonly ask: Ask;
  readonly system: string;
  readonly calibration: Calibration;
}

export interface Decided {
  readonly verdict: Verdict;
  readonly by: "floor" | "judge" | "failure";
  readonly model: string | null;
  readonly costUsd: number;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function git(
  cwd: string,
  args: readonly string[],
  { env, stdin }: { env?: Readonly<Record<string, string>>; stdin?: string } = {},
): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? null : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** The full messages of the commits `range` lists, oldest first. */
export function messagesOf(cwd: string, range: string): readonly string[] {
  return git(cwd, ["log", "--reverse", "--format=%B%x00", range])
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");
}

function subjectsOf(messages: readonly string[]): readonly string[] {
  return messages.map((message) => message.split("\n")[0] ?? "");
}

export function evidenceOf(source: Source): Evidence {
  const diff = (...options: string[]) =>
    git(
      source.cwd,
      ["diff", "--no-ext-diff", "--no-color", "--find-renames", ...options, ...source.diff],
      source.env === undefined ? {} : { env: source.env },
    );

  return {
    changes: changesOf(diff("--name-status", "-z")),
    nameStatus: diff("--name-status").trimEnd(),
    stat: diff("--stat").trimEnd(),
    patch: diff(),
    lines: linesOf(diff("--numstat", "-z")),
    messages: source.messages,
  };
}

/**
 * The *Left open* section of a pull request's body, its heading aside, up to the next heading or session line outside
 * a code fence; null when the body has none.
 */
export function leftOpenOf(body: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => LEFT_OPEN.test(line));

  if (start === -1) return null;

  const section: string[] = [];
  let fence: string | null = null;

  for (const line of lines.slice(start + 1)) {
    const marker = FENCE.exec(line)?.[1];

    if (fence === null && (HEADING.test(line) || SESSION_LINE.test(line))) break;

    if (marker !== undefined && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
    }

    section.push(line);
  }

  const text = section.join("\n").trim();

  return text === "" ? null : text;
}

/** The message the judge reads: the change's files, size, messages, the PR's *Left open*, then its diff. */
export function promptOf(evidence: Evidence, leftOpen: string | null): string {
  return [
    `<name_status>\n${evidence.nameStatus}\n</name_status>`,
    `<stat>\n${evidence.stat}\n</stat>`,
    `<commit_messages>\n${evidence.messages.join("\n\n---\n\n")}\n</commit_messages>`,
    ...(leftOpen === null ? [] : [`<left_open>\n${leftOpen}\n</left_open>`]),
    `<diff>\n${evidence.patch}\n</diff>`,
  ].join("\n\n");
}

/**
 * The answer in `claude -p --output-format json`'s output: its result message, alone or the last of the array a
 * `verbose` setting prints, carries the schema's answer in `structured_output` and the model in `modelUsage`.
 */
export function answerOf(stdout: string): Answer {
  let output: unknown;

  try {
    output = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p printed no JSON: ${stdout.trim().slice(0, 200)}`);
  }

  const result = Array.isArray(output)
    ? output.findLast((item) => isRecord(item) && item["type"] === "result")
    : output;

  if (!isRecord(result) || result["type"] !== "result") {
    throw new Error("claude -p printed no result message");
  }

  if (result["is_error"] !== false || result["subtype"] !== "success") {
    throw new Error(
      `claude -p ended in error (${String(result["subtype"])}): ${(stringField(result, "result") ?? "").slice(0, 200)}`,
    );
  }

  const answer = result["structured_output"];

  if (!isRecord(answer)) throw new Error("claude -p answered without structured_output");

  const tier = TIERS.find((known) => known === answer["tier"]);

  if (tier === undefined) {
    throw new Error(`the judge's tier ${JSON.stringify(answer["tier"])} is not low or human`);
  }

  const reason = (stringField(answer, "reason") ?? "")
    .replaceAll(CONTROL, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, REASON_MAX);

  if (reason === "") throw new Error("the judge gave no reason");

  const usage = result["modelUsage"];
  const models = isRecord(usage) ? Object.keys(usage) : [];
  const cost = result["total_cost_usd"];

  return {
    tier,
    reason,
    model: models.length === 1 ? (models[0] ?? null) : null,
    costUsd: Number.isFinite(cost) ? Number(cost) : 0,
  };
}

/** No tool, hook, MCP server, setting file or saved session: the system prompt, the schema and the change alone. */
export function claudeArgs(model: string, system: string): readonly string[] {
  return [
    "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(SCHEMA),
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--settings",
    '{"disableAllHooks":true}',
    "--setting-sources",
    "",
    "--system-prompt",
    system,
  ];
}

export const askClaude: Ask = async (model, system, prompt) => {
  const cwd = mkdtempSync(join(tmpdir(), "tier-"));

  try {
    const child = Bun.spawn([...claudeArgs(model, system)], {
      cwd,
      env: withoutSessionIdentity(process.env),
      stdin: new TextEncoder().encode(prompt),
      stdout: "pipe",
      stderr: "pipe",
      timeout: CLAUDE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (child.signalCode !== null) {
      throw new Error(`claude -p gave no answer within ${CLAUDE_TIMEOUT_MS / 1000} s`);
    }

    if (code !== 0) throw new Error(`claude -p exited ${code}: ${(stderr || stdout).trim()}`);

    return stdout;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

function floorFor(evidence: Evidence, risky: RiskyRead): Verdict | null {
  return floorOf({
    changes: evidence.changes,
    subjects: subjectsOf(evidence.messages),
    risky,
    lines: evidence.lines,
  });
}

/** The floor's verdict, else the judge's, asked of `model`; a judge that fails answers `human` with why. */
export async function decide(
  evidence: Evidence,
  risky: RiskyRead,
  leftOpen: string | null,
  judge: Judge,
  model: string,
): Promise<Decided> {
  const floor = floorFor(evidence, risky);

  if (floor !== null) return { verdict: floor, by: "floor", model: null, costUsd: 0 };

  try {
    const plain = answerOf(await judge.ask(model, judge.system, promptOf(evidence, null)));

    if (plain.tier === "human" || leftOpen === null) {
      return {
        verdict: { tier: plain.tier, reason: plain.reason },
        by: "judge",
        model: plain.model,
        costUsd: plain.costUsd,
      };
    }

    // *Left open* is the author's text: read only once the change alone reads low, it can raise the tier, not lower it.
    const read = answerOf(await judge.ask(model, judge.system, promptOf(evidence, leftOpen)));

    return {
      verdict: { tier: read.tier, reason: read.reason },
      by: "judge",
      model: plain.model === read.model ? read.model : null,
      costUsd: plain.costUsd + read.costUsd,
    };
  } catch (error) {
    return {
      verdict: { tier: "human", reason: firstLine(messageOf(error)) },
      by: "failure",
      model: null,
      costUsd: 0,
    };
  }
}

/** Why the judge may not answer: no calibration accepted yet, or a prompt other than the one it was accepted with. */
export function staleness(judge: Judge): string | null {
  const { model, prompt } = judge.calibration;

  if (model === null || prompt === null) {
    return "no calibration: tier.cases.json names no model and prompt it was validated with";
  }

  const now = digestOf(judge.system);

  return prompt === now
    ? null
    : `stale calibration: tier.prompt.md is ${now}, tier.cases.json was validated with ${prompt}`;
}

/** The tier of a change: the floor, else the calibrated judge; `human` for any judge it was not validated with. */
export async function tierOf(
  evidence: Evidence,
  risky: RiskyRead,
  leftOpen: string | null,
  judge: Judge,
): Promise<Verdict> {
  const floor = floorFor(evidence, risky);

  if (floor !== null) return floor;

  const stale = staleness(judge);
  const { model } = judge.calibration;

  if (stale !== null || model === null) {
    return { tier: "human", reason: stale ?? "no calibrated model" };
  }

  const decided = await decide(evidence, risky, leftOpen, judge, model);

  if (decided.by === "judge" && decided.model !== model) {
    return {
      tier: "human",
      reason: `stale calibration: ${decided.model ?? "an unnamed model"} answered, tier.cases.json was validated with ${model}`,
    };
  }

  return decided.verdict;
}

export function calibrationOf(text: string): Calibration {
  const parsed: unknown = JSON.parse(text);

  if (!isRecord(parsed) || !Array.isArray(parsed["cases"])) {
    throw new Error("tier.cases.json holds no cases array");
  }

  const entries: unknown[] = parsed["cases"];

  const cases = entries.map((value, index): Case => {
    const where = `tier.cases.json: case ${index + 1}`;

    if (!isRecord(value)) throw new Error(`${where} is not an object`);

    const name = stringField(value, "name");
    const expected = TIERS.find((tier) => tier === value["expected"]);

    if (name === undefined || expected === undefined) {
      throw new Error(`${where} needs a name and an expected tier, low or human`);
    }

    const marked = value["heldOut"];

    if (marked !== undefined && marked !== true && marked !== false) {
      throw new Error(`${where} (${name}): heldOut is true or false`);
    }

    const heldOut = marked === true;
    const sha = stringField(value, "sha");
    const base = stringField(value, "base");
    const patch = stringField(value, "patch");
    const message = stringField(value, "message");

    if (sha !== undefined) return { name, expected, heldOut, sha };

    if (base === undefined || patch === undefined || message === undefined) {
      throw new Error(`${where} (${name}) needs a sha, or a base, a patch and a message`);
    }

    return { name, expected, heldOut, base, patch, message };
  });

  return {
    model: stringField(parsed, "model") ?? null,
    prompt: stringField(parsed, "prompt") ?? null,
    cases,
  };
}

export function judgeFromFiles(ask: Ask = askClaude): Judge {
  return {
    ask,
    system: readFileSync(PROMPT_FILE, "utf8"),
    calibration: calibrationOf(readFileSync(CASES_FILE, "utf8")),
  };
}

export function lineOf(verdict: Verdict): string {
  return `${verdict.tier} ${verdict.reason.replaceAll(/\s+/gu, " ").trim()}`;
}

function prBodyOf(cwd: string, pr: string): string {
  const view = Bun.spawnSync(["gh", "pr", "view", pr, "--json", "body", "--jq", ".body"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (view.exitCode !== 0) throw new Error(`gh pr view ${pr}: ${view.stderr.toString().trim()}`);

  return view.stdout.toString();
}

async function pooled<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  // One iterator shared by the workers: each takes the next item when it is free.
  const queue = items.entries();

  const worker = async () => {
    for (const [index, item] of queue) {
      // oxlint-disable-next-line no-await-in-loop -- each worker takes one item at a time, CONCURRENCY workers at once.
      results[index] = await work(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

  return results;
}

/** The source of one commit's own change: its diff from its first parent, its message. */
function commitSource(cwd: string, sha: string): Source {
  return { cwd, diff: [`${sha}^`, sha], messages: messagesOf(cwd, `${sha}^..${sha}`) };
}

async function history(cwd: string, count: number, judge: Judge): Promise<void> {
  const model = judge.calibration.model ?? "haiku";
  const risky = riskyOf(cwd, BASE);

  const commits = git(cwd, ["log", "--first-parent", "--format=%H%x00%P%x00%s", BASE])
    .split("\n")
    .map((line) => line.split("\0"))
    .filter(([, parents = "", subject = ""]) => parents !== "" && !VERSION_BUMP.test(subject))
    .slice(0, count);

  const decided = await pooled(commits, async ([sha = "", , subject = ""]) => ({
    sha,
    subject,
    decided: await decide(evidenceOf(commitSource(cwd, sha)), risky, null, judge, model),
  }));

  for (const row of decided) {
    console.log(
      [
        short(row.sha),
        row.decided.verdict.tier,
        row.decided.by,
        row.decided.verdict.reason,
        row.subject,
      ].join("\t"),
    );
  }

  const cost = decided.reduce((sum, row) => sum + row.decided.costUsd, 0);
  const lows = decided.filter((row) => row.decided.verdict.tier === "low").length;
  const models = new Set(decided.flatMap((row) => row.decided.model ?? []));

  console.error(
    `${decided.length} commits: ${lows} low, ${decided.length - lows} human; model ${[...models].join(", ") || "none answered"}, asked as ${model}; prompt ${digestOf(judge.system)}; $${cost.toFixed(2)}`,
  );
}

/** The change a case holds: its commit's, or its patch applied on its base in an index of its own. */
function caseSource(cwd: string, entry: Case, index: string): Source {
  if (entry.sha !== undefined) return commitSource(cwd, entry.sha);

  const base = entry.base ?? "";
  const env = { GIT_INDEX_FILE: index };

  git(cwd, ["read-tree", base], { env });
  git(cwd, ["apply", "--cached", "-"], { env, stdin: entry.patch ?? "" });

  return { cwd, diff: ["--cached", base], env, messages: [entry.message ?? ""] };
}

/** One case of `--eval` and the decisions of its runs. */
export interface CaseRuns {
  readonly entry: Case;
  readonly runs: readonly Decided[];
}

/**
 * The rule-of-three line over the held-out changes the model judged. A case's runs share one change and sample only
 * the model's noise, so both counts are of changes: a case is a false low when any of its runs reads low.
 */
export function ruleOfThree(results: readonly CaseRuns[]): string {
  const judged = results.filter(
    ({ entry, runs }) => entry.heldOut && runs.some((decided) => decided.by === "judge"),
  );

  if (judged.length === 0) return "rule of three: no held-out case the model judged, no bound";

  const falseLows = judged.filter(
    ({ entry, runs }) =>
      entry.expected === "human" && runs.some((decided) => decided.verdict.tier === "low"),
  ).length;

  return `rule of three: ${falseLows} of ${judged.length} held-out changes read a false low; at 0, the false-low rate is under 3/${judged.length} = ${((3 / judged.length) * 100).toFixed(1)}% at 95%`;
}

/** The `low` cases read `human` on every run: a judge that answers human to all would pass on false lows alone. */
export function humanOnEveryRun(results: readonly CaseRuns[]): readonly string[] {
  return results.flatMap(({ entry, runs }) =>
    entry.expected === "low" &&
    runs.length > 0 &&
    runs.every((decided) => decided.by !== "failure" && decided.verdict.tier === "human")
      ? [entry.name]
      : [],
  );
}

async function evaluate(cwd: string, file: string, ask: Ask): Promise<number> {
  const judge: Judge = {
    ask,
    system: readFileSync(PROMPT_FILE, "utf8"),
    calibration: calibrationOf(readFileSync(file, "utf8")),
  };

  const model = judge.calibration.model ?? "haiku";
  const risky = riskyOf(cwd, BASE);
  const scratch = mkdtempSync(join(tmpdir(), "tier-eval-"));

  try {
    const read = judge.calibration.cases.map((entry, index) => ({
      entry,
      evidence: evidenceOf(caseSource(cwd, entry, join(scratch, `index-${index}`))),
    }));

    const results = await pooled(read, async ({ entry, evidence }) => {
      const runs: Decided[] = [];

      for (let attempt = 0; attempt < RUNS_PER_CASE; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- the floor is deterministic: one run says what it says thrice.
        const decided = await decide(evidence, risky, null, judge, model);

        runs.push(decided);

        if (decided.by === "floor") break;
      }

      return { entry, runs };
    });

    let agreed = 0;
    let judged = 0;
    const failures: string[] = [];
    const falseLows: string[] = [];
    const falseHumans: string[] = [];
    const models = new Set<string>();

    for (const { entry, runs } of results) {
      const tiers = runs.map((decided) => decided.verdict.tier);

      for (const decided of runs) {
        if (decided.model !== null) models.add(decided.model);

        if (decided.by === "judge") judged += 1;

        if (decided.by === "failure") failures.push(`${entry.name}: ${decided.verdict.reason}`);
        else if (decided.verdict.tier === entry.expected) agreed += 1;
        else if (decided.verdict.tier === "low")
          falseLows.push(`${entry.name}: ${decided.verdict.reason}`);
        else falseHumans.push(`${entry.name}: ${decided.verdict.reason}`);
      }

      console.log(
        [
          entry.name,
          `expected ${entry.expected}`,
          tiers.join(","),
          runs[0]?.by ?? "",
          runs.at(-1)?.verdict.reason ?? "",
        ].join("\t"),
      );
    }

    const total = results.reduce((sum, { runs }) => sum + runs.length, 0);

    const cost = results.reduce(
      (sum, { runs }) => sum + runs.reduce((run, decided) => run + decided.costUsd, 0),
      0,
    );

    console.log(
      `\nagreement ${agreed}/${total} runs; ${judged} judged by the model, ${failures.length} failed, the rest by the floor`,
    );
    console.log(`failed ${failures.length}${failures.map((line) => `\n  ${line}`).join("")}`);
    console.log(`false low ${falseLows.length}${falseLows.map((line) => `\n  ${line}`).join("")}`);
    console.log(
      `false human ${falseHumans.length}${falseHumans.map((line) => `\n  ${line}`).join("")}`,
    );

    const lowsLost = humanOnEveryRun(results);

    console.log(
      `low read human on every run ${lowsLost.length}${lowsLost.map((name) => `\n  ${name}`).join("")}`,
    );
    console.log(ruleOfThree(results));

    console.log(
      `model ${[...models].join(", ") || "none answered"}, asked as ${model}; prompt ${digestOf(judge.system)}; $${cost.toFixed(2)}`,
    );

    return falseLows.length === 0 && failures.length === 0 && lowsLost.length === 0 ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const usage =
    "Usage: bun ./scripts/tier.ts [--base <ref>] [--pr <n>] [--checkout <path>] | --history <n> | --eval <cases.json>";

  let values;

  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        base: { type: "string" },
        pr: { type: "string" },
        checkout: { type: "string" },
        history: { type: "string" },
        eval: { type: "string" },
      },
    }));
  } catch {
    console.error(usage);

    return 2;
  }

  // One mode per run: an allow rule on `--pr *` must not also cover a --history or --eval that bills a call per commit.
  const modes = [
    values.history !== undefined,
    values.eval !== undefined,
    values.pr !== undefined || values.base !== undefined,
  ].filter(Boolean).length;

  if (modes > 1) {
    console.error(usage);

    return 2;
  }

  const cwd = values.checkout ?? process.cwd();

  if (values.history !== undefined) {
    const count = Number(values.history);

    if (!Number.isInteger(count) || count < 1) {
      console.error(usage);

      return 2;
    }

    await history(cwd, count, judgeFromFiles());

    return 0;
  }

  if (values.eval !== undefined) return evaluate(cwd, values.eval, askClaude);

  const base = values.base ?? BASE;

  try {
    const evidence = evidenceOf({
      cwd,
      diff: [`${base}...HEAD`],
      messages: messagesOf(cwd, `${base}..HEAD`),
    });

    const leftOpen = values.pr === undefined ? null : leftOpenOf(prBodyOf(cwd, values.pr));

    console.log(lineOf(await tierOf(evidence, riskyOf(cwd, base), leftOpen, judgeFromFiles())));
  } catch (error) {
    console.log(lineOf({ tier: "human", reason: firstLine(messageOf(error)) }));
  }

  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
