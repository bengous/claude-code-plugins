import type { DocRef } from "../protocol.ts";
import { Badge } from "./kit.tsx";
import { annotations, currentDoc, docs, editing, planDoc, select } from "./state.ts";

function kindOf(doc: DocRef): string {
  if (doc.mediaType === "text/markdown") return "Markdown";

  if (doc.mediaType === "text/html") return "HTML";

  return "Image";
}

function nameOf(doc: DocRef): string {
  return doc.path.split("/").at(-1) ?? doc.path;
}

function count(path: string): number {
  return annotations.value.filter((a) => a.doc === path).length;
}

export function DocList(): preact.JSX.Element {
  const plan = planDoc.value;
  const linked = plan === null ? docs.value : docs.value.slice(1);

  const item = (doc: DocRef, name: string, kind: string): preact.JSX.Element => (
    <button
      type="button"
      key={doc.path}
      aria-selected={currentDoc.value?.path === doc.path}
      onClick={() => select(doc.path === plan?.path ? null : doc.path)}
    >
      <span class="name">{name}</span>
      <span class="kind">{kind}</span>
      {count(doc.path) > 0 && <Badge>{count(doc.path)}</Badge>}
    </button>
  );

  return (
    <nav class="rail" aria-label="Documents" inert={editing.value !== null}>
      {plan !== null && item(plan, "Plan", plan.path.split("/").at(-1)?.replace(".md", "") ?? "")}
      <h5>Artifacts</h5>
      {linked.length === 0 && <div class="empty">No files yet</div>}
      {linked.map((doc) => item(doc, nameOf(doc), kindOf(doc)))}
      <div class="hint">
        <kbd>[</kbd> <kbd>]</kbd> previous, next
      </div>
    </nav>
  );
}
