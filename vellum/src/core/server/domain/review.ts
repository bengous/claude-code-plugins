import type { Annotation } from "./feedback.ts";
import { formatNotes, retargetAnnotations } from "./feedback.ts";
import type { FinalDir, ParseResult, ProjectPath, Slug, Version, WipDir } from "./paths.ts";
import { parseVersion } from "./paths.ts";
import { slugFromFileName, slugFromTitle } from "./slug.ts";
import type { PlanWorkspace } from "./workspace.ts";
import { notesFile, PLAN_FILE, projectPath, versionFile } from "./workspace.ts";

/**
 * The decisions of a review, as pure functions of plain values. The application reads the
 * directory, calls one of these, then applies what it says: a file to write, a memory to
 * keep. Nothing here touches the disk, so every case is a plain call in a test.
 */

/**
 * The reviewer's own text of the plan, with the version it edits: a bare text could not say
 * that Claude recorded a newer version since, and would overwrite it.
 */
export type Edit = { readonly version: Version; readonly text: string };

/** What the reviewer typed and has not submitted: visible on screen, so never thrown in silence. */
export type Typed = {
  readonly general: string;
  /** By document path: the composer's text, given back to the next composer on that document. */
  readonly composer: Readonly<Record<string, string>>;
  /** By transcript path: the answers by question id, and the note. */
  readonly grill: Readonly<
    Record<string, { readonly answers: Readonly<Record<string, string>>; readonly note: string }>
  >;
  /** The open editor's typing, with the version edited; given back to the next Edit on that version. */
  readonly editor: { readonly version: Version; readonly text: string } | null;
};

export const EMPTY_TYPED: Typed = { general: "", composer: {}, grill: {}, editor: null };

/**
 * The page's unsent work: the comments, the reviewer's edit with the version it edits, and what
 * is typed. The approval note alone stays out of it: its popover closes on success only.
 */
export type Draft = {
  readonly annotations: readonly Annotation[];
  readonly edit: Edit | null;
  readonly typed: Typed;
};

function typedIsEmpty(typed: Typed): boolean {
  return (
    typed.general === "" &&
    Object.values(typed.composer).every((text) => text === "") &&
    typed.editor === null &&
    Object.values(typed.grill).every(
      (entry) => entry.note === "" && Object.values(entry.answers).every((text) => text === ""),
    )
  );
}

/** A draft with nothing in it is no draft: the server removes the file instead of writing it. */
export function draftIsEmpty(draft: Draft): boolean {
  return draft.annotations.length === 0 && draft.edit === null && typedIsEmpty(draft.typed);
}

/**
 * The one decision left to the bar beside a Send: the approval. `edit` is `null` when the reviewer
 * changed nothing, `notes` empty when they left none.
 */
export type Decision = {
  readonly kind: "approve";
  readonly edit: Edit | null;
  readonly notes: string;
};

/**
 * What a reload makes of the page's unsent edit. `landed`: the loaded version is the edit
 * itself, written before a rename or a later write failed. `stale`: another version arrived.
 */
export function editOnLoad(
  edit: Edit,
  loaded: { readonly version: Version; readonly text: string } | null,
): "pending" | "landed" | "stale" {
  if (loaded?.version === edit.version) return "pending";

  return loaded?.version === edit.version + 1 && loaded.text === edit.text ? "landed" : "stale";
}

function nextVersion(after: Version | null): Version {
  const next = parseVersion((after ?? 0) + 1);

  if (!next.ok) throw new Error(next.error);

  return next.value;
}

function versionPath(dir: WipDir | FinalDir, version: Version): ProjectPath {
  return projectPath(`${dir}${versionFile(version)}`);
}

/**
 * The comments of an edit that landed: written on `vN.md` with the edit's lines, they are
 * `vN+1.md`'s. Read from the edit's version, not from what the page showed before: a first load
 * has no before.
 */
export function landedAnnotations(
  annotations: readonly Annotation[],
  dir: WipDir | FinalDir,
  edit: Edit,
): readonly Annotation[] {
  const landed = versionPath(dir, nextVersion(edit.version));

  return retargetAnnotations(annotations, versionPath(dir, edit.version), landed);
}

export type Gated =
  | { readonly kind: "kept"; readonly version: Version }
  | { readonly kind: "recorded"; readonly version: Version };

/**
 * Which version a submitted plan is: the one under review keeps its number when the text is
 * the same. Once the reviewer sent a batch on it, the submission is a new version even with the
 * same text: an artifact revised alone must reopen the review.
 */
export function gateVersion(
  workspace: PlanWorkspace,
  latestText: string | null,
  plan: string,
): Gated {
  const latest = workspace.kind === "drafting" ? null : workspace.version;
  const kept = workspace.kind === "inReview" && workspace.batches === 0 && latestText === plan;

  return latest !== null && kept
    ? { kind: "kept", version: latest }
    : { kind: "recorded", version: nextVersion(latest) };
}

type Written = { readonly path: ProjectPath; readonly text: string };

