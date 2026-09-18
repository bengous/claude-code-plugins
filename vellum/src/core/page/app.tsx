import { render } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { pageExtensions } from "../../extensions/page.ts";
import type { Renderer } from "../extension.ts";
import type { DocRef } from "../protocol.ts";
import { lineAtTop } from "./caret.ts";
import { Comments } from "./comments.tsx";
import { DecisionBar } from "./decision-bar.tsx";
import { DocList } from "./doc-list.tsx";
import { Editor } from "./editor.tsx";
import {
  addAnnotation,
  annotations,
  currentDoc,
  edited,
  editing,
  holding,
  openEditor,
  planChanges,
  planDoc,
  showChanges,
  split,
  start,
  step,
} from "./state.ts";
import { Tools } from "./tools.tsx";

function rendererOf(doc: DocRef): Renderer | undefined {
  return pageExtensions
    .flatMap((extension) => extension.renderers ?? [])
    .find((candidate) => candidate.accepts(doc));
}

/** Whether what is on screen takes comments: the document's renderer says, and the plan beside it always does. */
function takesComments(): boolean {
  const doc = currentDoc.value;
  const besidePlan = split.value && planDoc.value !== null && doc?.path !== planDoc.value.path;

  return doc === null || besidePlan || rendererOf(doc)?.comments !== false;
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

  const head = doc !== null && (
    <div class="doc-head">
      <span class="path">{doc.path}</span>
      {edited.value !== null && !beside && <span class="edited">edited, not sent</span>}
    </div>
  );

  // Before the empty state: an open editor keeps its Cancel whatever the document list became.
  if (session !== null) {
    return (
      <div class="docs">
        {head}
        <Editor version={session.version} base={session.base} line={session.line} />
      </div>
    );
  }

  if (doc === null) {
    return (
      <div class="docs">
        <div class="waiting">Nothing to show yet. The working directory's files appear here.</div>
      </div>
    );
  }

  const startEdit = (): void => openEditor(panes.current === null ? 1 : lineAtTop(panes.current));

  return (
    <div class="docs">
      {head}
      <Tools onEdit={startEdit} comments={takesComments()} />
      <div class="panes" ref={panes}>
        {beside && split.value && plan !== null && <Doc doc={plan} />}
        <Doc doc={doc} />
      </div>
    </div>
  );
}

const actions = pageExtensions.flatMap((extension) => extension.actions ?? []);

function App(): preact.JSX.Element {
  useEffect(() => {
    void start();

    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
        return;
      }

      if (event.key === "]") step(1);

      if (event.key === "[") step(-1);
    };

    const held = (event: KeyboardEvent): void => {
      holding.value = event.ctrlKey || event.metaKey;
    };

    const release = (): void => {
      holding.value = false;
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("keydown", held);
    document.addEventListener("keyup", held);
    window.addEventListener("blur", release);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", held);
      document.removeEventListener("keyup", held);
      window.removeEventListener("blur", release);
    };
  }, []);

  return (
    <div class="app">
      <DecisionBar actions={actions} />
      <div class="body">
        <DocList />
        <Panes />
        {takesComments() && <Comments />}
      </div>
    </div>
  );
}

const root = document.querySelector("#root");

if (root !== null) render(<App />, root);
