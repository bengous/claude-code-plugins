import type { Decision, Pending, PlanWorkspace } from "../protocol.ts";
import type {
  FinalDir,
  ParseResult,
  ProjectPath,
  Slug,
  Version,
  WipDir,
} from "../workspace/paths.ts";
import { parseProjectPath, parseVersion } from "../workspace/paths.ts";
import type { DiskWorkspace } from "../workspace/read.ts";
import { feedbackFile } from "../workspace/read.ts";
import { slugFromFileName, slugFromTitle } from "../workspace/slug.ts";

/**
 * The decisions of a review, as pure functions of plain values. `Review` reads the
 * directory, calls one of these, then applies what it says: a file to write, a memory to
 * keep. Nothing here touches the disk, so every case is a plain call in a test.
 */

/** What the directory cannot say: the steps between Approve and the rename, and a rename that failed. */
export type Memory =
  | { readonly kind: "none" }
  | { readonly kind: "approvedPending"; readonly version: Version }
  | { readonly kind: "finalizing"; readonly version: Version; readonly to: FinalDir }
  | { readonly kind: "finalizeError"; readonly version: Version; readonly error: string }
  | { readonly kind: "approved"; readonly version: Version; readonly dir: FinalDir };

/** The workspace as the page and the hooks module see it: the directory, overlaid with the memory. */
export function workspaceOf(disk: DiskWorkspace, memory: Memory, workdir: WipDir): PlanWorkspace {
  if (memory.kind === "approved") {
    return { kind: "approved", dir: memory.dir, version: memory.version };
  }

  if (memory.kind === "finalizing") {
    return { kind: "finalizing", from: workdir, to: memory.to, version: memory.version };
  }

  if (disk.kind === "inReview" && memory.kind === "approvedPending") {
    return { kind: "approvedPending", dir: disk.dir, version: disk.version };
  }

  if (disk.kind === "inReview" && memory.kind === "finalizeError") {
    return { ...disk, finalizeError: memory.error };
  }

  return disk;
}

/** What the hooks module must relay to Claude, read off the workspace: nothing is kept beside it. */
export function pendingOf(workspace: PlanWorkspace): Pending {
  if (workspace.kind === "changesRequested") {
    return {
      kind: "feedback",
      version: workspace.version,
      path: projectPath(`${workspace.dir}${feedbackFile(workspace.version)}`),
    };
  }

  if (workspace.kind === "approvedPending") {
    return { kind: "approved", version: workspace.version };
  }

  return { kind: "none" };
}

export type Gated =
  | { readonly kind: "kept"; readonly version: Version }
  | { readonly kind: "recorded"; readonly version: Version };

/**
 * Which version a submitted plan is. The latest version, still under review or already
 * approved in the browser, keeps its number when the text is the same (a repeated call, or
 * the approval's second call); after a feedback the resubmission is a new round, since the
 * artifacts may have changed while the text did not.
 */
export function gateVersion(
  workspace: PlanWorkspace,
  latestText: string | null,
  plan: string,
): Gated {
  const latest = workspace.kind === "drafting" ? null : workspace.version;
  const kept = latest !== null && workspace.kind !== "changesRequested" && latestText === plan;

  if (latest !== null && kept) return { kind: "kept", version: latest };
  const next = parseVersion((latest ?? 0) + 1);

  if (!next.ok) throw new Error(next.error);

  return { kind: "recorded", version: next.value };
}

export type Decided =
  | { readonly kind: "refused" }
  | { readonly kind: "approve"; readonly memory: Memory }
  | { readonly kind: "feedback"; readonly path: ProjectPath; readonly version: Version };

/** A decision is taken on a plan under review and on nothing else. */
export function decideOn(workspace: PlanWorkspace, decision: Decision): Decided {
  if (workspace.kind !== "inReview") return { kind: "refused" };

  if (decision.kind === "approve") {
    return { kind: "approve", memory: { kind: "approvedPending", version: workspace.version } };
  }

  return {
    kind: "feedback",
    path: projectPath(`${workspace.dir}${feedbackFile(workspace.version)}`),
    version: workspace.version,
  };
}

/** The final directory's name: the plan's title, else the plan file's name. */
export function slugFor(plan: string, planFilePath: string | null): ParseResult<Slug> {
  const fromTitle = slugFromTitle(plan);

  return fromTitle.ok ? fromTitle : slugFromFileName(planFilePath ?? "plan.md");
}

function projectPath(path: string): ProjectPath {
  const parsed = parseProjectPath(path);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}
