import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";

import type {
  Annotation,
  Choice,
  ChoiceRef,
  Choices,
  DecisionKey,
  Decision,
  Draft,
  Edit,
  LineDiff,
  Mark,
  SendRefusal,
  SendRefused,
  Typed,
} from "../../review/contract.ts";
import { goneWithEdit, lineDiff, shiftAnnotations, unshiftAnnotations } from "../../review/diff.ts";
import {
  editOnLoad,
  EMPTY_TYPED,
  landedAnnotations,
  choicesIn,
  withoutChoices,
} from "../../review/review.ts";
import type { ProjectPath, Version } from "../../workshop/paths.ts";
import { sameBuild } from "../../workshop/vellum-build.ts";
import type { SendShare } from "../extension.ts";
import type { GroupedDoc, ReviewView, VellumBuild, WorkflowView } from "../protocol.ts";
import { takesComments } from "../protocol.ts";
import {
  draftWriter,
  fetchDraft,
  fetchReview,
  fetchVellumBuild,
  postDecision,
  postSend,
  subscribe,
} from "./api.ts";
import type { Failure } from "./notices.ts";
import { NEW_LINK_HINT_MS } from "./notices.ts";

function nameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export type Unsent = readonly { readonly where: string; readonly text: string }[];

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

/**
 * What a decision came to: taken, the draft cleared; refused (409), by the row the server names
 * when it names one, which the caller says; or failed, a failure the notices show.
 */
export type Decided =
  | { readonly kind: "taken" }
  | { readonly kind: "refused"; readonly rule: string | null; readonly reason: string | null }
  | { readonly kind: "failed" };

/**
 * What a Send came to. Sent, with what held the review when the server left the edit in the draft
 * (`editKept`); `kept`, an edit sent alone and refused while the review is held, which stays in the
 * draft, nothing sent; questions no answer takes; or a failure the notices show.
 */
export type Sent =
  | { readonly kind: "sent"; readonly editKept: string | null }
  | { readonly kind: "kept"; readonly reason: string }
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

/** The page's state, one object: every field a component reads, and nothing derived. */
export type Page = {
  readonly review: ReviewView | null;
  /** The comments not sent yet: a send clears them, and nothing Claude does may. */
  readonly annotations: readonly Annotation[];
  /**
   * The options chosen in mockups and not sent yet: `choose` and `unchoose` change them, a Send
   * takes out what it sent, an approval clears them, and the saved draft restores them.
   */
  readonly choices: Choices;
  /**
   * The choices whose option its mockup no longer holds, as the mockup's frame last read it, at its
   * load and at each change of its choices: page memory, never the draft's.
   */
  readonly absent: readonly ChoiceRef[];
  /** What is typed and not submitted, saved with the draft; `setTyped` is its one writer. */
  readonly typed: Typed;
  /** The document shown; `null` is the plan. */
  readonly current: ProjectPath | null;
  readonly split: boolean;
  /**
   * Whether the comments panel takes its width: open when the window is wide, folded when narrow,
   * read again at every load, by `readWindow`.
   */
  readonly commentsOpen: boolean;
  /**
   * The comments' last fold was the layout's, not the reviewer's: it is drawn at once. A panel is
   * known only once its extension loaded, after the first render, and a slide then reads as the
   * page jumping. The handle clears it, so the reviewer's own folds slide.
   */
  readonly commentsSnap: boolean;
  /** Whether the document rail takes its width: open at every load, whatever the window's width. */
  readonly railOpen: boolean;
  /** Whether the page draws its dark theme: what resolves tokens outside CSS redraws at each change. */
  readonly dark: boolean;
  /** The reviewer's switch: off at every load. */
  readonly commentSwitch: boolean;
  /** Ctrl or Meta held down: a drag or a click adds to the set instead of replacing it. */
  readonly holding: boolean;
  /** The reviewer's own text of the plan, not sent yet: the next decision records it as the next version. */
  readonly edited: Edit | null;
  readonly editing: EditSession | null;
  /**
   * The source line to come back to once the editor closes: the plan's renderer scrolls to its
   * block and clears it, and Edit takes the focus; `null` the rest of the time.
   */
  readonly resume: number | null;
  /** "Changes since" is off at every load: the reviewer reads the plan itself first. */
  readonly showChanges: boolean;
  /** The requests that failed, one per operation: `fail` replaces the operation's entry, `succeed` removes it. */
  readonly failures: readonly Failure[];
  /**
   * What the last Delete of a card can undo, for `UNDO_MS`; `null` past that, once undone, and
   * after a decision, Done or Discard edit, which the comment it holds was made before.
   */
  readonly undo: { readonly label: string; readonly run: () => void } | null;
  /**
   * The card the reviewer is on, by its annotation's id: hovered or focused, the plan's renderer
   * highlights its passage; clicked (`reveal`), it scrolls to it as well. `null` off any card.
   */
  readonly focused: { readonly id: string; readonly reveal: boolean } | null;
  readonly connection: "up" | "down";
  /** How long ago the stream failed, as far as the notice cares: `0`, then past the hint's delay; `null` while it is up. */
  readonly downFor: number | null;
  /**
   * A write out to the review that takes from the draft, a Send or End grill: every way to either
   * waits, so nothing is sent twice. A Send stays out until the page has read again what it left.
   */
  readonly sending: boolean;
};

