import type { Annotation, Choice, ChoiceRef, DecisionKey, SentChoice } from "./feedback.ts";
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

/** The options chosen in mockups, by mockup path, then by decision: one choice per decision and per mockup. */
export type Choices = Readonly<Record<string, Readonly<Record<DecisionKey, Choice>>>>;

/**
 * The page's unsent work: the comments, the reviewer's edit with the version it edits, the options
 * chosen in mockups, and what is typed. The approval note alone stays out of it: its popover
 * closes on success only.
 */
export type Draft = {
  readonly annotations: readonly Annotation[];
  readonly edit: Edit | null;
  readonly choices: Choices;
  readonly typed: Typed;
};

/** Every choice `choices` holds, in its order. */
export function choicesIn(choices: Choices): readonly SentChoice[] {
  return Object.entries(choices).flatMap(([doc, decisions]) =>
    Object.entries(decisions).map(([decision, choice]) => ({
      // SAFETY: a key of `Choices` is a mockup's path, as `choose` and the draft's parser write it.
      doc: doc as ProjectPath,
      decision,
      ...choice,
    })),
  );
}

/** What a Send names of a choice: its place and its option. */
export function refOf(choice: ChoiceRef): ChoiceRef {
  return { doc: choice.doc, decision: choice.decision, option: choice.option };
}

/**
 * `choices` without those named, each while it is still the option named: one chosen since stays.
 * The same object when none named is held, so what compares it by identity sees no change.
 */
export function withoutChoices(choices: Choices, named: readonly ChoiceRef[]): Choices {
  const gone = new Set(named.map(({ doc, decision, option }) => choiceKey(doc, decision, option)));

  const held = Object.entries(choices).some(([doc, decisions]) =>
    Object.entries(decisions).some(([decision, { option }]) =>
      gone.has(choiceKey(doc, decision, option)),
    ),
  );

  if (!held) return choices;

  const kept = Object.entries(choices).map(
    ([doc, decisions]) =>
      [
        doc,
        Object.fromEntries(
          Object.entries(decisions).filter(
            ([decision, { option }]) => !gone.has(choiceKey(doc, decision, option)),
          ),
        ),
      ] as const,
  );

  return Object.fromEntries(kept.filter(([, decisions]) => Object.keys(decisions).length > 0));
}

function choiceKey(doc: string, decision: DecisionKey, option: string): string {
  return JSON.stringify([doc, decision, option]);
}

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
  return (
    draft.annotations.length === 0 &&
    draft.edit === null &&
    choicesIn(draft.choices).length === 0 &&
    typedIsEmpty(draft.typed)
  );
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

/**
 * What a Send takes of the draft, as the reviewer saw it at the click: the comments by id, the
 * edit by the version it edits, `null` for none, and the choices by their option.
 */
export type Taking = {
  readonly annotations: readonly string[];
  readonly edit: Version | null;
  readonly choices: readonly ChoiceRef[];
};

/**
 * A Send as the page asks it: what it takes, whether the extensions' parts go (the bar's Send,
 * never Send now), and the ids of the questions the reviewer agreed to leave to their
 * recommendation.
 */
export type SendRequest = Taking & {
  readonly parts: boolean;
  readonly takeDefaults: readonly string[];
};

/**
 * Why a Send takes nothing: an approved plan; a comment, a choice or an edit the draft no longer
 * holds as named; an edit of a version no longer under review; a comment on the plan sent without
 * the edit whose lines it was moved to.
 */
export type SendRefused = "approved" | "changed" | "stale" | "edit";

/**
 * An edit a Send left in the draft, since `held` holds the review: no version opens under it. The
 * comments on the plan's lines stay with it, by id, since their lines are the edit's.
 */
export type EditKept = { readonly held: string; readonly annotations: readonly string[] };

/** What a Send writes, decided before anything is written. */
export type Sending =
  | { readonly kind: "refused"; readonly reason: SendRefused }
  | {
      readonly kind: "send";
      /** The version the batch is sent on: the edit's once it lands, `null` while drafting. */
      readonly version: Version | null;
      readonly edit: Written | null;
      readonly editedFrom: Version | null;
      /** The comments sent, the plan's retargeted to the edit's version. */
      readonly annotations: readonly Annotation[];
      readonly choices: readonly SentChoice[];
      /** What the draft keeps: everything the Send did not take. */
      readonly rest: Draft;
      readonly editKept: EditKept | null;
    };

