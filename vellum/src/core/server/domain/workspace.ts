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

/** What the reviewer tells Claude with an approval; it stays beside the version it approves. */
export function notesFile(version: Version): string {
  return `${REVIEW_DIR}/v${version}.notes.md`;
}

/** The page's unsent work, kept for a reload; a decision that lands removes it. */
export const DRAFT_FILE = `${REVIEW_DIR}/draft.json`;

/**
 * What one Send wrote, numbered under the version it was sent on: `v0` before the first version,
 * which sorts under every version. A Send changes no stage, so a version takes any number of them.
 */
export function batchFile(version: Version | null, batch: number): string {
  return `${REVIEW_DIR}/v${version ?? 0}.feedback-${batch}.md`;
}

const BATCH = /^v(\d+)\.feedback-([1-9]\d*)\.md$/u;

/** The version and the number a batch's file name says; `null` for any other name. */
export function batchOf(name: string): { readonly version: number; readonly batch: number } | null {
  const match = BATCH.exec(name);

  return match === null ? null : { version: Number(match[1]), batch: Number(match[2]) };
}

const LEGACY_FEEDBACK = /^v([1-9]\d*)\.feedback\.md$/u;

/**
 * The batch a feedback file of vellum before 0.14.5 becomes: one feedback per version, the page
 * locked until the next, so it is that version's first batch. `null` for any other name.
 */
export function legacyBatch(name: string): string | null {
  const version = LEGACY_FEEDBACK.exec(name)?.[1];

  return version === undefined ? null : `v${version}.feedback-1.md`;
}

/** How many batches the listing holds for `version`, `null` for the ones sent before the first. */
export function batchesOf(names: ReadonlySet<string>, version: Version | null): number {
  return [...names].filter((name) => batchOf(name)?.version === (version ?? 0)).length;
}

/**
 * The directory's listing overlaid with the memory; the two agree on every variant. `batches`
 * counts the Sends on the version under review, the ones before the first version while drafting.
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

  const batches = batchesOf(names, latest);

  if (latest === null) return { ok: true, value: { kind: "drafting", dir: wip.value, batches } };

  return {
    ok: true,
    value: { kind: "inReview", dir: wip.value, version: latest, batches, finalizeError: null },
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
 * Comments are taken before the first version and on a version under review: everywhere but
 * approved, where nothing the reviewer adds could be sent, and no decision would remove a draft.
 */
export function takesComments(workspace: PlanWorkspace): boolean {
  return workspace.kind === "drafting" || workspace.kind === "inReview";
}

export function projectPath(path: string): ProjectPath {
  const parsed = parseProjectPath(path);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}
