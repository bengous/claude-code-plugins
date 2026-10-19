#!/usr/bin/env bun

import { existsSync } from "node:fs";

import { execute } from "./git-clean-apply.ts";
import { audit, type AuditSuccess, inspectWorktree } from "./git-clean-audit.ts";
import { git, GitError, gitRead, listRefs } from "./git.ts";
import { parseManifest } from "./manifest.ts";
import { gh, githubRepo } from "./proofs.ts";
import {
  buildProtectedSet,
  localBranchExists,
  originHeadTarget,
  readSweepConfig,
} from "./sweep-config.ts";
import {
  type MainWorktree,
  parseWorktreeList,
  type TriageContext,
  triageWorktree,
  type WorktreeHead,
  type WorktreeList,
} from "./worktrees.ts";

export const CLOSED_PR_GRACE_DAYS = 14;

export const NO_PR_IDLE_DAYS = 30;

const ARCHIVE_REFS = "refs/archive/";

const AGENT_WORKTREES = "/.claude/worktrees/agent-";

const AGENT_BRANCH_PREFIX = "worktree-";

const DEV_TRUNKS = ["dev", "develop"];

const DETAIL_LIMIT = 120;

const DAY_MS = 86_400_000;

type Categories = AuditSuccess["categories"];

type KeptBranch = AuditSuccess["kept"][number];

type Ignored = Categories["removable_worktrees"][number]["ignored"];

type WorktreeRemoval = { path: string; branch: string | null; why: string };

type BranchDeletion = { name: string; oid: string; force: boolean; why: string };

type Archival = {
  name: string;
  oid: string;
  worktree: { path: string; stale: boolean } | null;
  why: string;
};

type KeptLine = { name: string; reason: string };

type Plan = {
  base: string;
  mainWorktree: string;
  worktrees: WorktreeRemoval[];
  staleWorktrees: WorktreeRemoval[];
  deletions: BranchDeletion[];
  archivals: Archival[];
  kept: KeptLine[];
};

export function isAgentWorktree(path: string, mainPath: string): boolean {
  const prefix = `${mainPath}${AGENT_WORKTREES}`;
  const id = path.slice(prefix.length);

  return path.startsWith(prefix) && id !== "" && !id.includes("/");
}

const listed = (items: string[], truncated: boolean): string =>
  `${items.join(", ")}${truncated ? ", …" : ""}`;

