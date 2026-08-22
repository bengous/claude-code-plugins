#!/usr/bin/env bun

// rebase — Backend for the /rebase command.
//
// Plans an interactive rebase over the repository the caller stands in, renders
// the plan, then executes it without ever opening an editor. Every mode prints
// one JSON object on stdout; the /rebase command asks the user and feeds the
// answers back in as a plan on stdin.

import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Action = "pick" | "squash" | "reword" | "drop";

type Commit = {
  hash: string;
  short: string;
  subject: string;
  body: string;
  author: string;
  age: string;
  files: number;
  insertions: number;
  deletions: number;
};

type Step = { hash: string; action: Action; message: string | null };

type Plan = { base: string; steps: Step[] };

type ConflictedFile = { path: string; markers: number };

type RebaseState = {
  in_progress: boolean;
  current: number | null;
  total: number | null;
  conflicted: ConflictedFile[];
};

type Phase = "validate" | "plan" | "apply" | "continue" | "skip" | "abort" | "status";

type Success =
  | {
      ok: true;
      step: "plan";
      base: string;
      base_short: string;
      branch: string;
      commits: Commit[];
      note: string | null;
    }
  | { ok: true; step: "dry-run"; plan_text: string }
  | {
      ok: true;
      step: "applied";
      plan_text: string;
      backup_ref: string;
      head: string;
      commits: number;
    }
  | { ok: true; step: "completed"; from: "continue" | "skip"; head: string }
  | { ok: true; step: "aborted" }
  | { ok: true; step: "status"; state: RebaseState }
  | { ok: true; step: "usage"; usage: string };

type Failure = {
  ok: false;
  step: Phase;
  error: string;
  detail: string | null;
  state: RebaseState | null;
  guidance: string[] | null;
};

type Result = Success | Failure;

const GUIDANCE = [
  "Open each conflicted file and resolve the conflicts.",
  "Conflict markers are <<<<<<< HEAD (yours), ======= (separator), >>>>>>> commit (incoming).",
  "Remove every marker once you keep the changes you want.",
  "Stage the resolved files: git add <file>",
  "Resume: /rebase continue",
  "Or drop the current commit with /rebase skip, or undo everything with /rebase abort.",
] as const;

const USAGE = `Usage: /rebase <branch|N|X..Y>

  N          the last N commits (HEAD~N)
  <rev>      every commit since the merge base with <rev>
  X..Y       every commit since X

Follow-up: /rebase continue | skip | abort | status`;

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const US = "\u001F";
const RS = "\u001E";

async function git(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.quiet().nothrow();
  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode };
}

