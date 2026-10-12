import type { JSX } from "react";

import type { Annotation, Choices } from "../../review/contract.ts";
import type { ProjectPath } from "../../workshop/paths.ts";
import type { DocGroup, GroupedDoc } from "../protocol.ts";
import { Badge, Handle } from "./kit.tsx";
import { docLabeller, nameParts, planLabel } from "./labels.ts";
import { pageStore, select, selectCurrentDoc, selectDocs, toggleRail, usePage } from "./state.ts";

/** A document's unsent work: its comments, and the choices made in it. */
function countOf(annotations: readonly Annotation[], choices: Choices, path: string): number {
  const chosen = Object.keys(choices[path] ?? {}).length;

  return annotations.filter((a) => a.doc === path).length + chosen;
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
export function RailHandle(): JSX.Element {
  const railOpen = usePage((s) => s.railOpen);

  return (
    <Handle
      side="left"
      open={railOpen}
      controls="rail"
      name="Documents"
      onToggle={(event) => {
        toggleRail();

        if (pageStore.getState().railOpen) {
          unfold = { at: performance.now(), from: event.currentTarget.getBoundingClientRect() };
        }
      }}
    />
  );
}

export function DocList(): JSX.Element {
  const view = usePage((s) => s.review);
  const docs = usePage(selectDocs);
  const current = usePage(selectCurrentDoc);
  const annotations = usePage((s) => s.annotations);
  const choices = usePage((s) => s.choices);
  const railOpen = usePage((s) => s.railOpen);
  const editing = usePage((s) => s.editing);
  const workspace = view?.workspace;
  const plan = docs.find((doc) => doc.group === "plan");
  const artifacts = inGroup(docs, "artifact");
  const cited = inGroup(docs, "cited");
  const labelOf = view === null ? null : docLabeller(view);
  const count = (path: string): number => countOf(annotations, choices, path);

  // The name's stem alone is cut when the room is short: the extension says what the line opens.
  const item = (doc: GroupedDoc): JSX.Element => {
    const label = labelOf === null ? null : labelOf(doc);
    const { stem, ext } = nameParts(label?.name ?? doc.path);

    return (
      <button
        type="button"
        key={doc.path}
        title={doc.path}
        aria-current={current?.path === doc.path ? "page" : undefined}
        onClick={(event) => chooseDoc(doc.path, event.nativeEvent)}
      >
        <span className="name">
          <span className="stem">{stem}</span>
          {ext !== "" && <span className="ext">{ext}</span>}
        </span>
        {label !== null && label.dir !== null && (
          <span className="dir" title={label.dir}>
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
      className={railOpen ? "rail" : "rail folded"}
      aria-label="Documents"
      inert={editing !== null || !railOpen}
    >
      {plan !== undefined && workspace !== undefined && (
        <button
          type="button"
          className="plate"
          aria-current={current?.path === plan.path ? "page" : undefined}
          onClick={(event) => chooseDoc(plan.path, event.nativeEvent)}
        >
          <span className="lead">Plan</span>
          <span className="ver">{planLabel(workspace)}</span>
          {count(plan.path) > 0 && <Badge>{count(plan.path)}</Badge>}
        </button>
      )}
      <h5>
        Artifacts <span className="n">{artifacts.length}</span>
      </h5>
      {artifacts.length === 0 && <div className="empty">No files yet</div>}
      {artifacts.map((doc) => item(doc))}
      {cited.length > 0 && (
        <div className="away">
          <h5>
            Cited in the plan <span className="n">{cited.length}</span>
          </h5>
          {cited.map((doc) => item(doc))}
        </div>
      )}
    </nav>
  );
}
