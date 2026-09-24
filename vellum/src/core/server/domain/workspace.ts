import type { FinalDir, ParseResult, ProjectPath, Version, WipDir } from "./paths.ts";
import { parseProjectPath, parseVersion, parseWipDir } from "./paths.ts";

/**
 * The plan's working directory as a state: what its `.review/` listing says, what the
 * server remembers between Approve and the rename, and what the two make together.
 */

export const REVIEW_DIR = ".review";

/** Whether a project path lies under a `.review/`: the server's own files, never the plan's. */
export function underReviewDir(path: string): boolean {
  return path.split("/").includes(REVIEW_DIR);
}

/** The plan the model writes and `submit` sends for review, at the working directory's root. */
export const PLAN_FILE = "plan.md";

export function versionFile(version: Version): string {
  return `${REVIEW_DIR}/v${version}.md`;
}

export function feedbackFile(version: Version): string {
  return `${REVIEW_DIR}/v${version}.feedback.md`;
}

/** What the reviewer tells Claude with an approval; it stays beside the version it approves. */
export function notesFile(version: Version): string {
  return `${REVIEW_DIR}/v${version}.notes.md`;
}

/** The page's unsent work, kept for a reload; a decision that lands removes it. */
export const DRAFT_FILE = `${REVIEW_DIR}/draft.json`;

/** A batch of comments sent before the first version; `v0` sorts under no version. */
export function draftFeedbackFile(batch: number): string {
  return `${REVIEW_DIR}/v0.feedback-${batch}.md`;
}

/**
 * The directory's listing overlaid with the memory; the two agree on every variant. `batches`
 * counts the drafting feedback sent before the first version; it stays on `inReview`, since a
 * batch sent in the second before the gate is still Claude's to read.
 */
export type PlanWorkspace =
  | { readonly kind: "drafting"; readonly dir: WipDir; readonly batches: number }
  | {
      readonly kind: "inReview";
      readonly dir: WipDir;
      readonly version: Version;
      readonly batches: number;
      readonly finalizeError: string | null;
    }
  | { readonly kind: "changesRequested"; readonly dir: WipDir; readonly version: Version }
  | {
      readonly kind: "approved";
      readonly dir: FinalDir;
      readonly version: Version;
      /** Whether the approved version has a notes file. */
      readonly notes: boolean;
    };

/**
 * What the directory cannot say: a rename that failed, and the one that landed. `notes` is read
 * from the final directory's listing, never from the decision: a retried approval carries no note.
 */
export type Memory =
  | { readonly kind: "none" }
  | { readonly kind: "finalizeError"; readonly version: Version; readonly error: string }
  | {
      readonly kind: "approved";
      readonly version: Version;
      readonly dir: FinalDir;
      readonly notes: boolean;
    };

const DRAFT_FEEDBACK = /^v0\.feedback-\d+\.md$/u;

function draftBatches(names: ReadonlySet<string>): number {
  let batches = 0;

  for (const name of names) if (DRAFT_FEEDBACK.test(name)) batches += 1;

  return batches;
}

function latestVersion(names: ReadonlySet<string>): Version | null {
  let latest: Version | null = null;

  for (const name of names) {
    const match = /^v(\d+)\.md$/u.exec(name);
    const parsed = match?.[1] === undefined ? null : parseVersion(Number(match[1]));

    if (parsed?.ok === true && (latest === null || parsed.value > latest)) latest = parsed.value;
  }

  return latest;
}

/** The state a `.review/` listing spells: `names` are the entries of that directory, none when it is missing. */
export function workspaceFromListing(
  dir: WipDir | FinalDir,
  names: ReadonlySet<string>,
): ParseResult<PlanWorkspace> {
  const latest = latestVersion(names);
  const wip = parseWipDir(dir);

  if (!wip.ok) {
    // SAFETY: `dir` is `WipDir | FinalDir` and `parseWipDir` just refused it, so it is the FinalDir.
    return latest === null
      ? { ok: false, error: `${dir} holds no .review/vN.md` }
      : {
          ok: true,
          value: {
            kind: "approved",
            dir: dir as FinalDir,
            version: latest,
            notes: names.has(`v${latest}.notes.md`),
          },
        };
  }

  if (latest === null) {
    return { ok: true, value: { kind: "drafting", dir: wip.value, batches: draftBatches(names) } };
  }

  return names.has(`v${latest}.feedback.md`)
    ? { ok: true, value: { kind: "changesRequested", dir: wip.value, version: latest } }
    : {
        ok: true,
        value: {
          kind: "inReview",
          dir: wip.value,
          version: latest,
          batches: draftBatches(names),
          finalizeError: null,
        },
      };
}

/** The workspace as the page and the hooks module see it: the directory, overlaid with the memory. */
export function workspaceOf(disk: PlanWorkspace, memory: Memory): PlanWorkspace {
  if (memory.kind === "approved") {
    return { kind: "approved", dir: memory.dir, version: memory.version, notes: memory.notes };
  }

  if (disk.kind === "inReview" && memory.kind === "finalizeError") {
    return { ...disk, finalizeError: memory.error };
  }

  return disk;
}

/**
 * Comments are taken before the first version and on a version under review. In any other state
 * nothing the reviewer adds could be sent, and no decision would remove a draft that holds it.
 */
export function takesComments(workspace: PlanWorkspace): boolean {
  return workspace.kind === "drafting" || workspace.kind === "inReview";
}

export function projectPath(path: string): ProjectPath {
  const parsed = parseProjectPath(path);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}