const clip = (text: string): string =>
  text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT - 1)}…`;

const relativeTo = (text: string, mainWorktree: string): string =>
  text.replaceAll(`${mainWorktree}/`, "");

const describeKept = (entry: KeptBranch, mainWorktree: string): string =>
  entry.detail === null
    ? entry.reason
    : `${entry.reason}: ${clip(relativeTo(entry.detail, mainWorktree))}`;

function removalWhy(proof: string, ignored: Ignored): string {
  return ignored.dirs.length === 0
    ? proof
    : `${proof}; ignored dirs removed: ${listed(ignored.dirs, ignored.truncated)}`;
}

// Claude Code locks an agent's worktree while the agent runs, and names the
// branch it created there after the worktree's directory. Whether its cleanup
// at the agent's end copes with that branch gone is not measured.
export function runningAgentBranches(
  list: WorktreeList,
  isAgent: (path: string) => boolean,
): Map<string, string> {
  const running = new Map<string, string>();

  for (const { path, registration } of list.linked) {
    if (isAgent(path) && registration.kind === "locked") {
      const branch = `${AGENT_BRANCH_PREFIX}${path.slice(path.lastIndexOf("/") + 1)}`;
      running.set(branch, `its agent still runs in ${path} (locked)`);
    }
  }

  return running;
}

type ProvenPlan = Pick<Plan, "worktrees" | "staleWorktrees" | "deletions"> & {
  blocked: KeptLine[];
};

// A loose ignored file is more often a per-worktree secret or note than build
// output, and removing the worktree destroys it for good.
function planProven(
  audited: AuditSuccess,
  isAgent: (path: string) => boolean,
  running: ReadonlyMap<string, string>,
): ProvenPlan {
  const { categories } = audited;
  const plan: ProvenPlan = { worktrees: [], staleWorktrees: [], deletions: [], blocked: [] };
  const holds = new Map(running);

  for (const { path, branch, proof, ignored } of categories.removable_worktrees) {
    if (!isAgent(path)) {
      holds.set(branch, `worktree: ${path} is not an agent worktree`);
    } else if (ignored.files.length > 0) {
      holds.set(
        branch,
        `worktree: ${path} holds ignored files (${listed(ignored.files, ignored.truncated)})`,
      );
    } else {
      plan.worktrees.push({ path, branch, why: removalWhy(proof, ignored) });
    }
  }

  for (const { path, branch } of categories.stale_worktrees) {
    if (isAgent(path)) plan.staleWorktrees.push({ path, branch, why: "directory gone" });
    else if (branch !== null) holds.set(branch, `stale worktree: ${path} is not an agent worktree`);
  }

  const proven = [
    ...categories.merged_local,
    ...categories.orphaned_worktree,
    ...categories.content_merged,
  ];

  for (const branch of categories.backup) {
    if (branch.proof === "ancestry") {
      proven.push(branch);
    } else {
      plan.blocked.push({
        name: branch.name,
        reason: `backup: ${branch.proof}; only a backup contained by ancestry goes unasked`,
      });
    }
  }

  for (const { name, oid, d_refusal, proof } of proven) {
    const hold = holds.get(name);

    if (hold === undefined)
      plan.deletions.push({ name, oid, force: d_refusal !== null, why: proof });
    else plan.blocked.push({ name, reason: hold });
  }

  return plan;
}

type PullState = "OPEN" | "CLOSED" | "MERGED";

export type Pull = { number: number; state: PullState; closedAt: Date | null };

export type PullLookup = { kind: "found"; pulls: Pull[] } | { kind: "unknown"; reason: string };

type Verdict = { archive: boolean; why: string };

const daysSince = (date: Date, now: Date): number =>
  Math.floor((now.getTime() - date.getTime()) / DAY_MS);

type Closing = { number: number; closedAt: Date };

export function judgeUnproven(lastCommit: Date, lookup: PullLookup, now: Date): Verdict {
  if (lookup.kind === "unknown") {
    return { archive: false, why: `pull requests unknown: ${lookup.reason}` };
  }

  const idle = daysSince(lastCommit, now);
  const open = lookup.pulls.find((pull) => pull.state === "OPEN");

  if (open !== undefined) return { archive: false, why: `PR #${open.number} is open` };
  const merged = lookup.pulls.find((pull) => pull.state === "MERGED");

  if (merged !== undefined) {
    return { archive: false, why: `PR #${merged.number} merged, the branch still unproven` };
  }

  const closings = lookup.pulls.flatMap(({ number, closedAt }): Closing[] =>
    closedAt === null ? [] : [{ number, closedAt }],
  );

  if (closings.length < lookup.pulls.length) {
    return { archive: false, why: "a closed PR carries no closing date" };
  }

  const last = closings.reduce<Closing | null>(
    (latest, closing) =>
      latest === null || closing.closedAt.getTime() > latest.closedAt.getTime() ? closing : latest,
    null,
  );

  if (last !== null) {
    const closed = daysSince(last.closedAt, now);
    const archive = closed >= CLOSED_PR_GRACE_DAYS && idle >= CLOSED_PR_GRACE_DAYS;
    const wait = archive ? "" : `; archived once both pass ${CLOSED_PR_GRACE_DAYS} days`;

    return {
      archive,
      why: `PR #${last.number} closed unmerged ${closed} day(s) ago, last commit ${idle} day(s) ago${wait}`,
    };
  }

  const archive = idle >= NO_PR_IDLE_DAYS;
  const wait = archive ? "" : `; archived after ${NO_PR_IDLE_DAYS} days`;

  return { archive, why: `no PR, last commit ${idle} day(s) ago${wait}` };
}

const PULL_JQ = String.raw`.[] | "\(.number) \(.state) \(.closedAt // "-") \(.headRefName)"`;

const PULL_LINE = /^(\d+) (OPEN|CLOSED|MERGED) (\S+) (\S+)$/u;

