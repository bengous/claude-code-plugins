import { batch, computed, effect, signal } from "@preact/signals";

import type { SendShare } from "../extension.ts";
import type {
  Annotation,
  Choice,
  ChoiceRef,
  Choices,
  DecisionKey,
  Decision,
  Draft,
  Edit,
  GroupedDoc,
  LineDiff,
  Mark,
  ReviewView,
  SendRefused,
  Typed,
} from "../protocol.ts";
import {
  editOnLoad,
  goneWithEdit,
  EMPTY_TYPED,
  landedAnnotations,
  lineDiff,
  shiftAnnotations,
  takesComments,
  unshiftAnnotations,
  choicesIn,
  withoutChoices,
} from "../protocol.ts";
import type { ProjectPath, Version } from "../server/domain/paths.ts";
import { draftWriter, fetchDraft, fetchReview, postDecision, postSend, subscribe } from "./api.ts";
import type { Failure } from "./notices.ts";
import { NEW_LINK_HINT_MS, noticesOf } from "./notices.ts";

export const review = signal<ReviewView | null>(null);

/** The comments not sent yet: a send clears them, and nothing Claude does may. */
export const annotations = signal<readonly Annotation[]>([]);

/**
 * The options chosen in mockups and not sent yet: `choose` and `unchoose` change them, a Send
 * takes out what it sent, an approval clears them, and the saved draft restores them.
 */
export const choices = signal<Choices>({});

/**
 * The choices whose option its mockup no longer holds, as the mockup's frame last read it, at its
 * load and at each change of its choices: page memory, never the draft's.
 */
export const absent = signal<readonly ChoiceRef[]>([]);

/** What the frame of `doc` reads now replaces what it read before. */
export function setAbsent(doc: ProjectPath, found: readonly Omit<ChoiceRef, "doc">[]): void {
  absent.value = [
    ...absent.value.filter((ref) => ref.doc !== doc),
    ...found.map(({ decision, option }) => ({ doc, decision, option })),
  ];
}

export function isAbsent(choice: ChoiceRef): boolean {
  return absent.value.some(
    (ref) =>
      ref.doc === choice.doc && ref.decision === choice.decision && ref.option === choice.option,
  );
}

/** The choices a Send takes: every one whose mockup still holds its option, as far as the page read it. */
export const sendableChoices = computed(() =>
  choicesIn(choices.value).filter((choice) => !isAbsent(choice)),
);

/** What is typed and not submitted, saved with the draft; `setTyped` is its one writer. */
export const typed = signal<Typed>(EMPTY_TYPED);

export function setTyped(patch: Partial<Typed>): void {
  typed.value = { ...typed.value, ...patch };
}

function nameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export type Unsent = readonly { readonly where: string; readonly text: string }[];

/** What a Send would throw: every typed text, named by where it is on screen, but the grill's answers, which leave with it. */
export const strayTyped = computed<Unsent>(() => {
  const { general, composer, editor } = typed.value;
  const found: { readonly where: string; readonly text: string }[] = [];

  if (general.trim() !== "") found.push({ where: "the general box", text: general });

  for (const [path, body] of Object.entries(composer)) {
    if (body.trim() !== "") found.push({ where: `a comment on ${nameOf(path)}`, text: body });
  }

  if (editor !== null) found.push({ where: "the editor", text: editor.text });

  return found;
});

/** What an approval would throw: every typed text, the grill's answers included. */
export const unsentTyped = computed<Unsent>(() => {
  const found = [...strayTyped.value];

  for (const [path, entry] of Object.entries(typed.value.grill)) {
    const texts = [...Object.values(entry.answers), entry.note].filter((t) => t.trim() !== "");

    if (texts.length > 0) {
      const at = found.findIndex(({ where }) => where === "the editor");
      found.splice(at === -1 ? found.length : at, 0, {
        where: `the answers in ${nameOf(path)}`,
        text: texts.join("\n"),
      });
    }
  }

  return found;
});