async function gitOk(...args: string[]): Promise<string> {
  const result = await git(...args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function fail(step: Phase, error: string, detail: string | null = null): Failure {
  return { ok: false, step, error, detail, state: null, guidance: null };
}

function conflictFailure(step: Phase, state: RebaseState): Failure {
  return { ok: false, step, error: "conflict", detail: null, state, guidance: [...GUIDANCE] };
}

// ---------------------------------------------------------------------------
// Rebase state
// ---------------------------------------------------------------------------

async function readNumber(path: string): Promise<number | null> {
  if (!existsSync(path)) return null;
  const value = Number((await readFile(path, "utf8")).trim());
  return Number.isFinite(value) ? value : null;
}

async function countMarkers(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const contents = await readFile(path, "utf8");
  let markers = 0;
  for (const line of contents.split("\n")) {
    if (line.startsWith("<<<<<<< ")) markers += 1;
  }
  return markers;
}

async function conflictedFiles(): Promise<ConflictedFile[]> {
  const listed = await gitOk("diff", "--name-only", "--diff-filter=U");
  const files: ConflictedFile[] = [];
  for (const path of listed.split("\n").filter(Boolean)) {
    files.push({ path, markers: await countMarkers(path) });
  }
  return files;
}

async function readState(): Promise<RebaseState> {
  const mergeDir = await gitOk("rev-parse", "--git-path", "rebase-merge");
  const applyDir = await gitOk("rev-parse", "--git-path", "rebase-apply");
  const inProgress = existsSync(mergeDir) || existsSync(applyDir);
  if (!inProgress) {
    return { in_progress: false, current: null, total: null, conflicted: [] };
  }
  return {
    in_progress: true,
    current: await readNumber(join(mergeDir, "msgnum")),
    total: await readNumber(join(mergeDir, "end")),
    conflicted: await conflictedFiles(),
  };
}

// ---------------------------------------------------------------------------
// Range resolution
// ---------------------------------------------------------------------------

type Range =
  | { kind: "resolved"; base: string; note: string | null }
  | { kind: "rejected"; reason: string };

async function resolveCommit(rev: string): Promise<string | null> {
  const result = await git("rev-parse", "--verify", `${rev}^{commit}`);
  return result.exitCode === 0 ? result.stdout : null;
}

async function resolveRange(spec: string): Promise<Range> {
  if (/^\d+$/u.test(spec)) {
    const base = await resolveCommit(`HEAD~${spec}`);
    if (base === null) return { kind: "rejected", reason: `HEAD has fewer than ${spec} commits` };
    return { kind: "resolved", base, note: null };
  }

  const dots = spec.indexOf("..");
  if (dots !== -1) {
    const left = spec.slice(0, dots);
    const right = spec.slice(dots + 2).replace(/^\./u, "");
    if (left === "") return { kind: "rejected", reason: `range without a base: ${spec}` };
    const base = await resolveCommit(left);
    if (base === null) return { kind: "rejected", reason: `unknown revision: ${left}` };
    if (right === "") return { kind: "resolved", base, note: null };
    const head = await resolveCommit("HEAD");
    const end = await resolveCommit(right);
    if (end === null) return { kind: "rejected", reason: `unknown revision: ${right}` };
    if (end === head) return { kind: "resolved", base, note: null };
    return {
      kind: "resolved",
      base,
      note: `A rebase always rewrites through HEAD, so the commits after ${right} are replayed unchanged.`,
    };
  }

  const target = await resolveCommit(spec);
  if (target === null) return { kind: "rejected", reason: `unknown revision: ${spec}` };
  const mergeBase = await git("merge-base", "HEAD", target);
  if (mergeBase.exitCode !== 0) {
    return { kind: "rejected", reason: `no common ancestor between HEAD and ${spec}` };
  }
  return { kind: "resolved", base: mergeBase.stdout, note: null };
}

// ---------------------------------------------------------------------------
// Commit collection
// ---------------------------------------------------------------------------

type Stats = { files: number; insertions: number; deletions: number };

async function collectStats(base: string): Promise<Map<string, Stats>> {
  const raw = await gitOk("log", "--reverse", `--format=${RS}%H`, "--numstat", `${base}..HEAD`);
  const stats = new Map<string, Stats>();
  for (const record of raw.split(RS)) {
    const lines = record.split("\n").filter((line) => line !== "");
    const hash = lines[0];
    if (hash === undefined) continue;
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of lines.slice(1)) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      files += 1;
      insertions += Number(parts[0]) || 0;
      deletions += Number(parts[1]) || 0;
    }
    stats.set(hash, { files, insertions, deletions });
  }
  return stats;
}

