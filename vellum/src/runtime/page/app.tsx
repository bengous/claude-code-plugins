import type { JSX } from "react";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

import { lineAtTop } from "../../review/caret.ts";
import { Comments, CommentsHandle } from "../../review/comments.tsx";
import { DecisionBar, Notices } from "../../review/decision-bar.tsx";
import { Editor } from "../../review/editor.tsx";
import { isSwitchKey, keyPressOf } from "../../review/selection.ts";
import type { Renderer } from "../extension.ts";
import type { DocRef, GroupedDoc } from "../protocol.ts";
import { DocList, RailHandle } from "./doc-list.tsx";
import { pathLabel } from "./labels.ts";
import { DOCS_PANE, guttersOf, PANE_ORDER, panesOf } from "./panes.ts";
import { pageExtensions } from "./slices.ts";
import type { Page } from "./state.ts";
import {
  addAnnotation,
  flipCommentSwitch,
  foldCommentsForPanel,
  openEditor,
  pageStore,
  readWindow,
  selectCurrentDoc,
  selectPlanChanges,
  selectPlanDoc,
  setHolding,
  start,
  usePage,
} from "./state.ts";
import { switchShown, Tools } from "./tools.tsx";

function rendererOf(doc: DocRef): Renderer | undefined {
  return pageExtensions
    .flatMap((extension) => extension.renderers ?? [])
    .find((candidate) => candidate.accepts(doc));
}

/** Whether the document shown is beside the plan, drawn on its own or split. */
function besidePlan(s: Page): boolean {
  const doc = selectCurrentDoc(s);
  const plan = selectPlanDoc(s);

  return s.split && plan !== null && doc?.path !== plan.path;
}

/** Whether what is on screen takes comments: the document's renderer says, and the plan beside it always does. */
function takesComments(s: Page): boolean {
  const doc = selectCurrentDoc(s);

  return doc === null || besidePlan(s) || rendererOf(doc)?.comments !== false;
}

/** What the general box comments: the document shown, or the plan when the one beside it takes no comment. */
function commented(s: Page): GroupedDoc | null {
  const doc = selectCurrentDoc(s);

  return doc !== null && besidePlan(s) && rendererOf(doc)?.comments === false
    ? selectPlanDoc(s)
    : doc;
}

function Doc(props: { readonly doc: DocRef }): JSX.Element {
  const { doc } = props;
  const isPlan = usePage((s) => doc.path === selectPlanDoc(s)?.path);
  const annotations = usePage((s) => s.annotations);
  const edited = usePage((s) => s.edited);
  const showChanges = usePage((s) => s.showChanges);
  const planChanges = usePage(selectPlanChanges);
  const renderer = rendererOf(doc);

  if (renderer === undefined) {
    return <div className="waiting">No renderer for {doc.mediaType}</div>;
  }

  const Component = renderer.component;

  return (
    <div className="pane" key={doc.path}>
      <Component
        doc={doc}
        annotations={annotations.filter((a) => a.doc === doc.path)}
        annotate={addAnnotation}
        source={isPlan ? (edited?.text ?? null) : null}
        changes={showChanges && isPlan ? planChanges : null}
      />
    </div>
  );
}

