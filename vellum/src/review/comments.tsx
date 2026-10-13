import type { JSX } from "react";
import { Fragment, useEffect, useRef, useState } from "react";

import { Badge, Button, Handle, Tag } from "../runtime/page/kit.tsx";
import { pathLabel, quoteOf, whereOf } from "../runtime/page/labels.ts";
import {
  addAnnotation,
  blurCard,
  focusCard,
  isAbsent,
  removeAnnotation,
  selectDocs,
  selectLocked,
  send,
  setTyped,
  toggleComments,
  unchoose,
  updateAnnotation,
  usePage,
} from "../runtime/page/state.ts";
import { switchShown } from "../runtime/page/tools.tsx";
import type { GroupedDoc, ReviewView } from "../runtime/protocol.ts";
import type { Anchor, Annotation, Mark, SentChoice } from "./feedback.ts";
import { DELETE_SENTENCE, QUICK_LABELS } from "./feedback.ts";
import type { Choices } from "./review.ts";
import { choicesIn, refOf } from "./review.ts";

type Quote = {
  readonly key: string;
  readonly text: string;
  readonly mono: boolean;
  readonly removed: boolean;
};

function quotesOf(anchor: Anchor): readonly Quote[] {
  if (anchor.kind === "global") return [];

  if (anchor.kind === "text") {
    return anchor.passages.map((passage) => ({
      key: `${passage.lines[0]}-${passage.quote}`,
      text: quoteOf(passage),
      mono: passage.kind !== "prose",
      removed: passage.removed,
    }));
  }

  return anchor.elements.map((element) => ({
    key: JSON.stringify(element),
    text: element.text,
    mono: false,
    removed: false,
  }));
}

/** The first line a comment points at; a general one comes before every passage of its document. */
function firstLine(anchor: Anchor): number {
  return anchor.kind === "text" ? Math.min(...anchor.passages.map(({ lines }) => lines[0])) : 0;
}

/** The cards in the documents' order, then by line: what the reviewer reads top to bottom. */
function sorted(list: readonly Annotation[], order: readonly GroupedDoc[]): readonly Annotation[] {
  const rank = new Map(order.map((doc, index) => [doc.path, index]));

  return list.toSorted(
    (a, b) =>
      (rank.get(a.doc) ?? order.length) - (rank.get(b.doc) ?? order.length) ||
      firstLine(a.anchor) - firstLine(b.anchor),
  );
}

/** The choices' cards after the comments', in the documents' order. */
function sortedChoices(choices: Choices, order: readonly GroupedDoc[]): readonly SentChoice[] {
  const rank = new Map(order.map((doc, index) => [doc.path, index]));

  return choicesIn(choices).toSorted(
    (a, b) => (rank.get(a.doc) ?? order.length) - (rank.get(b.doc) ?? order.length),
  );
}

/** The empty panel names the switch only where `Tools` draws it, and the box only where it takes text. */
function emptyLine(boxOpen: boolean, switchDrawn: boolean): string {
  if (!boxOpen) return "No comments yet.";

  return switchDrawn
    ? "No comments yet. Turn on Comment to pick text, or use the box below."
    : "No comments yet. Use the box below.";
}

function MarkWords(props: { readonly mark: Mark }): JSX.Element {
  const { mark } = props;

  if (mark.kind === "comment") return <div>{mark.body}</div>;

  if (mark.kind === "delete") return <div>{DELETE_SENTENCE}</div>;

  return (
    <div>
      <Tag>{QUICK_LABELS[mark.label].name}</Tag>
    </div>
  );
}

/**
 * A comment's words, reopened in place: every keystroke with words in it goes to the annotation
 * itself, so the store never holds an empty comment and a reload keeps the last words; the card
 * keeps the field's text, so that it can be cleared, and `open`. While the editor is open the
 * actions are off, the card readable. Send now sends this comment alone, and leaves the round; a
 * comment on the plan waits for the pending edit, since `Done` moved its lines to the edit's text.
 */
