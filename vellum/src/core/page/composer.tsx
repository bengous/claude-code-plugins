import { useEffect, useRef, useState } from "preact/hooks";

import type { Mark, QuickLabel } from "../protocol.ts";
import { QUICK_LABELS } from "../protocol.ts";
import { Button, Chip, Popover } from "./kit.tsx";

/** One chosen place, as the popover shows it: what it says, and where it is. */
export type Pick = { readonly key: string; readonly text: string; readonly where: string };

export type ComposerProps = {
  readonly picks: readonly Pick[];
  /** While a target is being added, the popover fades and lets the pointer through. */
  readonly through: boolean;
  readonly top: number;
  readonly left: number;
  readonly onSubmit: (mark: Mark) => void;
  readonly onCancel: () => void;
};

const LABELS: readonly QuickLabel[] = ["clarify", "verify", "tooMuch", "missingCheck"];

/**
 * The popover under a selection: every chosen place, the labels and "Delete this", a textarea,
 * Cancel and Add comment. A label or "Delete this" submits at once; a label takes the
 * textarea's text as its detail, which may be empty.
 */
export function Composer(props: ComposerProps): preact.JSX.Element {
  const [body, setBody] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const places = props.picks.map((pick) => pick.key).join("|");

  // The popover is not remounted when its place changes, and a pick inside a mockup leaves the
  // focus in its frame: the textarea takes it back at every change of place.
  useEffect(() => textarea.current?.focus(), [places]);

  return (
    <Popover label="New comment" through={props.through} top={props.top} left={props.left}>
      {props.picks.map((pick) => (
        <div class="quote" key={pick.key}>
          “{pick.text}” · {pick.where}
        </div>
      ))}
      <div class="labels">
        {LABELS.map((label) => (
          <Chip
            key={label}
            onClick={() => props.onSubmit({ kind: "label", label, body: body.trim() })}
          >
            {QUICK_LABELS[label].name}
          </Chip>
        ))}
        <span class="spacer" />
        <Chip tone="del" onClick={() => props.onSubmit({ kind: "delete" })}>
          Delete this
        </Chip>
      </div>
      <textarea
        rows={3}
        aria-label="Comment"
        placeholder="Comment, or a detail for the label"
        ref={textarea}
        value={body}
        onInput={(event) => setBody(event.currentTarget.value)}
      />
      <div class="row">
        <Button size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="send"
          disabled={body.trim() === ""}
          onClick={() => props.onSubmit({ kind: "comment", body: body.trim() })}
        >
          Add comment
        </Button>
      </div>
    </Popover>
  );
}
