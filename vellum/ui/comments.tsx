import { useState } from "preact/hooks";

import type { Annotation } from "../src/protocol.ts";
import { addAnnotation, annotations, currentDoc, locked, removeAnnotation } from "./state.ts";

function Card(props: { readonly annotation: Annotation }): preact.JSX.Element {
  const { annotation } = props;
  const { anchor } = annotation;

  return (
    <div class="card">
      <div class="where">
        {annotation.doc} ·{" "}
        {anchor.kind === "global" ? "general" : `lines ${anchor.lines[0]}–${anchor.lines[1]}`}
      </div>
      {anchor.kind === "text" && <div class="quote">“{anchor.quote}”</div>}
      <div>{annotation.body}</div>
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

export function Comments(): preact.JSX.Element {
  const [draft, setDraft] = useState("");
  const doc = currentDoc.value;
  const list = annotations.value;
  const name = doc === null ? "" : (doc.path.split("/").at(-1) ?? doc.path);

  const add = (): void => {
    if (doc === null || draft.trim() === "") return;
    addAnnotation({ doc: doc.path, anchor: { kind: "global" }, body: draft.trim() });
    setDraft("");
  };

  return (
    <aside class="comments" aria-label="Comments">
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
          <button
            class="btn small"
            type="button"
            disabled={locked.value || doc === null || draft.trim() === ""}
            onClick={add}
          >
            Add comment
          </button>
        </div>
      </div>
    </aside>
  );
}
