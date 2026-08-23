#!/usr/bin/env bun

// git-clean-apply — Execute a cleanup manifest one operation at a time.
// Consumed by the git-sweep skill (apply phase, fed by the audit phase).

import { $ } from "bun";
import { rename, unlink } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CleanupManifest = {
  base: string;
  worktrees: string[];
  branches: { name: string; force: boolean; oid: string }[];
  remote_branches: { remote: string; ref: string; oid: string }[];
  prune_remotes: boolean;
  prune_worktrees: boolean;
};

type Operation = {
  type:
    | "worktree-remove"
    | "branch-delete"
    | "remote-delete"
    | "prune-remote"
    | "prune-worktree"
    | "manifest-rewrite";
  target: string;
  success: boolean;
  error: string | null;
};

type CleanupResult = {
  ok: boolean;
  operations: Operation[];
  summary: { succeeded: number; failed: number };
  // Present when a partial failure left operations behind in the hand-off file.
  manifest_remaining?: { path: string; operations: number };
};

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.quiet().nothrow();
  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode };
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser the rules ask for: it validates a manifest read from stdin before anything deletes a branch. Their fix (parse before calling) has no earlier place to happen. */

const isOid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{7,64}$/u.test(v);

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

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type */

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

// A branch held by a removable worktree is legitimately reported twice by the
// audit (once as the worktree to free, once as the branch to delete), so a
// manifest can name the same ref twice. Executing it twice makes the second
// attempt fail on an already-deleted ref, which would leave an unsatisfiable
// operation behind in the rewritten hand-off. Identical entries collapse;
// contradictory ones are an error, not something to guess at.
function dedupe<T>(items: T[], keyOf: (item: T) => string, label: string): T[] | { error: string } {
  const seen = new Map<string, { key: string; json: string; item: T }>();
  for (const item of items) {
    const key = keyOf(item);
    const json = JSON.stringify(item);
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, { key, json, item });
    } else if (previous.json !== json) {
      return { error: `conflicting ${label} entries for '${key}' in the manifest` };
    }
  }
  return [...seen.values()].map((entry) => entry.item);
}