const INITIAL: Page = {
  review: null,
  annotations: [],
  choices: {},
  absent: [],
  typed: EMPTY_TYPED,
  current: null,
  split: false,
  commentsOpen: true,
  commentsSnap: false,
  railOpen: true,
  dark: false,
  commentSwitch: false,
  holding: false,
  edited: null,
  editing: null,
  resume: null,
  showChanges: false,
  failures: [],
  undo: null,
  focused: null,
  connection: "up",
  downFor: null,
  sending: false,
};

/** Writes `partial` unless every field it names already holds that value: an equal write wakes nobody. */
export function patchStore<S extends object>(store: StoreApi<S>, partial: Partial<S>): void {
  const state = store.getState();
  let changed = false;

  for (const key in partial) {
    if (Object.hasOwn(partial, key) && !Object.is(partial[key], state[key])) changed = true;
  }

  if (changed) store.setState(partial);
}

/**
 * A one-entry cache over one or several states: `compute` runs again only when an input changed
 * by reference, so a render and a handler read the same object while the inputs stand.
 */
export function memoized<A extends readonly unknown[], I extends unknown[], R>(
  inputs: (...states: A) => I,
  compute: (...input: I) => R,
): (...states: A) => R {
  let last: { readonly input: I; readonly result: R } | null = null;

  return (...states) => {
    const input = inputs(...states);

    if (
      last !== null &&
      last.input.length === input.length &&
      last.input.every((one, index) => Object.is(one, input[index]))
    ) {
      return last.result;
    }

    const result = compute(...input);
    last = { input, result };

    return result;
  };
}

type Patch = (s: Page) => Partial<Page>;

/** One patch of several, each seeing the state the ones before it made. */
function compose(...patches: readonly Patch[]): Patch {
  return (s) => {
    const merged: Partial<Page> = {};
    let seen = s;

    for (const patch of patches) {
      const part = patch(seen);
      Object.assign(merged, part);
      seen = { ...seen, ...part };
    }

    return merged;
  };
}

/** Whether `choice` is one of `absent`, the choices whose option the mockup no longer holds. */
export function isAbsent(absent: readonly ChoiceRef[], choice: ChoiceRef): boolean {
  return absent.some(
    (ref) =>
      ref.doc === choice.doc && ref.decision === choice.decision && ref.option === choice.option,
  );
}

/** The choices a Send takes: every one whose mockup still holds its option, as far as the page read it. */
export const selectSendableChoices = memoized(
  (s: Page): [Choices, readonly ChoiceRef[]] => [s.choices, s.absent],
  (choices, absent) => choicesIn(choices).filter((choice) => !isAbsent(absent, choice)),
);

