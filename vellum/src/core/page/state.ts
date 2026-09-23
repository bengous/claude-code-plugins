import { batch, computed, effect, signal } from "@preact/signals";

import type {
  Annotation,
  Decision,
  Draft,
  Edit,
  GroupedDoc,
  LineDiff,
  Mark,
  ReviewView,
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
} from "../protocol.ts";
import type { ProjectPath, Version } from "../server/domain/paths.ts";
import { fetchDraft, fetchReview, postDecision, putDraft, subscribe } from "./api.ts";
import type { Failure } from "./notices.ts";
import { NEW_LINK_HINT_MS, noticesOf } from "./notices.ts";

export const review = signal<ReviewView | null>(null);

/** The comments not sent yet: a send clears them, and nothing Claude does may. */
export const annotations = signal<readonly Annotation[]>([]);

/** What is typed and not submitted, saved with the draft; `setTyped` is its one writer. */
export const typed = signal<Typed>(EMPTY_TYPED);

export function setTyped(patch: Partial<Typed>): void {
  typed.value = { ...typed.value, ...patch };
}

function nameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** What an action would throw: every typed text, named by where it is on screen. */
export const unsentTyped = computed<readonly { readonly where: string; readonly text: string }[]>(
  () => {
    const { general, composer, grill, editor } = typed.value;
    const found: { readonly where: string; readonly text: string }[] = [];

    if (general.trim() !== "") found.push({ where: "the general box", text: general });

    for (const [path, body] of Object.entries(composer)) {
      if (body.trim() !== "") found.push({ where: `a comment on ${nameOf(path)}`, text: body });
    }

    for (const [path, entry] of Object.entries(grill)) {
      const texts = [...Object.values(entry.answers), entry.note].filter((t) => t.trim() !== "");

      if (texts.length > 0) {
        found.push({ where: `the answers in ${nameOf(path)}`, text: texts.join("\n") });
      }
    }

    if (editor !== null) found.push({ where: "the editor", text: editor.text });

    return found;
  },
);

/** The document shown; `null` is the plan. */
export const current = signal<ProjectPath | null>(null);

export const split = signal(false);

/**
 * Whether the comments panel takes its width: open when the window is wide, folded when narrow,
 * read again at every load, by `readWindow`.
 */
export const commentsOpen = signal(true);

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

/** Comments are taken on a plan under review and while drafting; every other state locks the page. */
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
  } else {
    batch(() => {
      annotations.value = [];
      edited.value = null;
      typed.value = EMPTY_TYPED;
      clearUndo();
      succeed("decision");
    });
  }

  await loadReview();

  return status < 300;
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

/** Never rejects: the saves are chained, and one rejection would silence every save after it. */
async function saveDraft(draft: Draft): Promise<void> {
  try {
    const status = await putDraft(draft);

    if (status >= 300) {
      fail(
        "draft",
        `Your comments are kept in this tab, not saved: the server answered ${status}.`,
      );
    } else succeed("draft");
  } catch {
    fail("draft", "Your comments are kept in this tab, not saved: the server did not answer.");
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

/**
 * The first load. The saved draft goes in before the review loads, so its edit meets the fate of
 * any unsent edit at a load: kept, landed or dropped. Saving starts only after that, at every
 * change of the comments or of the edit, each one a single write, and once a typing pauses:
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
      typed.value = draft.typed;
    });
  }

  await loadReview();

  if (saved.ok) {
    let saving = Promise.resolve();
    let pending: ReturnType<typeof setTimeout> | null = null;
    let written = typed.peek();

    // In order: two changes close together must not reach the file reversed.
    const write = (unsent: Draft): void => {
      if (pending !== null) clearTimeout(pending);
      pending = null;
      written = unsent.typed;
      saving = saving.then(() => saveDraft(unsent));
    };

    effect(() => {
      write({ annotations: annotations.value, edit: edited.value, typed: typed.peek() });
    });

    // A typing is written once it pauses; a comment or an edit written meanwhile carries it.
    effect(() => {
      if (typed.value === written) return;

      if (pending !== null) clearTimeout(pending);

      pending = setTimeout(
        () => write({ annotations: annotations.peek(), edit: edited.peek(), typed: typed.peek() }),
        TYPED_WRITE_MS,
      );
    });
  } else {
    fail(
      "draft",
      saved.reason ??
        `The saved draft could not be read: the server answered ${saved.status}. Nothing is saved until a reload succeeds.`,
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
    held: review.value?.held ?? null,
    connection: connection.value,
    downSince: downFor.value,
    editing: editing.value,
    failures: failures.value,
    undo: undo.value,
    retry: () => void decide({ kind: "approve", edit: null, notes: "" }),
  }),
);