/** The document shown; `null` is the plan. */
export const current = signal<ProjectPath | null>(null);

export const split = signal(false);

/**
 * Whether the comments panel takes its width: open when the window is wide, folded when narrow,
 * read again at every load, by `readWindow`.
 */
export const commentsOpen = signal(true);

/**
 * The comments' last fold was the layout's, not the reviewer's: it is drawn at once. A panel is
 * known only once its extension loaded, after the first render, and a slide then reads as the
 * page jumping. The handle clears it, so the reviewer's own folds slide.
 */
export const commentsSnap = signal(false);

/** Whether the document rail takes its width: open at every load, whatever the window's width. */
export const railOpen = signal(true);

/** Whether the page draws its dark theme: what resolves tokens outside CSS redraws at each change. */
export const dark = signal(false);

/** The reviewer's switch: off at every load. */
export const commentSwitch = signal(false);

/** Ctrl or Meta held down: a drag or a click adds to the set instead of replacing it. */
export const holding = signal(false);

/** The reviewer's own text of the plan, not sent yet: the next decision records it as the next version. */
export const edited = signal<Edit | null>(null);

/**
 * The open editor: the version and the text it opened on, kept for its whole life whatever
 * loads meanwhile, and the source line its caret starts on. `null` while the plan is rendered;
 * open, nothing can be selected, so comments wait.
 */
export type EditSession = {
  readonly version: Version;
  readonly base: string;
  readonly line: number;
};

export const editing = signal<EditSession | null>(null);

/**
 * The source line to come back to once the editor closes: the plan's renderer scrolls to its
 * block and clears it, and Edit takes the focus; `null` the rest of the time.
 */
export const resume = signal<number | null>(null);

/** "Changes since" is off at every load: the reviewer reads the plan itself first. */
export const showChanges = signal(false);

/** The requests that failed, one per operation: `fail` replaces the operation's entry, `succeed` removes it. */
export const failures = signal<readonly Failure[]>([]);

export function fail(op: Failure["op"], text: string): void {
  failures.value = [...failures.value.filter((failure) => failure.op !== op), { op, text }];
}

export function succeed(op: Failure["op"]): void {
  if (failures.value.some((failure) => failure.op === op)) {
    failures.value = failures.value.filter((failure) => failure.op !== op);
  }
}

/**
 * The edit a Send left in the draft, and what held the review, in the server's words: the notice
 * says so while that very edit waits and until the page reads that nothing holds the review.
 */
export const editWaits = signal<{ readonly held: string; readonly edit: Edit } | null>(null);

/**
 * What the last Delete of a card can undo, for `UNDO_MS`; `null` past that, once undone, and
 * after a decision, Done or Discard edit, which the comment it holds was made before.
 */
export const undo = signal<{ readonly label: string; readonly run: () => void } | null>(null);

let undoTimer: ReturnType<typeof setTimeout> | null = null;

function clearUndo(): void {
  if (undoTimer !== null) clearTimeout(undoTimer);
  undoTimer = null;

  if (undo.peek() !== null) undo.value = null;
}

/**
 * The card the reviewer is on, by its annotation's id: hovered or focused, the plan's renderer
 * highlights its passage; clicked (`reveal`), it scrolls to it as well. `null` off any card.
 */
export const focused = signal<{ readonly id: string; readonly reveal: boolean } | null>(null);

export const connection = signal<"up" | "down">("up");

/** When the stream first failed, and how long ago as far as the notice cares: `0`, then past the hint's delay. */
const downAt = signal<number | null>(null);

const downFor = signal<number | null>(null);

export const planDoc = computed<GroupedDoc | null>(() => {
  const plan = review.value?.plan;

  // A version's file never changes: its path is the whole key.
  return plan === null || plan === undefined
    ? null
    : { path: plan.doc, mediaType: "text/markdown", modified: 0, group: "plan" };
});

