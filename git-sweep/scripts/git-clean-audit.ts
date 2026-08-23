#!/usr/bin/env bun

// git-clean-audit — Scan git branches and worktrees for cleanup candidates.
// Emits structured JSON for the git-sweep skill (audit phase, feeding git-clean-apply).

import { $ } from "bun";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// How strongly we can prove a branch's content is already in the base:
//   ancestry       — the tip is reachable from base. Nothing is lost, history included.
//   no-merge-delta — merging it into base would change no file. Content is safe;
//                    the intermediate commits are not (squash/rebase/cherry-pick).
//   unproven       — the test did not conclude. NOT a proof of absence.
type ProofKind = "ancestry" | "no-merge-delta" | "unproven";

type BranchInfo = {
  name: string;
  oid: string;
  ahead: number;
  behind: number;
  last_commit_date: string;
  last_commit_subject: string;
  proof: ProofKind;
  // Ref that `git branch -d` measures against (upstream, else HEAD) when it
  // would refuse the deletion. null when `-d` is expected to succeed.
  d_refusal: string | null;
};

type WorktreeInfo = {
  path: string;
  branch: string | null;
  reason: "missing-dir" | "broken-ref";
};

// A live, clean worktree whose branch is already contained in the base: the
// worktree is the only thing keeping that branch alive.
type RemovableWorktree = {
  path: string;
  branch: string;
  proof: ProofKind;
  // Files git never tracked, which removing the worktree destroys for good.
  // Directories are listed apart: they are usually regenerable build output,
  // while a loose ignored file is more often a per-worktree secret or note.
  ignored: { files: string[]; dirs: string[]; truncated: boolean };
};

type RemoteBranchInfo = {
  name: string;
  oid: string;
  last_commit_date: string;
  last_commit_subject: string;
  proof: ProofKind;
};

type KeptBranch = {
  name: string;
  reason: "base" | "current" | "worktree" | "dirty-worktree" | "unproven" | "too-old" | "protected";
  detail: string | null;
};

type AuditSuccess = {
  ok: true;
  base: string;
  remote_base: string | null;
  categories: {
    merged_local: BranchInfo[];
    orphaned_worktree: BranchInfo[];
    content_merged: BranchInfo[];
    backup: BranchInfo[];
    stale_worktrees: WorktreeInfo[];
    removable_worktrees: RemovableWorktree[];
    stale_remote: RemoteBranchInfo[];
    stale_tracking: string[];
  };
  kept: KeptBranch[];
  kept_remote: KeptBranch[];
};

type AuditError = {
  ok: false;
  error: string;
  step: "validate" | "scan-local" | "scan-worktrees" | "scan-remote" | "internal";
};

type AuditResult = AuditSuccess | AuditError;

type CleanupManifest = {
  base: string;
  worktrees: string[];
  branches: { name: string; force: boolean; oid: string }[];
  remote_branches: { remote: string; ref: string; oid: string }[];
  prune_remotes: boolean;
  prune_worktrees: boolean;
};

type SaveResult = { ok: true; path: string } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.quiet().nothrow();
  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode };
}

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
// Configuration (git config sweep.*) and base resolution
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_PREFIX = "worktree-agent-";
const DEFAULT_BACKUP_PREFIX = "backup/";
const DEFAULT_MAX_AGE_DAYS = 180;
// Never proposed for deletion, local or remote, whatever the audit proves:
// a trunk being contained in the base is by design, not staleness.
const DEFAULT_PROTECTED = ["main", "master", "trunk", "dev", "develop"];

type SweepConfig = {
  base: string | null;
  protect: string[];
  agentPrefix: string;
  backupPrefix: string;
  maxAgeDays: number;
};

const POSITIVE_INT = /^[1-9]\d*$/u;

