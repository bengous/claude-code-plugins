import type { AtlasMap, Node, Panel } from "./atlas.ts";

// The markup a panel keeps from a map's text, and the rest, which it shows as text. A map's text
// comes from whoever writes the map, an agent copying a repository among them, and the page
// carries the token that writes threads as the human: no markup that runs or loads anything may
// reach it.

/** The tags a panel keeps, without any attribute. */
export const KEPT_TAGS = ["code", "cite", "b", "i", "em", "strong", "br"] as const;

const KEPT = new RegExp(`<(/?)(${KEPT_TAGS.join("|")})\\s*/?>`, "iyu");

const TAG_LIKE = /<[!?/A-Za-z][^<>]{0,40}>?/uy;

const SHOWN_AT_MOST = 40;

/** `html` as a panel shows it: the kept tags as they are, any other `<` as text. */
export function keptMarkup(html: string): string {
  let out = "";

  for (let at = 0; at < html.length; at += 1) {
    if (html[at] !== "<") {
      out += html[at];
      continue;
    }

    KEPT.lastIndex = at;
    const kept = KEPT.exec(html);

    if (kept === null) {
      out += "&lt;";
      continue;
    }

    out += `<${kept[1] ?? ""}${(kept[2] ?? "").toLowerCase()}>`;
    at += kept[0].length - 1;
  }

  return out;
}

/** Each tag in `html` a panel would not keep, as written, cut to SHOWN_AT_MOST characters. */
export function markupFaults(html: string): string[] {
  const faults: string[] = [];

  for (let at = html.indexOf("<"); at !== -1; at = html.indexOf("<", at + 1)) {
    KEPT.lastIndex = at;

    if (KEPT.test(html)) continue;
    TAG_LIKE.lastIndex = at;
    const tag = TAG_LIKE.exec(html)?.[0];

    if (tag !== undefined) faults.push(tag.slice(0, SHOWN_AT_MOST));
  }

  return faults;
}

type Shown = Panel & { readonly title?: string; readonly open?: Node["open"] };

/** The fields of a panel the page writes as HTML, an open point's text among them, by name. */
function htmlFields(panel: Shown): [string, string][] {
  const texts: [string, string | undefined][] = [
    ["title", panel.title],
    ["lead", panel.lead],
    ["swap", panel.swap],
    ["extend", panel.extend],
    ["alt", panel.alt],
    ["how", panel.how],
  ];

  return [
    ...texts.flatMap(([field, text]): [string, string][] =>
      text === undefined ? [] : [[field, text]],
    ),
    ...(panel.io ?? []).map(([, text]): [string, string] => ["io", text]),
    ...(panel.pitfalls ?? []).map((text): [string, string] => ["pitfalls", text]),
    ...(panel.why ?? []).map((text): [string, string] => ["why", text]),
    ...(panel.seams ?? []).map(([, text]): [string, string] => ["seams", text]),
    ...(panel.traps ?? []).map(([, text]): [string, string] => ["traps", text]),
    ...(panel.open ?? []).map((point): [string, string] => ["open", point.text]),
  ];
}

const nodesOf = (nodes: readonly Node[]): Node[] =>
  nodes.flatMap((node) => [node, ...nodesOf(node.children ?? [])]);

/** One HTML field of a panel of the map: `where` is "root" or "node <id>". */
export type HtmlField = { readonly where: string; readonly field: string; readonly text: string };

/** Every HTML field of the map's panels, an open point's text among them, in panel order. */
export function mapHtmlFields(map: AtlasMap): HtmlField[] {
  const panels: [string, Shown][] = [
    ["root", map.root],
    ...nodesOf(map.root.children).map((node): [string, Shown] => [`node ${node.id}`, node]),
  ];

  return panels.flatMap(([where, panel]) =>
    htmlFields(panel).map(([field, text]) => ({ where, field, text })),
  );
}

/**
 * Each piece of markup a panel would not keep in the map's HTML fields, an open point's text
 * among them, as "<root | node id>: <field>: <tag> …".
 */
export const mapMarkupFaults = (map: AtlasMap): string[] =>
  mapHtmlFields(map).flatMap(({ where, field, text }) =>
    markupFaults(text).map(
      (tag) =>
        `${where}: ${field}: ${tag} is not markup a panel keeps (${KEPT_TAGS.join(", ")}, with no attribute)`,
    ),
  );

/** A map whose text holds markup a panel would not keep, every fault listed. */
export class MarkupError extends Error {
  readonly faults: readonly string[];

  constructor(faults: readonly string[]) {
    super(faults.join("\n"));
    this.faults = faults;
  }
}