/** The plan's text as shown: the reviewer's unsent edit of it, else the version's. */
export const planText = computed(() => edited.value?.text ?? review.value?.plan?.text ?? null);

const previousText = computed(() => review.value?.plan?.previous?.text ?? null);

/**
 * The plan, or the reviewer's edit of it, against the version before; `null` at v1. Computed
 * from the two texts, not from `review`: every workspace event loads a new view, and the same
 * texts keep the same diff.
 */
export const planChanges = computed<LineDiff | null>(() =>
  planText.value === null || previousText.value === null
    ? null
    : lineDiff(previousText.value, planText.value),
);

export const docs = computed<readonly GroupedDoc[]>(() => {
  const plan = planDoc.value;
  const listed = review.value?.docs ?? [];

  return plan === null ? listed : [plan, ...listed];
});

/** The selected document, or, once a version or an approval took it off the list, the plan or the first one. */
export const currentDoc = computed<GroupedDoc | null>(() => {
  const list = docs.value;

  return list.find((doc) => doc.path === current.value) ?? planDoc.value ?? list[0] ?? null;
});

/** Comments are taken on a plan under review and while drafting; an approved one locks the page. */
export const locked = computed(() => {
  const workspace = review.value?.workspace;

  return workspace === undefined || !takesComments(workspace);
});

/** Whether a renderer starts a comment now: the switch is on and the page takes comments. */
export const commenting = computed(() => commentSwitch.value && !locked.value);

/** The switch clicked or `C` pressed; a locked page keeps its switch as it is. */
export function flipCommentSwitch(): void {
  if (locked.value) return;
  commentSwitch.value = !commentSwitch.value;
}

/** What a load makes of the unsent edit: kept, cleared because it landed, or dropped with a banner. */
function settleEdit(view: ReviewView): void {
  const edit = edited.value;
  const { workspace, plan } = view;

  if (edit === null) return;

  const fate = editOnLoad(
    edit,
    workspace.kind === "drafting" || plan === null
      ? null
      : { version: workspace.version, text: plan.text },
  );

  if (fate === "pending") return;
  edited.value = null;

  if (fate === "stale") {
    fail(
      "edit",
      `Your unsent edit of v${edit.version} was dropped: another version of the plan arrived. Your comments are kept.`,
    );

    return;
  }

  // Landed: the loaded version is the edit, and the comments' lines were shifted to its text already.
  annotations.value = landedAnnotations(annotations.value, workspace.dir, edit);
}

async function loadReview(): Promise<void> {
  const fetched = await fetchReview().catch(() => null);

  if (fetched === null || !fetched.ok) {
    fail(
      "review",
      fetched === null
        ? "The review could not be loaded: the server did not answer."
        : `The review could not be loaded: the server answered ${fetched.status}.`,
    );

    return;
  }

  batch(() => {
    succeed("review");
    review.value = fetched.value;
    settleEdit(fetched.value);
    settleEditorTyping(fetched.value);

    if (fetched.value.held === null) editWaits.value = null;
  });
}

/** The editor's typing goes with the version it was typed on: no Edit opens on another one. */
function settleEditorTyping(view: ReviewView): void {
  const { editor } = typed.peek();
  const { workspace } = view;

  if (editor === null) return;

  if (workspace.kind === "inReview" && workspace.version === editor.version) return;
  setTyped({ editor: null });
}

/** Clears what an approval took: the comments, the edit, the choices, what is typed. */
function clearDraft(): void {
  batch(() => {
    annotations.value = [];
    edited.value = null;
    choices.value = {};
    typed.value = EMPTY_TYPED;
    clearUndo();
    succeed("decision");
  });
}

/** `true` once the server took the decision; a refusal or a server that did not answer is a failure the notices show. */
export async function decide(decision: Decision): Promise<boolean> {
  const status = await postDecision(decision).catch(() => null);

  if (status === null) {
    fail("decision", "The decision did not reach the server. Your comments are kept in this tab.");

    return false;
  }

  if (status === 409) fail("decision", "This version was already decided.");
  else if (status >= 300) {
    fail("decision", `Not sent: the server answered ${status}. Your comments are kept.`);
  } else clearDraft();

  await loadReview();

  return status < 300;
}

