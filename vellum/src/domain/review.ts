import type { Annotation } from "./feedback.ts";
import type { ParseResult, ProjectPath, Slug, Version } from "./paths.ts";
import { parseVersion } from "./paths.ts";
import { slugFromFileName, slugFromTitle } from "./slug.ts";
import type { Memory, PlanWorkspace } from "./workspace.ts";
import { feedbackFile, projectPath } from "./workspace.ts";

/**
 * The decisions of a review, as pure functions of plain values. The application reads the
 * directory, calls one of these, then applies what it says: a file to write, a memory to
 * keep. Nothing here touches the disk, so every case is a plain call in a test.
 */

export type Decision =
  | { readonly kind: "approve" }
  | { readonly kind: "feedback"; readonly annotations: readonly Annotation[] };

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