async function readSweepConfig(): Promise<SweepConfig | { error: string }> {
  const [base, protect, agentPrefix, backupPrefix, maxAge] = await Promise.all([
    git("config", "--get", "sweep.base"),
    git("config", "--get-all", "sweep.protect"),
    git("config", "--get", "sweep.agentPrefix"),
    git("config", "--get", "sweep.backupPrefix"),
    git("config", "--get", "sweep.maxAgeDays"),
  ]);

  let maxAgeDays = DEFAULT_MAX_AGE_DAYS;
  if (maxAge.exitCode === 0) {
    if (!POSITIVE_INT.test(maxAge.stdout)) {
      return {
        error: `invalid sweep.maxAgeDays '${maxAge.stdout}' (expected a positive integer)`,
      };
    }
    maxAgeDays = parseInt(maxAge.stdout, 10);
  }

  return {
    base: base.exitCode === 0 && base.stdout ? base.stdout : null,
    protect: protect.exitCode === 0 ? protect.stdout.split("\n").filter(Boolean) : [],
    agentPrefix:
      agentPrefix.exitCode === 0 && agentPrefix.stdout ? agentPrefix.stdout : DEFAULT_AGENT_PREFIX,
    backupPrefix:
      backupPrefix.exitCode === 0 && backupPrefix.stdout
        ? backupPrefix.stdout
        : DEFAULT_BACKUP_PREFIX,
    maxAgeDays,
  };
}

async function localBranchExists(name: string): Promise<boolean> {
  // refs/heads/ in full: the bare name would also match a tag.
  return (await git("rev-parse", "--verify", `refs/heads/${name}`)).exitCode === 0;
}

async function originHeadTarget(): Promise<string | null> {
  const head = await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  return head.exitCode === 0 && head.stdout.startsWith("origin/")
    ? head.stdout.slice("origin/".length)
    : null;
}

