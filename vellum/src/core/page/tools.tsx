import type { InputMethod } from "./state.ts";
import { currentDoc, inputMethod, locked, planDoc, review, showChanges, split } from "./state.ts";

const METHODS: readonly (readonly [InputMethod, string])[] = [
  ["select", "Select"],
  ["pinpoint", "Pinpoint"],
];

/**
 * The controls over the document: Select|Pinpoint while a pane takes comments, Beside the plan
 * while an artifact shows, Edit while the plan under review shows, Changes since while the plan
 * is drawn and has a version before it.
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

  const commentable =
    props.comments &&
    (doc?.mediaType === "text/markdown" ||
      doc?.mediaType === "text/html" ||
      (beside && split.value));

  const pinpointable = commentable && !locked.value;

  return (
    <div class="tools">
      {pinpointable && (
        <span class="seg" role="group" aria-label="Input method">
          {METHODS.map(([method, name]) => (
            <button
              key={method}
              type="button"
              aria-pressed={inputMethod.value === method}
              onClick={() => {
                inputMethod.value = method;
              }}
            >
              {name}
            </button>
          ))}
        </span>
      )}
      {pinpointable && beside && <span class="sep" />}
      {beside && (
        <label class="toggle">
          <input
            type="checkbox"
            checked={split.value}
            onChange={(event) => {
              split.value = event.currentTarget.checked;
            }}
          />{" "}
          Beside the plan
        </label>
      )}
      {editable && (
        <>
          <span class="sep" />
          <button class="btn small" type="button" onClick={props.onEdit}>
            Edit
          </button>
        </>
      )}
      {since !== null && (
        <>
          <span class="sep" />
          <label class="toggle">
            <input
              type="checkbox"
              checked={showChanges.value}
              onChange={(event) => {
                showChanges.value = event.currentTarget.checked;
              }}
            />{" "}
            Changes since v{since}
          </label>
        </>
      )}
    </div>
  );
}
