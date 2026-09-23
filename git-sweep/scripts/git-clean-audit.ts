#!/usr/bin/env bun

// git-clean-audit — Scan git branches and worktrees for cleanup candidates.
// Emits structured JSON for the git-sweep skill (audit phase, feeding git-clean-apply).

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";

import {
  type Kept,
  type Placement,
  settleLocal,
  settleRemote,
  tooOld,
  triageLocal,
  triageRemote,
} from "./classify.ts";
import { git, GitError, gitRead, listRefs, localRef, type Ref, remoteRef } from "./git.ts";
import { parseManifest } from "./manifest.ts";
import {
  type GithubProver,
  makeGithubProver,
  predictDashDRefusal,
  type ProofKind,
  type Proven,
  proveContained,
} from "./proofs.ts";
import {
  buildProtectedSet,
  localBranchExists,
  originHeadTarget,
  POSITIVE_INT,
  readSweepConfig,
  resolveBase,
  type SweepConfig,
} from "./sweep-config.ts";
import {
  type BranchHold,
  type KeptWorktree,
  type LinkedWorktree,
  parseWorktreeList,
  type StaleWorktree,
  type Triage,
  type TriageContext,
  triageWorktree,
} from "./worktrees.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BranchMeta = {
  name: string;
  oid: string;
  ahead: number;
  behind: number;
  // Committer date: a rebase or an amend is activity, which an author date
  // carried over from an older commit would hide from the age gate.
  last_commit_date: string;
  last_commit_subject: string;
  // What `git branch -d` measures against (upstream, else HEAD) when it would
  // refuse the deletion. null when `-d` is expected to succeed.
  d_refusal: string | null;
};

type BranchInfo = BranchMeta & { proof: ProofKind };

// A live, clean worktree whose branch is already contained in the base: the
// worktree is the only thing keeping that branch alive.
type RemovableWorktree = {
  path: string;
  branch: string;
  proof: Proven;
  // Files git never tracked, which removing the worktree destroys for good.
  // Directories are listed apart: they are usually regenerable build output,
  // while a loose ignored file is more often a per-worktree secret or note.
  ignored: { files: string[]; dirs: string[]; truncated: boolean };
};

type RemoteMeta = {
  name: string;
  oid: string;
  last_commit_date: string;
  last_commit_subject: string;
};

type RemoteBranchInfo = RemoteMeta & { proof: Proven };

type KeptBranch = { name: string } & Kept;

type AuditSuccess = {
  ok: true;
  base: string;
  remote_base: string | null;
  categories: {
    merged_local: BranchInfo[];
    orphaned_worktree: BranchInfo[];
    content_merged: BranchInfo[];
    backup: BranchInfo[];
    stale_worktrees: StaleWorktree[];
    removable_worktrees: RemovableWorktree[];
    stale_remote: RemoteBranchInfo[];
    stale_tracking: string[];
  };
  kept: KeptBranch[];
  kept_worktrees: KeptWorktree[];
  kept_remote: KeptBranch[];
};

type AuditStep = "validate" | "scan-local" | "scan-worktrees" | "scan-remote" | "internal";

type AuditError = { ok: false; error: string; step: AuditStep };

type AuditResult = AuditSuccess | AuditError;

type SaveResult = { ok: true; path: string } | { ok: false; error: string };

// `git merge-tree --write-tree` is the containment proof; it landed in 2.38.
const MIN_GIT = [2, 38] as const;

async function gitVersionAtLeast(): Promise<{ ok: boolean; found: string }> {
  const raw = (await git("--version")).stdout;
  const match = raw.match(/(\d+)\.(\d+)/u);

  if (!match) return { ok: false, found: raw || "unknown" };
  const [major, minor] = [parseInt(match[1]!, 10), parseInt(match[2]!, 10)];
  const ok = major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);

  return { ok, found: `${major}.${minor}` };
}

// ---------------------------------------------------------------------------
// Branch metadata
// ---------------------------------------------------------------------------

function count(raw: string): number {
  if (!/^\d+$/u.test(raw)) throw new Error(`expected a commit count, got '${raw}'`);

  return parseInt(raw, 10);
}

async function lastCommit(ref: Ref): Promise<{ date: string; subject: string }> {
  const [date, subject] = (await gitRead("log", "-1", "--format=%cI%x00%s", ref)).split("\0");

  if (date === undefined || subject === undefined) throw new Error(`no commit on ${ref}`);

  return { date, subject };
}

