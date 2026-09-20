import { useState } from "preact/hooks";

import type { Anchor, Annotation, Mark } from "../protocol.ts";
import { DELETE_SENTENCE, QUICK_LABELS } from "../protocol.ts";
import { Badge, Button, Chevron, Tag } from "./kit.tsx";
import {
  addAnnotation,
  annotations,
  commentsOpen,
  currentDoc,
  editing,
  locked,
  removeAnnotation,
  review,
} from "./state.ts";

/** What the card says above the quotes: general, the lines of the passages, or the elements. */
function whereOf(anchor: Anchor): string {
  if (anchor.kind === "global") return "general";

  if (anchor.kind === "text") {
    return `lines ${anchor.passages.map((passage) => `${passage.lines[0]}–${passage.lines[1]}`).join(", ")}`;
  }

  return anchor.elements.map((element) => element.selector).join(", ");
}

function quotesOf(anchor: Anchor): readonly { readonly key: string; readonly text: string }[] {
  if (anchor.kind === "global") return [];

  if (anchor.kind === "text") {
    return anchor.passages.map((passage) => ({
      key: `${passage.lines[0]}-${passage.quote}`,
      text: passage.quote,
    }));
  }

  return anchor.elements.map((element) => ({ key: element.selector, text: element.text }));
}

function MarkWords(props: { readonly mark: Mark }): preact.JSX.Element {
  const { mark } = props;

  if (mark.kind === "comment") return <div>{mark.body}</div>;

  if (mark.kind === "delete") return <div>{DELETE_SENTENCE}</div>;

  return (
    <div>
      <Tag>{QUICK_LABELS[mark.label].name}</Tag>
      {mark.body !== "" && <div>{mark.body}</div>}
    </div>
  );
}

function Card(props: { readonly annotation: Annotation }): preact.JSX.Element {
  const { annotation } = props;
  const dir = review.value?.workspace.dir ?? "";
  const doc = annotation.doc.startsWith(dir) ? annotation.doc.slice(dir.length) : annotation.doc;

  return (
    <div class="card">
      <div class="where" title={annotation.doc}>
        {doc} · {whereOf(annotation.anchor)}
      </div>
      {quotesOf(annotation.anchor).map((quote) => (
        <div class={annotation.mark.kind === "delete" ? "quote struck" : "quote"} key={quote.key}>
          “{quote.text}”
        </div>
      ))}
      <MarkWords mark={annotation.mark} />
      {!locked.value && (
        <div class="actions">
          <button type="button" onClick={() => removeAnnotation(annotation.id)}>
            Delete
          </button>
        </div>
      )}
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
    <button
      type="button"
      class="handle"
      aria-controls="comments"
      aria-expanded={commentsOpen.value}
      aria-label={`Comments (${count})`}
      onClick={() => {
        commentsOpen.value = !commentsOpen.value;
      }}
    >
      {count > 0 && <Badge>{count}</Badge>}
      <Chevron />
    </button>
  );
}

export function Comments(): preact.JSX.Element {
  const [draft, setDraft] = useState("");
  const doc = currentDoc.value;
  const list = annotations.value;
  const name = doc === null ? "" : (doc.path.split("/").at(-1) ?? doc.path);

  const add = (): void => {
    if (doc === null || draft.trim() === "") return;
    addAnnotation({
      doc: doc.path,
      anchor: { kind: "global" },
      mark: { kind: "comment", body: draft.trim() },
    });
    setDraft("");
  };

  return (
    <aside
      id="comments"
      class={commentsOpen.value ? "comments" : "comments folded"}
      aria-label="Comments"
      inert={editing.value !== null || !commentsOpen.value}
    >
      <header>
        Comments <span>{list.length}</span>
      </header>
      <div class="list">
        {list.length === 0 && (
          <div class="none">No comments yet. Select text or use the box below.</div>
        )}
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
          disabled={locked.value || doc === null}
          value={draft}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <div class="row">
          <Button
            size="sm"
            disabled={locked.value || doc === null || draft.trim() === ""}
            onClick={add}
          >
            Add comment
          </Button>
        </div>
      </div>
    </aside>
  );
}
