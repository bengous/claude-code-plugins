import { batch } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type { Anchor, Annotation, GroupedDoc, Mark } from "../protocol.ts";
import { DELETE_SENTENCE, QUICK_LABELS } from "../protocol.ts";
import { Badge, Button, Handle, Tag } from "./kit.tsx";
import { pathLabel, quoteOf, whereOf } from "./labels.ts";
import {
  addAnnotation,
  annotations,
  commentsOpen,
  commentsSnap,
  connection,
  docs,
  editing,
  focused,
  locked,
  removeAnnotation,
  review,
  send,
  sending,
  setTyped,
  typed,
  updateAnnotation,
} from "./state.ts";
import { switchShown } from "./tools.tsx";

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

/** The empty panel names the switch only where `Tools` draws it, and the box only where it takes text. */
function emptyLine(boxOpen: boolean): string {
  if (!boxOpen) return "No comments yet.";

  // `true`: `app.tsx` draws the panel only where what is on screen takes comments.
  return switchShown(true)
    ? "No comments yet. Turn on Comment to pick text, or use the box below."
    : "No comments yet. Use the box below.";
}

function MarkWords(props: { readonly mark: Mark }): preact.JSX.Element {
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
 * actions are off, the card readable. Send now sends this comment alone, and leaves the round.
 */
function CardWords(props: { readonly annotation: Annotation }): preact.JSX.Element {
  const { annotation } = props;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { mark } = annotation;
  const off = editing.value !== null;

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
        {!locked.value && (
          <div class="actions">
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
              disabled={off || sending.value || connection.value === "down"}
              onClick={() => void send([annotation.id], false)}
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
        autofocus
        value={text}
        onInput={(event) => type(event.currentTarget.value)}
      />
      <div class="actions">
        <button type="button" disabled={text.trim() === ""} onClick={() => setOpen(false)}>
          Done
        </button>
      </div>
    </>
  );
}

/** What a card calls its document: the listed document's label, or the file's name once it is listed no more. */
function docLabelOf(path: string): string {
  const view = review.value;
  const doc = docs.value.find((one) => one.path === path);

  return view === null || doc === undefined
    ? (path.split("/").at(-1) ?? path)
    : pathLabel(doc, view);
}

/** A card the pointer or the focus is on names itself to the renderer; a click asks it to scroll there too. */
function Card(props: { readonly annotation: Annotation }): preact.JSX.Element {
  const { annotation } = props;

  const on = (reveal: boolean): void => {
    focused.value = { id: annotation.id, reveal };
  };

  const off = (): void => {
    if (focused.peek()?.id === annotation.id) focused.value = null;
  };

  return (
    <div
      class="card"
      id={`card-${annotation.id}`}
      onMouseEnter={() => on(false)}
      onMouseLeave={off}
      onFocusCapture={() => on(false)}
      onBlurCapture={off}
      onClick={() => on(true)}
    >
      <div class="where" title={annotation.doc}>
        {docLabelOf(annotation.doc)} · {whereOf(annotation.anchor)}
      </div>
      {/* The tag stays out of the quote, which stops at three lines and would hide it. */}
      {quotesOf(annotation.anchor).map((quote) => (
        <Fragment key={quote.key}>
          <div
            class={["quote", annotation.mark.kind === "delete" && "struck", quote.mono && "code"]
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
export function CommentsHandle(): preact.JSX.Element {
  const count = annotations.value.length;

  return (
    <Handle
      side="right"
      open={commentsOpen.value}
      controls="comments"
      name="Comments"
      label={`Comments (${count})`}
      onToggle={() => {
        batch(() => {
          commentsSnap.value = false;
          commentsOpen.value = !commentsOpen.value;
        });
      }}
    >
      {count > 0 && <Badge>{count}</Badge>}
    </Handle>
  );
}

/** The panel; `doc` is what the general box comments: the document shown, or the plan beside one that takes none. */
export function Comments(props: { readonly doc: GroupedDoc | null }): preact.JSX.Element {
  const draft = typed.value.general;
  const { doc } = props;
  const list = sorted(annotations.value, docs.value);
  const view = review.value;
  const name = doc === null || view === null ? "" : pathLabel(doc, view);
  const known = useRef<ReadonlySet<string> | null>(null);
  const folded = commentsOpen.value ? "comments" : "comments folded";

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
      class={commentsSnap.value ? `${folded} snap` : folded}
      aria-label="Comments"
      inert={!commentsOpen.value}
    >
      <header>
        Comments <span>{list.length}</span>
      </header>
      <div class="list">
        {list.length === 0 && <div class="none">{emptyLine(!locked.value && doc !== null)}</div>}
        {list.map((annotation) => (
          <Card key={annotation.id} annotation={annotation} />
        ))}
      </div>
      <div class="global">
        <label for="global">Comment on {name}</label>
        <textarea
          id="global"
          rows={2}
          placeholder="General feedback on this document"
          disabled={locked.value || doc === null || editing.value !== null}
          value={draft}
          onInput={(event) => setTyped({ general: event.currentTarget.value })}
        />
        <div class="row">
          <Button
            size="sm"
            disabled={locked.value || doc === null || editing.value !== null || draft.trim() === ""}
            onClick={add}
          >
            Add comment
          </Button>
        </div>
      </div>
    </aside>
  );
}