function dedupeManifest(m: CleanupManifest): CleanupManifest | { error: string } {
  const branches = dedupe(m.branches, (b) => b.name, "branch");
  if ("error" in branches) return branches;
  const remote_branches = dedupe(m.remote_branches, (r) => `${r.remote}/${r.ref}`, "remote branch");
  if ("error" in remote_branches) return remote_branches;
  return { ...m, worktrees: [...new Set(m.worktrees)], branches, remote_branches };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function execute(
  manifest: CleanupManifest,
): Promise<{ result: CleanupResult; remaining: CleanupManifest }> {
  const operations: Operation[] = [];

  // Everything that does not succeed is collected here, so a partial run can
  // hand back a manifest describing exactly what is left instead of a stale
  // copy of the original.
  const remaining: CleanupManifest = {
    base: manifest.base,
    worktrees: [],
    branches: [],
    remote_branches: [],
    prune_remotes: false,
    prune_worktrees: false,
  };

  const currentBranch = (await git("branch", "--show-current")).stdout;

  // 1. Remove worktrees first (must happen before branch deletion). No --force:
  // a worktree that became dirty since the audit must fail loudly, not be wiped.
  for (const path of manifest.worktrees) {
    const result = await git("worktree", "remove", path);
    const success = result.exitCode === 0;
    if (!success) remaining.worktrees.push(path);
    operations.push({
      type: "worktree-remove",
      target: path,
      success,
      error: success ? null : result.stderr,
    });
  }

  // 2. Prune worktree refs
  if (manifest.prune_worktrees) {
    const result = await git("worktree", "prune");
    const success = result.exitCode === 0;
    if (!success) remaining.prune_worktrees = true;
    operations.push({
      type: "prune-worktree",
      target: "worktree refs",
      success,
      error: success ? null : result.stderr,
    });
  }

  // 3. Delete local branches
  for (const entry of manifest.branches) {
    const { name, force, oid } = entry;
    const fail = (error: string) => {
      remaining.branches.push(entry);
      operations.push({ type: "branch-delete", target: name, success: false, error });
    };

    // Guards the manifest cannot waive, whatever the audit or a hand edit says.
    if (name === manifest.base) {
      fail(`refusing to delete the base branch '${name}'`);
      continue;
    }
    if (name === currentBranch) {
      fail(`refusing to delete the checked-out branch '${name}'`);
      continue;
    }

    // The audit proved containment for THIS commit; if the branch moved since,
    // that proof no longer covers what would be deleted.
    const head = await git("rev-parse", "--verify", `refs/heads/${name}`);
    if (head.exitCode !== 0) {
      fail(`branch no longer exists: ${head.stderr}`);
      continue;
    }
    if (head.stdout !== oid) {
      fail(`branch moved since the audit (audited ${oid}, now ${head.stdout}) — re-run /git-sweep`);
      continue;
    }

    const result = await git("branch", force ? "-D" : "-d", name);
    if (result.exitCode !== 0) {
      fail(result.stderr);
      continue;
    }
    operations.push({ type: "branch-delete", target: name, success: true, error: null });
  }

  // 4. Delete remote branches one at a time, each under a lease on the commit
  // the audit judged: if anyone pushed to that branch since, the delete is
  // refused instead of silently discarding their work.
  for (const entry of manifest.remote_branches) {
    const { remote, ref, oid } = entry;
    const target = `${remote}/${ref}`;

    if (ref === manifest.base) {
      remaining.remote_branches.push(entry);
      operations.push({
        type: "remote-delete",
        target,
        success: false,
        error: `refusing to delete the base branch '${ref}' on ${remote}`,
      });
      continue;
    }

    const result = await git(
      "push",
      `--force-with-lease=refs/heads/${ref}:${oid}`,
      remote,
      "--delete",
      ref,
    );
    const success = result.exitCode === 0;
    if (!success) remaining.remote_branches.push(entry);
    operations.push({
      type: "remote-delete",
      target,
      success,
      error: success ? null : result.stderr,
    });
  }

  // 5. Prune remote tracking refs
  if (manifest.prune_remotes) {
    const result = await git("remote", "prune", "origin");
    const success = result.exitCode === 0;
    if (!success) remaining.prune_remotes = true;
    operations.push({
      type: "prune-remote",
      target: "remote tracking refs",
      success,
      error: success ? null : result.stderr,
    });
  }

  const succeeded = operations.filter((op) => op.success).length;
  const failed = operations.filter((op) => !op.success).length;

  return {
    result: { ok: failed === 0, operations, summary: { succeeded, failed } },
    remaining,
  };
}

function countOperations(m: CleanupManifest): number {
  return (
    m.worktrees.length +
    m.branches.length +
    m.remote_branches.length +
    (m.prune_remotes ? 1 : 0) +
    (m.prune_worktrees ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<CleanupResult | { ok: false; error: string }> {
  const args = Bun.argv.slice(2);

  let manifestJson: string | null = null;
  let manifestFile: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest":
        manifestJson = args[++i]!;
        break;
      case "--manifest-file":
        manifestFile = args[++i]!;
        break;
      default:
        return { ok: false, error: `unknown argument: ${args[i]}` };
    }
  }

  /* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- same boundary as isValidManifest above: `parsed` is raw JSON, and `kept` is an opaque passthrough this script re-serialises without ever reading it. */

  let manifest: CleanupManifest;
  let consumePath: string | null = null;
  let kept: unknown = [];

  if (manifestFile !== null) {
    // Durable hand-off: file holds {manifest, kept} written by git-clean-audit.
    let raw: string;
    try {
      raw = await Bun.file(manifestFile).text();
    } catch {
      return { ok: false, error: `cannot read manifest file: ${manifestFile}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "invalid JSON in manifest file" };
    }
    const candidate = (parsed as { manifest?: unknown }).manifest;
    if (!isValidManifest(candidate)) {
      return { ok: false, error: "invalid manifest shape in manifest file" };
    }
    manifest = candidate;
    kept = (parsed as { kept?: unknown }).kept ?? [];
    consumePath = manifestFile;
  } else if (manifestJson === null) {
    return { ok: false, error: "missing --manifest or --manifest-file argument" };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestJson);
    } catch {
      return { ok: false, error: "invalid JSON in --manifest" };
    }
    if (!isValidManifest(parsed)) {
      return { ok: false, error: "invalid manifest shape in --manifest" };
    }
    manifest = parsed;
  }

  /* oxlint-enable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening */

  const deduped = dedupeManifest(manifest);
  if ("error" in deduped) {
    return { ok: false, error: deduped.error };
  }

  const { result, remaining } = await execute(deduped);

  if (consumePath !== null) {
    if (result.ok) {
      // Fully applied: the hand-off is spent.
      try {
        await unlink(consumePath);
      } catch {}
    } else {
      // Partial run: rewrite the hand-off so it describes only what is left.
      // Replaying the original would re-attempt already-completed deletions and
      // could never reach a clean state.
      const tmp = `${consumePath}.tmp`;
      try {
        await Bun.write(tmp, JSON.stringify({ manifest: remaining, kept }, null, 2));
        await rename(tmp, consumePath);
        result.manifest_remaining = { path: consumePath, operations: countOperations(remaining) };
      } catch (err) {
        result.operations.push({
          type: "manifest-rewrite",
          target: consumePath,
          success: false,
          error: `could not rewrite manifest file: ${err instanceof Error ? err.message : String(err)}`,
        });
        result.summary.failed += 1;
      }
    }
  }

  return result;
}

if (import.meta.main) {
  const result = await main();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
