import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import { Button, Popover, Switch } from "./kit.tsx";
import type { Page } from "./state.ts";
import {
  discardEdit,
  flipCommentSwitch,
  pageStore,
  selectCurrentDoc,
  selectGoneOnDiscard,
  selectLocked,
  selectPlanDoc,
  toggleShowChanges,
  toggleSplit,
  usePage,
} from "./state.ts";

/** Where the switch is drawn, and false while the editor is open; `app.tsx` reads it before `C` flips the switch. */
export function switchShown(comments: boolean, s: Page): boolean {
  const plan = selectPlanDoc(s);
  const doc = selectCurrentDoc(s);
  const beside = plan !== null && doc !== null && doc.path !== plan.path;

  return (
    comments &&
    s.editing === null &&
    !selectLocked(s) &&
    (doc?.mediaType === "text/markdown" || doc?.mediaType === "text/html" || (beside && s.split))
  );
}

/**
 * Discard edit asks first: the edit is the reviewer's own text of the plan, and it goes whole,
 * with the comments on a line only it holds.
 */
function DiscardEdit(props: { readonly version: number }): JSX.Element {
  const [asking, setAsking] = useState(false);
  const gone = usePage(selectGoneOnDiscard);

  return (
    <>
      <Button size="sm" onClick={() => setAsking(true)}>
        Discard edit
      </Button>
      {asking && (
        <Popover
          label="Before discarding the edit"
          className="pop-bar"
          onClose={() => setAsking(false)}
        >
          <div className="warn-text">Your edit of v{props.version} is not sent.</div>
          <div>Discarding it brings the version's text back, and the comments with it.</div>
          {gone > 0 && (
            <div className="warn-text">
              {gone === 1
                ? "1 comment is on a line only your edit holds: it goes with the edit."
                : `${gone} comments are on lines only your edit holds: they go with the edit.`}
            </div>
          )}
          <div className="row">
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

export function Tools(props: ToolsProps): JSX.Element {
  const plan = usePage(selectPlanDoc);
  const doc = usePage(selectCurrentDoc);
  const view = usePage((s) => s.review);
  const split = usePage((s) => s.split);
  const shown = usePage((s) => switchShown(props.comments, s));
  const commentSwitch = usePage((s) => s.commentSwitch);
  const showChanges = usePage((s) => s.showChanges);
  const unsent = usePage((s) => s.edited);
  const beside = plan !== null && doc !== null && doc.path !== plan.path;
  const editable = plan !== null && !beside && view?.workspace.kind === "inReview";
  const planDrawn = plan !== null && (!beside || split);
  const since = planDrawn ? (view?.plan?.previous?.version ?? null) : null;
  const row = useRef<HTMLDivElement>(null);

  // The row comes back with the plan once the editor closes: the focus returns to Edit then.
  useEffect(() => {
    if (pageStore.getState().resume === null) return;
    row.current
      ?.querySelector<HTMLButtonElement>("button[name=edit]")
      ?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="tools" ref={row}>
      {shown && (
        <>
          <Switch checked={commentSwitch} onChange={flipCommentSwitch}>
            Comment
          </Switch>
          <kbd>C</kbd>
        </>
      )}
      {shown && beside && <span className="sep" />}
      {beside && (
        <Switch checked={split} onChange={toggleSplit}>
          Beside the plan
        </Switch>
      )}
      {editable && (
        <>
          <span className="sep" />
          <Button size="sm" name="edit" onClick={props.onEdit}>
            Edit
          </Button>
          {unsent !== null && <DiscardEdit version={unsent.version} />}
        </>
      )}
      {since !== null && (
        <>
          <span className="sep" />
          <Switch checked={showChanges} onChange={toggleShowChanges}>
            Changes since v{since}
          </Switch>
        </>
      )}
    </div>
  );
}