const isPullState = (state: string): state is PullState =>
  state === "OPEN" || state === "CLOSED" || state === "MERGED";

// `gh pr list --head` also matches a fork's branch of the same name.
export function parsePullLines(text: string, branch: string): Pull[] | null {
  const pulls: Pull[] = [];

  for (const line of text.split("\n").filter(Boolean)) {
    const [, number = "", state = "", closed = "", head = ""] = PULL_LINE.exec(line) ?? [];
    const closedAt = closed === "-" ? null : new Date(closed);

    if (!isPullState(state) || (closedAt !== null && Number.isNaN(closedAt.getTime()))) {
      return null;
    }

    if (head === branch) pulls.push({ number: Number(number), state, closedAt });
  }

  return pulls;
}

type PullFinder = (branch: string) => Promise<PullLookup>;

// No origin, no pull request anywhere; an origin gh cannot read leaves every
// branch unknown, which never archives.
async function pullFinder(): Promise<PullFinder> {
  if ((await git("remote", "get-url", "origin")).exitCode !== 0) {
    return () => Promise.resolve({ kind: "found", pulls: [] });
  }

  const repo = await githubRepo();

  if (repo === null) {
    return () => Promise.resolve({ kind: "unknown", reason: "gh cannot read origin's repository" });
  }

  return async (branch) => {
    const response = await gh(
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      "number,state,closedAt,headRefName",
      "--jq",
      PULL_JQ,
    );

    if (response.exitCode !== 0) return { kind: "unknown", reason: "gh pr list failed" };
    const pulls = parsePullLines(response.stdout, branch);

    return pulls === null
      ? { kind: "unknown", reason: "gh pr list printed a line it should not" }
      : { kind: "found", pulls };
  };
}

type Holder =
  | { kind: "none" }
  | { kind: "agent"; path: string; stale: boolean }
  | { kind: "blocked"; why: string }
  | { kind: "other" };

const branchOf = (head: WorktreeHead | MainWorktree["head"]): string | null =>
  head.kind === "branch" || head.kind === "unborn" ? head.branch : null;

async function holderOf(
  branch: string,
  list: WorktreeList,
  isAgent: (path: string) => boolean,
  context: TriageContext,
): Promise<Holder> {
  if (branchOf(list.main.head) === branch) return { kind: "other" };
  const holders = list.linked.filter((worktree) => branchOf(worktree.head) === branch);
  const [holder] = holders;

  if (holder === undefined) return { kind: "none" };

  if (holders.length > 1 || !isAgent(holder.path)) return { kind: "other" };
  const triage = triageWorktree(holder, context);

  if (triage.kind === "stale") return { kind: "agent", path: holder.path, stale: true };

  if (triage.kind !== "inspect") return { kind: "other" };
  const verdict = await inspectWorktree(triage.path, triage.branch);

  if (verdict.kind === "held") {
    return { kind: "blocked", why: `${verdict.hold.reason}: ${verdict.hold.detail}` };
  }

  if (verdict.kind !== "candidate") return { kind: "other" };
  const { ignored } = verdict.candidate;

  return ignored.files.length > 0
    ? {
        kind: "blocked",
        why: `its worktree holds ignored files (${listed(ignored.files, ignored.truncated)})`,
      }
    : { kind: "agent", path: holder.path, stale: false };
}

const ARCHIVABLE: ReadonlySet<string> = new Set(["unproven", "too-old", "worktree"]);

type Candidate = { name: string; worktree: Archival["worktree"] };