async function branchMeta(branch: string, base: Ref): Promise<BranchMeta> {
  const ref = localRef(branch);

  const [oid, ahead, behind, last, dRefusal] = await Promise.all([
    gitRead("rev-parse", ref),
    gitRead("rev-list", "--count", `${base}..${ref}`),
    gitRead("rev-list", "--count", `${ref}..${base}`),
    lastCommit(ref),
    predictDashDRefusal(branch),
  ]);

  return {
    name: branch,
    oid,
    ahead: count(ahead),
    behind: count(behind),
    last_commit_date: last.date,
    last_commit_subject: last.subject,
    d_refusal: dRefusal,
  };
}

async function remoteMeta(remoteBranch: string): Promise<RemoteMeta> {
  const ref = remoteRef(remoteBranch);
  const [oid, last] = await Promise.all([gitRead("rev-parse", ref), lastCommit(ref)]);

  return {
    name: remoteBranch,
    oid,
    last_commit_date: last.date,
    last_commit_subject: last.subject,
  };
}

// ---------------------------------------------------------------------------
// Worktree scanning
// ---------------------------------------------------------------------------

const IGNORED_LIST_CAP = 10;

type WorktreeScan = {
  stale: StaleWorktree[];
  removable: RemovableWorktree[];
  kept: KeptWorktree[];
  // Branches held by a worktree we are NOT proposing to touch, with the reason.
  retained: Map<string, BranchHold>;
};

type WorktreeVerdict =
  | Exclude<Triage, { kind: "inspect" }>
  | { kind: "removable"; worktree: RemovableWorktree };

// A live, clean worktree on a branch is removable once that branch is proven
// contained; anything else keeps it, and so its branch.
async function inspectWorktree(
  path: string,
  branch: string,
  base: Ref,
  github: GithubProver | null,
): Promise<WorktreeVerdict> {
  const held = (reason: BranchHold["reason"], detail: string): WorktreeVerdict => ({
    kind: "held",
    hold: { name: branch, reason, detail },
  });

  // --ignored so the scan also sees what `git worktree remove` would delete
  // without a word: ignored files are untracked, so neither the porcelain
  // status nor git's own refusal counts them as work worth protecting.
  const status = await git("-C", path, "status", "--porcelain", "--ignored");

  if (status.exitCode !== 0) return held("worktree", `${path} (status unreadable)`);

  const lines = status.stdout.split("\n").filter(Boolean);

  if (lines.some((line) => !line.startsWith("!!"))) return held("dirty-worktree", path);

  const proof = await proveContained(localRef(branch), base, github);

  if (proof === "unproven") return held("worktree", path);

  const ignoredPaths = lines.map((line) => line.slice(3));
  const files = ignoredPaths.filter((p) => !p.endsWith("/"));
  const dirs = ignoredPaths.filter((p) => p.endsWith("/"));

  return {
    kind: "removable",
    worktree: {
      path,
      branch,
      proof,
      ignored: {
        files: files.slice(0, IGNORED_LIST_CAP),
        dirs: dirs.slice(0, IGNORED_LIST_CAP),
        truncated: files.length > IGNORED_LIST_CAP || dirs.length > IGNORED_LIST_CAP,
      },
    },
  };
}

