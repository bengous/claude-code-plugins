import type { Element, Root, RootContent } from "hast";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

function isList(node: RootContent): boolean {
  return node.type === "element" && (node.tagName === "ul" || node.tagName === "ol");
}

/** A list item's own lines end with its last child before its first nested list. */
function endLine(element: Element, start: number, end: number): number {
  const nested = element.tagName === "li" ? element.children.findIndex(isList) : -1;

  if (nested === -1) return end;
  const own = element.children.slice(0, nested).findLast((child) => child.position !== undefined);

  return own?.position?.end.line ?? start;
}

/**
 * Every block element keeps its source lines as `data-lines="start-end"`, and a code block
 * opened by a fence says so as `data-fenced`: its first line is then no code.
 */
function addLines(node: Root | RootContent, source: readonly string[]): void {
  if (node.type === "element" && node.position !== undefined) {
    const { start, end } = node.position;
    node.properties.dataLines = `${start.line}-${endLine(node, start.line, end.line)}`;

    if (node.tagName === "pre") {
      const opening = source[start.line - 1]?.slice(start.column - 1) ?? "";

      if (opening.startsWith("```") || opening.startsWith("~~~")) node.properties.dataFenced = true;
    }
  }

  if ("children" in node) for (const child of node.children) addLines(child, source);
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeHighlight, { detect: false, plainText: ["mermaid"] });

/** The Markdown `text` as hast, every element carrying its source lines. */
export function toTree(text: string): Root {
  const tree = processor.runSync(processor.parse(text));
  addLines(tree, text.split(/\r\n|\r|\n/u));

  return tree;
}