async function planSweep(audited: AuditSuccess, now: Date): Promise<Plan> {
  const list = parseWorktreeList(await gitRead("worktree", "list", "--porcelain"));

  if ("error" in list) throw new Error(list.error);
  const config = await readSweepConfig();

  if ("error" in config) throw new Error(config.error);
  const isAgent = (path: string): boolean => isAgentWorktree(path, list.main.path);
  const running = runningAgentBranches(list, isAgent);
  const { blocked, ...proven } = planProven(audited, isAgent, running);
  const toplevel = await git("rev-parse", "--show-toplevel");

  const context: TriageContext = {
    currentWorktree: toplevel.exitCode === 0 ? toplevel.stdout : null,
    protectedBranches: buildProtectedSet(audited.base, await originHeadTarget(), config),
    directoryExists: existsSync,
  };

  let finder: Promise<PullFinder> | null = null;
  const archivals: Archival[] = [];
  const kept: KeptLine[] = [];

  const judge = async ({ name, worktree }: Candidate, line: string): Promise<void> => {
    const [oid, date] = (
      await gitRead("log", "-1", "--format=%H%x00%cI", `refs/heads/${name}`)
    ).split("\0");

    if (oid === undefined || date === undefined) throw new Error(`no commit on ${name}`);
    finder ??= pullFinder();
    const verdict = judgeUnproven(new Date(date), await (await finder)(name), now);

    if (verdict.archive) archivals.push({ name, oid, worktree, why: verdict.why });
    else kept.push({ name, reason: `${line}; ${verdict.why}` });
  };

  for (const entry of audited.kept) {
    const line = describeKept(entry, list.main.path);
    const { name } = entry;

    if (!ARCHIVABLE.has(entry.reason) || context.protectedBranches.has(name)) {
      kept.push({ name, reason: line });
      continue;
    }

    const runs = running.get(name);

    if (runs !== undefined) {
      kept.push({ name, reason: `${line}; ${runs}` });
      continue;
    }

    const holder = await holderOf(name, list, isAgent, context);

    if (holder.kind === "agent") {
      await judge({ name, worktree: { path: holder.path, stale: holder.stale } }, line);
    } else if (holder.kind === "none" && name.startsWith(config.agentPrefix)) {
      await judge({ name, worktree: null }, line);
    } else if (holder.kind === "blocked") {
      kept.push({ name, reason: `${line}; not archived: ${holder.why}` });
    } else {
      kept.push({ name, reason: line });
    }
  }

  return {
    base: audited.base,
    mainWorktree: list.main.path,
    ...proven,
    archivals,
    kept: [...kept, ...blocked],
  };
}

type Failure = { target: string; error: string };

type Outcome = { done: ReadonlySet<string>; failures: Failure[] };

const opKey = (type: "worktree-remove" | "branch-delete", target: string): string =>
  `${type} ${target}`;

async function archiveRef(
  name: string,
  oid: string,
): Promise<{ wrote: boolean } | { error: string }> {
  const ref = `${ARCHIVE_REFS}${name}`;
  const existing = await git("rev-parse", "--verify", "--quiet", ref);

  if (existing.exitCode === 0) {
    return existing.stdout === oid
      ? { wrote: false }
      : { error: `${ref} already holds ${existing.stdout.slice(0, 8)}` };
  }

  const created = await git("update-ref", ref, oid, "");

  return created.exitCode === 0 ? { wrote: true } : { error: created.stderr };
}

// Each branch is archived before git-clean-apply deletes it, and the archive
// is dropped again when the deletion fails, so refs/archive/ lists only what
// is gone.
async function apply(plan: Plan): Promise<Outcome> {
  const failures: Failure[] = [];
  const archived: Archival[] = [];
  const written = new Set<string>();

  for (const entry of plan.archivals) {
    const result = await archiveRef(entry.name, entry.oid);

    if ("error" in result) {
      failures.push({ target: `archive ${entry.name}`, error: result.error });
      continue;
    }

    if (result.wrote) written.add(entry.name);
    archived.push(entry);
  }

  const archivedWorktrees = (stale: boolean): string[] =>
    archived.flatMap(({ worktree }) => (worktree?.stale === stale ? [worktree.path] : []));

  const manifest = parseManifest({
    base: plan.base,
    worktrees: [...plan.worktrees.map(({ path }) => path), ...archivedWorktrees(false)],
    stale_worktrees: [...plan.staleWorktrees.map(({ path }) => path), ...archivedWorktrees(true)],
    branches: [
      ...plan.deletions.map(({ name, oid, force }) => ({ name, oid, force })),
      ...archived.map(({ name, oid }) => ({ name, oid, force: true })),
    ],
    remote_branches: [],
    prune_remotes: false,
  });

  if ("error" in manifest)
    throw new Error(`auto-sweep built an invalid manifest: ${manifest.error}`);
  const { result } = await execute(manifest);
  const done = new Set<string>();

  for (const { type, target, success, error } of result.operations) {
    if (success) done.add(`${type} ${target}`);
    else failures.push({ target: `${type} ${target}`, error: error ?? "failed" });
  }

  for (const { name, oid } of archived) {
    if (done.has(opKey("branch-delete", name)) || !written.has(name)) continue;
    const dropped = await git("update-ref", "-d", `${ARCHIVE_REFS}${name}`, oid);

    if (dropped.exitCode !== 0) {
      failures.push({ target: `archive ${name}`, error: `left in place: ${dropped.stderr}` });
    }
  }

  return { done, failures };
}

