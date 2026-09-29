import type { Element as HastElement, RootContent } from "hast";
import type { ComponentChild } from "preact";
import { h } from "preact";

import { fileUrl } from "../../runtime/page/api.ts";
import type { GroupedDoc } from "../../runtime/protocol.ts";
import type { ProjectPath } from "../../workshop/paths.ts";
import { parseProjectPath } from "../../workshop/paths.ts";
import type { Changes, RemovedRun } from "./changes.ts";
import { removedLabel } from "./changes.ts";
import type { PlanTarget } from "./links.ts";
import { linkedDoc } from "./links.ts";

/**
 * The hast of `tree.ts` as Preact nodes, by hand: the JSX runtime adapters type against a
 * global JSX namespace this page does not own. What the sheet is drawn with: the changes to
 * mark, and the documents a link, an image or a name in backticks may reach.
 */
export type Sheet = {
  readonly changes: Changes | null;
  readonly docs: readonly GroupedDoc[];
  readonly plan: PlanTarget | null;
};

function attributeName(property: string): string {
  return property.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * A URL of the document, as the page may use it: a relative path reaches the document it names
 * as `linkedDoc` reads it, beside the plan or under the project root, and keeps that path in
 * `data-path`; an absolute URL with a safe scheme stays; anything else (`javascript:`, `data:`)
 * is dropped. Markdown is the model's text, not the reviewer's.
 */
export function urlAttributes(value: string, sheet: Sheet): readonly (readonly [string, string])[] {
  const scheme = /^([a-z][a-z0-9+.-]*:)/iu.exec(value)?.[1]?.toLowerCase();

  if (scheme !== undefined) {
    return SAFE_SCHEMES.has(scheme) ? [["href", value]] : [];
  }

  if (value.startsWith("#")) return [["href", value]];
  const target = value.split(/[#?]/u)[0] ?? "";
  const listed = linkedDoc(target, sheet.docs, sheet.plan);
  const path = listed === null ? parseProjectPath(target) : { ok: true as const, value: listed };

  return path.ok
    ? [
        ["href", fileUrl(path.value)],
        ["data-path", path.value],
      ]
    : [];
}

/** The source of a mermaid block, when `node` is the `pre` holding one. */
export function mermaidSource(node: HastElement): string | null {
  const code = node.tagName === "pre" ? node.children[0] : undefined;
  const classes = code?.type === "element" ? code.properties.className : undefined;

  if (!Array.isArray(classes) || !classes.includes("language-mermaid")) return null;
  const text = code?.type === "element" ? code.children[0] : undefined;

  return text?.type === "text" ? text.value : null;
}

function textOf(node: RootContent): string {
  if (node.type === "text") return node.value;

  return node.type === "element" ? node.children.map((child) => textOf(child)).join("") : "";
}

/**
 * A removed run, folded. Its label and its old source are attributes CSS draws, as the Mermaid
 * figure keeps its source: with no text node it takes no selection and no quote search finds it.
 * Before a code block or a figure it takes the block's width.
 */
export function removedBlock(run: RemovedRun, wide = false): ComponentChild {
  return h(
    "details",
    { key: `removed-${run.before}`, class: wide ? "removed wide" : "removed" },
    h("summary", { "data-label": removedLabel(run.lines.length) }),
    h("div", { "data-source": run.lines.join("\n") }),
  );
}

/** What is drawn before `node`: its removed runs, as a row of their own before a row. */
function removedBefore(node: HastElement, runs: readonly RemovedRun[]): ComponentChild[] {
  if (runs.length === 0) return [];

  if (node.tagName !== "tr") {
    const wide = node.tagName === "pre" || mermaidSource(node) !== null;

    return runs.map((run) => removedBlock(run, wide));
  }

  const cells = node.children.filter((child) => child.type === "element").length;

  return [
    h(
      "tr",
      { key: `removed-row-${runs[0]?.before ?? 0}`, class: "removed-row" },
      h("td", { colSpan: cells }, ...runs.map((run) => removedBlock(run))),
    ),
  ];
}

export function toVNodes(
  nodes: readonly RootContent[],
  sheet: Sheet,
  parent: HastElement | null = null,
): ComponentChild[] {
  return nodes.flatMap((node, index) => [
    ...(node.type === "element"
      ? removedBefore(node, sheet.changes?.removedBefore.get(node) ?? [])
      : []),
    toVNode(node, index, sheet, parent),
  ]);
}

/** The bands over a code block's added lines, placed by CSS from the line's index. */
function addedLineBands(lines: readonly number[]): ComponentChild[] {
  return lines.map((line) =>
    h("span", { key: `line-${line}`, class: "line-added", style: `--line: ${line}` }),
  );
}

function classOf(node: HastElement, added: boolean): string | undefined {
  const own = Array.isArray(node.properties.className) ? node.properties.className.join(" ") : "";
  const all = added ? `${own} added`.trim() : own;

  return all === "" ? undefined : all;
}

type TaskLabel = { readonly "aria-label"?: string };

function isList(node: RootContent): boolean {
  return node.type === "element" && (node.tagName === "ul" || node.tagName === "ol");
}

/**
 * A task's checkbox is named after its item, which the box's own markup leaves nameless. The
 * tree holds no raw HTML, so every `input` is a task's box: its parent is the item, or in a
 * loose list the item's first paragraph; a nested list is the next items', not this one's.
 */
function taskLabel(parent: HastElement | null): TaskLabel {
  if (parent === null) return {};
  const own = parent.children.filter((child) => !isList(child));

  return {
    "aria-label": own
      .map((child) => textOf(child))
      .join("")
      .trim(),
  };
}

/** A name in backticks that reaches a document of the review is drawn as a link to it. */
function linkedName(node: HastElement, sheet: Sheet): ProjectPath | null {
  const [text] = node.children;

  return text?.type === "text" ? linkedDoc(text.value, sheet.docs, sheet.plan) : null;
}

export function toVNode(
  node: RootContent,
  key: number,
  sheet: Sheet,
  parent: HastElement | null = null,
): ComponentChild {
  if (node.type === "text") return node.value;

  if (node.type !== "element") return null;
  const source = mermaidSource(node);
  const added = sheet.changes?.marked.has(node) === true;

  if (source !== null) {
    return h("figure", {
      key,
      class: added ? "mermaid added" : "mermaid",
      "data-lines": String(node.properties.dataLines),
      "data-source": source,
    });
  }

  // A boolean goes as it is: `checked: ""` sets the DOM property to a string, which reads false.
  const attributes = Object.entries(node.properties).flatMap(
    ([name, value]): (readonly [string, string | true])[] => {
      if (value === undefined || value === null || value === false || name === "className") {
        return [];
      }

      if (value === true) return [[attributeName(name), true]];
      const text = Array.isArray(value) ? value.join(" ") : String(value);

      if (name === "href" || name === "src") {
        return urlAttributes(text, sheet).map(([attribute, url]) => [
          attribute === "href" ? name : attribute,
          url,
        ]);
      }

      return [[attributeName(name), text]];
    },
  );

  const extra = node.tagName === "a" ? { target: "_blank", rel: "noopener" } : {};
  const named = node.tagName === "input" ? taskLabel(parent) : {};
  const given: Record<string, string | true> = Object.fromEntries(attributes);

  const inside = (sheet.changes?.removedInside.get(node) ?? []).map((run) => removedBlock(run));
  const children = toVNodes(node.children, sheet, node);
  const bands = addedLineBands(sheet.changes?.addedLines.get(node) ?? []);

  // A task item's removed run follows its checkbox, so the box stays on the bullet's line.
  const first = node.children[0];
  const checkbox = first?.type === "element" && first.tagName === "input" ? 1 : 0;

  const drawn = h(
    node.tagName,
    { key, ...extra, ...given, ...named, class: classOf(node, added) },
    ...children.slice(0, checkbox),
    ...inside,
    ...children.slice(checkbox),
    ...bands,
  );

  if (node.tagName === "table") return h("div", { key, class: "scroll-x" }, drawn);

  // Inside a link already, a second one would nest two anchors.
  const linked =
    node.tagName === "code" && parent?.tagName !== "pre" && parent?.tagName !== "a"
      ? linkedName(node, sheet)
      : null;

  return linked === null
    ? drawn
    : h(
        "a",
        { key, target: "_blank", rel: "noopener", href: fileUrl(linked), "data-path": linked },
        drawn,
      );
}
