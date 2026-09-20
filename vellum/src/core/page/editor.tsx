import { useEffect, useRef } from "preact/hooks";

import { offsetOfLine } from "./caret.ts";
import { Button } from "./kit.tsx";
import type { EditSession } from "./state.ts";
import { editing, finishEdit } from "./state.ts";

/** The session the editor opened on: nothing in it changes while it is open. */
export type EditorProps = {
  readonly session: EditSession;
};

/**
 * The plan's Markdown source in place of its rendering: a plain textarea, Cancel and Done.
 * Nothing is sent from here: Done hands the text to the store, and the next decision carries it.
 */
export function Editor({ session }: EditorProps): preact.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const area = textarea.current;

    if (area === null) return;
    const offset = offsetOfLine(session.base, session.line);
    area.setSelectionRange(offset, offset);
    // A focus taken after the caret moved is what scrolls a textarea to its caret.
    area.blur();
    area.focus();
  }, []);

  return (
    <>
      <div class="tools">
        <span>Editing the source of v{session.version}</span>
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
          onClick={() => finishEdit(session, textarea.current?.value ?? session.base)}
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
            defaultValue={session.base}
          />
        </div>
      </div>
    </>
  );
}