/**
 * A write out to the review that takes from the draft, a Send or End grill: every way to either
 * waits, so nothing is sent twice. A Send stays out until the page has read again what it left.
 */
export const sending = signal(false);

/** Runs `work` as the one write out; `null`, running nothing, while another is. */
export async function outOnce<T>(work: () => Promise<T>): Promise<T | null> {
  if (sending.peek()) return null;
  sending.value = true;

  try {
    return await work();
  } finally {
    sending.value = false;
  }
}

/**
 * Writes the draft as the page shows it and answers whether the server kept it; `startSaving`
 * binds it, and `null` is a page whose first read of the draft failed, so it saves nothing yet.
 */
let flushDraft: (() => Promise<boolean>) | null = null;

/**
 * The draft written now, as the page shows it: what the server reads next is what is on screen.
 * `true` once kept. A page that could not read the draft at its load reads it again first: none
 * saved starts the saving; one saved that this tab never loaded is never written over.
 */
export async function writeDraft(): Promise<boolean> {
  if (flushDraft !== null) return await flushDraft();
  const saved = await fetchDraft().catch(() => null);

  if (saved?.ok !== true || saved.value !== null) {
    fail(
      "draft",
      saved?.ok === true
        ? "A saved draft this tab did not load is on the server: reload the page to see it before you send."
        : (saved?.reason ?? "The saved draft still cannot be read: nothing is sent."),
    );

    return false;
  }

  succeed("draft");

  return await startSaving()();
}

export type Sent =
  | { readonly kind: "sent" }
  | { readonly kind: "unanswered"; readonly ids: readonly string[] }
  | { readonly kind: "failed" };

/**
 * A Send as the reviewer clicked it, snapshotted at the click: the comments on screen by id, the
 * edit, the choices by their option, each extension's share (`null` for Send now, which takes no
 * part), and the question ids the bar warned about and the reviewer agreed to leave to their
 * recommendation.
 */
export type Outgoing = {
  readonly annotations: readonly string[];
  readonly edit: Edit | null;
  readonly choices: readonly ChoiceRef[];
  readonly parts: readonly SendShare[] | null;
  readonly takeDefaults: readonly string[];
};

const REFUSED: Readonly<Record<SendRefused | "empty" | "unreadable", string>> = {
  approved: "Not sent: the plan is approved.",
  changed:
    "Not sent: the saved draft no longer holds what you sent, changed in another tab. Reload the page.",
  edit: "Not sent: a comment on the plan goes with your edit. Send them together with Send.",
  empty: "Not sent: nothing to send. Your comments are kept.",
  stale: "Not sent: your edit is of a version no longer under review. Your comments are kept.",
  unreadable: "Not sent: the saved draft cannot be read. Your comments are kept in this tab.",
};

/**
 * One Send, the one write out while it lasts. The server sends from the draft it keeps what the
 * snapshot names, so the page writes the draft first. Once taken, the page reads the review and
 * each part its state again, then takes out exactly what was sent: a comment added since stays,
 * and what is typed stays where it is. Questions no answer takes come back as their ids, for the
 * bar to ask about before it leaves them to their recommendation.
 */
export async function send(out: Outgoing): Promise<Sent> {
  return (await outOnce(() => sendOut(out))) ?? { kind: "failed" };
}