/** What a Send would throw: every typed text, named by where it is on screen, but the grill's answers, which leave with it. */
export const selectStrayTyped = memoized(
  (s: Page): [Typed] => [s.typed],
  ({ general, composer, editor }): Unsent => {
    const found: { readonly where: string; readonly text: string }[] = [];

    if (general.trim() !== "") found.push({ where: "the general box", text: general });

    for (const [path, body] of Object.entries(composer)) {
      if (body.trim() !== "") found.push({ where: `a comment on ${nameOf(path)}`, text: body });
    }

    if (editor !== null) found.push({ where: "the editor", text: editor.text });

    return found;
  },
);

/** What an approval would throw: every typed text, the grill's answers included. */
export const selectUnsentTyped = memoized(
  (s: Page): [Unsent, Typed["grill"]] => [selectStrayTyped(s), s.typed.grill],
  (stray, grill): Unsent => {
    const found = [...stray];

    for (const [path, entry] of Object.entries(grill)) {
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
  },
);

export const selectPlanDoc = memoized(
  (s: Page): [ProjectPath | null] => [s.review?.plan?.doc ?? null],
  // A version's file never changes: its path is the whole key.
  (doc): GroupedDoc | null =>
    doc === null ? null : { path: doc, mediaType: "text/markdown", modified: 0, group: "plan" },
);

/** The plan's text as shown: the reviewer's unsent edit of it, else the version's. */
export function selectPlanText(s: Page): string | null {
  return s.edited?.text ?? s.review?.plan?.text ?? null;
}

export function selectPreviousText(s: Page): string | null {
  return s.review?.plan?.previous?.text ?? null;
}

/**
 * The plan, or the reviewer's edit of it, against the version before; `null` at v1. Computed
 * from the two texts, not from `review`: every workspace event loads a new view, and the same
 * texts keep the same diff.
 */
export const selectPlanChanges = memoized(
  (s: Page): [string | null, string | null] => [selectPlanText(s), selectPreviousText(s)],
  (text, previous): LineDiff | null =>
    text === null || previous === null ? null : lineDiff(previous, text),
);

const NO_DOCS: readonly GroupedDoc[] = [];

export const selectDocs = memoized(
  (s: Page): [GroupedDoc | null, readonly GroupedDoc[]] => [
    selectPlanDoc(s),
    s.review?.docs ?? NO_DOCS,
  ],
  (plan, listed): readonly GroupedDoc[] => (plan === null ? listed : [plan, ...listed]),
);

/** The selected document, or, once a version or an approval took it off the list, the plan or the first one. */
export const selectCurrentDoc = memoized(
  (s: Page): [readonly GroupedDoc[], ProjectPath | null, GroupedDoc | null] => [
    selectDocs(s),
    s.current,
    selectPlanDoc(s),
  ],
  (list, current, plan): GroupedDoc | null =>
    list.find((doc) => doc.path === current) ?? plan ?? list[0] ?? null,
);

/** Comments are taken on a plan under review and while drafting; an approved one locks the page. */
export function selectLocked(s: Page): boolean {
  const workspace = s.review?.workspace;

  return workspace === undefined || !takesComments(workspace);
}

/** Whether a renderer starts a comment now: the switch is on and the page takes comments. */
export function selectCommenting(s: Page): boolean {
  return s.commentSwitch && !selectLocked(s);
}

/** The comments Discard edit takes whole, as its confirmation counts them before the click. */
export function selectGoneOnDiscard(s: Page): number {
  const edit = s.edited;
  const plan = s.review?.plan ?? null;

  return edit === null || plan === null
    ? 0
    : goneWithEdit(s.annotations, plan.doc, { version: plan.text, edit: edit.text });
}

export function selectWorkflow(s: Page): WorkflowView | null {
  return s.review?.workflow ?? null;
}

/** What holds the review, in the holder's words; `null` when nothing does. */
export function selectHeld(s: Page): string | null {
  return s.review?.workflow.held ?? null;
}

const REFUSED: Readonly<Record<SendRefused | "empty" | "unreadable", string>> = {
  approved: "Not sent: the plan is approved.",
  changed:
    "Not sent: the saved draft no longer holds what you sent, changed in another tab. Reload the page.",
  edit: "Not sent: a comment on the plan goes with your edit. Send them together with Send.",
  empty: "Not sent: nothing to send. Your comments are kept.",
  stale: "Not sent: your edit is of a version no longer under review. Your comments are kept.",
  unreadable: "Not sent: the saved draft cannot be read. Your comments are kept in this tab.",
};

/** A refusal in the page's words for the Send's rows it knows, in the row's own words for any other. */
function refusedText(refusal: Exclude<SendRefusal, { reason: "unanswered" }>): string {
  if (refusal.reason !== "refused") return REFUSED[refusal.reason];
  const known = Object.entries(REFUSED).find(([code]) => code === refusal.rule);

  return known?.[1] ?? `Not sent: ${refusal.text}.`;
}

/** How long a deleted card can be undone from the notice. */
const UNDO_MS = 8_000;

/** How long a typing pauses before the draft is written: a continuous typing is one write. */
const TYPED_WRITE_MS = 300;

function draftOf(s: Page): Draft {
  return { annotations: s.annotations, edit: s.edited, choices: s.choices, typed: s.typed };
}

/** The patches the actions compose: each reads the state the ones before it made. */
const patches = {
  fail:
    (op: Failure["op"], text: string, action?: Failure["action"]): Patch =>
    (s) => {
      const failure: Failure = action === undefined ? { op, text } : { op, text, action };

      return { failures: [...s.failures.filter((one) => one.op !== op), failure] };
    },
  succeed:
    (op: Failure["op"]): Patch =>
    (s) =>
      s.failures.some((failure) => failure.op === op)
        ? { failures: s.failures.filter((failure) => failure.op !== op) }
        : {},
  setTyped:
    (patch: Partial<Typed>): Patch =>
    (s) => ({ typed: { ...s.typed, ...patch } }),
  clearUndo: (s: Page): Partial<Page> => (s.undo === null ? {} : { undo: null }),
  /** What a load makes of the unsent edit: kept, cleared because it landed, or dropped with a banner. */
  settleEdit:
    (view: ReviewView): Patch =>
    (s) => {
      const edit = s.edited;
      const { workspace, plan } = view;

      if (edit === null) return {};

      const fate = editOnLoad(
        edit,
        workspace.kind === "drafting" || plan === null
          ? null
          : { version: workspace.version, text: plan.text },
      );

      if (fate === "pending") return {};

      if (fate === "stale") {
        return {
          edited: null,
          ...patches.fail(
            "edit",
            `Your unsent edit of v${edit.version} was dropped: another version of the plan arrived. Your comments are kept.`,
          )(s),
        };
      }

      // Landed: the loaded version is the edit, and the comments' lines were shifted to its text already.
      return { edited: null, annotations: landedAnnotations(s.annotations, workspace.dir, edit) };
    },
  /** The editor's typing goes with the version it was typed on: no Edit opens on another one. */
  settleEditorTyping:
    (view: ReviewView): Patch =>
    (s) => {
      const { editor } = s.typed;
      const { workspace } = view;

      if (editor === null) return {};

      if (workspace.kind === "inReview" && workspace.version === editor.version) return {};

      return patches.setTyped({ editor: null })(s);
    },
};

/**
 * The page's store and every action over it, built fresh by each call, so a suite gets a store of
 * its own with no module imported again. The page runs one, below; the selectors above read any.
 */
export function createPage() {
  const store = createStore<Page>(() => INITIAL);

  /** The one writer: a patch over the state now, written unless it changes nothing. */
  function apply(patch: Patch): void {
    patchStore(store, patch(store.getState()));
  }

  /** What the frame of `doc` reads now replaces what it read before. */
  function setAbsent(doc: ProjectPath, found: readonly Omit<ChoiceRef, "doc">[]): void {
    apply((s) => ({
      absent: [
        ...s.absent.filter((ref) => ref.doc !== doc),
        ...found.map(({ decision, option }) => ({ doc, decision, option })),
      ],
    }));
  }

  function setTyped(patch: Partial<Typed>): void {
    apply(patches.setTyped(patch));
  }

  function fail(op: Failure["op"], text: string, action?: Failure["action"]): void {
    apply(patches.fail(op, text, action));
  }

  function succeed(op: Failure["op"]): void {
    apply(patches.succeed(op));
  }

  let undoTimer: ReturnType<typeof setTimeout> | null = null;

  function stopUndoTimer(): void {
    if (undoTimer !== null) clearTimeout(undoTimer);
    undoTimer = null;
  }

  function clearUndo(): void {
    stopUndoTimer();
    apply(patches.clearUndo);
  }

  /** The switch clicked or `C` pressed; a locked page keeps its switch as it is. */
  function flipCommentSwitch(): void {
    const s = store.getState();

    if (selectLocked(s)) return;
    apply(() => ({ commentSwitch: !s.commentSwitch }));
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

    apply(
      compose(
        patches.succeed("review"),
        () => ({ review: fetched.value }),
        patches.settleEdit(fetched.value),
        patches.settleEditorTyping(fetched.value),
      ),
    );
  }

  /** Clears what an approval took: the comments, the edit, the choices, what is typed. */
  function clearDraft(): void {
    stopUndoTimer();

    apply(
      compose(
        () => ({ annotations: [], edited: null, choices: {}, typed: EMPTY_TYPED }),
        patches.clearUndo,
        patches.succeed("decision"),
      ),
    );
  }

  /** Posts the decision, clears what an approval took once the server took it, then reads the review again. */
  async function decide(decision: Decision): Promise<Decided> {
    const posted = await postDecision(decision).catch(() => null);

    if (posted === null) {
      fail(
        "decision",
        "The decision did not reach the server. Your comments are kept in this tab.",
      );

      return { kind: "failed" };
    }

    const { status, answer } = posted;

    const decided: Decided =
      status === 409
        ? { kind: "refused", rule: answer?.rule ?? null, reason: answer?.reason ?? null }
        : { kind: status >= 300 ? "failed" : "taken" };

    if (decided.kind === "taken") clearDraft();
    else if (decided.kind === "failed") {
      fail("decision", `Not sent: the server answered ${status}. Your comments are kept.`);
    }

    await loadReview();

    return decided;
  }

  /** Runs `work` as the one write out; `null`, running nothing, while another is. */
  async function outOnce<T>(work: () => Promise<T>): Promise<T | null> {
    if (store.getState().sending) return null;
    apply(() => ({ sending: true }));

    try {
      return await work();
    } finally {
      apply(() => ({ sending: false }));
    }
  }

  /**
   * Writes the draft as the page shows it and answers whether the server kept it; `startSaving`
   * binds it. `null` has two readings: before `firstLoad` settles, the first load is still out;
   * after it, the page's first read of the draft failed, so it saves nothing yet.
   */
  let flushDraft: (() => Promise<boolean>) | null = null;

  /**
   * Settled once `start` has run to its end or thrown, so `flushDraft` reads one way only. End
   * grill is drawn before the review loads, so a write can be asked before it settles.
   */
  let firstLoad: Promise<unknown> = Promise.resolve();

  /**
   * The draft written now, as the page shows it: what the server reads next is what is on screen.
   * `true` once kept. Asked during the first load, it waits for it. A page that could not read the
   * draft at its load reads it again first: none saved starts the saving; one saved that this tab
   * never loaded is never written over.
   */
  async function writeDraft(): Promise<boolean> {
    await firstLoad;

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

  /**
   * One Send, the one write out while it lasts. The server sends from the draft it keeps what the
   * snapshot names, so the page writes the draft first. Once taken, the page reads the review and
   * each part its state again, then takes out exactly what was sent: a comment added since stays,
   * and what is typed stays where it is. Questions no answer takes come back as their ids, for the
   * bar to ask about before it leaves them to their recommendation.
   */
  async function send(out: Outgoing): Promise<Sent> {
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

      if (answer.reason === "refused" && answer.rule === "held") {
        succeed("decision");

        return { kind: "kept", reason: answer.text };
      }

      fail("decision", refusedText(answer));

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

    apply(
      compose(
        (s) => ({
          annotations: s.annotations.filter(({ id }) => !taken.has(id)),
          choices: withoutChoices(s.choices, out.choices),
        }),
        (s) =>
          sentEdit !== null && s.edited?.version === sentEdit.version ? { edited: null } : {},
        patches.succeed("decision"),
      ),
    );

    return { kind: "sent", editKept: editKept?.reason ?? null };
  }

  /** Edit: the editor opens on the version under review, on the unsent edit of it when there is one. */
  function openEditor(line: number): void {
    const { review: view, edited } = store.getState();

    if (view?.workspace.kind !== "inReview" || view.plan === null) return;
    const { version } = view.workspace;
    const base = edited?.text ?? view.plan.text;
    apply(() => ({ editing: { version, base, line } }));
  }

  /**
   * Done, with the session the editor opened on and the text typed: the comments follow their lines
   * through the edit, and an edit back to the version's text is no edit. When another version
   * arrived meanwhile, or this one was decided elsewhere, nothing is recorded, under the notice
   * `staleEditor` derives: the typing must stay reachable. `closeEditor` is what closes.
   */
  function finishEdit(session: EditSession, text: string): void {
    const { version, base } = session;
    const view = store.getState().review;

    if (view === null || view.plan === null || view.workspace.kind === "drafting") return;

    if (view.workspace.kind !== "inReview" || view.workspace.version !== version) return;

    const { doc, text: reviewed } = view.plan;
    stopUndoTimer();

    apply(
      compose(
        (s) => ({
          annotations: shiftAnnotations(s.annotations, doc, { version: reviewed, base, text }),
          edited: text === reviewed ? null : { version, text },
        }),
        patches.clearUndo,
        patches.succeed("edit"),
      ),
    );
  }

  /** Done and Cancel both end here: the editor closes, and the plan comes back at `atLine`. */
  function closeEditor(atLine: number): void {
    apply(() => ({ editing: null, resume: atLine }));
  }

  /**
   * Discard edit, the reverse of Done: the version's text again, the comments back on its lines,
   * but for those on a line only the edit held, which go with it.
   */
  function discardEdit(): void {
    const { edited: edit, review: view } = store.getState();
    const plan = view?.plan ?? null;

    if (edit === null || plan === null) return;
    stopUndoTimer();

    apply(
      compose(
        (s) => ({
          annotations: unshiftAnnotations(s.annotations, plan.doc, {
            version: plan.text,
            edit: edit.text,
          }),
          edited: null,
        }),
        patches.clearUndo,
      ),
    );
  }

  /** The one way a comment enters the page, as `select` is for navigation: a locked page takes none. */
  function addAnnotation(annotation: Omit<Annotation, "id">): void {
    if (selectLocked(store.getState())) return;
    apply((s) => ({ annotations: [...s.annotations, { ...annotation, id: crypto.randomUUID() }] }));
  }

  /**
   * A choice in a mockup: another option of the same decision replaces it, and the option already
   * chosen, chosen again, withdraws it; a locked page takes none.
   */
  function choose(doc: ProjectPath, decision: DecisionKey, choice: Choice): void {
    if (selectLocked(store.getState())) return;

    apply((s) => ({
      choices:
        s.choices[doc]?.[decision]?.option === choice.option
          ? withoutChoices(s.choices, [{ doc, decision, option: choice.option }])
          : { ...s.choices, [doc]: { ...s.choices[doc], [decision]: choice } },
    }));
  }

  /** A choice card's Delete: the choice leaves the draft, its mark the mockup. */
  function unchoose(named: ChoiceRef): void {
    apply((s) => ({ choices: withoutChoices(s.choices, [named]) }));
  }

  /**
   * Delete on a card: at once, and undone from the notice for a while; a second Delete replaces
   * the first's undo. Undone on a page that locked meanwhile, the comment stays gone, as
   * `addAnnotation` takes none.
   */
  function removeAnnotation(id: string): void {
    const { annotations } = store.getState();
    const index = annotations.findIndex((annotation) => annotation.id === id);
    const gone = annotations[index];

    if (gone === undefined) return;
    stopUndoTimer();
    undoTimer = setTimeout(clearUndo, UNDO_MS);

    const run = (): void => {
      stopUndoTimer();

      apply(
        compose(patches.clearUndo, (s) =>
          selectLocked(s) ? {} : { annotations: s.annotations.toSpliced(index, 0, gone) },
        ),
      );
    };

    apply(
      compose(
        (s) => ({ annotations: s.annotations.filter((annotation) => annotation.id !== id) }),
        () => ({ undo: { label: "Undo", run } }),
      ),
    );
  }

  /** A card's Edit: the mark changes, the place stays. */
  function updateAnnotation(id: string, mark: Mark): void {
    apply((s) => ({
      annotations: s.annotations.map((annotation) =>
        annotation.id === id ? { ...annotation, mark } : annotation,
      ),
    }));
  }

  function select(path: ProjectPath): void {
    if (store.getState().editing !== null) return;

    apply(
      compose(
        () => ({ current: path }),
        (s) => (path === selectPlanDoc(s)?.path ? { split: false } : {}),
      ),
    );
  }

  function toggleSplit(): void {
    apply((s) => ({ split: !s.split }));
  }

  function toggleShowChanges(): void {
    apply((s) => ({ showChanges: !s.showChanges }));
  }

  function toggleRail(): void {
    apply((s) => ({ railOpen: !s.railOpen }));
  }

  /** The comments handle: the reviewer's own fold, which slides. */
  function toggleComments(): void {
    apply((s) => ({ commentsSnap: false, commentsOpen: !s.commentsOpen }));
  }

  /** A panel appearing takes the comments' room, at once: the layout's fold, not the reviewer's. */
  function foldCommentsForPanel(): void {
    apply(() => ({ commentsOpen: false, commentsSnap: true }));
  }

  function setHolding(held: boolean): void {
    apply(() => ({ holding: held }));
  }

  /** A card the pointer or the focus is on; clicked (`reveal`), the renderer scrolls to its passage too. */
  function focusCard(id: string, reveal: boolean): void {
    apply(() => ({ focused: { id, reveal } }));
  }

  /** The pointer or the focus leaving a card: another card taken meanwhile keeps the focus. */
  function blurCard(id: string): void {
    apply((s) => (s.focused?.id === id ? { focused: null } : {}));
  }

  /** The plan's renderer scrolled to the line the editor closed on. */
  function clearResume(): void {
    apply(() => ({ resume: null }));
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
  function readWindow(): void {
    const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

    apply(() => ({
      commentsOpen: !window.matchMedia("(max-width: 900px)").matches,
      dark: darkScheme.matches,
    }));

    darkScheme.addEventListener("change", (event) => {
      apply(() => ({ dark: event.matches }));
    });
  }

  function draftShown(): Draft {
    return draftOf(store.getState());
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
    let written = store.getState().typed;
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

    // The draft as it stands, then at every change of the comments, the edit or the choices.
    write(draftShown());

    store.subscribe((s, prev) => {
      if (
        s.annotations === prev.annotations &&
        s.edited === prev.edited &&
        s.choices === prev.choices
      ) {
        return;
      }

      write(draftOf(s));
    });

    // A typing is written once it pauses; a comment or an edit written meanwhile carries it.
    store.subscribe((s, prev) => {
      if (s.typed === prev.typed || s.typed === written) return;

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

  /** The build that served this page, read at its stream's first open; `null` until then. */
  let servedBy: VellumBuild | null = null;

  /**
   * A server revived under this tab may run another build, whose routes this page's code does not
   * know (an update renames them), so the page loads that build. A build the server cannot read,
   * or a read that fails, leaves the page as it is: the stream's next open reads it again.
   */
  async function reloadOnAnotherBuild(): Promise<void> {
    const now = await fetchVellumBuild();

    if (!now.ok) return;

    if (servedBy === null) servedBy = now.value;
    else if (!sameBuild(servedBy, now.value)) location.reload();
  }

  /**
   * The first load. The saved draft goes in before the review loads, so its edit meets the fate of
   * any unsent edit at a load: kept, landed or dropped. Saving starts only after that, at every
   * change of the comments, the edit or the choices, each one a single write, and once a typing pauses:
   * earlier, a reload would replace the draft with the page's empty state. A draft that cannot be
   * read starts no saving, for the same reason. A write asked meanwhile waits for all of it
   * (`firstLoad`).
   */
  function start(): Promise<void> {
    const started = startInOrder();
    firstLoad = Promise.allSettled([started]);

    // A promise of its own: `allSettled` handles `started`, and the page's `void start()` must
    // still see a failed load reported as an unhandled rejection.
    return started.then(() => {});
  }

  /** When the stream first failed. */
  let downAt: number | null = null;

  async function startInOrder(): Promise<void> {
    const saved = await fetchDraft();

    const draft = saved.ok ? saved.value : null;

    if (draft !== null) {
      apply(() => ({
        annotations: draft.annotations,
        edited: draft.edit,
        choices: draft.choices,
        typed: draft.typed,
      }));
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
        if (downAt !== null) {
          apply(() => ({ connection: "down" }));

          return;
        }

        const at = Date.now();
        downAt = at;
        apply(() => ({ connection: "down", downFor: 0 }));

        setTimeout(() => {
          if (downAt === at) apply(() => ({ downFor: Date.now() - at }));
        }, NEW_LINK_HINT_MS);
      },
      () => {
        downAt = null;
        apply(() => ({ connection: "up", downFor: null }));

        reloadOnAnotherBuild().catch(() => {
          // The stream's next open reads the build again: see `reloadOnAnotherBuild`.
        });
      },
    );
  }

  return {
    store,
    setAbsent,
    setTyped,
    fail,
    succeed,
    flipCommentSwitch,
    decide,
    outOnce,
    writeDraft,
    send,
    openEditor,
    finishEdit,
    closeEditor,
    discardEdit,
    addAnnotation,
    choose,
    unchoose,
    removeAnnotation,
    updateAnnotation,
    select,
    toggleSplit,
    toggleShowChanges,
    toggleRail,
    toggleComments,
    foldCommentsForPanel,
    setHolding,
    focusCard,
    blurCard,
    clearResume,
    readWindow,
    start,
  };
}

export type PageModule = ReturnType<typeof createPage>;

/** The page's one store, which every component reads through `usePage` and every action writes. */
export const pageModule = createPage();

export const pageStore: StoreApi<Page> = pageModule.store;

export const {
  setAbsent,
  setTyped,
  fail,
  succeed,
  flipCommentSwitch,
  decide,
  outOnce,
  writeDraft,
  send,
  openEditor,
  finishEdit,
  closeEditor,
  discardEdit,
  addAnnotation,
  choose,
  unchoose,
  removeAnnotation,
  updateAnnotation,
  select,
  toggleSplit,
  toggleShowChanges,
  toggleRail,
  toggleComments,
  foldCommentsForPanel,
  setHolding,
  focusCard,
  blurCard,
  clearResume,
  readWindow,
  start,
} = pageModule;

/** A component's read of the page's store: `pick` a field or a `selectX`, and the component redraws when its value changes. */
export function usePage<T>(pick: (s: Page) => T): T {
  return useStore(pageStore, pick);
}

/** Whether the switch is on now, for a handler: the render's value may be a frame old. */
export function commentingNow(): boolean {
  return selectCommenting(pageStore.getState());
}
