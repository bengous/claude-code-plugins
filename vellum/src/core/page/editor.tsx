import { useEffect, useRef } from "preact/hooks";

import type { Version } from "../server/domain/paths.ts";
import { offsetOfLine } from "./caret.ts";
import { Button } from "./kit.tsx";
import { editing, finishEdit } from "./state.ts";

/** The session the editor opened on: `version` and `base` do not change while it is open. */
export type EditorProps = {
  readonly version: Version;
  readonly base: string;
  /** The source line the caret opens on: the block the reviewer was reading. */
  readonly line: number;
};

/**
 * The plan's Markdown source in place of its rendering: a plain textarea, Cancel and Done.
 * Nothing is sent from here: Done hands the text to the store, and the next decision carries it.
 */
export function Editor(props: EditorProps): preact.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const area = textarea.current;

    if (area === null) return;
    const offset = offsetOfLine(props.base, props.line);
    area.setSelectionRange(offset, offset);
    // A focus taken after the caret moved is what scrolls a textarea to its caret.
    area.blur();
    area.focus();
  }, []);

  return (
    <>
      <div class="tools">
        <span>Editing the source of v{props.version}</span>
        <span class="spacer" />
        <Button
          size="sm"
          onClick={() => {
            editing.value = null;
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="send"
          onClick={() =>
            finishEdit(props.version, props.base, textarea.current?.value ?? props.base)
          }
        >
          Done
        </Button>
      </div>
      <div class="panes">
        <div class="editor">
          <textarea
            ref={textarea}
            spellcheck={false}
            aria-label="Plan source"
            defaultValue={props.base}
          />
        </div>
      </div>
    </>
  );
}