async function sendOut(out: Outgoing): Promise<Sent> {
  if (!(await writeDraft())) {
    fail(
      "decision",
      "Not sent: your comments are not saved on the server. They are kept in this tab.",
    );

    return { kind: "failed" };
  }

  const posted = await postSend({
    annotations: out.annotations,
    edit: out.edit?.version ?? null,
    choices: out.choices,
    parts: out.parts !== null,
    takeDefaults: out.takeDefaults,
  }).catch(() => null);

  if (posted === null) {
    fail("decision", "The Send did not reach the server. Your comments are kept in this tab.");

    return { kind: "failed" };
  }

  const { status, answer } = posted;

  if (status === 409 && answer !== null && "reason" in answer) {
    if (answer.reason === "unanswered") return { kind: "unanswered", ids: answer.ids };

    if (answer.reason === "held") {
      const { held } = answer;

      batch(() => {
        editWaits.value = out.edit === null ? null : { held, edit: out.edit };
        succeed("decision");
      });

      return { kind: "failed" };
    }

    fail("decision", REFUSED[answer.reason]);

    return { kind: "failed" };
  }

  // A 400 is a Send the server could not read: this page's code is older than the server's.
  if (status === 400) {
    fail(
      "decision",
      "Not sent: this page is older than its server, which could not read the Send. Reload the page: your comments are saved.",
    );

    return { kind: "failed" };
  }

  if (status >= 300) {
    fail("decision", `Not sent: the server answered ${status}. Your comments are kept.`);

    return { kind: "failed" };
  }

  await loadReview();
  await Promise.all((out.parts ?? []).map((part) => part.sent()));
  const editKept = answer !== null && "editKept" in answer ? answer.editKept : null;
  const kept = new Set(editKept?.annotations);
  const taken = new Set(out.annotations.filter((id) => !kept.has(id)));
  const sentEdit = editKept === null ? out.edit : null;

  batch(() => {
    annotations.value = annotations.value.filter(({ id }) => !taken.has(id));
    choices.value = withoutChoices(choices.value, out.choices);

    if (sentEdit !== null && edited.peek()?.version === sentEdit.version) edited.value = null;

    // A Send with no edit, Send now, leaves the notice of one that still waits.
    if (out.edit !== null) {
      editWaits.value = editKept === null ? null : { held: editKept.held, edit: out.edit };
    }

    succeed("decision");
  });

  return { kind: "sent" };
}

/** Edit: the editor opens on the version under review, on the unsent edit of it when there is one. */
export function openEditor(line: number): void {
  const view = review.value;

  if (view?.workspace.kind !== "inReview" || view.plan === null) return;
  const { version } = view.workspace;
  editing.value = { version, base: edited.value?.text ?? view.plan.text, line };
}

/**
 * Done, with the session the editor opened on and the text typed: the comments follow their lines
 * through the edit, and an edit back to the version's text is no edit. When another version
 * arrived meanwhile, or this one was decided elsewhere, nothing is recorded, under the notice
 * `staleEditor` derives: the typing must stay reachable. `closeEditor` is what closes.
 */
export function finishEdit(session: EditSession, text: string): void {
  const { version, base } = session;
  const view = review.value;

  if (view === null || view.plan === null || view.workspace.kind === "drafting") return;

  if (view.workspace.kind !== "inReview" || view.workspace.version !== version) return;

  const { doc, text: reviewed } = view.plan;

  batch(() => {
    annotations.value = shiftAnnotations(annotations.value, doc, { version: reviewed, base, text });
    edited.value = text === reviewed ? null : { version, text };
    clearUndo();
    succeed("edit");
  });
}

/** Done and Cancel both end here: the editor closes, and the plan comes back at `atLine`. */
export function closeEditor(atLine: number): void {
  batch(() => {
    editing.value = null;
    resume.value = atLine;
  });
}

/** The comments Discard edit takes whole, as its confirmation counts them before the click. */
export const goneOnDiscard = computed(() => {
  const edit = edited.value;
  const plan = review.value?.plan ?? null;

  return edit === null || plan === null
    ? 0
    : goneWithEdit(annotations.value, plan.doc, { version: plan.text, edit: edit.text });
});

/**
 * Discard edit, the reverse of Done: the version's text again, the comments back on its lines,
 * but for those on a line only the edit held, which go with it.
 */
