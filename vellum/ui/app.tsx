import { render } from "preact";
import { useEffect } from "preact/hooks";

import { uiPlugins } from "../plugins/index.ts";
import type { DocRef } from "../src/protocol.ts";
import { Comments } from "./comments.tsx";
import { DecisionBar } from "./decision-bar.tsx";
import { DocList } from "./doc-list.tsx";
import {
  addAnnotation,
  annotations,
  currentDoc,
  listen,
  loadReview,
  planDoc,
  split,
  step,
} from "./state.ts";

function Doc(props: { readonly doc: DocRef }): preact.JSX.Element {
  const { doc } = props;

  const renderer = uiPlugins
    .flatMap((plugin) => plugin.renderers ?? [])
    .find((candidate) => candidate.accepts(doc));

  if (renderer === undefined) return <div class="waiting">No renderer for {doc.mediaType}</div>;
  const Component = renderer.component;

  return (
    <div class="pane" key={doc.path}>
      <Component
        doc={doc}
        annotations={annotations.value.filter((a) => a.doc === doc.path)}
        annotate={addAnnotation}
      />
    </div>
  );
}

function Panes(): preact.JSX.Element {
  const plan = planDoc.value;
  const doc = currentDoc.value;

  if (plan === null || doc === null) {
    return (
      <div class="docs">
        <div class="waiting">Waiting for the plan. It appears at ExitPlanMode.</div>
      </div>
    );
  }

  const beside = doc.path !== plan.path;

  return (
    <div class="docs">
      <div class="doc-head">
        <span class="path">{doc.path}</span>
        <span class="spacer" />
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
      </div>
      <div class="panes">
        {beside && split.value && <Doc doc={plan} />}
        <Doc doc={doc} />
      </div>
    </div>
  );
}

function App(): preact.JSX.Element {
  useEffect(() => {
    void loadReview();
    listen();

    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
        return;
      }

      if (event.key === "]") step(1);

      if (event.key === "[") step(-1);
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div class="app">
      <DecisionBar />
      <div class="body">
        <DocList />
        <Panes />
        <Comments />
      </div>
    </div>
  );
}

const root = document.querySelector("#root");

if (root !== null) render(<App />, root);