// outcome null is a dry run: every planned operation is shown as it would go.
function render(plan: Plan, outcome: Outcome | null, archiveCount: number): string {
  const ran = (key: string): boolean => outcome === null || outcome.done.has(key);
  const verb = (done: string, would: string): string => (outcome === null ? would : done);

  const lines = [
    `auto-sweep against ${plan.base}${outcome === null ? ", dry run: nothing changed" : ""}`,
  ];

  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(
      `${title} (${items.length}):`,
      ...items.map((item) => `  ${relativeTo(item, plan.mainWorktree)}`),
    );
  };

  section(
    verb("Deleted branches", "Would delete branches"),
    plan.deletions.flatMap(({ name, why }) =>
      ran(opKey("branch-delete", name)) ? [`${name} (${why})`] : [],
    ),
  );

  section(
    verb("Removed agent worktrees", "Would remove agent worktrees"),
    [...plan.worktrees, ...plan.staleWorktrees].flatMap(({ path, branch, why }) =>
      ran(opKey("worktree-remove", path))
        ? [`${path}${branch === null ? "" : ` on ${branch}`} (${why})`]
        : [],
    ),
  );

  section(
    verb(
      "Archived branches, restore one with `git branch <name> refs/archive/<name>`",
      "Would archive branches",
    ),
    plan.archivals.flatMap(({ name, oid, worktree, why }) =>
      ran(opKey("branch-delete", name))
        ? [
            `${name} -> ${ARCHIVE_REFS}${name} at ${oid.slice(0, 8)} (${why})${worktree === null ? "" : `, worktree ${worktree.path}`}`,
          ]
        : [],
    ),
  );

  section(
    "Kept",
    plan.kept.map(({ name, reason }) => `${name}: ${reason}`),
  );

  section(
    "Failed",
    (outcome?.failures ?? []).map(({ target, error }) => `${target}: ${error}`),
  );

  if (archiveCount > 0) {
    lines.push(`${ARCHIVE_REFS} holds ${archiveCount} ref(s): git for-each-ref ${ARCHIVE_REFS}`);
  }

  return lines.join("\n");
}

type Args = { base: string | null; dryRun: boolean };

function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { base: null, dryRun: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--base") {
      const value = argv[++i];

      if (value === undefined) return { error: "missing value for --base" };
      args.base = value;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }

  return args;
}

// A dev trunk is where agents land; sweep.base, when set, wins over it, and
// without either the audit resolves origin/HEAD, then main, master, trunk.
async function chooseBase(named: string | null): Promise<string | null> {
  if (named !== null) return named;

  if ((await git("config", "--get", "sweep.base")).exitCode === 0) return null;

  for (const name of DEV_TRUNKS) {
    if (await localBranchExists(name)) return name;
  }

  return null;
}

async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));

  if ("error" in args) {
    console.error(`auto-sweep: ${args.error}`);

    return 2;
  }

  const audited = await audit(
    { base: await chooseBase(args.base), includeRemote: false, githubProofs: true, maxAge: null },
    () => {},
  );

  if (!audited.ok) {
    console.error(`auto-sweep: the audit failed (${audited.step}): ${audited.error}`);

    return 1;
  }

  const plan = await planSweep(audited, new Date());
  const outcome = args.dryRun ? null : await apply(plan);

  console.log(render(plan, outcome, (await listRefs(ARCHIVE_REFS)).length));

  return outcome !== null && outcome.failures.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    console.error(`auto-sweep: ${error.message}`);
    process.exit(1);
  }
}