function Panes(): JSX.Element {
  const plan = usePage(selectPlanDoc);
  const doc = usePage(selectCurrentDoc);
  const panes = useRef<HTMLDivElement>(null);
  const session = usePage((s) => s.editing);
  const view = usePage((s) => s.review);
  const edited = usePage((s) => s.edited);
  const split = usePage((s) => s.split);
  const comments = usePage(takesComments);
  const beside = plan !== null && doc !== null && doc.path !== plan.path;

  const head = doc !== null && (
    <div className="doc-head">
      <span className="path" title={doc.path}>
        {view === null ? doc.path : pathLabel(doc, view)}
      </span>
      {edited !== null && !beside && <span className="edited">edited, not sent</span>}
    </div>
  );

  // Before the empty state: an open editor keeps its Cancel whatever the document list became.
  if (session !== null) {
    return (
      <main id="doc" className="docs" tabIndex={-1}>
        {head}
        <Editor session={session} />
      </main>
    );
  }

  if (doc === null) {
    return (
      <main id="doc" className="docs" tabIndex={-1}>
        <div className="waiting">
          Nothing to show yet. The working directory's files appear here.
        </div>
      </main>
    );
  }

  const startEdit = (): void => openEditor(panes.current === null ? 1 : lineAtTop(panes.current));

  return (
    <main id="doc" className="docs" tabIndex={-1}>
      {head}
      <Tools onEdit={startEdit} comments={comments} />
      <div className="panes" ref={panes}>
        {beside && split && plan !== null && <Doc doc={plan} />}
        <Doc doc={doc} />
      </div>
    </main>
  );
}

const actions = pageExtensions.flatMap((extension) => extension.actions ?? []);

const shares = pageExtensions.flatMap(({ useSend }) => (useSend === undefined ? [] : [useSend]));

const extraNotices = pageExtensions.flatMap((extension) => extension.notices ?? []);

const panels = pageExtensions.flatMap(({ id, panel }) =>
  panel === undefined ? [] : [{ id, panel }],
);

function App(): JSX.Element {
  // oxlint-disable-next-line react/rules-of-hooks -- `panels` is the registry, fixed at load: the hooks are called in one order at every render.
  const shownPanels = panels.filter(({ panel: { useShown } }) => useShown());
  const comments = usePage(takesComments);
  const commentedDoc = usePage(commented);
  const panes = panesOf(PANE_ORDER, shownPanels);
  const panelShown = panes.some((pane) => pane.kind === "panel");

  // Four columns do not fit a laptop: a panel appearing takes the comments' room, their handle kept.
  useEffect(() => {
    if (panelShown) foldCommentsForPanel();
  }, [panelShown]);

  useEffect(() => {
    void start();

    // A pointer event carries the modifiers too: a Control pressed before a focus change sends no key event after it.
    const held = (event: KeyboardEvent | PointerEvent): void => {
      setHolding(event.ctrlKey || event.metaKey);
    };

    const flip = (event: KeyboardEvent): void => {
      const s = pageStore.getState();

      if (isSwitchKey(keyPressOf(event)) && switchShown(takesComments(s), s)) flipCommentSwitch();
    };

    const release = (): void => {
      setHolding(false);
    };

    document.addEventListener("keydown", held);
    document.addEventListener("keydown", flip);
    document.addEventListener("keyup", held);
    document.addEventListener("pointermove", held);
    window.addEventListener("blur", release);

    return () => {
      document.removeEventListener("keydown", held);
      document.removeEventListener("keydown", flip);
      document.removeEventListener("keyup", held);
      document.removeEventListener("pointermove", held);
      window.removeEventListener("blur", release);
    };
  }, []);

  return (
    <div className="app">
      <a className="skip" href="#doc">
        Skip to document
      </a>
      <DecisionBar actions={actions} shares={shares} />
      <Notices extensions={extraNotices} />
      <div className="body">
        <DocList />
        <RailHandle />
        {panes.map((pane, index) => {
          const gutters = guttersOf(index, panes.length);
          const Component = pane.kind === "docs" ? Panes : pane.panel.component;

          return (
            <div
              key={pane.kind === "docs" ? DOCS_PANE : pane.id}
              className={`slot${gutters.start ? " gutter-start" : ""}${gutters.end ? " gutter-end" : ""}`}
            >
              <Component />
            </div>
          );
        })}
        {comments && (
          <>
            <Comments doc={commentedDoc} />
            <CommentsHandle />
          </>
        )}
      </div>
    </div>
  );
}

const root = document.querySelector("#root");

if (root !== null) {
  readWindow();
  createRoot(root).render(<App />);
}
