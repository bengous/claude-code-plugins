#!/usr/bin/env bun

// git-clean-apply — Execute a cleanup manifest one operation at a time.
// Consumed by the git-sweep skill (apply phase, fed by the audit phase).

import { existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";

import { git, localRef } from "./git.ts";
import { type CleanupManifest, type KeptEntry, parseHandoff, parseManifest } from "./manifest.ts";
import { buildProtectedSet, originHeadTarget, readProtectionConfig } from "./sweep-config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Operation = {
  type: "worktree-remove" | "branch-delete" | "remote-delete" | "prune-remote" | "manifest-rewrite";
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

  return {
    ...m,
    worktrees: [...new Set(m.worktrees)],
    stale_worktrees: [...new Set(m.stale_worktrees)],
    branches,
    remote_branches,
  };
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
    stale_worktrees: [],
    branches: [],
    remote_branches: [],
    prune_remotes: false,
  };

  const currentBranch = (await git("branch", "--show-current")).stdout;

  // Backstop for the audit-time trunk protection: the manifest crosses an LLM
  // hand-off and survives as an editable file, so the layer that deletes must
  // re-refuse protected branches on its own.
  const protectedBranches = buildProtectedSet(
    manifest.base,
    await originHeadTarget(),
    await readProtectionConfig(),
  );

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

  // Stale registrations: `git worktree remove` on a directory that came back
  // (a remount, a move undone) would delete it with its ignored files, which
  // the audit never listed because it saw no directory.
  for (const path of manifest.stale_worktrees) {
    let error: string | null = null;

    if (existsSync(path)) {
      error = `the directory is back since the audit: ${path}; re-run /git-sweep`;
    } else {
      const result = await git("worktree", "remove", path);

      // A registration already dropped (gc, or a prune by hand) is the goal reached.
      if (result.exitCode !== 0 && !result.stderr.includes("is not a working tree")) {
        error = result.stderr;
      }
    }

    if (error !== null) remaining.stale_worktrees.push(path);
    operations.push({ type: "worktree-remove", target: path, success: error === null, error });
  }

  // 2. Delete local branches
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

    if (protectedBranches.has(name)) {
      fail(`refusing to delete the protected branch '${name}' (sweep.unprotect can lift it)`);
      continue;
    }

    // The audit proved containment for THIS commit; if the branch moved since,
    // that proof no longer covers what would be deleted.
    const head = await git("rev-parse", "--verify", localRef(name));

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

  // 3. Delete remote branches one at a time, each under a lease on the commit
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

    if (protectedBranches.has(ref)) {
      remaining.remote_branches.push(entry);
      operations.push({
        type: "remote-delete",
        target,
        success: false,
        error: `refusing to delete the protected branch '${ref}' on ${remote} (sweep.unprotect can lift it)`,
      });
      continue;
    }

    // The full ref on both sides: a short --delete is resolved by the remote,
    // so "heads/dev" would delete dev past the protection check above, under a
    // lease on a ref the push never touches.
    const result = await git(
      "push",
      `--force-with-lease=${localRef(ref)}:${oid}`,
      remote,
      "--delete",
      localRef(ref),
    );

    // A full-ref delete of a branch already gone is refused as "stale info", like
    // one pushed to since the audit: ls-remote tells them apart. Gone is the goal
    // reached, and retrying could only fail the same way.
    const success =
      result.exitCode === 0 ||
      (await git("ls-remote", "--exit-code", remote, localRef(ref))).exitCode === 2;

    if (!success) remaining.remote_branches.push(entry);
    operations.push({
      type: "remote-delete",
      target,
      success,
      error: success ? null : result.stderr,
    });
  }

  // 4. Prune remote tracking refs
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
    m.stale_worktrees.length +
    m.branches.length +
    m.remote_branches.length +
    (m.prune_remotes ? 1 : 0)
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

  let manifest: CleanupManifest;
  let consumePath: string | null = null;
  let kept: KeptEntry[] = [];

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

    const handoff = parseHandoff(parsed);

    if ("error" in handoff) return { ok: false, error: `manifest file: ${handoff.error}` };
    manifest = handoff.manifest;
    kept = handoff.kept;
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

    const candidate = parseManifest(parsed);

    if ("error" in candidate) {
      return { ok: false, error: `invalid manifest in --manifest: ${candidate.error}` };
    }

    manifest = candidate;
  }

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
