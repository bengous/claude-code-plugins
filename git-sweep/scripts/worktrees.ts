// Reads `git worktree list --porcelain` into one typed state per linked
// worktree, and decides what the audit may propose for it. Pure: the audit
// supplies git's output and the filesystem check, and runs the inspection
// (status, containment proof) that a live worktree on a branch still needs.

export type WorktreeHead =
  | { kind: "branch"; branch: string }
  // HEAD names a branch that has no commit: deleted under the worktree, or an
  // orphan branch not committed to yet. git lists it with a zero HEAD.
  | { kind: "unborn"; branch: string }
  | { kind: "detached" };

// git never reports a locked worktree as prunable, so the three are exclusive.
export type Registration =
  | { kind: "active" }
  | { kind: "locked"; reason: string | null }
  | { kind: "prunable"; reason: string | null };

export type LinkedWorktree = {
  path: string;
  head: WorktreeHead;
  registration: Registration;
};

const ZERO_OID = /^0+$/u;

function parseBlock(block: string): LinkedWorktree | { error: string } {
  let path: string | null = null;
  let oid: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let lock: { reason: string | null } | null = null;
  let prune: { reason: string | null } | null = null;

  for (const line of block.split("\n")) {
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? null : line.slice(space + 1);

    switch (key) {
      case "worktree":
        path = value;
        break;
      case "HEAD":
        oid = value;
        break;
      case "branch":
        branch = value?.replace(/^refs\/heads\//u, "") ?? null;
        break;
      case "detached":
        detached = true;
        break;
      case "locked":
        lock = { reason: value };
        break;
      case "prunable":
        prune = { reason: value };
        break;
      default:
        break;
    }
  }

  if (path === null) return { error: `worktree entry without a path: ${block}` };

  if (oid === null) return { error: `worktree ${path} has no HEAD line` };

  if (lock !== null && prune !== null) {
    return { error: `worktree ${path} is reported both locked and prunable` };
  }

  let head: WorktreeHead;

  if (branch !== null) {
    head = ZERO_OID.test(oid) ? { kind: "unborn", branch } : { kind: "branch", branch };
  } else if (detached) {
    head = { kind: "detached" };
  } else {
    return { error: `worktree ${path} has neither a branch nor a detached HEAD` };
  }

  let registration: Registration = { kind: "active" };

  if (lock !== null) registration = { kind: "locked", reason: lock.reason };
  else if (prune !== null) registration = { kind: "prunable", reason: prune.reason };

  return { path, head, registration };
}

// The first entry is always the main worktree, which is never a candidate.
export function parseWorktreeList(porcelain: string): LinkedWorktree[] | { error: string } {
  const worktrees: LinkedWorktree[] = [];

  for (const block of porcelain.split("\n\n").filter(Boolean).slice(1)) {
    const parsed = parseBlock(block);

    if ("error" in parsed) return parsed;
    worktrees.push(parsed);
  }

  return worktrees;
}

// Registered, its directory gone: `git worktree remove` drops the registration.
export type StaleWorktree = { path: string; branch: string | null };

// Left alone for a reason of the worktree itself, which no branch entry says.
export type KeptWorktree = {
  path: string;
  branch: string | null;
  reason: "locked" | "prunable" | "unborn";
  detail: string | null;
};

// A branch the sweep must not delete because a worktree it leaves stands on it.
export type BranchHold = {
  name: string;
  reason: "worktree" | "protected" | "dirty-worktree";
  detail: string;
};

export type Triage =
  | { kind: "stale"; worktree: StaleWorktree }
  | { kind: "kept"; worktree: KeptWorktree; hold: BranchHold | null }
  | { kind: "held"; hold: BranchHold }
  | { kind: "skipped" }
  | { kind: "inspect"; path: string; branch: string };

export type TriageContext = {
  currentWorktree: string;
  protectedBranches: ReadonlySet<string>;
  directoryExists: (path: string) => boolean;
};

function lockDetail(reason: string | null, present: boolean): string | null {
  const parts = [
    ...(present ? [] : ["directory missing"]),
    ...(reason === null ? [] : [`lock reason: ${reason}`]),
  ];

  return parts.length > 0 ? parts.join("; ") : null;
}

function triageActive(path: string, head: WorktreeHead, context: TriageContext): Triage {
  switch (head.kind) {
    case "detached":
      return { kind: "skipped" };
    case "unborn":
      return {
        kind: "kept",
        worktree: {
          path,
          branch: head.branch,
          reason: "unborn",
          detail: `refs/heads/${head.branch} has no commit`,
        },
        hold: null,
      };
    case "branch":
      if (path === context.currentWorktree) {
        return {
          kind: "held",
          hold: { name: head.branch, reason: "worktree", detail: `${path} (current worktree)` },
        };
      }

      if (context.protectedBranches.has(head.branch)) {
        return { kind: "held", hold: { name: head.branch, reason: "protected", detail: path } };
      }

      return { kind: "inspect", path, branch: head.branch };
    default: {
      const unreachable: never = head;
      throw new Error(`unhandled worktree head: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function triageWorktree(worktree: LinkedWorktree, context: TriageContext): Triage {
  const { path, head, registration } = worktree;
  const branch = head.kind === "detached" ? null : head.branch;
  const present = context.directoryExists(path);

  // Only an existing branch can be deleted, so only it needs holding.
  const holdAs = (state: string): BranchHold | null =>
    head.kind === "branch"
      ? { name: head.branch, reason: "worktree", detail: `${path} (${state})` }
      : null;

  switch (registration.kind) {
    // A lock says "leave this alone", and `git worktree remove` refuses a
    // locked worktree whatever state it is in.
    case "locked":
      return {
        kind: "kept",
        worktree: {
          path,
          branch,
          reason: "locked",
          detail: lockDetail(registration.reason, present),
        },
        hold: holdAs("locked"),
      };
    // With its directory still there, `git worktree remove` refuses it, and
    // `git worktree prune` has no path argument: it would drop every one.
    case "prunable":
      return present
        ? {
            kind: "kept",
            worktree: { path, branch, reason: "prunable", detail: registration.reason },
            hold: holdAs("prunable"),
          }
        : { kind: "stale", worktree: { path, branch } };
    case "active":
      return present
        ? triageActive(path, head, context)
        : { kind: "stale", worktree: { path, branch } };
    default: {
      const unreachable: never = registration;
      throw new Error(`unhandled worktree registration: ${JSON.stringify(unreachable)}`);
    }
  }
}
