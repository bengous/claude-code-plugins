import type { DocGroup, GroupedDoc } from "../protocol.ts";
import type { ProjectPath } from "../server/domain/paths.ts";
import { Badge, Handle } from "./kit.tsx";
import { docLabeller, nameParts, planLabel } from "./labels.ts";
import { annotations, currentDoc, docs, editing, railOpen, review, select } from "./state.ts";

function count(path: string): number {
  return annotations.value.filter((a) => a.doc === path).length;
}

function inGroup(list: readonly GroupedDoc[], group: DocGroup): readonly GroupedDoc[] {
  return list.filter((doc) => doc.group === group);
}

/**
 * The rail's last unfolding: when, and where the handle was. The handle rides the rail's edge, so
 * the second click of a double click on it lands on whatever line slid under the pointer, with a
 * click count of 1 since the target changed: a line ignores a click that arrives within a double
 * click's delay of the unfolding, at the spot the handle left.
 */
type Unfold = { readonly at: number; readonly from: DOMRect };

let unfold: Unfold | null = null;

const DOUBLE_CLICK_MS = 300;

function isSecondClickOnHandle(event: MouseEvent): boolean {
  if (unfold === null || performance.now() - unfold.at >= DOUBLE_CLICK_MS) return false;
  const { from } = unfold;

  return (
    event.clientX >= from.left &&
    event.clientX <= from.right &&
    event.clientY >= from.top &&
    event.clientY <= from.bottom
  );
}

function chooseDoc(path: ProjectPath, event: MouseEvent): void {
  if (isSecondClickOnHandle(event)) return;
  select(path);
}

/**
 * The fold control, on the rail's edge, which it follows. Folded, the rail hides each document's
 * count and any document Claude writes meanwhile; the handle carries no badge all the same, since
 * the rail opens at every load and only the reviewer folds it.
 */
export function RailHandle(): preact.JSX.Element {
  return (
    <Handle
      side="left"
      open={railOpen.value}
      controls="rail"
      name="Documents"
      onToggle={(event) => {
        railOpen.value = !railOpen.value;

        if (railOpen.value) {
          unfold = { at: performance.now(), from: event.currentTarget.getBoundingClientRect() };
        }
      }}
    />
  );
}

export function DocList(): preact.JSX.Element {
  const workspace = review.value?.workspace;
  const plan = docs.value.find((doc) => doc.group === "plan");
  const artifacts = inGroup(docs.value, "artifact");
  const cited = inGroup(docs.value, "cited");
  const view = review.value;
  const labelOf = view === null ? null : docLabeller(view);

  // The name's stem alone is cut when the room is short: the extension says what the line opens.
  const item = (doc: GroupedDoc): preact.JSX.Element => {
    const label = labelOf === null ? null : labelOf(doc);
    const { stem, ext } = nameParts(label?.name ?? doc.path);

    return (
      <button
        type="button"
        key={doc.path}
        title={doc.path}
        aria-current={currentDoc.value?.path === doc.path ? "page" : undefined}
        onClick={(event) => chooseDoc(doc.path, event)}
      >
        <span class="name">
          <span class="stem">{stem}</span>
          {ext !== "" && <span class="ext">{ext}</span>}
        </span>
        {label !== null && label.dir !== null && (
          <span class="dir" title={label.dir}>
            {label.dir}
          </span>
        )}
        {count(doc.path) > 0 && <Badge>{count(doc.path)}</Badge>}
      </button>
    );
  };

  return (
    <nav
      id="rail"
      class={railOpen.value ? "rail" : "rail folded"}
      aria-label="Documents"
      inert={editing.value !== null || !railOpen.value}
    >
      {plan !== undefined && workspace !== undefined && (
        <button
          type="button"
          class="plate"
          aria-current={currentDoc.value?.path === plan.path ? "page" : undefined}
          onClick={(event) => chooseDoc(plan.path, event)}
        >
          <span class="lead">Plan</span>
          <span class="ver">{planLabel(workspace)}</span>
          {count(plan.path) > 0 && <Badge>{count(plan.path)}</Badge>}
        </button>
      )}
      <h5>
        Artifacts <span class="n">{artifacts.length}</span>
      </h5>
      {artifacts.length === 0 && <div class="empty">No files yet</div>}
      {artifacts.map((doc) => item(doc))}
      {cited.length > 0 && (
        <div class="away">
          <h5>
            Cited in the plan <span class="n">{cited.length}</span>
          </h5>
          {cited.map((doc) => item(doc))}
        </div>
      )}
    </nav>
  );
}
