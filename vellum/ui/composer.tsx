import { useState } from "preact/hooks";

import type { TextAnchor } from "./anchoring.ts";

export type ComposerProps = {
  readonly anchor: TextAnchor;
  readonly top: number;
  readonly left: number;
  readonly onSubmit: (body: string) => void;
  readonly onCancel: () => void;
};

/** The popover under a selection: the quote, a textarea, Cancel and Add comment. */
export function Composer(props: ComposerProps): preact.JSX.Element {
  const [body, setBody] = useState("");
  const { anchor } = props;

  return (
    <div
      class="popover"
      role="dialog"
      aria-label="New comment"
      style={{ top: `${props.top}px`, left: `${props.left}px` }}
    >
      <div class="quote">
        “{anchor.quote}” · lines {anchor.lines[0]}–{anchor.lines[1]}
      </div>
      <textarea
        rows={3}
        aria-label="Comment"
        autoFocus
        value={body}
        onInput={(event) => setBody(event.currentTarget.value)}
      />
      <div class="row">
        <button class="btn small" type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          class="btn small send"
          type="button"
          disabled={body.trim() === ""}
          onClick={() => props.onSubmit(body.trim())}
        >
          Add comment
        </button>
      </div>
    </div>
  );
}