function CardWords(props: { readonly annotation: Annotation }): JSX.Element {
  const { annotation } = props;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { mark } = annotation;
  const off = usePage((s) => s.editing !== null);
  const withEdit = usePage((s) => s.edited !== null && annotation.doc === s.review?.plan?.doc);
  const locked = usePage(selectLocked);
  const sending = usePage((s) => s.sending);
  const down = usePage((s) => s.connection === "down");

  const reopen = (body: string): void => {
    setText(body);
    setOpen(true);
  };

  const type = (body: string): void => {
    setText(body);

    if (body.trim() !== "") updateAnnotation(annotation.id, { kind: "comment", body });
  };

  if (!open || mark.kind !== "comment") {
    return (
      <>
        <MarkWords mark={mark} />
        {!locked && (
          <div className="actions">
            {mark.kind === "comment" && (
              <button type="button" disabled={off} onClick={() => reopen(mark.body)}>
                Edit
              </button>
            )}
            <button type="button" disabled={off} onClick={() => removeAnnotation(annotation.id)}>
              Delete
            </button>
            <button
              type="button"
              disabled={off || withEdit || sending || down}
              title={withEdit ? "It goes with your edit: send them together with Send" : undefined}
              onClick={() =>
                void send({
                  annotations: [annotation.id],
                  edit: null,
                  choices: [],
                  parts: null,
                  takeDefaults: [],
                })
              }
            >
              Send now
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <textarea
        rows={3}
        aria-label="Comment"
        value={text}
        onInput={(event) => type(event.currentTarget.value)}
      />
      <div className="actions">
        <button type="button" disabled={text.trim() === ""} onClick={() => setOpen(false)}>
          Done
        </button>
      </div>
    </>
  );
}

/** What a card calls its document: the listed document's label, or the file's name once it is listed no more. */
function docLabelOf(path: string, view: ReviewView | null, docs: readonly GroupedDoc[]): string {
  const doc = docs.find((one) => one.path === path);

  return view === null || doc === undefined
    ? (path.split("/").at(-1) ?? path)
    : pathLabel(doc, view);
}

/**
 * A choice made in a mockup: its mockup, its decision, and the option by the heading it holds,
 * else its key. Send now sends it alone and leaves the round; Delete withdraws it, as a click on
 * the same Choose does. A choice whose option the mockup no longer holds says so, and only
 * Delete remains: no Send takes it.
 */
function ChoiceCard(props: { readonly choice: SentChoice }): JSX.Element {
  const { choice } = props;
  const named = refOf(choice);
  const gone = usePage((s) => isAbsent(s.absent, choice));
  const off = usePage((s) => s.editing !== null);
  const locked = usePage(selectLocked);
  const sending = usePage((s) => s.sending);
  const down = usePage((s) => s.connection === "down");
  const view = usePage((s) => s.review);
  const docs = usePage(selectDocs);

  return (
    <div className="card choice-card">
      <div className="where" title={choice.doc}>
        {docLabelOf(choice.doc, view, docs)} · {choice.decision}
      </div>
      <div>Chosen: “{choice.label}”</div>
      {gone && <Tag>no longer in the mockup</Tag>}
      {!locked && (
        <div className="actions">
          <button type="button" disabled={off} onClick={() => unchoose(named)}>
            Delete
          </button>
          {!gone && (
            <button
              type="button"
              disabled={off || sending || down}
              onClick={() =>
                void send({
                  annotations: [],
                  edit: null,
                  choices: [named],
                  parts: null,
                  takeDefaults: [],
                })
              }
            >
              Send now
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A card the pointer or the focus is on names itself to the renderer; a click asks it to scroll there too. */
function Card(props: { readonly annotation: Annotation }): JSX.Element {
  const { annotation } = props;
  const view = usePage((s) => s.review);
  const docs = usePage(selectDocs);

  const on = (reveal: boolean): void => {
    focusCard(annotation.id, reveal);
  };

  const off = (): void => {
    blurCard(annotation.id);
  };

  return (
    <div
      className="card"
      id={`card-${annotation.id}`}
      onMouseEnter={() => on(false)}
      onMouseLeave={off}
      onFocusCapture={() => on(false)}
      onBlurCapture={off}
      onClick={() => on(true)}
    >
      <div className="where" title={annotation.doc}>
        {docLabelOf(annotation.doc, view, docs)} · {whereOf(annotation.anchor)}
      </div>
      {/* The tag stays out of the quote, which stops at three lines and would hide it. */}
      {quotesOf(annotation.anchor).map((quote) => (
        <Fragment key={quote.key}>
          <div
            className={[
              "quote",
              annotation.mark.kind === "delete" && "struck",
              quote.mono && "code",
            ]
              .filter((name) => name !== false)
              .join(" ")}
          >
            “{quote.text}”
          </div>
          {quote.removed && <Tag>removed by your edit</Tag>}
        </Fragment>
      ))}
      <CardWords annotation={annotation} />
    </div>
  );
}

/**
 * The fold control, on the panel's edge, which it follows. Folded, it is the only trace left of
 * the panel, so it carries the total: neither `Comments` nor the decision bar filters by document.
 */
export function CommentsHandle(): JSX.Element {
  const count = usePage((s) => s.annotations.length + choicesIn(s.choices).length);
  const commentsOpen = usePage((s) => s.commentsOpen);

  return (
    <Handle
      side="right"
      open={commentsOpen}
      controls="comments"
      name="Comments"
      label={`Comments (${count})`}
      onToggle={toggleComments}
    >
      {count > 0 && <Badge>{count}</Badge>}
    </Handle>
  );
}

/** The panel; `doc` is what the general box comments: the document shown, or the plan beside one that takes none. */
export function Comments(props: { readonly doc: GroupedDoc | null }): JSX.Element {
  const draft = usePage((s) => s.typed.general);
  const { doc } = props;
  const annotations = usePage((s) => s.annotations);
  const choices = usePage((s) => s.choices);
  const docs = usePage(selectDocs);
  const view = usePage((s) => s.review);
  const commentsOpen = usePage((s) => s.commentsOpen);
  const commentsSnap = usePage((s) => s.commentsSnap);
  const locked = usePage(selectLocked);
  const editing = usePage((s) => s.editing !== null);
  // `true`: `app.tsx` draws the panel only where what is on screen takes comments.
  const switchDrawn = usePage((s) => switchShown(true, s));
  const list = sorted(annotations, docs);
  const chosen = sortedChoices(choices, docs);
  const name = doc === null || view === null ? "" : pathLabel(doc, view);
  const known = useRef<ReadonlySet<string> | null>(null);
  const folded = commentsOpen ? "comments" : "comments folded";

  // A comment added scrolls the list to its card: the reviewer sees it land. Several at once are
  // a load (the draft, after the panel mounted empty), which keeps the list where it is.
  useEffect(() => {
    const ids = new Set(list.map((annotation) => annotation.id));
    const before = known.current;
    known.current = ids;

    if (before === null) return;
    const [added, ...more] = list.filter((annotation) => !before.has(annotation.id));

    if (added === undefined || more.length > 0) return;
    document.querySelector(`#card-${added.id}`)?.scrollIntoView({ block: "nearest" });
  }, [list.map((annotation) => annotation.id).join("|")]);

  const add = (): void => {
    if (doc === null || draft.trim() === "") return;
    addAnnotation({
      doc: doc.path,
      anchor: { kind: "global" },
      mark: { kind: "comment", body: draft.trim() },
    });
    setTyped({ general: "" });
  };

  return (
    <aside
      id="comments"
      className={commentsSnap ? `${folded} snap` : folded}
      aria-label="Comments"
      inert={!commentsOpen}
    >
      <header>
        Comments <span>{list.length + chosen.length}</span>
      </header>
      <div className="list">
        {list.length + chosen.length === 0 && (
          <div className="none">{emptyLine(!locked && doc !== null, switchDrawn)}</div>
        )}
        {list.map((annotation) => (
          <Card key={annotation.id} annotation={annotation} />
        ))}
        {chosen.map((choice) => (
          <ChoiceCard key={JSON.stringify([choice.doc, choice.decision])} choice={choice} />
        ))}
      </div>
      <div className="global">
        <label htmlFor="global">Comment on {name}</label>
        <textarea
          id="global"
          rows={2}
          placeholder="General feedback on this document"
          disabled={locked || doc === null || editing}
          value={draft}
          onInput={(event) => setTyped({ general: event.currentTarget.value })}
        />
        <div className="row">
          <Button
            size="sm"
            disabled={locked || doc === null || editing || draft.trim() === ""}
            onClick={add}
          >
            Add comment
          </Button>
        </div>
      </div>
    </aside>
  );
}
