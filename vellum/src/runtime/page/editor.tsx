import { useEffect, useRef, useState } from "preact/hooks";

import { lineOfOffset, offsetOfLine } from "./caret.ts";
import { Button, Popover } from "./kit.tsx";
import { staleEditor } from "./notices.ts";
import type { EditSession } from "./state.ts";
import { closeEditor, finishEdit, review, setTyped, typed } from "./state.ts";

/** The session the editor opened on: nothing in it changes while it is open. */
export type EditorProps = {
  readonly session: EditSession;
};

/**
 * The plan's Markdown source in place of its rendering: a plain textarea, Cancel and Done, which
 * Ctrl+Enter is too. Nothing is sent from here: Done hands the text to the store, and the next
 * decision carries it. The typing goes to the draft as it pauses, and comes back to the next
 * editor on the same version; Cancel over a changed text asks first. Both close the editor on
 * the line under the caret, where the plan comes back.
 */
export function Editor({ session }: EditorProps): preact.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [asking, setAsking] = useState(false);
  const stale = staleEditor(session, review.value?.workspace ?? null);
  const kept = typed.peek().editor;
  const initial = kept !== null && kept.version === session.version ? kept.text : session.base;

  useEffect(() => {
    const area = textarea.current;

    if (area === null) return;
    const offset = offsetOfLine(session.base, session.line);
    area.setSelectionRange(offset, offset);
    // A focus taken after the caret moved is what scrolls a textarea to its caret.
    area.blur();
    area.focus();
  }, []);

  const text = (): string => textarea.current?.value ?? session.base;

  const caretLine = (): number => lineOfOffset(text(), textarea.current?.selectionStart ?? 0);

  const discard = (): void => {
    setTyped({ editor: null });
    closeEditor(caretLine());
  };

  const cancel = (): void => {
    if (text() === session.base) discard();
    else setAsking(true);
  };

  const done = (): void => {
    if (stale !== null) return;
    setTyped({ editor: null });
    finishEdit(session, text());
    closeEditor(caretLine());
  };

  return (
    <>
      <div class="tools">
        <span>Editing the source of v{session.version}</span>
        <span class="spacer" />
        <Button size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="send"
          disabled={stale !== null}
          title={stale ?? undefined}
          onClick={done}
        >
          Done <kbd>Ctrl</kbd> <kbd>↵</kbd>
        </Button>
        {asking && (
          <Popover
            label="Before leaving the editor"
            class="pop-bar"
            onClose={() => setAsking(false)}
          >
            <div class="warn-text">What you typed is not kept.</div>
            <div>Cancel throws it away.</div>
            <div class="row">
              <Button size="sm" onClick={() => setAsking(false)}>
                Keep editing
              </Button>
              <Button size="sm" variant="send" onClick={discard}>
                Discard
              </Button>
            </div>
          </Popover>
        )}
      </div>
      <div class="panes">
        <div class="editor">
          <textarea
            ref={textarea}
            spellcheck={false}
            aria-label="Plan source"
            defaultValue={initial}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setTyped({
                editor: value === session.base ? null : { version: session.version, text: value },
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) done();
            }}
          />
        </div>
      </div>
    </>
  );
}