// origin/HEAD goes stale and can name a branch that no longer exists anywhere:
// every candidate must pass the existence check before it may become the base.
// Never falls back to HEAD — from a feature branch that would make the real
// trunk look deletable.
async function resolveBase(configBase: string | null, originHead: string | null) {
  const candidates = [configBase, originHead, "main", "master", "trunk"].filter(
    (c): c is string => c !== null,
  );
  for (const name of candidates) {
    if (await localBranchExists(name)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Branch metadata
// ---------------------------------------------------------------------------

async function getBranchInfo(name: string, base: string, proof: ProofKind): Promise<BranchInfo> {
  const [oidResult, aheadResult, behindResult, dateResult, subjectResult, dRefusal] =
    await Promise.all([
      git("rev-parse", name),
      git("rev-list", "--count", `${base}..${name}`),
      git("rev-list", "--count", `${name}..${base}`),
      git("log", "-1", "--format=%aI", name),
      git("log", "-1", "--format=%s", name),
      predictDashDRefusal(name),
    ]);

  return {
    name,
    oid: oidResult.stdout,
    ahead: parseInt(aheadResult.stdout, 10) || 0,
    behind: parseInt(behindResult.stdout, 10) || 0,
    last_commit_date: dateResult.stdout,
    last_commit_subject: subjectResult.stdout,
    proof,
    d_refusal: dRefusal,
  };
}

async function getRemoteBranchInfo(name: string, proof: ProofKind): Promise<RemoteBranchInfo> {
  const [oidResult, dateResult, subjectResult] = await Promise.all([
    git("rev-parse", name),
    git("log", "-1", "--format=%aI", name),
    git("log", "-1", "--format=%s", name),
  ]);

  return {
    name,
    oid: oidResult.stdout,
    last_commit_date: dateResult.stdout,
    last_commit_subject: subjectResult.stdout,
    proof,
  };
}

// ---------------------------------------------------------------------------
// Containment proofs
// ---------------------------------------------------------------------------

// Exit 0 = ancestor, 1 = not, anything else = error (treated as "not proven").
async function isAncestor(ref: string, of: string): Promise<boolean> {
  return (await git("merge-base", "--is-ancestor", ref, of)).exitCode === 0;
}

// Would merging `branch` into `base` change any file? Replaces the older
// commit-tree + `git cherry` patch-id test, which reported "contained" for a
// squash that was later reverted (patch-id only sees that the patch once
// landed, never that base still holds it).
async function hasNoMergeDelta(branch: string, base: string): Promise<boolean> {
  const merged = await git("merge-tree", "--write-tree", base, branch);
  // A conflict exits non-zero and still prints a tree — both checks are needed.
  if (merged.exitCode !== 0) return false;
  const baseTree = await git("rev-parse", `${base}^{tree}`);
  if (baseTree.exitCode !== 0) return false;
  return merged.stdout.split("\n")[0]?.trim() === baseTree.stdout;
}

async function proveContained(branch: string, base: string): Promise<ProofKind> {
  if (await isAncestor(branch, base)) return "ancestry";
  if (await hasNoMergeDelta(branch, base)) return "no-merge-delta";
  return "unproven";
}

// `git branch -d` refuses unless the tip is contained in the branch's upstream,
// or in HEAD when no upstream is set. A branch fully merged into the base still
// fails when its remote counterpart has diverged — the audit predicts that here
// so the operation can carry a justified force flag instead of failing at apply.
async function predictDashDRefusal(branch: string): Promise<string | null> {
  const upstream = await git(
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  );
  const target = upstream.exitCode === 0 && upstream.stdout ? upstream.stdout : "HEAD";
  const check = await git("merge-base", "--is-ancestor", branch, target);
  // Only a definite "not an ancestor" (exit 1) predicts refusal; an error leaves
  // the safe flag in place and lets `-d` speak for itself.
  return check.exitCode === 1 ? target : null;
}

// ---------------------------------------------------------------------------
// Worktree scanning
// ---------------------------------------------------------------------------

type WorktreeEntry = {
  path: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
  is_main: boolean;
};

function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];

  porcelain
    .split("\n\n")
    .filter(Boolean)
    .forEach((block, index) => {
      let path = "";
      let branch: string | null = null;
      let locked = false;
      let prunable = false;

      for (const line of block.split("\n")) {
        // `locked` and `prunable` appear bare or followed by a reason.
        if (line.startsWith("worktree ")) path = line.slice(9);
        else if (line.startsWith("branch ")) branch = line.slice(7).replace("refs/heads/", "");
        else if (line === "locked" || line.startsWith("locked ")) locked = true;
        else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
      }

      // The first entry is always the main worktree, which is never a candidate.
      if (path) entries.push({ path, branch, locked, prunable, is_main: index === 0 });
    });

  return entries;
}

const IGNORED_LIST_CAP = 10;

type WorktreeScan = {
  stale: WorktreeInfo[];
  removable: RemovableWorktree[];
  // Branches held by a worktree we are NOT proposing to touch, with the reason.
  retained: Map<string, KeptBranch>;
};

// Splits worktrees three ways: broken (stale), live-but-releasable (removable),
// and live-and-kept. A branch is only reported as retained when its worktree
// survives the sweep — otherwise it must flow into normal branch classification
// so the branch and its worktree are cleaned in the same pass.
async function scanWorktrees(
  entries: WorktreeEntry[],
  base: string,
  currentWorktree: string,
  protectedBranches: Set<string>,
): Promise<WorktreeScan> {
  const stale: WorktreeInfo[] = [];
  const removable: RemovableWorktree[] = [];
  const retained = new Map<string, KeptBranch>();

  const keep = (branch: string, reason: KeptBranch["reason"], detail: string) =>
    retained.set(branch, { name: branch, reason, detail });

  for (const entry of entries) {
    if (entry.is_main) continue;

    if (entry.prunable || !existsSync(entry.path)) {
      stale.push({ path: entry.path, branch: entry.branch, reason: "missing-dir" });
      continue;
    }

    if (entry.locked) {
      const branchRef = entry.branch
        ? await git("rev-parse", "--verify", `refs/heads/${entry.branch}`)
        : { exitCode: 1 };
      if (branchRef.exitCode !== 0) {
        stale.push({ path: entry.path, branch: entry.branch, reason: "broken-ref" });
      } else if (entry.branch) {
        // A lock is an explicit "leave this alone".
        keep(entry.branch, "worktree", `${entry.path} (locked)`);
      }
      continue;
    }

    // Detached worktrees hold no branch: nothing to classify, nothing to free.
    if (!entry.branch) continue;

    if (entry.path === currentWorktree) {
      keep(entry.branch, "worktree", `${entry.path} (current worktree)`);
      continue;
    }

    if (entry.branch === base) {
      keep(entry.branch, "base", entry.path);
      continue;
    }

    if (protectedBranches.has(entry.branch)) {
      keep(entry.branch, "protected", entry.path);
      continue;
    }

    // --ignored so the scan also sees what `git worktree remove` would delete
    // without a word: ignored files are untracked, so neither the porcelain
    // status nor git's own refusal counts them as work worth protecting.
    const status = await git("-C", entry.path, "status", "--porcelain", "--ignored");
    if (status.exitCode !== 0) {
      keep(entry.branch, "worktree", `${entry.path} (status unreadable)`);
      continue;
    }

    const lines = status.stdout.split("\n").filter(Boolean);
    if (lines.some((line) => !line.startsWith("!!"))) {
      keep(entry.branch, "dirty-worktree", entry.path);
      continue;
    }

    const proof = await proveContained(entry.branch, base);
    if (proof === "unproven") {
      keep(entry.branch, "worktree", entry.path);
      continue;
    }

    const ignoredPaths = lines.map((line) => line.slice(3));
    const files = ignoredPaths.filter((p) => !p.endsWith("/"));
    const dirs = ignoredPaths.filter((p) => p.endsWith("/"));
    removable.push({
      path: entry.path,
      branch: entry.branch,
      proof,
      ignored: {
        files: files.slice(0, IGNORED_LIST_CAP),
        dirs: dirs.slice(0, IGNORED_LIST_CAP),
        truncated: files.length > IGNORED_LIST_CAP || dirs.length > IGNORED_LIST_CAP,
      },
    });
  }

  return { stale, removable, retained };
}

// ---------------------------------------------------------------------------
// Manifest hand-off (durable audit -> apply)
// ---------------------------------------------------------------------------

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser the rules ask for: it validates a manifest read from stdin before anything touches a branch. Their fix (parse before calling) has no earlier place to happen. */

const isOid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{7,64}$/u.test(v);

const isKeptBranch = (k: unknown): boolean =>
  typeof k === "object" &&
  k !== null &&
  typeof (k as { name?: unknown }).name === "string" &&
  typeof (k as { reason?: unknown }).reason === "string";

function isValidManifest(m: unknown): m is CleanupManifest {
  if (typeof m !== "object" || m === null) return false;
  const o = m as Record<string, unknown>;
  if (typeof o.base !== "string" || o.base === "") return false;
  if (!Array.isArray(o.worktrees) || !o.worktrees.every((w) => typeof w === "string")) return false;
  if (
    !Array.isArray(o.branches) ||
    !o.branches.every(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        typeof (b as { name?: unknown }).name === "string" &&
        typeof (b as { force?: unknown }).force === "boolean" &&
        isOid((b as { oid?: unknown }).oid),
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(o.remote_branches) ||
    !o.remote_branches.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as { remote?: unknown }).remote === "string" &&
        typeof (r as { ref?: unknown }).ref === "string" &&
        isOid((r as { oid?: unknown }).oid),
    )
  ) {
    return false;
  }
  if (typeof o.prune_remotes !== "boolean") return false;
  if (typeof o.prune_worktrees !== "boolean") return false;
  return true;
}

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
  const { manifest, kept } = parsed as { manifest?: unknown; kept?: unknown };
  if (!isValidManifest(manifest)) {
    return { ok: false, error: "invalid manifest shape" };
  }
  if (!Array.isArray(kept) || !kept.every((k) => isKeptBranch(k))) {
    return { ok: false, error: "invalid kept list (expected {name, reason}[])" };
  }

  /* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type */

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