async function collectCommits(base: string): Promise<Commit[]> {
  const format = RS + ["%H", "%h", "%s", "%an", "%ar", "%b"].join(US);
  const raw = await gitOk("log", "--reverse", `--format=${format}`, `${base}..HEAD`);
  const stats = await collectStats(base);
  const commits: Commit[] = [];
  for (const record of raw.split(RS)) {
    if (record.trim() === "") continue;
    const fields = record.split(US);
    const hash = fields[0] ?? "";
    if (hash === "") continue;
    const stat = stats.get(hash) ?? { files: 0, insertions: 0, deletions: 0 };
    commits.push({
      hash,
      short: fields[1] ?? "",
      subject: fields[2] ?? "",
      author: fields[3] ?? "",
      age: fields[4] ?? "",
      body: (fields[5] ?? "").trim(),
      files: stat.files,
      insertions: stat.insertions,
      deletions: stat.deletions,
    });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// Plan rendering
// ---------------------------------------------------------------------------

const LABELS = new Map<Action, string>([
  ["pick", "✓ PICK  "],
  ["squash", "⬆ SQUASH"],
  ["reword", "✎ REWORD"],
  ["drop", "✗ DROP  "],
]);

function renderPlan(baseShort: string, commits: Commit[], steps: Step[]): string {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const counts = new Map<Action, number>([
    ["pick", 0],
    ["squash", 0],
    ["reword", 0],
    ["drop", 0],
  ]);
  const lines = [`Rebase plan — base ${baseShort}`, ""];

  for (const step of steps) {
    const commit = byHash.get(step.hash);
    const short = commit?.short ?? step.hash.slice(0, 7);
    const subject = commit?.subject ?? "";
    lines.push(`  ${LABELS.get(step.action) ?? step.action} ${short} ${subject}`);
    if (step.action === "squash") {
      lines.push("           └─ folded into the commit above");
    }
    if (step.message !== null) {
      lines.push(`           └─ message: ${step.message.split("\n")[0] ?? ""}`);
    }
    counts.set(step.action, (counts.get(step.action) ?? 0) + 1);
  }

  const summary = [...counts.entries()].map(([action, count]) => `${count} ${action}`).join(", ");
  lines.push("", `Summary: ${summary}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plan parsing
// ---------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- this block IS the boundary parser those rules ask for: the plan arrives as untyped JSON on stdin and drives a history rewrite, so every field is checked before anything runs. */

const ACTIONS = new Set(["pick", "squash", "reword", "drop"]);

function isAction(value: unknown): value is Action {
  return typeof value === "string" && ACTIONS.has(value);
}

function parseStep(value: unknown, index: number): Parsed<Step> {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: `steps[${index}] is not an object` };
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.hash !== "string" || !/^[0-9a-f]{7,64}$/u.test(raw.hash)) {
    return { ok: false, error: `steps[${index}].hash is not a commit hash` };
  }
  if (!isAction(raw.action)) {
    return { ok: false, error: `steps[${index}].action is not pick, squash, reword or drop` };
  }
  const message = raw.message ?? null;
  if (message !== null && typeof message !== "string") {
    return { ok: false, error: `steps[${index}].message is neither a string nor null` };
  }
  return { ok: true, value: { hash: raw.hash, action: raw.action, message } };
}

function parsePlan(input: string): Parsed<Plan> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    return { ok: false, error: "plan is not valid JSON" };
  }
  if (typeof decoded !== "object" || decoded === null) {
    return { ok: false, error: "plan is not an object" };
  }
  const raw = decoded as Record<string, unknown>;
  if (typeof raw.base !== "string" || raw.base === "") {
    return { ok: false, error: "plan.base is missing" };
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return { ok: false, error: "plan.steps is empty" };
  }
  const steps: Step[] = [];
  for (const [index, entry] of raw.steps.entries()) {
    const parsed = parseStep(entry, index);
    if (!parsed.ok) return parsed;
    steps.push(parsed.value);
  }
  return { ok: true, value: { base: raw.base, steps } };
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- back to typed values. */

function checkSteps(steps: Step[], commits: Commit[]): string | null {
  if (steps.length !== commits.length) {
    return `plan covers ${steps.length} commits, the range holds ${commits.length}`;
  }
  for (const [index, step] of steps.entries()) {
    if (step.hash !== commits[index]?.hash) {
      return `plan.steps[${index}] is not the commit at that position any more`;
    }
  }
  const firstKept = steps.find((step) => step.action !== "drop");
  if (firstKept !== undefined && firstKept.action === "squash") {
    return "the first commit that is kept cannot be squashed: nothing precedes it";
  }
  for (const [index, step] of steps.entries()) {
    if (step.action === "reword" && (step.message === null || step.message.trim() === "")) {
      return `steps[${index}] rewords without a message`;
    }
    if ((step.action === "pick" || step.action === "drop") && step.message !== null) {
      return `steps[${index}] carries a message but its action is ${step.action}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function requireRepo(step: Phase): Promise<Failure | null> {
  const top = await git("rev-parse", "--show-toplevel");
  if (top.exitCode !== 0) return fail(step, "not-a-git-repo", top.stderr);
  return null;
}

async function requireClean(step: Phase): Promise<Failure | null> {
  const status = await gitOk("status", "--porcelain");
  if (status !== "") return fail(step, "dirty-worktree", status);
  return null;
}

async function requireNoRebase(step: Phase): Promise<Failure | null> {
  const state = await readState();
  if (state.in_progress) return fail(step, "rebase-already-in-progress");
  return null;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function planMode(spec: string): Promise<Result> {
  const repoError = await requireRepo("plan");
  if (repoError !== null) return repoError;
  const rebaseError = await requireNoRebase("plan");
  if (rebaseError !== null) return rebaseError;
  const cleanError = await requireClean("plan");
  if (cleanError !== null) return cleanError;

  const range = await resolveRange(spec);
  if (range.kind === "rejected") return fail("plan", "invalid-range", range.reason);

  return {
    ok: true,
    step: "plan",
    base: range.base,
    base_short: await gitOk("rev-parse", "--short", range.base),
    branch: await gitOk("branch", "--show-current"),
    commits: await collectCommits(range.base),
    note: range.note,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Message files live under the git directory, not in a temp dir: a conflict
 * pauses the rebase, and the `exec` lines that read them only run when the user
 * resumes, long after this process exited.
 */
async function messageDir(): Promise<string> {
  const gitDir = await gitOk("rev-parse", "--absolute-git-dir");
  return join(gitDir, "claude-rebase");
}

async function buildTodo(steps: Step[], dir: string): Promise<string[]> {
  const lines: string[] = [];
  for (const [index, step] of steps.entries()) {
    lines.push(`${step.action === "reword" ? "pick" : step.action} ${step.hash}`);
    if (step.message === null) continue;
    const path = join(dir, `message-${index}.txt`);
    await writeFile(path, `${step.message.trimEnd()}\n`);
    lines.push(`exec git commit --amend --file=${shellQuote(path)}`);
  }
  return lines;
}

async function applyMode(input: string, dryRun: boolean): Promise<Result> {
  const repoError = await requireRepo("apply");
  if (repoError !== null) return repoError;
  const rebaseError = await requireNoRebase("apply");
  if (rebaseError !== null) return rebaseError;
  const cleanError = await requireClean("apply");
  if (cleanError !== null) return cleanError;

  const parsed = parsePlan(input);
  if (!parsed.ok) return fail("apply", "invalid-plan", parsed.error);
  const plan = parsed.value;

  const base = await resolveCommit(plan.base);
  if (base === null) return fail("apply", "invalid-plan", `unknown base: ${plan.base}`);

  const commits = await collectCommits(base);
  const mismatch = checkSteps(plan.steps, commits);
  if (mismatch !== null) return fail("apply", "plan-stale", mismatch);

  const planText = renderPlan(await gitOk("rev-parse", "--short", base), commits, plan.steps);
  if (dryRun) return { ok: true, step: "dry-run", plan_text: planText };

  const branch = await gitOk("branch", "--show-current");
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/gu, "")
    .slice(0, 14);
  const label = (branch === "" ? "detached" : branch).replaceAll(/[^A-Za-z0-9._-]/gu, "-");
  const backupRef = `rebase-backup-${label}-${stamp}`;
  const backup = await git("branch", backupRef);
  if (backup.exitCode !== 0) return fail("apply", "backup-failed", backup.stderr);

  const dir = await messageDir();
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const todoPath = join(dir, "todo");
  await writeFile(todoPath, `${(await buildTodo(plan.steps, dir)).join("\n")}\n`);

  // GIT_EDITOR=true keeps squash and reword from opening an editor; the `exec`
  // lines set the final messages afterwards.
  const run = await $`git rebase -i ${base}`
    .env({
      ...process.env,
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todoPath)}`,
    })
    .quiet()
    .nothrow();

  const state = await readState();
  if (state.in_progress) return conflictFailure("apply", state);
  if (run.exitCode !== 0) {
    return fail("apply", "rebase-failed", run.stderr.toString().trim());
  }

  await rm(dir, { recursive: true, force: true });
  return {
    ok: true,
    step: "applied",
    plan_text: planText,
    backup_ref: backupRef,
    head: await gitOk("rev-parse", "HEAD"),
    commits: Number(await gitOk("rev-list", "--count", `${base}..HEAD`)),
  };
}

async function stagedMarkers(): Promise<string | null> {
  const staged = await gitOk("diff", "--cached", "--name-only");
  for (const path of staged.split("\n").filter(Boolean)) {
    if ((await countMarkers(path)) > 0) return path;
  }
  return null;
}

async function resumeMode(mode: "continue" | "skip"): Promise<Result> {
  const repoError = await requireRepo(mode);
  if (repoError !== null) return repoError;

  const before = await readState();
  if (!before.in_progress) return fail(mode, "no-rebase-in-progress");

  if (mode === "continue") {
    if (before.conflicted.length > 0) {
      return { ...conflictFailure(mode, before), error: "unresolved-conflicts" };
    }
    const marked = await stagedMarkers();
    if (marked !== null) return fail(mode, "conflict-markers-staged", marked);
  }

  const run = await $`git rebase ${mode === "continue" ? "--continue" : "--skip"}`
    .env({ ...process.env, GIT_EDITOR: "true" })
    .quiet()
    .nothrow();

  const after = await readState();
  if (after.in_progress) return conflictFailure(mode, after);
  if (run.exitCode !== 0) return fail(mode, "rebase-failed", run.stderr.toString().trim());

  await rm(await messageDir(), { recursive: true, force: true });
  return { ok: true, step: "completed", from: mode, head: await gitOk("rev-parse", "HEAD") };
}

async function abortMode(): Promise<Result> {
  const repoError = await requireRepo("abort");
  if (repoError !== null) return repoError;

  const state = await readState();
  if (!state.in_progress) return fail("abort", "no-rebase-in-progress");

  const run = await git("rebase", "--abort");
  if (run.exitCode !== 0) return fail("abort", "abort-failed", run.stderr);

  await rm(await messageDir(), { recursive: true, force: true });
  return { ok: true, step: "aborted" };
}

async function statusMode(): Promise<Result> {
  const repoError = await requireRepo("status");
  if (repoError !== null) return repoError;
  return { ok: true, step: "status", state: await readState() };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<Result> {
  const args = Bun.argv.slice(2);
  const mode = args[0] ?? "";

  switch (mode) {
    case "":
    case "-h":
    case "--help":
    case "help": {
      return { ok: true, step: "usage", usage: USAGE };
    }
    case "plan": {
      const spec = args[1];
      if (spec === undefined) return fail("plan", "missing-range", USAGE);
      return planMode(spec);
    }
    case "apply": {
      return applyMode(await Bun.stdin.text(), args.includes("--dry-run"));
    }
    case "continue":
    case "skip": {
      return resumeMode(mode);
    }
    case "abort": {
      return abortMode();
    }
    case "status": {
      return statusMode();
    }
    default: {
      return fail("validate", "unknown-mode", `${mode}\n\n${USAGE}`);
    }
  }
}

if (import.meta.main) {
  let result: Result;
  try {
    result = await main();
  } catch (error) {
    result = fail(
      "validate",
      "unexpected-failure",
      error instanceof Error ? error.message : String(error),
    );
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
