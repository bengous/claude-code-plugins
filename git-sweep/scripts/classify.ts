// Where a local or remote branch lands in the audit, decided in two pure steps
// around the git work: triage says what the name and the cheap facts already
// settle, or which proof route it needs; settle places it once proven.

import type { ProofKind, Proven } from "./proofs.ts";
import type { BranchHold } from "./worktrees.ts";

export type KeptReason = "base" | "current" | BranchHold["reason"] | "unproven" | "too-old";

export type Kept = { reason: KeptReason; detail: string | null };

// backup keeps a branch whatever its proof: unproven is the normal state of a
// save, which the user judges from its log. Every other category needs a proof.
export type Placement =
  | { kind: "kept"; kept: Kept }
  | { kind: "merged_local" | "orphaned_worktree" | "content_merged"; proof: Proven }
  | { kind: "backup"; proof: ProofKind };

// backup and agent are proven whatever their age; content passes the age gate
// first, which bounds what the proofs cost.
export type Route = "backup" | "agent" | "content";

export type LocalTriage =
  | { kind: "placed"; placement: Placement }
  | { kind: "prove"; route: Route };

export type LocalContext = {
  held: ReadonlyMap<string, BranchHold>;
  protectedBranches: ReadonlySet<string>;
  // Contained in the base by ancestry, from `for-each-ref --merged`.
  merged: ReadonlySet<string>;
  agentPrefix: string;
  backupPrefix: string;
};

const kept = (reason: KeptReason, detail: string | null = null): Placement => ({
  kind: "kept",
  kept: { reason, detail },
});

// For every local branch but the base and the current one, which the audit
// lists first with their own reasons.
export function triageLocal(branch: string, context: LocalContext): LocalTriage {
  // Branches whose worktree is itself removable are absent from `held` on
  // purpose: they fall through so branch and worktree go in the same pass.
  const hold = context.held.get(branch);

  if (hold !== undefined) return { kind: "placed", placement: kept(hold.reason, hold.detail) };

  if (context.protectedBranches.has(branch))
    return { kind: "placed", placement: kept("protected") };

  const isAgent = branch.startsWith(context.agentPrefix);

  if (context.merged.has(branch)) {
    return {
      kind: "placed",
      placement: { kind: isAgent ? "orphaned_worktree" : "merged_local", proof: "ancestry" },
    };
  }

  if (branch.startsWith(context.backupPrefix)) return { kind: "prove", route: "backup" };

  // The tool creates agent branches and agents normally abandon them empty;
  // one that still holds unproven commits was worked on directly and carries
  // the only copy, so it is kept like any other unproven branch.
  if (isAgent) return { kind: "prove", route: "agent" };

  return { kind: "prove", route: "content" };
}

export type AgeGate = { lastCommit: Date; maxAgeDays: number; now: Date };

// An old branch is reported as untested, never as proven absent.
export function tooOld({ lastCommit, maxAgeDays, now }: AgeGate): Kept | null {
  if (Number.isNaN(lastCommit.getTime())) throw new Error("invalid last commit date");
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - maxAgeDays);

  return lastCommit < cutoff
    ? { reason: "too-old", detail: `older than ${maxAgeDays} days, containment not tested` }
    : null;
}

export function settleLocal(route: Route, proof: ProofKind, unprovenDetail: string): Placement {
  if (route === "backup") return { kind: "backup", proof };

  if (proof === "unproven") return kept("unproven", unprovenDetail);

  return { kind: route === "agent" ? "orphaned_worktree" : "content_merged", proof };
}

// A branch standing in a clean worktree is proven once, as a branch, with its
// age gate: the worktree is removable exactly when that proof holds, and
// otherwise holds the branch. An unproven backup is listed, never proven, so it
// is held too.
export type WorktreeSettlement = { placement: Placement; removableBy: Proven | null };

// A kept branch's own detail, such as the report of an unproven one, rides
// along with the path.
export function settleInWorktree(placement: Placement, worktreePath: string): WorktreeSettlement {
  if (placement.kind === "kept") {
    const { detail } = placement.kept;
    const held = detail === null ? worktreePath : `${worktreePath} (${detail})`;

    return { placement: kept("worktree", held), removableBy: null };
  }

  if (placement.proof === "unproven") {
    return { placement: kept("worktree", worktreePath), removableBy: null };
  }

  return { placement, removableBy: placement.proof };
}

export type RemotePlacement = { kind: "kept"; kept: Kept } | { kind: "stale"; proof: Proven };

export type RemoteTriage = RemotePlacement | { kind: "prove" };

// Ancestry is cheap and age-independent, so an old remote merged by ancestry
// is still reported; only the costlier proofs pass the age gate.
export function triageRemote(
  branch: string,
  context: { protectedBranches: ReadonlySet<string>; merged: ReadonlySet<string> },
): RemoteTriage {
  if (context.protectedBranches.has(branch)) {
    return { kind: "kept", kept: { reason: "protected", detail: null } };
  }

  if (context.merged.has(branch)) return { kind: "stale", proof: "ancestry" };

  return { kind: "prove" };
}

export function settleRemote(
  proof: ProofKind,
  remoteBase: string,
  report: string | null,
): RemotePlacement {
  if (proof !== "unproven") return { kind: "stale", proof };
  const detail = `not proven to be in ${remoteBase}`;

  return {
    kind: "kept",
    kept: { reason: "unproven", detail: report === null ? detail : `${detail}; ${report}` },
  };
}