async function main(): Promise<AuditResult | SaveResult> {
  const args = Bun.argv.slice(2);

  // Save-manifest mode: durable hand-off writer, not a scan.
  if (args.includes("--save-manifest")) {
    return saveManifest();
  }

  let baseArg: string | null = null;
  let includeRemote = false;
  let maxAgeArg: number | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--base": {
        const value = args[++i];
        if (value === undefined) {
          return { ok: false, error: "missing value for --base", step: "validate" };
        }
        baseArg = value;
        break;
      }
      case "--include-remote":
        includeRemote = true;
        break;
      case "--max-age": {
        const value = args[++i];
        if (value === undefined || !POSITIVE_INT.test(value)) {
          return {
            ok: false,
            error: `invalid --max-age '${value ?? ""}' (expected a positive integer)`,
            step: "validate",
          };
        }
        maxAgeArg = parseInt(value, 10);
        break;
      }
      default:
        return { ok: false, error: `unknown argument: ${args[i]}`, step: "validate" };
    }
  }

  const config = await readSweepConfig();
  if ("error" in config) {
    return { ok: false, error: config.error, step: "validate" };
  }
  const maxAgeDays = maxAgeArg ?? config.maxAgeDays;

  const originHead = await originHeadTarget();

  let base: string;
  if (baseArg === null) {
    const resolved = await resolveBase(config.base, originHead);
    if (resolved === null) {
      return { ok: false, error: "no trunk branch found; pass --base <branch>", step: "validate" };
    }
    base = resolved;
  } else {
    // An explicitly named base is the caller's decision: verified, never substituted.
    const baseCheck = await git("rev-parse", "--verify", baseArg);
    if (baseCheck.exitCode !== 0) {
      return { ok: false, error: `base branch '${baseArg}' not found`, step: "validate" };
    }
    base = baseArg;
  }

  const protectedBranches = new Set([
    base,
    ...(originHead === null ? [] : [originHead]),
    ...DEFAULT_PROTECTED,
    ...config.protect,
  ]);

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

  try {
    // Get current branch (to exclude from cleanup)
    const currentBranch = (await git("branch", "--show-current")).stdout;
    const currentWorktree = (await git("rev-parse", "--show-toplevel")).stdout;

    // Get worktree info for cross-referencing. A failure here is fatal (rather
    // than silently treating the tree as worktree-free).
    const worktreeList = await git("worktree", "list", "--porcelain");
    if (worktreeList.exitCode !== 0) {
      return {
        ok: false,
        error: `git worktree list failed: ${worktreeList.stderr}`,
        step: "scan-worktrees",
      };
    }

    const worktreeScan = await scanWorktrees(
      parseWorktrees(worktreeList.stdout),
      base,
      currentWorktree,
      protectedBranches,
    );
    const stale_worktrees = worktreeScan.stale;
    const removable_worktrees = worktreeScan.removable;

    // -------------------------------------------------------------------------
    // Scan local branches
    // -------------------------------------------------------------------------

    // Get merged branches (a failed listing is fatal, not an empty result)
    const mergedResult = await git("branch", "--merged", base, "--format=%(refname:short)");
    if (mergedResult.exitCode !== 0) {
      return {
        ok: false,
        error: `git branch --merged failed: ${mergedResult.stderr}`,
        step: "scan-local",
      };
    }
    const mergedSet = new Set(
      mergedResult.stdout
        .split("\n")
        .filter(Boolean)
        .filter((b) => b !== base && b !== currentBranch),
    );

    // Get all local branches
    const allBranchesResult = await git("branch", "--format=%(refname:short)");
    if (allBranchesResult.exitCode !== 0) {
      return {
        ok: false,
        error: `git branch failed: ${allBranchesResult.stderr}`,
        step: "scan-local",
      };
    }
    const allBranches = allBranchesResult.stdout.split("\n").filter(Boolean);

    const kept: KeptBranch[] = [{ name: base, reason: "base", detail: null }];
    if (currentBranch && currentBranch !== base) {
      kept.push({ name: currentBranch, reason: "current", detail: null });
    }

    const merged_local: BranchInfo[] = [];
    const orphaned_worktree: BranchInfo[] = [];
    const content_merged: BranchInfo[] = [];
    const backup: BranchInfo[] = [];
    const unclassified: string[] = [];

    const maxAgeDate = new Date();
    maxAgeDate.setDate(maxAgeDate.getDate() - maxAgeDays);

    for (const branch of allBranches) {
      // base and current are already in kept with their own reasons
      if (branch === base || branch === currentBranch) continue;

      // Branches held by a worktree that survives the sweep. Branches whose
      // worktree is itself removable are absent here on purpose: they fall
      // through so branch and worktree go in the same pass.
      const heldBy = worktreeScan.retained.get(branch);
      if (heldBy) {
        kept.push(heldBy);
        continue;
      }

      if (protectedBranches.has(branch)) {
        kept.push({ name: branch, reason: "protected", detail: null });
        continue;
      }

      if (mergedSet.has(branch)) {
        // Category 1 or 2: merged -- check if it's an orphaned worktree branch
        const target = branch.startsWith(config.agentPrefix) ? orphaned_worktree : merged_local;
        target.push(await getBranchInfo(branch, base, "ancestry"));
      } else if (branch.startsWith(config.backupPrefix)) {
        // Category 4: backup branch
        backup.push(await getBranchInfo(branch, base, await proveContained(branch, base)));
      } else if (branch.startsWith(config.agentPrefix)) {
        // Unmerged worktree-agent branch. The tool creates these and agents
        // normally abandon them empty; one that still holds unproven commits
        // was worked on directly and carries the only copy. A name prefix is
        // no reason to offer a deletion that the same content would forbid on
        // any other branch, so it is retained like any other unproven branch.
        const proof = await proveContained(branch, base);
        const info = await getBranchInfo(branch, base, proof);
        if (proof === "unproven") {
          kept.push({
            name: branch,
            reason: "unproven",
            detail: `${info.ahead} commit(s) not proven to be in ${base}`,
          });
        } else {
          orphaned_worktree.push(info);
        }
      } else {
        // Candidate for the content-containment proof
        unclassified.push(branch);
      }
    }

    // Content-containment proof for unclassified branches. The age gate bounds
    // cost; an old branch is reported as untested, never as proven absent.
    for (const branch of unclassified) {
      const info = await getBranchInfo(branch, base, "unproven");
      const commitDate = new Date(info.last_commit_date);

      if (commitDate < maxAgeDate) {
        kept.push({
          name: branch,
          reason: "too-old",
          detail: `older than ${maxAgeDays} days, containment not tested`,
        });
        continue;
      }

      const proof = await proveContained(branch, base);
      if (proof === "unproven") {
        kept.push({
          name: branch,
          reason: "unproven",
          detail: `${info.ahead} commit(s) not proven to be in ${base}`,
        });
      } else {
        content_merged.push({ ...info, proof });
      }
    }

    // -------------------------------------------------------------------------
    // Scan remote branches (origin-only, non-destructive)
    // -------------------------------------------------------------------------

    const stale_remote: RemoteBranchInfo[] = [];
    const kept_remote: KeptBranch[] = [];
    let stale_tracking: string[] = [];
    let remote_base: string | null = null;

    if (includeRemote) {
      // Origin-presence gate: no origin -> fully local, no network, refs intact.
      const originCheck = await git("remote", "get-url", "origin");
      if (originCheck.exitCode === 0) {
        // Non-destructive refresh: update remote-tracking refs WITHOUT pruning
        // (pruning stays a confirmed apply op) and without clobbering FETCH_HEAD.
        // Fail-closed: never proceed on stale remote data when offline.
        const fetchResult = await git("fetch", "--no-prune", "--no-write-fetch-head", "origin");
        if (fetchResult.exitCode !== 0) {
          return {
            ok: false,
            error: `git fetch origin failed: ${fetchResult.stderr}`,
            step: "scan-remote",
          };
        }

        // Remote branches are judged against origin/<base>, never local <base>:
        // a local base that lags would under-report, and an unpushed local merge
        // must never justify deleting the only remote copy of a branch.
        const remoteBaseRef = `origin/${base}`;
        const remoteBaseCheck = await git("rev-parse", "--verify", remoteBaseRef);

        if (remoteBaseCheck.exitCode === 0) {
          remote_base = remoteBaseRef;

          // All remote branches (reject any non-origin prefix)
          const allRemoteResult = await git("branch", "-r", "--format=%(refname:short)");
          if (allRemoteResult.exitCode !== 0) {
            return {
              ok: false,
              error: `git branch -r failed: ${allRemoteResult.stderr}`,
              step: "scan-remote",
            };
          }
          const allRemotes = allRemoteResult.stdout
            .split("\n")
            .filter(Boolean)
            .filter((b) => b.startsWith("origin/") && !b.endsWith("/HEAD") && b !== remoteBaseRef);

          for (const remoteBranch of allRemotes) {
            if (protectedBranches.has(remoteBranch.slice("origin/".length))) {
              kept_remote.push({ name: remoteBranch, reason: "protected", detail: null });
              continue;
            }

            // Ancestry is cheap and age-independent; only the merge-tree proof
            // is gated, so old ancestor-merged remotes stay reported.
            if (await isAncestor(remoteBranch, remoteBaseRef)) {
              stale_remote.push(await getRemoteBranchInfo(remoteBranch, "ancestry"));
              continue;
            }

            const info = await getRemoteBranchInfo(remoteBranch, "unproven");
            if (new Date(info.last_commit_date) < maxAgeDate) {
              kept_remote.push({
                name: remoteBranch,
                reason: "too-old",
                detail: `older than ${maxAgeDays} days, containment not tested`,
              });
            } else if (await hasNoMergeDelta(remoteBranch, remoteBaseRef)) {
              stale_remote.push({ ...info, proof: "no-merge-delta" });
            } else {
              kept_remote.push({
                name: remoteBranch,
                reason: "unproven",
                detail: `not proven to be in ${remoteBaseRef}`,
              });
            }
          }
        }

        // Stale tracking refs: refs whose upstream is gone. With --no-prune above,
        // `remote prune --dry-run` reports them honestly (populating stale_tracking
        // so apply can prune them under confirmation).
        const pruneResult = await git("remote", "prune", "origin", "--dry-run");
        if (pruneResult.stdout) {
          stale_tracking = pruneResult.stdout
            .split("\n")
            .filter((line) => line.includes("would prune"))
            .map((line) => line.replace(/^.*\[would prune\]\s*/u, "").trim())
            .filter(Boolean);
        }
      }
    }

    return {
      ok: true,
      base,
      remote_base,
      categories: {
        merged_local,
        orphaned_worktree,
        content_merged,
        backup,
        stale_worktrees,
        removable_worktrees,
        stale_remote,
        stale_tracking,
      },
      kept,
      kept_remote,
    };
  } catch (err) {
    // Catch-all: any in-process exception still emits one valid AuditError JSON.
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
