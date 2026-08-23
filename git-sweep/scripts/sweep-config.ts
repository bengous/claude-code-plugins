// Shared by git-clean-audit and git-clean-apply: sweep.* configuration,
// trunk candidates, and the protected-branch set both layers must agree on.

import { $ } from "bun";

async function git(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.quiet().nothrow();
  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode };
}

const DEFAULT_AGENT_PREFIX = "worktree-agent-";
const DEFAULT_BACKUP_PREFIX = "backup/";
const DEFAULT_MAX_AGE_DAYS = 180;

// One list for both roles: what the audit may resolve as the base (in this
// order) is also what it never proposes for deletion — a trunk being contained
// in the base is by design, not staleness.
export const TRUNK_CANDIDATES = ["main", "master", "trunk", "dev", "develop"];

export const POSITIVE_INT = /^[1-9]\d*$/u;

// Read even when the full config is invalid: apply's protection backstop must
// not be disabled by an unrelated bad key, so these two never error.
export type ProtectionConfig = {
  protect: string[];
  unprotect: string[];
};

export type SweepConfig = ProtectionConfig & {
  base: string | null;
  agentPrefix: string;
  backupPrefix: string;
  maxAgeDays: number;
};

const multi = (result: { stdout: string; exitCode: number }): string[] =>
  result.exitCode === 0 ? result.stdout.split("\n").filter(Boolean) : [];

export async function readProtectionConfig(): Promise<ProtectionConfig> {
  const [protect, unprotect] = await Promise.all([
    git("config", "--get-all", "sweep.protect"),
    git("config", "--get-all", "sweep.unprotect"),
  ]);
  return { protect: multi(protect), unprotect: multi(unprotect) };
}

export async function readSweepConfig(): Promise<SweepConfig | { error: string }> {
  const [protection, base, agentPrefix, backupPrefix, maxAge] = await Promise.all([
    readProtectionConfig(),
    git("config", "--get", "sweep.base"),
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

  const agent =
    agentPrefix.exitCode === 0 && agentPrefix.stdout ? agentPrefix.stdout : DEFAULT_AGENT_PREFIX;
  const backup =
    backupPrefix.exitCode === 0 && backupPrefix.stdout
      ? backupPrefix.stdout
      : DEFAULT_BACKUP_PREFIX;
  // One prefix containing the other reroutes unproven agent branches into the
  // deletable backup category, past the kept-unproven guarantee.
  if (agent.startsWith(backup) || backup.startsWith(agent)) {
    return {
      error: `sweep.agentPrefix '${agent}' and sweep.backupPrefix '${backup}' overlap (one is a prefix of the other)`,
    };
  }

  return {
    ...protection,
    base: base.exitCode === 0 && base.stdout ? base.stdout : null,
    agentPrefix: agent,
    backupPrefix: backup,
    maxAgeDays,
  };
}

export async function localBranchExists(name: string): Promise<boolean> {
  // refs/heads/ in full: the bare name would also match a tag.
  return (await git("rev-parse", "--verify", `refs/heads/${name}`)).exitCode === 0;
}

export async function originHeadTarget(): Promise<string | null> {
  const head = await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  return head.exitCode === 0 && head.stdout.startsWith("origin/")
    ? head.stdout.slice("origin/".length)
    : null;
}

// origin/HEAD goes stale and can name a branch that no longer exists anywhere:
// every candidate must pass the existence check before it may become the base.
// Never falls back to HEAD — from a feature branch that would make the real
// trunk look deletable.
export async function resolveBase(configBase: string | null, originHead: string | null) {
  const candidates = [configBase, originHead, ...TRUNK_CANDIDATES].filter(
    (c): c is string => c !== null,
  );
  for (const name of candidates) {
    if (await localBranchExists(name)) return name;
  }
  return null;
}

// sweep.unprotect lifts default names; the base itself can never be lifted.
export function buildProtectedSet(
  base: string,
  originHead: string | null,
  config: ProtectionConfig,
): Set<string> {
  const set = new Set([
    base,
    ...(originHead === null ? [] : [originHead]),
    ...TRUNK_CANDIDATES,
    ...config.protect,
  ]);
  for (const name of config.unprotect) {
    if (name !== base) set.delete(name);
  }
  return set;
}
