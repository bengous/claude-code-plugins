import { useEffect, useRef, useState } from "preact/hooks";

import { Button, Popover, Switch } from "./kit.tsx";
import {
  commentSwitch,
  currentDoc,
  discardEdit,
  edited,
  editing,
  flipCommentSwitch,
  goneOnDiscard,
  locked,
  planDoc,
  resume,
  review,
  showChanges,
  split,
} from "./state.ts";

/** Where the switch is drawn, and false while the editor is open; `app.tsx` reads it before `C` flips the switch. */
export function switchShown(comments: boolean): boolean {
  const plan = planDoc.value;
  const doc = currentDoc.value;
  const beside = plan !== null && doc !== null && doc.path !== plan.path;

  return (
    comments &&
    editing.value === null &&
    !locked.value &&
    (doc?.mediaType === "text/markdown" ||
      doc?.mediaType === "text/html" ||
      (beside && split.value))
  );
}

/**
 * Discard edit asks first: the edit is the reviewer's own text of the plan, and it goes whole,
 * with the comments on a line only it holds.
 */
function DiscardEdit(props: { readonly version: number }): preact.JSX.Element {
  const [asking, setAsking] = useState(false);
  const gone = goneOnDiscard.value;

  return (
    <>
      <Button size="sm" onClick={() => setAsking(true)}>
        Discard edit
      </Button>
      {asking && (
        <Popover
          label="Before discarding the edit"
          class="pop-bar"
          onClose={() => setAsking(false)}
        >
          <div class="warn-text">Your edit of v{props.version} is not sent.</div>
          <div>Discarding it brings the version's text back, and the comments with it.</div>
          {gone > 0 && (
            <div class="warn-text">
              {gone === 1
                ? "1 comment is on a line only your edit holds: it goes with the edit."
                : `${gone} comments are on lines only your edit holds: they go with the edit.`}
            </div>
          )}
          <div class="row">
            <Button size="sm" onClick={() => setAsking(false)}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="send"
              onClick={() => {
                setAsking(false);
                discardEdit();
              }}
            >
              Discard
            </Button>
          </div>
        </Popover>
      )}
    </>
  );
}

/**
 * The controls over the document: the Comment switch while a pane takes comments, Beside the plan
 * while an artifact shows, Edit while the plan under review shows, Discard edit beside it while
 * an edit is unsent, Changes since while the plan is drawn and has a version before it.
 */
type ToolsProps = {
  readonly onEdit: () => void;
  /** Whether what is on screen takes comments, as `app.tsx` reads it off the renderer. */
  readonly comments: boolean;
};

export function Tools(props: ToolsProps): preact.JSX.Element {
  const plan = planDoc.value;
  const doc = currentDoc.value;
  const beside = plan !== null && doc !== null && doc.path !== plan.path;
  const editable = plan !== null && !beside && review.value?.workspace.kind === "inReview";
  const planDrawn = plan !== null && (!beside || split.value);
  const since = planDrawn ? (review.value?.plan?.previous?.version ?? null) : null;
  const shown = switchShown(props.comments);
  const row = useRef<HTMLDivElement>(null);
  const unsent = edited.value;

  // The row comes back with the plan once the editor closes: the focus returns to Edit then.
  useEffect(() => {
    if (resume.peek() === null) return;
    row.current
      ?.querySelector<HTMLButtonElement>("button[name=edit]")
      ?.focus({ preventScroll: true });
  }, []);

  return (
    <div class="tools" ref={row}>
      {shown && (
        <>
          <Switch checked={commentSwitch.value} onChange={flipCommentSwitch}>
            Comment
          </Switch>
          <kbd>C</kbd>
        </>
      )}
      {shown && beside && <span class="sep" />}
      {beside && (
        <Switch
          checked={split.value}
          onChange={() => {
            split.value = !split.value;
          }}
        >
          Beside the plan
        </Switch>
      )}
      {editable && (
        <>
          <span class="sep" />
          <Button size="sm" name="edit" onClick={props.onEdit}>
            Edit
          </Button>
          {unsent !== null && <DiscardEdit version={unsent.version} />}
        </>
      )}
      {since !== null && (
        <>
          <span class="sep" />
          <Switch
            checked={showChanges.value}
            onChange={() => {
              showChanges.value = !showChanges.value;
            }}
          >
            Changes since v{since}
          </Switch>
        </>
      )}
    </div>
  );
}