export const EMPTY_DRAFT: Draft = { annotations: [], edit: null, choices: {}, typed: EMPTY_TYPED };

/** The choices named that the draft holds as named, each once; `null` when one of them it does not. */
function choicesNamed(choices: Choices, named: readonly ChoiceRef[]): readonly SentChoice[] | null {
  const once = [
    ...new Map(
      named.map((ref) => [choiceKey(ref.doc, ref.decision, ref.option), ref] as const),
    ).values(),
  ];

  const sent = once.flatMap((ref) => {
    const held = choices[ref.doc]?.[ref.decision];

    return held?.option === ref.option ? [{ ...ref, ...held }] : [];
  });

  return sent.length === once.length ? sent : null;
}

/**
 * A Send takes comments and choices before the first version and on the version under review,
 * exactly the ones named, and the edit when named, which lands as the next version, the batch
 * sent on it. A name the draft no longer holds refuses the whole Send rather than send something
 * else. A comment on the plan left without the pending edit is refused too: `Done` moved its
 * lines to the edit's text. A Send changes no stage: the page takes comments after it. While
 * `held` holds the review, the edit named stays in the draft, and the comments on the plan's lines
 * with it: the rest goes, a general comment on the plan included, since it names no line.
 */
export function sendOn(
  workspace: PlanWorkspace,
  latestText: string | null,
  draft: Draft,
  taking: Taking,
  held: string | null = null,
): Sending {
  if (workspace.kind === "approved") return { kind: "refused", reason: "approved" };
  const named = new Set(taking.annotations);
  const sent = draft.annotations.filter((annotation) => named.has(annotation.id));
  const choices = choicesNamed(draft.choices, taking.choices);
  const editNamed = taking.edit !== null;

  if (
    sent.length !== named.size ||
    choices === null ||
    (editNamed && draft.edit?.version !== taking.edit)
  ) {
    return { kind: "refused", reason: "changed" };
  }

  const rest: Draft = {
    ...draft,
    annotations: draft.annotations.filter((annotation) => !named.has(annotation.id)),
    edit: editNamed ? null : draft.edit,
    choices: withoutChoices(draft.choices, choices),
  };

  if (workspace.kind === "drafting") {
    return editNamed
      ? { kind: "refused", reason: "stale" }
      : {
          kind: "send",
          version: null,
          edit: null,
          editedFrom: null,
          annotations: sent,
          choices,
          rest,
          editKept: null,
        };
  }

  const { dir, version: reviewed } = workspace;
  const plan = versionPath(dir, reviewed);

  if (!editNamed && draft.edit !== null && sent.some((annotation) => annotation.doc === plan)) {
    return { kind: "refused", reason: "edit" };
  }

  const edited = editOf(workspace, latestText, editNamed ? draft.edit : null);

  if (edited === "stale") return { kind: "refused", reason: "stale" };
  const { version, edit } = edited;

  if (held !== null && edit !== null) {
    const onEdit = (annotation: Annotation): boolean =>
      annotation.doc === plan && annotation.anchor.kind !== "global";

    return {
      kind: "send",
      version: reviewed,
      edit: null,
      editedFrom: null,
      annotations: sent.filter((annotation) => !onEdit(annotation)),
      choices,
      rest: {
        ...rest,
        annotations: draft.annotations.filter(
          (annotation) => !named.has(annotation.id) || onEdit(annotation),
        ),
        edit: draft.edit,
      },
      editKept: { held, annotations: sent.filter((one) => onEdit(one)).map(({ id }) => id) },
    };
  }

  return {
    kind: "send",
    version,
    edit,
    editedFrom: edit === null ? null : reviewed,
    annotations: retargetAnnotations(sent, plan, versionPath(dir, version)),
    choices,
    rest,
    editKept: null,
  };
}

/** The final directory's name: the plan's title, else the plan file's own name. */
export function slugFor(plan: string): ParseResult<Slug> {
  const fromTitle = slugFromTitle(plan);

  return fromTitle.ok ? fromTitle : slugFromFileName(PLAN_FILE);
}
