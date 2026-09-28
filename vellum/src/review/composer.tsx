import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { Button, Chip, Popover } from "../runtime/page/kit.tsx";
import { quoteOf, whereOf } from "../runtime/page/labels.ts";
import type { Rect } from "../runtime/page/place.ts";
import { placeNear } from "../runtime/page/place.ts";
import { setTyped, typed } from "../runtime/page/state.ts";
import type { ProjectPath } from "../workshop/paths.ts";
import type { ElementRef, Mark, Passage, QuickLabel } from "./feedback.ts";
import { QUICK_LABELS } from "./feedback.ts";

/** One chosen place: a passage of a text, or an element of a mockup; the popover says it in the page's words. */
export type Pick = { readonly key: string } & (
  | { readonly passage: Passage }
  | { readonly element: ElementRef }
);

/** What the popover shows of a pick: the quote, in mono for a code block, and where it is. */
type Shown = { readonly quote: string; readonly mono: boolean; readonly where: string };

function shown(pick: Pick): Shown {
  if ("element" in pick) {
    return { quote: pick.element.text, mono: false, where: pick.element.label };
  }

  return {
    quote: quoteOf(pick.passage),
    mono: pick.passage.kind !== "prose",
    where: whereOf({ kind: "text", passages: [pick.passage] }),
  };
}

export type ComposerProps = {
  /** The document commented: the text typed is kept for the next composer on it. */
  readonly doc: ProjectPath;
  readonly picks: readonly Pick[];
  /** While a target is being added, the popover fades and lets the pointer through. */
  readonly through: boolean;
  /** The last chosen place and the pane's window, both in the pane's scrolled content. */
  readonly target: Rect;
  readonly pane: Rect;
  readonly onSubmit: (mark: Mark) => void;
  readonly onCancel: () => void;
};

const LABELS: readonly QuickLabel[] = ["clarify", "verify", "tooMuch", "missingCheck"];

/** The popover's width before it is measured: what `style.css` gives `.popover`. */
const UNMEASURED = { width: 300, height: 0 };

/**
 * The popover near a selection: every chosen place, the labels and "Delete this", a textarea,
 * Cancel and Add comment. It does one thing: a label or "Delete this" is a comment by itself,
 * sent at the click, and typed text goes by Add comment, so the labels grey as soon as a text is typed.
 * The text lives in the draft: a composer unmounted under it gives it to the next one on the
 * same document, and a send or a Cancel is what clears it.
 */
export function Composer(props: ComposerProps): preact.JSX.Element {
  const body = typed.value.composer[props.doc] ?? "";
  const [size, setSize] = useState(UNMEASURED);
  const box = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const places = props.picks.map((pick) => pick.key).join("|");
  const text = body.trim();

  const forget = (): void => {
    const { [props.doc]: _gone, ...rest } = typed.value.composer;
    setTyped({ composer: rest });
  };

  const setBody = (value: string): void => {
    if (value === "") forget();
    else setTyped({ composer: { ...typed.value.composer, [props.doc]: value } });
  };

  const submit = (mark: Mark): void => {
    forget();
    props.onSubmit(mark);
  };

  const cancel = (): void => {
    forget();
    props.onCancel();
  };

  // The popover is not remounted when its place changes, and a pick inside a mockup leaves the
  // focus in its frame: the textarea takes it back at every change of place.
  useEffect(() => textarea.current?.focus({ preventScroll: true }), [places]);

  // Placed from its own height, measured once drawn and again when its content changes: another
  // quote or a longer text, another height.
  useLayoutEffect(() => {
    const element = box.current;

    if (element === null) return;
    const measured = { width: element.offsetWidth, height: element.offsetHeight };

    setSize((current) =>
      current.width === measured.width && current.height === measured.height ? current : measured,
    );
  }, [places, body]);

  const at = placeNear(props.target, props.pane, size);

  const send = (): void => {
    if (text !== "") submit({ kind: "comment", body: text });
  };

  return (
    <Popover
      label="New comment"
      through={props.through}
      top={at.top}
      left={at.left}
      box={box}
      onClose={cancel}
      onSubmit={send}
    >
      {props.picks.map((pick) => {
        const { quote, mono, where } = shown(pick);

        return (
          <div class={mono ? "quote code" : "quote"} key={pick.key}>
            “{quote}” · <span class="where">{where}</span>
          </div>
        );
      })}
      <div class="labels">
        {LABELS.map((label) => (
          <Chip key={label} disabled={text !== ""} onClick={() => submit({ kind: "label", label })}>
            {QUICK_LABELS[label].name}
          </Chip>
        ))}
        <span class="spacer" />
        <Chip tone="del" disabled={text !== ""} onClick={() => submit({ kind: "delete" })}>
          Delete this
        </Chip>
      </div>
      <textarea
        rows={3}
        aria-label="Comment"
        placeholder="Comment"
        autofocus
        ref={textarea}
        value={body}
        onInput={(event) => setBody(event.currentTarget.value)}
      />
      <div class="row">
        <Button size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" variant="send" disabled={text === ""} onClick={send}>
          Add comment
        </Button>
      </div>
    </Popover>
  );
}