export function discardEdit(): void {
  const edit = edited.value;
  const plan = review.value?.plan ?? null;

  if (edit === null || plan === null) return;

  batch(() => {
    annotations.value = unshiftAnnotations(annotations.value, plan.doc, {
      version: plan.text,
      edit: edit.text,
    });
    edited.value = null;
    clearUndo();
  });
}

/** The one way a comment enters the page, as `select` is for navigation: a locked page takes none. */
export function addAnnotation(annotation: Omit<Annotation, "id">): void {
  if (locked.value) return;
  annotations.value = [...annotations.value, { ...annotation, id: crypto.randomUUID() }];
}

/**
 * A choice in a mockup: another option of the same decision replaces it, and the option already
 * chosen, chosen again, withdraws it; a locked page takes none.
 */
export function choose(doc: ProjectPath, decision: DecisionKey, choice: Choice): void {
  if (locked.value) return;

  choices.value =
    choices.value[doc]?.[decision]?.option === choice.option
      ? withoutChoices(choices.value, [{ doc, decision, option: choice.option }])
      : { ...choices.value, [doc]: { ...choices.value[doc], [decision]: choice } };
}

/** A choice card's Delete: the choice leaves the draft, its mark the mockup. */
export function unchoose(named: ChoiceRef): void {
  choices.value = withoutChoices(choices.value, [named]);
}

/** How long a deleted card can be undone from the notice. */
const UNDO_MS = 8_000;

/**
 * Delete on a card: at once, and undone from the notice for a while; a second Delete replaces
 * the first's undo. Undone on a page that locked meanwhile, the comment stays gone, as
 * `addAnnotation` takes none.
 */
export function removeAnnotation(id: string): void {
  const index = annotations.value.findIndex((annotation) => annotation.id === id);
  const gone = annotations.value[index];

  if (gone === undefined) return;
  annotations.value = annotations.value.filter((annotation) => annotation.id !== id);
  clearUndo();
  undoTimer = setTimeout(clearUndo, UNDO_MS);

  undo.value = {
    label: "Undo",
    run: () => {
      batch(() => {
        clearUndo();

        if (!locked.peek()) annotations.value = annotations.value.toSpliced(index, 0, gone);
      });
    },
  };
}

/** A card's Edit: the mark changes, the place stays. */
export function updateAnnotation(id: string, mark: Mark): void {
  annotations.value = annotations.value.map((annotation) =>
    annotation.id === id ? { ...annotation, mark } : annotation,
  );
}

export function select(path: ProjectPath): void {
  if (editing.value !== null) return;
  current.value = path;

  if (path === planDoc.value?.path) split.value = false;
}

const putDraft = draftWriter();

/** Never rejects: the saves are chained, and one rejection would silence every save after it. `true` once kept. */
async function saveDraft(draft: Draft): Promise<boolean> {
  try {
    const status = await putDraft(draft);

    if (status >= 300) {
      fail(
        "draft",
        `Your comments are kept in this tab, not saved: the server answered ${status}.`,
      );

      return false;
    }

    succeed("draft");

    return true;
  } catch {
    fail("draft", "Your comments are kept in this tab, not saved: the server did not answer.");

    return false;
  }
}

/**
 * What the window says, read by `app.tsx` before the first render: the width once, the colour
 * scheme for as long as the page lives. The 900px threshold is `style.css`'s media query as well,
 * since no `@media` reads a CSS property: whoever moves one moves the other.
 */
export function readWindow(): void {
  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

  batch(() => {
    commentsOpen.value = !window.matchMedia("(max-width: 900px)").matches;
    dark.value = darkScheme.matches;
  });

  darkScheme.addEventListener("change", (event) => {
    dark.value = event.matches;
  });
}

/** How long a typing pauses before the draft is written: a continuous typing is one write. */
const TYPED_WRITE_MS = 300;