export type Decided =
  | { readonly kind: "refused" }
  | {
      readonly kind: "approve";
      readonly version: Version;
      readonly edit: Written | null;
      /** `null` writes nothing, so a retry keeps the notes file the first attempt wrote. */
      readonly notes: Written | null;
    };

/**
 * What the reviewer's edit makes of the version under review: the next version, holding the
 * edit's text, which the decision or the Send applies to; `vN.md` stays what Claude submitted.
 * An edit equal to the version's text is no edit, and an edit of another version is stale.
 */
function editOf(
  workspace: Extract<PlanWorkspace, { kind: "inReview" }>,
  latestText: string | null,
  edit: Edit | null,
): { readonly version: Version; readonly edit: Written | null } | "stale" {
  const { dir, version: reviewed } = workspace;

  if (edit !== null && edit.version !== reviewed) return "stale";
  const edited = edit?.text === latestText ? null : (edit?.text ?? null);

  if (edited === null) return { version: reviewed, edit: null };
  const version = nextVersion(reviewed);

  return { version, edit: { path: versionPath(dir, version), text: edited } };
}

/**
 * A plan is approved under review and nowhere else. The reviewer's edit is the next version, and
 * the approval applies to it. Its notes file says the plan was edited, then what the reviewer noted.
 */
export function decideOn(
  workspace: PlanWorkspace,
  latestText: string | null,
  decision: Decision,
): Decided {
  if (workspace.kind !== "inReview") return { kind: "refused" };
  const edited = editOf(workspace, latestText, decision.edit);

  if (edited === "stale") return { kind: "refused" };
  const { version, edit } = edited;
  const editedFrom = edit === null ? null : workspace.version;
  const text = formatNotes(version, editedFrom, decision.notes);
  const path = projectPath(`${workspace.dir}${notesFile(version)}`);

  return { kind: "approve", version, edit, notes: text === null ? null : { path, text } };
}

/** A comment of the draft, named by its id: the one "Send now" takes. */
export type DraftItemRef = { readonly kind: "annotation"; readonly id: string };

/**
 * What a Send takes from the draft: `all` of it, the open round and the edit included, or the
 * items named, which leave the round and the edit where they are.
 */
export type SendItems = "all" | readonly DraftItemRef[];

export type SendRequest = { readonly items: SendItems; readonly takeDefaults: boolean };

/** What a Send writes, decided before the extensions write their part. */
export type Sending =
  | { readonly kind: "refused"; readonly reason: "approved" | "stale" }
  | {
      readonly kind: "send";
      /** The version the batch is sent on: the edit's once it lands, `null` while drafting. */
      readonly version: Version | null;
      readonly edit: Written | null;
      readonly editedFrom: Version | null;
      /** The comments sent, the plan's retargeted to the edit's version. */
      readonly annotations: readonly Annotation[];
      /** What the draft keeps. */
      readonly rest: Draft;
    };

const EMPTY_DRAFT: Draft = { annotations: [], edit: null, typed: EMPTY_TYPED };

/**
 * A Send takes comments before the first version and on the version under review. `all` takes
 * the whole draft, and its edit lands as the next version, the batch sent on it; named items
 * leave the rest of the draft. A Send changes no stage: the page takes comments after it.
 */
export function sendOn(
  workspace: PlanWorkspace,
  latestText: string | null,
  draft: Draft,
  items: SendItems,
): Sending {
  if (workspace.kind === "approved") return { kind: "refused", reason: "approved" };
  const named = items === "all" ? null : new Set(items.map((item) => item.id));
  const sent = draft.annotations.filter((annotation) => named?.has(annotation.id) ?? true);

  if (named !== null) {
    const rest = { ...draft, annotations: draft.annotations.filter((a) => !named.has(a.id)) };
    const version = workspace.kind === "drafting" ? null : workspace.version;

    return { kind: "send", version, edit: null, editedFrom: null, annotations: sent, rest };
  }

  if (workspace.kind === "drafting") {
    return draft.edit === null
      ? {
          kind: "send",
          version: null,
          edit: null,
          editedFrom: null,
          annotations: sent,
          rest: EMPTY_DRAFT,
        }
      : { kind: "refused", reason: "stale" };
  }

  const edited = editOf(workspace, latestText, draft.edit);

  if (edited === "stale") return { kind: "refused", reason: "stale" };
  const { version, edit } = edited;
  const { dir, version: reviewed } = workspace;

  return {
    kind: "send",
    version,
    edit,
    editedFrom: edit === null ? null : reviewed,
    annotations: retargetAnnotations(sent, versionPath(dir, reviewed), versionPath(dir, version)),
    rest: EMPTY_DRAFT,
  };
}

/** The final directory's name: the plan's title, else the plan file's own name. */
export function slugFor(plan: string): ParseResult<Slug> {
  const fromTitle = slugFromTitle(plan);

  return fromTitle.ok ? fromTitle : slugFromFileName(PLAN_FILE);
}
