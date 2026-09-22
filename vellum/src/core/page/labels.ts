import type {
  Anchor,
  DocGroup,
  GroupedDoc,
  Passage,
  PlanWorkspace,
  ReviewView,
} from "../protocol.ts";

/**
 * What the page names, purely: a document, a place in it, a quote of it. The server's names
 * (`.review/v2.md`, a selector) never reach the screen.
 */

/** What the plate prints beside `Plan`: `draft` before the first version, `v<n>` after. */
export function planLabel(workspace: PlanWorkspace): string {
  return workspace.kind === "drafting" ? "draft" : `v${workspace.version}`;
}

/** A line of the rail: the file's name, and the folder that tells it from its neighbours, or none. */
export type DocLabel = { readonly name: string; readonly dir: string | null };

/** What `docLabel` reads of the review: the version and the plan's folder, the listed documents. */
export type Labelled = Pick<ReviewView, "workspace" | "docs">;

function dirname(path: string): string {
  const at = path.lastIndexOf("/");

  return at === -1 ? "" : path.slice(0, at);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The plan's folder, the workspace's: known before `plan.md` is written, as a grill's transcript is. */
function planDirOf(view: Labelled): string {
  return view.workspace.dir.replace(/\/$/u, "");
}

/** `path` under `dir`, or as it is. */
function under(path: string, dir: string): string {
  return dir !== "" && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

function tail(dir: string, segments: number): string {
  return dir.split("/").slice(-segments).join("/");
}

/**
 * Each distinct folder by its last segments, as few as tell it from every other folder of the
 * set: `docs` and `vellum/docs` read `docs` and `vellum/docs`, never `docs` twice.
 */
export function dirLabels(dirs: readonly string[]): ReadonlyMap<string, string> {
  const distinct = [...new Set(dirs)].filter((dir) => dir !== "");

  return new Map(
    distinct.map((dir) => {
      const segments = dir.split("/").length;
      let taken = 1;

      while (
        taken < segments &&
        distinct.some((other) => other !== dir && tail(other, taken) === tail(dir, taken))
      ) {
        taken += 1;
      }

      return [dir, tail(dir, taken)];
    }),
  );
}

/** An artifact's folder is read beside the plan, a cited file's from the project root. */
function folderOf(doc: GroupedDoc, planDir: string): string {
  return dirname(doc.group === "artifact" ? under(doc.path, planDir) : doc.path);
}

/**
 * The rail's line for `doc`: `Plan` and its version; an artifact by its name and, in a
 * subfolder of the plan's, that folder; a cited file by its name and the folders that tell it
 * from the other cited files.
 */
export function docLabel(doc: GroupedDoc, view: Labelled): DocLabel {
  return docLabeller(view)(doc);
}

/** `docLabel` for every line of the rail: each group's folders are labelled once, not once a line. */
export function docLabeller(view: Labelled): (doc: GroupedDoc) => DocLabel {
  const planDir = planDirOf(view);

  const folders = (group: DocGroup): ReadonlyMap<string, string> =>
    dirLabels(
      view.docs.filter((other) => other.group === group).map((other) => folderOf(other, planDir)),
    );

  const labels = { artifact: folders("artifact"), cited: folders("cited") };

  return (doc) =>
    doc.group === "plan"
      ? { name: `Plan ${planLabel(view.workspace)}`, dir: null }
      : { name: basename(doc.path), dir: labels[doc.group].get(folderOf(doc, planDir)) ?? null };
}

/** What the document's head and a card call `doc`: `Plan v2`, an artifact's path beside the plan, a cited file's path. */
export function pathLabel(doc: GroupedDoc, view: Labelled): string {
  if (doc.group === "plan") return docLabel(doc, view).name;

  return doc.group === "artifact" ? under(doc.path, planDirOf(view)) : doc.path;
}

/** A file name in two parts, so the stem alone is cut when the room is short: `capture-800px-sans-r….png`. */
export function nameParts(name: string): { readonly stem: string; readonly ext: string } {
  const at = name.lastIndexOf(".");

  return at <= 0 ? { stem: name, ext: "" } : { stem: name.slice(0, at), ext: name.slice(at) };
}

/** Where a comment points, in the reviewer's words: `general`, `line 3`, `lines 3–5`, an element's label, never a selector. */
export function whereOf(anchor: Anchor): string {
  if (anchor.kind === "global") return "general";

  if (anchor.kind === "text") {
    return anchor.passages
      .map(({ lines: [from, to] }) => (from === to ? `line ${from}` : `lines ${from}–${to}`))
      .join(", ");
  }

  return anchor.elements.map((element) => element.label).join(", ");
}

const DIAGRAM_KINDS: readonly (readonly [RegExp, string])[] = [
  [/^sequenceDiagram/u, "sequence"],
  [/^(?:flowchart|graph)\b/u, "flowchart"],
  [/^classDiagram/u, "class"],
  [/^stateDiagram/u, "state"],
  [/^erDiagram/u, "entity relationship"],
  [/^gantt/u, "gantt"],
  [/^pie/u, "pie"],
  [/^mindmap/u, "mindmap"],
  [/^timeline/u, "timeline"],
  [/^gitGraph/u, "git graph"],
  [/^journey/u, "journey"],
];

/** The quote as a card shows it: prose as it is, a code block by its first line and its length, a diagram by its kind. */
export function quoteOf(passage: Passage): string {
  if (passage.kind === "prose") return passage.quote;

  if (passage.kind === "code") {
    const lines = passage.quote.split("\n");

    return lines.length === 1 ? passage.quote : `${lines[0] ?? ""} (${lines.length} lines)`;
  }

  const kind = DIAGRAM_KINDS.find(([pattern]) => pattern.test(passage.quote))?.[1];

  return kind === undefined ? "diagram" : `diagram (${kind})`;
}
