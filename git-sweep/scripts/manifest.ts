// The cleanup manifest the audit hands to apply, and the one parser both use.
// It crosses an LLM hand-off and survives as an editable file, so every field
// is checked on the way in, whoever wrote it.

declare const OidBrand: unique symbol;

// A full commit id: apply compares it to `git rev-parse` output and leases a
// remote delete on it, and an abbreviated one would never match.
export type Oid = string & { readonly [OidBrand]: true };

declare const BranchNameBrand: unique symbol;

// A name apply hands to git as an argument: a leading dash would read as an
// option (`git branch -d -D`).
export type BranchName = string & { readonly [BranchNameBrand]: true };

export type BranchDeletion = { name: BranchName; force: boolean; oid: Oid };

export type RemoteDeletion = { remote: string; ref: BranchName; oid: Oid };

export type CleanupManifest = {
  base: string;
  // Live worktrees, removed with whatever they hold.
  worktrees: string[];
  // Registrations whose directory was gone at audit time: apply refuses one
  // whose directory is back, which a plain `git worktree remove` would delete.
  stale_worktrees: string[];
  branches: BranchDeletion[];
  remote_branches: RemoteDeletion[];
  prune_remotes: boolean;
};

// What the audit handed over beside the manifest, shown back to the user.
export type KeptEntry = { name: string; reason: string; detail: string | null };

export type Handoff = { manifest: CleanupManifest; kept: KeptEntry[] };

const FIELDS: readonly string[] = [
  "base",
  "worktrees",
  "stale_worktrees",
  "branches",
  "remote_branches",
  "prune_remotes",
] satisfies (keyof CleanupManifest)[];

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- this module IS the boundary parser those rules ask for: the manifest arrives as JSON from stdin or a file, and nothing past this function sees it untyped. */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseOid = (value: unknown): Oid | null =>
  typeof value === "string" && FULL_OID.test(value) ? (value as Oid) : null;

const parseBranchName = (value: unknown): BranchName | null =>
  typeof value === "string" && value !== "" && !value.startsWith("-")
    ? (value as BranchName)
    : null;

type Parsed<T> = { value: T } | { error: string };

function parseBranch(raw: unknown, at: string): Parsed<BranchDeletion> {
  if (!isRecord(raw)) return { error: `${at} is not an object` };

  const name = parseBranchName(raw.name);

  if (name === null) return { error: `${at}.name is not a branch name` };

  if (typeof raw.force !== "boolean") return { error: `${at}.force is not a boolean` };
  const oid = parseOid(raw.oid);

  if (oid === null) return { error: `${at}.oid is not a full commit id` };

  return { value: { name, force: raw.force, oid } };
}

function parseRemote(raw: unknown, at: string): Parsed<RemoteDeletion> {
  if (!isRecord(raw)) return { error: `${at} is not an object` };

  if (typeof raw.remote !== "string" || raw.remote === "") {
    return { error: `${at}.remote is not a remote name` };
  }

  const ref = parseBranchName(raw.ref);

  if (ref === null) return { error: `${at}.ref is not a branch name` };
  const oid = parseOid(raw.oid);

  if (oid === null) return { error: `${at}.oid is not a full commit id` };

  return { value: { remote: raw.remote, ref, oid } };
}

const parsePath = (item: unknown, at: string): Parsed<string> =>
  typeof item === "string" && item !== "" ? { value: item } : { error: `${at} is not a path` };

function parseList<T>(
  raw: unknown,
  field: string,
  parseItem: (item: unknown, at: string) => Parsed<T>,
): Parsed<T[]> {
  if (!Array.isArray(raw)) return { error: `${field} is not a list` };
  const items: T[] = [];

  for (const [index, item] of raw.entries()) {
    const parsed = parseItem(item, `${field}[${index}]`);

    if ("error" in parsed) return parsed;
    items.push(parsed.value);
  }

  return { value: items };
}

export function parseManifest(raw: unknown): CleanupManifest | { error: string } {
  if (!isRecord(raw)) return { error: "the manifest is not an object" };
  const unknown = Object.keys(raw).filter((key) => !FIELDS.includes(key));

  if (unknown.length > 0) {
    return {
      error: `unknown manifest field(s): ${unknown.join(", ")}; re-run /git-sweep to audit again`,
    };
  }

  if (typeof raw.base !== "string" || raw.base === "") {
    return { error: "base is not a branch name" };
  }

  const worktrees = parseList(raw.worktrees, "worktrees", parsePath);

  if ("error" in worktrees) return worktrees;
  const staleWorktrees = parseList(raw.stale_worktrees, "stale_worktrees", parsePath);

  if ("error" in staleWorktrees) return staleWorktrees;
  const branches = parseList(raw.branches, "branches", parseBranch);

  if ("error" in branches) return branches;
  const remoteBranches = parseList(raw.remote_branches, "remote_branches", parseRemote);

  if ("error" in remoteBranches) return remoteBranches;

  if (typeof raw.prune_remotes !== "boolean") return { error: "prune_remotes is not a boolean" };

  return {
    base: raw.base,
    worktrees: worktrees.value,
    stale_worktrees: staleWorktrees.value,
    branches: branches.value,
    remote_branches: remoteBranches.value,
    prune_remotes: raw.prune_remotes,
  };
}

function parseKept(raw: unknown, at: string): Parsed<KeptEntry> {
  if (!isRecord(raw)) return { error: `${at} is not an object` };

  if (typeof raw.name !== "string" || typeof raw.reason !== "string") {
    return { error: `${at} needs a name and a reason` };
  }

  if (raw.detail !== null && typeof raw.detail !== "string") {
    return { error: `${at}.detail is neither text nor null` };
  }

  return { value: { name: raw.name, reason: raw.reason, detail: raw.detail } };
}

// The {manifest, kept} file both scripts read and write.
export function parseHandoff(raw: unknown): Handoff | { error: string } {
  if (!isRecord(raw)) return { error: "the hand-off is not a {manifest, kept} object" };
  const manifest = parseManifest(raw.manifest);

  if ("error" in manifest) return { error: `invalid manifest: ${manifest.error}` };
  const kept = parseList(raw.kept, "kept", parseKept);

  if ("error" in kept) return { error: `invalid kept list: ${kept.error}` };

  return { manifest, kept: kept.value };
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type */
