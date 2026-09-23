// The cleanup manifest the audit hands to apply, and the one parser both use.
// It crosses an LLM hand-off and survives as an editable file, so every field
// is checked on the way in, whoever wrote it.

declare const OidBrand: unique symbol;

// A full commit id: apply compares it to `git rev-parse` output and leases a
// remote delete on it, and an abbreviated one would never match.
export type Oid = string & { readonly [OidBrand]: true };

export type BranchDeletion = { name: string; force: boolean; oid: Oid };

export type RemoteDeletion = { remote: string; ref: string; oid: Oid };

export type CleanupManifest = {
  base: string;
  worktrees: string[];
  branches: BranchDeletion[];
  remote_branches: RemoteDeletion[];
  prune_remotes: boolean;
};

const FIELDS: readonly string[] = [
  "base",
  "worktrees",
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

type Parsed<T> = { value: T } | { error: string };

function parseBranch(raw: unknown, at: string): Parsed<BranchDeletion> {
  if (!isRecord(raw)) return { error: `${at} is not an object` };

  if (typeof raw.name !== "string" || raw.name === "") {
    return { error: `${at}.name is not a branch name` };
  }

  if (typeof raw.force !== "boolean") return { error: `${at}.force is not a boolean` };
  const oid = parseOid(raw.oid);

  if (oid === null) return { error: `${at}.oid is not a full commit id` };

  return { value: { name: raw.name, force: raw.force, oid } };
}

function parseRemote(raw: unknown, at: string): Parsed<RemoteDeletion> {
  if (!isRecord(raw)) return { error: `${at} is not an object` };

  if (typeof raw.remote !== "string" || raw.remote === "") {
    return { error: `${at}.remote is not a remote name` };
  }

  if (typeof raw.ref !== "string" || raw.ref === "") return { error: `${at}.ref is not a ref` };
  const oid = parseOid(raw.oid);

  if (oid === null) return { error: `${at}.oid is not a full commit id` };

  return { value: { remote: raw.remote, ref: raw.ref, oid } };
}

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

  const worktrees = parseList(raw.worktrees, "worktrees", (item, at) =>
    typeof item === "string" && item !== "" ? { value: item } : { error: `${at} is not a path` },
  );

  if ("error" in worktrees) return worktrees;
  const branches = parseList(raw.branches, "branches", parseBranch);

  if ("error" in branches) return branches;
  const remoteBranches = parseList(raw.remote_branches, "remote_branches", parseRemote);

  if ("error" in remoteBranches) return remoteBranches;

  if (typeof raw.prune_remotes !== "boolean") return { error: "prune_remotes is not a boolean" };

  return {
    base: raw.base,
    worktrees: worktrees.value,
    branches: branches.value,
    remote_branches: remoteBranches.value,
    prune_remotes: raw.prune_remotes,
  };
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type */
