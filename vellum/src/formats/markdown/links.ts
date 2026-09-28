import type { GroupedDoc } from "../../runtime/protocol.ts";
import type { ProjectPath } from "../../workshop/paths.ts";

export type PlanTarget = {
  readonly doc: ProjectPath;
  readonly workingCopy: ProjectPath;
};

/**
 * The document a link names, or `null` for the new tab its anchor already carries. A target is
 * the plan's author's own spelling, so a bare name reaches any document ending on it, and three
 * answers are read in order: a listed document named in full, then the working copy, which is on
 * no list once a version exists and there names the version the reviewer reads, then a listed
 * document the name only ends. So `plan.md` means the plan under review as it does while
 * drafting, and another directory's `plan.md` answers for it no more.
 */
export function linkedDoc(
  wanted: string,
  docs: readonly GroupedDoc[],
  plan: PlanTarget | null,
): ProjectPath | null {
  const named = docs.find((doc) => doc.path === wanted);

  if (named !== undefined) return named.path;
  const ending = `/${wanted}`;

  if (plan !== null && (plan.workingCopy === wanted || plan.workingCopy.endsWith(ending))) {
    return plan.doc;
  }

  return docs.find((doc) => doc.path.endsWith(ending))?.path ?? null;
}