function draftShown(): Draft {
  return {
    annotations: annotations.peek(),
    edit: edited.peek(),
    choices: choices.peek(),
    typed: typed.peek(),
  };
}

/**
 * Saves the draft at every change of the comments, the edit or the choices, each change one
 * write, and once a typing pauses, in order; answers the flush a Send runs first. When the page is
 * hidden or closed while a write waits, a typing pausing or a write queued, the draft shown is
 * sent at once, and the writes it overtook never start.
 */
function startSaving(): () => Promise<boolean> {
  let saving = Promise.resolve(true);
  let pending: ReturnType<typeof setTimeout> | null = null;
  let written = typed.peek();
  let queued = 0;
  let started = 0;

  // In order: two changes close together must not reach the file reversed. `now` starts the write
  // within the caller, for a page that may not outlive it, and an older write never starts after it.
  const write = (unsent: Draft, now = false): void => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
    written = unsent.typed;
    queued += 1;
    const mine = queued;

    const put = (): Promise<boolean> => {
      if (mine < started) return Promise.resolve(true);
      started = mine;

      return saveDraft(unsent);
    };

    if (now) {
      const sent = put();
      saving = saving.then(() => sent);
    } else saving = saving.then(put);
  };

  const flush = (): Promise<boolean> => {
    write(draftShown());

    return saving;
  };

  flushDraft = flush;

  effect(() => {
    write({
      annotations: annotations.value,
      edit: edited.value,
      choices: choices.value,
      typed: typed.peek(),
    });
  });

  // A typing is written once it pauses; a comment or an edit written meanwhile carries it.
  effect(() => {
    if (typed.value === written) return;

    if (pending !== null) clearTimeout(pending);

    pending = setTimeout(() => write(draftShown()), TYPED_WRITE_MS);
  });

  const leave = (): void => {
    if (pending === null && started === queued) return;
    write(draftShown(), true);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leave();
  });
  window.addEventListener("pagehide", leave);

  return flush;
}

/**
 * The first load. The saved draft goes in before the review loads, so its edit meets the fate of
 * any unsent edit at a load: kept, landed or dropped. Saving starts only after that, at every
 * change of the comments, the edit or the choices, each one a single write, and once a typing pauses:
 * earlier, a reload would replace the draft with the page's empty state. A draft that cannot be
 * read starts no saving, for the same reason.
 */
export async function start(): Promise<void> {
  const saved = await fetchDraft();

  const draft = saved.ok ? saved.value : null;

  if (draft !== null) {
    batch(() => {
      annotations.value = draft.annotations;
      edited.value = draft.edit;
      choices.value = draft.choices;
      typed.value = draft.typed;
    });
  }

  await loadReview();

  if (saved.ok) startSaving();
  else {
    fail(
      "draft",
      saved.reason ??
        `The saved draft could not be read: the server answered ${saved.status}. Nothing is saved until the page reads it again, at a reload or a Send.`,
    );
  }

  subscribe(
    () => void loadReview(),
    () => {
      connection.value = "down";

      if (downAt.peek() !== null) return;
      const at = Date.now();
      batch(() => {
        downAt.value = at;
        downFor.value = 0;
      });

      setTimeout(() => {
        if (downAt.peek() === at) downFor.value = Date.now() - at;
      }, NEW_LINK_HINT_MS);
    },
    () => {
      batch(() => {
        connection.value = "up";
        downAt.value = null;
        downFor.value = null;
      });
    },
  );
}

/** The core's notices, drawn under the bar in this order. */
export const notices = computed(() =>
  noticesOf({
    workspace: review.value?.workspace ?? null,
    connection: connection.value,
    downSince: downFor.value,
    editing: editing.value,
    failures: failures.value,
    editWaits:
      editWaits.value !== null && editWaits.value.edit === edited.value
        ? editWaits.value.held
        : null,
    undo: undo.value,
    retry: () => void decide({ kind: "approve", edit: null, notes: "" }),
  }),
);
