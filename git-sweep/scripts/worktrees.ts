// Reads `git worktree list --porcelain` into one typed state per worktree,
// and decides what the audit may propose for each linked one. Pure: the audit
// supplies git's output and the filesystem check, and runs the inspection
// (status) that a live worktree on a branch still needs.

import { LOCAL_REFS, localRef } from "./git.ts";

export type WorktreeHead =
  | { kind: "branch"; branch: string }
  // HEAD names a branch that has no commit: deleted under the worktree, or an
  // orphan branch not committed to yet. git lists it with a zero HEAD.
  | { kind: "unborn"; branch: string }
  | { kind: "detached" }
  // git could not resolve HEAD at all (a corrupt HEAD file): a zero HEAD with
  // neither a branch nor a detached line.
  | { kind: "unreadable" };

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

export type MainWorktree = { path: string; head: WorktreeHead | { kind: "bare" } };

export type WorktreeList = { main: MainWorktree; linked: LinkedWorktree[] };

const ZERO_OID = /^0+$/u;

type Entry = {
  path: string | null;
  oid: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  lock: { reason: string | null } | null;
  prune: { reason: string | null } | null;
};

function readEntry(block: string): Entry {
  const entry: Entry = {
    path: null,
    oid: null,
    branch: null,
    detached: false,
    bare: false,
    lock: null,
    prune: null,
  };

  for (const line of block.split("\n")) {
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? null : line.slice(space + 1);

    switch (key) {
      case "worktree":
        entry.path = value;
        break;
      case "HEAD":
        entry.oid = value;
        break;
      case "branch":
        entry.branch = value?.startsWith(LOCAL_REFS) ? value.slice(LOCAL_REFS.length) : value;
        break;
      case "detached":
        entry.detached = true;
        break;
      case "bare":
        entry.bare = true;
        break;
      case "locked":
        entry.lock = { reason: value };
        break;
      case "prunable":
        entry.prune = { reason: value };
        break;
      default:
        break;
    }
  }

  return entry;
}

function headOf(entry: Entry, path: string): WorktreeHead | { error: string } {
  if (entry.oid === null) return { error: `worktree ${path} has no HEAD line` };
  const zero = ZERO_OID.test(entry.oid);

  if (entry.branch !== null) {
    return zero
      ? { kind: "unborn", branch: entry.branch }
      : { kind: "branch", branch: entry.branch };
  }

  if (entry.detached) return { kind: "detached" };

  if (zero) return { kind: "unreadable" };

  return { error: `worktree ${path} has neither a branch nor a detached HEAD` };
}

function parseLinked(block: string): LinkedWorktree | { error: string } {
  const entry = readEntry(block);

  if (entry.path === null) return { error: `worktree entry without a path: ${block}` };
  const { path, lock, prune } = entry;

  if (lock !== null && prune !== null) {
    return { error: `worktree ${path} is reported both locked and prunable` };
  }

  const head = headOf(entry, path);

  if ("error" in head) return head;

  let registration: Registration = { kind: "active" };

  if (lock !== null) registration = { kind: "locked", reason: lock.reason };
  else if (prune !== null) registration = { kind: "prunable", reason: prune.reason };

  return { path, head, registration };
}

function parseMain(block: string): MainWorktree | { error: string } {
  const entry = readEntry(block);

  if (entry.path === null) return { error: `worktree entry without a path: ${block}` };

  if (entry.bare) return { path: entry.path, head: { kind: "bare" } };
  const head = headOf(entry, entry.path);

  return "error" in head ? head : { path: entry.path, head };
}

// The first entry is always the main worktree: never a candidate, but the
// branch it stands on is held like any other.
export function parseWorktreeList(porcelain: string): WorktreeList | { error: string } {
  const [first, ...rest] = porcelain.split("\n\n").filter(Boolean);

  if (first === undefined) return { error: "git worktree list printed no worktree" };
  const main = parseMain(first);

  if ("error" in main) return main;
  const linked: LinkedWorktree[] = [];

  for (const block of rest) {
    const parsed = parseLinked(block);

    if ("error" in parsed) return parsed;
    linked.push(parsed);
  }

  return { main, linked };
}

// `git branch -d` refuses a branch checked out in the main worktree too, and
// the audit may run from a linked one.
export function holdMainBranch(main: MainWorktree): BranchHold | null {
  return main.head.kind === "branch"
    ? { name: main.head.branch, reason: "worktree", detail: `${main.path} (main worktree)` }
    : null;
}

// Registered, its directory gone: `git worktree remove` drops the registration.
export type StaleWorktree = { path: string; branch: string | null };

// Left alone for a reason of the worktree itself, which no branch entry says.
export type KeptWorktree = {
  path: string;
  branch: string | null;
  reason: "locked" | "prunable" | "unborn" | "unreadable";
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
  // null in a bare repository, which has no work tree of its own.
  currentWorktree: string | null;
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
    case "unreadable":
      return {
        kind: "kept",
        worktree: { path, branch: null, reason: "unreadable", detail: "HEAD cannot be resolved" },
        hold: null,
      };
    case "unborn":
      return {
        kind: "kept",
        worktree: {
          path,
          branch: head.branch,
          reason: "unborn",
          detail: `${localRef(head.branch)} has no commit`,
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
  const branch = head.kind === "branch" || head.kind === "unborn" ? head.branch : null;
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
