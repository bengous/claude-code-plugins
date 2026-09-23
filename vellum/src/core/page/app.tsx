import { batch } from "@preact/signals";
import { render } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { pageExtensions } from "../../extensions/page.ts";
import type { Renderer } from "../extension.ts";
import type { DocRef, GroupedDoc } from "../protocol.ts";
import { lineAtTop } from "./caret.ts";
import { Comments, CommentsHandle } from "./comments.tsx";
import { DecisionBar, Notices } from "./decision-bar.tsx";
import { DocList, RailHandle } from "./doc-list.tsx";
import { Editor } from "./editor.tsx";
import { pathLabel } from "./labels.ts";
import { DOCS_PANE, guttersOf, PANE_ORDER, panesOf } from "./panes.ts";
import { isSwitchKey, keyPressOf } from "./selection.ts";
import {
  addAnnotation,
  annotations,
  commentsOpen,
  commentsSnap,
  currentDoc,
  edited,
  editing,
  flipCommentSwitch,
  holding,
  openEditor,
  planChanges,
  planDoc,
  readWindow,
  review,
  showChanges,
  split,
  start,
} from "./state.ts";
import { switchShown, Tools } from "./tools.tsx";

function rendererOf(doc: DocRef): Renderer | undefined {
  return pageExtensions
    .flatMap((extension) => extension.renderers ?? [])
    .find((candidate) => candidate.accepts(doc));
}

/** Whether the document shown is beside the plan, drawn on its own or split. */
function besidePlan(): boolean {
  const doc = currentDoc.value;

  return split.value && planDoc.value !== null && doc?.path !== planDoc.value.path;
}

/** Whether what is on screen takes comments: the document's renderer says, and the plan beside it always does. */
function takesComments(): boolean {
  const doc = currentDoc.value;

  return doc === null || besidePlan() || rendererOf(doc)?.comments !== false;
}

/** What the general box comments: the document shown, or the plan when the one beside it takes no comment. */
function commented(): GroupedDoc | null {
  const doc = currentDoc.value;

  return doc !== null && besidePlan() && rendererOf(doc)?.comments === false ? planDoc.value : doc;
}

function Doc(props: { readonly doc: DocRef }): preact.JSX.Element {
  const { doc } = props;
  const isPlan = doc.path === planDoc.value?.path;
  const renderer = rendererOf(doc);

  if (renderer === undefined) return <div class="waiting">No renderer for {doc.mediaType}</div>;
  const Component = renderer.component;

  return (
    <div class="pane" key={doc.path}>
      <Component
        doc={doc}
        annotations={annotations.value.filter((a) => a.doc === doc.path)}
        annotate={addAnnotation}
        source={isPlan ? (edited.value?.text ?? null) : null}
        changes={showChanges.value && isPlan ? planChanges.value : null}
      />
    </div>
  );
}

function Panes(): preact.JSX.Element {
  const plan = planDoc.value;
  const doc = currentDoc.value;
  const panes = useRef<HTMLDivElement>(null);
  const session = editing.value;
  const beside = plan !== null && doc !== null && doc.path !== plan.path;

  const view = review.value;

  const head = doc !== null && (
    <div class="doc-head">
      <span class="path" title={doc.path}>
        {view === null ? doc.path : pathLabel(doc, view)}
      </span>
      {edited.value !== null && !beside && <span class="edited">edited, not sent</span>}
    </div>
  );

  // Before the empty state: an open editor keeps its Cancel whatever the document list became.
  if (session !== null) {
    return (
      <main id="doc" class="docs" tabIndex={-1}>
        {head}
        <Editor session={session} />
      </main>
    );
  }

  if (doc === null) {
    return (
      <main id="doc" class="docs" tabIndex={-1}>
        <div class="waiting">Nothing to show yet. The working directory's files appear here.</div>
      </main>
    );
  }

  const startEdit = (): void => openEditor(panes.current === null ? 1 : lineAtTop(panes.current));

  return (
    <main id="doc" class="docs" tabIndex={-1}>
      {head}
      <Tools onEdit={startEdit} comments={takesComments()} />
      <div class="panes" ref={panes}>
        {beside && split.value && plan !== null && <Doc doc={plan} />}
        <Doc doc={doc} />
      </div>
    </main>
  );
}

const actions = pageExtensions.flatMap((extension) => extension.actions ?? []);

const extraNotices = pageExtensions.flatMap((extension) => extension.notices ?? []);

const panels = pageExtensions.flatMap(({ id, panel }) =>
  panel === undefined ? [] : [{ id, panel }],
);

function App(): preact.JSX.Element {
  const panes = panesOf(
    PANE_ORDER,
    panels.filter(({ panel }) => panel.shown()),
  );

  const panelShown = panes.some((pane) => pane.kind === "panel");

  // Four columns do not fit a laptop: a panel appearing takes the comments' room, their handle kept.
  useEffect(() => {
    if (!panelShown) return;

    batch(() => {
      commentsOpen.value = false;
      commentsSnap.value = true;
    });
  }, [panelShown]);

  useEffect(() => {
    void start();

    const held = (event: KeyboardEvent): void => {
      holding.value = event.ctrlKey || event.metaKey;
    };

    const flip = (event: KeyboardEvent): void => {
      if (isSwitchKey(keyPressOf(event)) && switchShown(takesComments())) flipCommentSwitch();
    };

    const release = (): void => {
      holding.value = false;
    };

    document.addEventListener("keydown", held);
    document.addEventListener("keydown", flip);
    document.addEventListener("keyup", held);
    window.addEventListener("blur", release);

    return () => {
      document.removeEventListener("keydown", held);
      document.removeEventListener("keydown", flip);
      document.removeEventListener("keyup", held);
      window.removeEventListener("blur", release);
    };
  }, []);

  return (
    <div class="app">
      <a class="skip" href="#doc">
        Skip to document
      </a>
      <DecisionBar actions={actions} />
      <Notices extensions={extraNotices} />
      <div class="body">
        <DocList />
        <RailHandle />
        {panes.map((pane, index) => {
          const gutters = guttersOf(index, panes.length);
          const Component = pane.kind === "docs" ? Panes : pane.panel.component;

          return (
            <div
              key={pane.kind === "docs" ? DOCS_PANE : pane.id}
              class={`slot${gutters.start ? " gutter-start" : ""}${gutters.end ? " gutter-end" : ""}`}
            >
              <Component />
            </div>
          );
        })}
        {takesComments() && (
          <>
            <Comments doc={commented()} />
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
  render(<App />, root);
}