// A branch is only reported as retained when its worktree survives the sweep —
// otherwise it must flow into normal branch classification so the branch and
// its worktree are cleaned in the same pass.
async function scanWorktrees(
  worktrees: LinkedWorktree[],
  context: TriageContext,
  base: Ref,
  github: GithubProver | null,
): Promise<WorktreeScan> {
  const scan: WorktreeScan = { stale: [], removable: [], kept: [], retained: new Map() };

  for (const worktree of worktrees) {
    const triage = triageWorktree(worktree, context);

    const verdict =
      triage.kind === "inspect"
        ? await inspectWorktree(triage.path, triage.branch, base, github)
        : triage;

    switch (verdict.kind) {
      case "stale":
        scan.stale.push(verdict.worktree);
        break;
      case "removable":
        scan.removable.push(verdict.worktree);
        break;
      case "kept":
        scan.kept.push(verdict.worktree);

        if (verdict.hold !== null) scan.retained.set(verdict.hold.name, verdict.hold);
        break;
      case "held":
        scan.retained.set(verdict.hold.name, verdict.hold);
        break;
      case "skipped":
        break;
      default: {
        const unreachable: never = verdict;
        throw new Error(`unhandled worktree verdict: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return scan;
}

// ---------------------------------------------------------------------------
// Local branch scanning
// ---------------------------------------------------------------------------

type LocalScan = {
  merged_local: BranchInfo[];
  orphaned_worktree: BranchInfo[];
  content_merged: BranchInfo[];
  backup: BranchInfo[];
  kept: KeptBranch[];
};

type ScanInput = {
  base: string;
  protectedBranches: ReadonlySet<string>;
  maxAgeDays: number;
  github: GithubProver | null;
  now: Date;
};

async function scanLocal(
  input: ScanInput & {
    currentBranch: string;
    held: ReadonlyMap<string, BranchHold>;
    config: SweepConfig;
  },
): Promise<LocalScan> {
  const { base, currentBranch, maxAgeDays, github, now } = input;
  const baseRef = localRef(base);

  const scan: LocalScan = {
    merged_local: [],
    orphaned_worktree: [],
    content_merged: [],
    backup: [],
    kept: [{ name: base, reason: "base", detail: null }],
  };

  if (currentBranch !== "" && currentBranch !== base) {
    scan.kept.push({ name: currentBranch, reason: "current", detail: null });
  }

  const context = {
    held: input.held,
    protectedBranches: input.protectedBranches,
    merged: new Set(await listRefs("refs/heads/", `--merged=${baseRef}`)),
    agentPrefix: input.config.agentPrefix,
    backupPrefix: input.config.backupPrefix,
  };

  const place = async (branch: string, placement: Placement, known?: BranchMeta) => {
    if (placement.kind === "kept") {
      scan.kept.push({ name: branch, ...placement.kept });

      return;
    }

    const meta = known ?? (await branchMeta(branch, baseRef));
    scan[placement.kind].push({ ...meta, proof: placement.proof });
  };

  for (const branch of await listRefs("refs/heads/")) {
    if (branch === base || branch === currentBranch) continue;
    const triage = triageLocal(branch, context);

    if (triage.kind === "placed") {
      await place(branch, triage.placement);
      continue;
    }

    const meta = await branchMeta(branch, baseRef);

    if (triage.route === "content") {
      const old = tooOld({ lastCommit: new Date(meta.last_commit_date), maxAgeDays, now });

      if (old !== null) {
        await place(branch, { kind: "kept", kept: old });
        continue;
      }
    }

    const proof = await proveContained(localRef(branch), baseRef, github);
    const unproven = `${meta.ahead} commit(s) not proven to be in ${base}`;
    await place(branch, settleLocal(triage.route, proof, unproven), meta);
  }

  return scan;
}

// ---------------------------------------------------------------------------
// Remote branch scanning (origin only, non-destructive)
// ---------------------------------------------------------------------------

type RemoteScan = {
  stale_remote: RemoteBranchInfo[];
  kept_remote: KeptBranch[];
  stale_tracking: string[];
  remote_base: string | null;
};

async function scanRemote(input: ScanInput): Promise<RemoteScan> {
  const { base, protectedBranches, maxAgeDays, github, now } = input;

  const scan: RemoteScan = {
    stale_remote: [],
    kept_remote: [],
    stale_tracking: [],
    remote_base: null,
  };

  // Origin-presence gate: no origin -> fully local, no network, refs intact.
  if ((await git("remote", "get-url", "origin")).exitCode !== 0) return scan;

  // Non-destructive refresh: update remote-tracking refs WITHOUT pruning
  // (pruning stays a confirmed apply op) and without clobbering FETCH_HEAD.
  // Fail-closed: never proceed on stale remote data when offline.
  await gitRead("fetch", "--no-prune", "--no-write-fetch-head", "origin");

  // Stale tracking refs: refs whose upstream is gone. With --no-prune above,
  // `remote prune --dry-run` reports them honestly (populating stale_tracking
  // so apply can prune them under confirmation). Read before the remote scan:
  // a ref the upstream no longer has must never be proposed for deletion on
  // that upstream, which fails with `remote ref does not exist`.
  scan.stale_tracking = (await gitRead("remote", "prune", "origin", "--dry-run"))
    .split("\n")
    .filter((line) => line.includes("would prune"))
    .map((line) => line.replace(/^.*\[would prune\]\s*/u, "").trim())
    .filter(Boolean);

  const staleTracking = new Set(scan.stale_tracking);

  // Remote branches are judged against origin/<base>, never local <base>:
  // a local base that lags would under-report, and an unpushed local merge
  // must never justify deleting the only remote copy of a branch.
  const remoteBase = `origin/${base}`;
  const remoteBaseRef = remoteRef(remoteBase);

  if ((await git("rev-parse", "--verify", "--quiet", remoteBaseRef)).exitCode !== 0) return scan;
  scan.remote_base = remoteBase;

  const context = {
    protectedBranches,
    merged: new Set(await listRefs("refs/remotes/origin/", `--merged=${remoteBaseRef}`)),
  };

  for (const branch of await listRefs("refs/remotes/origin/")) {
    const remoteBranch = `origin/${branch}`;

    if (branch === "HEAD" || branch === base || staleTracking.has(remoteBranch)) continue;
    const triage = triageRemote(branch, context);

    if (triage.kind === "kept") {
      scan.kept_remote.push({ name: remoteBranch, ...triage.kept });
      continue;
    }

    const meta = await remoteMeta(remoteBranch);

    if (triage.kind === "stale") {
      scan.stale_remote.push({ ...meta, proof: triage.proof });
      continue;
    }

    const old = tooOld({ lastCommit: new Date(meta.last_commit_date), maxAgeDays, now });

    if (old !== null) {
      scan.kept_remote.push({ name: remoteBranch, ...old });
      continue;
    }

    const proof = await proveContained(remoteRef(remoteBranch), remoteBaseRef, github);
    const placement = settleRemote(proof, remoteBase);

    if (placement.kind === "kept") scan.kept_remote.push({ name: remoteBranch, ...placement.kept });
    else scan.stale_remote.push({ ...meta, proof: placement.proof });
  }

  return scan;
}

// ---------------------------------------------------------------------------
// Manifest hand-off (durable audit -> apply)
// ---------------------------------------------------------------------------

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- the block below IS the boundary parser the rules ask for: it reads the {manifest, kept} envelope from stdin, the manifest through parseManifest, before anything is written. Their fix (parse before calling) has no earlier place to happen. */

const isKeptBranch = (k: unknown): boolean =>
  typeof k === "object" &&
  k !== null &&
  typeof (k as { name?: unknown }).name === "string" &&
  typeof (k as { reason?: unknown }).reason === "string";

// Persist {manifest, kept} (read from stdin) to a fixed repo-scoped file so the
// hand-off to the apply phase survives context compaction. Atomic: tmp + rename.
async function saveManifest(): Promise<SaveResult> {
  const raw = await Bun.stdin.text();
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON on stdin" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "expected a {manifest, kept} object on stdin" };
  }

  const { manifest: rawManifest, kept } = parsed as { manifest?: unknown; kept?: unknown };
  const manifest = parseManifest(rawManifest);

  if ("error" in manifest) {
    return { ok: false, error: `invalid manifest: ${manifest.error}` };
  }

  if (!Array.isArray(kept) || !kept.every((k) => isKeptBranch(k))) {
    return { ok: false, error: "invalid kept list (expected {name, reason}[])" };
  }

  /* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion */

  const gitDir = await git("rev-parse", "--absolute-git-dir");

  if (gitDir.exitCode !== 0) {
    return { ok: false, error: `git rev-parse --absolute-git-dir failed: ${gitDir.stderr}` };
  }

  const path = join(gitDir.stdout, "git-sweep-manifest.json");
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify({ manifest, kept }, null, 2));
  await rename(tmp, path);

  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type AuditArgs = { base: string | null; includeRemote: boolean; maxAge: number | null };

function parseArgs(args: string[]): AuditArgs | { error: string } {
  const parsed: AuditArgs = { base: null, includeRemote: false, maxAge: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--base": {
        const value = args[++i];

        if (value === undefined) return { error: "missing value for --base" };
        parsed.base = value;
        break;
      }

      case "--include-remote":
        parsed.includeRemote = true;
        break;
      case "--max-age": {
        const value = args[++i];

        if (value === undefined || !POSITIVE_INT.test(value)) {
          return { error: `invalid --max-age '${value ?? ""}' (expected a positive integer)` };
        }

        parsed.maxAge = parseInt(value, 10);
        break;
      }

      default:
        return { error: `unknown argument: ${args[i]}` };
    }
  }

  return parsed;
}

// An explicitly named base is the caller's decision: verified as a branch (a
// tag, an OID or HEAD would silently shift every containment proof), never
// substituted. So is a configured sweep.base.
async function chooseBase(
  baseArg: string | null,
  config: SweepConfig,
  originHead: string | null,
): Promise<{ base: string } | { error: string }> {
  if (config.base !== null && !(await localBranchExists(config.base))) {
    return { error: `configured sweep.base '${config.base}' not found` };
  }

  if (baseArg !== null) {
    return (await localBranchExists(baseArg))
      ? { base: baseArg }
      : { error: `base branch '${baseArg}' not found` };
  }

  const resolved = await resolveBase(config.base, originHead);

  return resolved === null
    ? { error: "no trunk branch found; pass --base <branch>" }
    : { base: resolved };
}

async function audit(args: AuditArgs, advance: (step: AuditStep) => void): Promise<AuditResult> {
  const config = await readSweepConfig();

  if ("error" in config) return { ok: false, error: config.error, step: "validate" };

  const maxAgeDays = args.maxAge ?? config.maxAgeDays;
  const originHead = await originHeadTarget();
  const chosen = await chooseBase(args.base, config, originHead);

  if ("error" in chosen) return { ok: false, error: chosen.error, step: "validate" };
  const { base } = chosen;
  const protectedBranches = buildProtectedSet(base, originHead, config);

  // Containment proofs rest on `git merge-tree --write-tree`; without it the
  // audit would silently under-report instead of proving anything.
  const version = await gitVersionAtLeast();

  if (!version.ok) {
    return {
      ok: false,
      error: `git ${MIN_GIT[0]}.${MIN_GIT[1]}+ required for merge-tree containment proofs (found ${version.found})`,
      step: "validate",
    };
  }

  // --include-remote is already the audit's network opt-in; the GitHub proof
  // rides on it rather than adding a second flag.
  const github = args.includeRemote ? makeGithubProver(base, maxAgeDays) : null;
  const scanInput: ScanInput = { base, protectedBranches, maxAgeDays, github, now: new Date() };

  advance("scan-worktrees");
  const currentBranch = await gitRead("branch", "--show-current");
  const currentWorktree = await gitRead("rev-parse", "--show-toplevel");
  const linkedWorktrees = parseWorktreeList(await gitRead("worktree", "list", "--porcelain"));

  if ("error" in linkedWorktrees) {
    return { ok: false, error: linkedWorktrees.error, step: "scan-worktrees" };
  }

  const worktrees = await scanWorktrees(
    linkedWorktrees,
    { currentWorktree, protectedBranches, directoryExists: existsSync },
    localRef(base),
    github,
  );

  advance("scan-local");
  const local = await scanLocal({ ...scanInput, currentBranch, held: worktrees.retained, config });

  advance("scan-remote");

  const remote: RemoteScan = args.includeRemote
    ? await scanRemote(scanInput)
    : { stale_remote: [], kept_remote: [], stale_tracking: [], remote_base: null };

  return {
    ok: true,
    base,
    remote_base: remote.remote_base,
    categories: {
      merged_local: local.merged_local,
      orphaned_worktree: local.orphaned_worktree,
      content_merged: local.content_merged,
      backup: local.backup,
      stale_worktrees: worktrees.stale,
      removable_worktrees: worktrees.removable,
      stale_remote: remote.stale_remote,
      stale_tracking: remote.stale_tracking,
    },
    kept: local.kept,
    kept_worktrees: worktrees.kept,
    kept_remote: remote.kept_remote,
  };
}

async function main(): Promise<AuditResult | SaveResult> {
  const argv = Bun.argv.slice(2);

  // Save-manifest mode: durable hand-off writer, not a scan.
  if (argv.includes("--save-manifest")) return saveManifest();

  const args = parseArgs(argv);

  if ("error" in args) return { ok: false, error: args.error, step: "validate" };

  // A git command that must succeed and does not is reported against the
  // phase it broke; anything else is a bug, and still one valid AuditError.
  let step: AuditStep = "validate";

  try {
    return await audit(args, (next) => {
      step = next;
    });
  } catch (err) {
    if (err instanceof GitError) return { ok: false, error: err.message, step };

    return {
      ok: false,
      error: `internal error: ${err instanceof Error ? err.message : String(err)}`,
      step: "internal",
    };
  }
}

if (import.meta.main) {
  const result = await main();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
