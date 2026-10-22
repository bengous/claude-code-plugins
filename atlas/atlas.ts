// The format of a map: a tree of nodes, the links between them, and the map's Config. Types only:
// a map's atlas.d.ts is a byte copy of this file, which its data import with `import type` and
// check with `satisfies`.

export type Pair = readonly [string, string];

/**
 * A fact of the map that stays unsettled, with its discussion in threads.json under the same id.
 * `id` is kebab-case, unique on the whole map, and never changes; `text` describes a state, never
 * a step: check.ts refuses work-package names and step words.
 */
export type OpenPoint = { readonly id: string; readonly text: string };

/**
 * The overview column of an outside node: "in" (left) or "out" (right). "both", for a leaf only,
 * draws it twice, its links leaving the left copy and arriving at the right one.
 */
export type Side = "in" | "out" | "both";

/** What a link carries, from a closed list, "none" included. */
export type Tag = "account" | "order" | "payment" | "none";

/** A colour the page defines, a --z-* token of plan.fr.html. */
export type Token =
  | "--z-olive"
  | "--z-brown"
  | "--z-indigo"
  | "--z-blue"
  | "--z-violet"
  | "--z-teal"
  | "--z-amber"
  | "--z-plum"
  | "--z-green"
  | "--z-grey";

/** The panel's content, in the order the panel shows it. HTML is allowed (<code>). */
export type Panel = {
  /** A small mono line above the title: the source file and lines. */
  readonly kicker?: string;
  /** What it is, in one or two sentences. */
  readonly lead?: string;
  /** Its contract: [["Receives", …], ["Produces", …]]. */
  readonly io?: readonly Pair[];
  /** What to touch to replace or remove it. */
  readonly swap?: string;
  /** The way to grow it. */
  readonly extend?: string;
  /** Its non-obvious traps. */
  readonly pitfalls?: readonly string[];
  /** Extension points, [node id, text]. */
  readonly seams?: readonly Pair[];
  /** Couplings to know, [node id, text]. */
  readonly traps?: readonly Pair[];
  /** The reasons for the current choice. */
  readonly why?: readonly string[];
  /** Alternatives already rejected or postponed. */
  readonly alt?: string;
  /** [label, value] pairs. */
  readonly facts?: readonly Pair[];
  /** Reading instructions. */
  readonly how?: string;
  /** Ids of related nodes, as chips. */
  readonly see?: readonly string[];
  /** A longer source reference, at the bottom. */
  readonly src?: string;
};

/**
 * One responsibility of the system: what one would replace on its own, never a file (a path is
 * its `src`). A node with `children` is drawn as a frame around them, a node without as a card.
 */
export type Node = Panel & {
  /** Unique among the nodes of the map: links, `couples`, `see` and the page's #id name it. */
  readonly id: string;
  /** The short name the map draws: a few words. */
  readonly label: string;
  /** The panel's heading, `label` when absent. */
  readonly title?: string;
  /** A mono subtitle, "\n" between lines. */
  readonly sub: string;
  /** A key of the Config's palette. */
  readonly color: string;
  /** For a node with children: the short list at the top of its panel. */
  readonly brief?: readonly string[];
  /** Ids of the nodes that change when this one is replaced; one side of a coupling lists it. */
  readonly couples?: readonly string[];
  /** "off": dormant, drawn dashed. */
  readonly kind?: "off";
  readonly side?: Side;
  /** Outside the system (a client, a third-party service): a child of the root, drawn dashed. */
  readonly outside?: true;
  readonly open?: readonly OpenPoint[];
  /** Drawn inside this node, packed in this order. */
  readonly children?: readonly Node[];
};

/** The top of the tree: the overview's panel and the nodes the overview shows. */
export type Root = Panel & {
  readonly title: string;
  /** The zone tour of the panel's ← → buttons, ids of nodes with children; depth-first when absent. */
  readonly tour?: readonly string[];
  readonly children: readonly Node[];
};

/**
 * An arrow, from → to. Between two leaves, the detail draws it, and the overview draws one arrow
 * per pair of boxes such arrows join. With a node with children on either end, it draws nothing: it
 * names the overview's arrow between those boxes, instead of the joined labels of the leaves'
 * arrows, and check.ts wants a leaves' arrow joining them in that direction.
 */
export type Link = {
  readonly from: string;
  readonly to: string;
  /** What moves along it (a call, a protocol, a table): a few words. */
  readonly label: string;
  /** "deny": refused, in red; "dash": dormant, local only, or on demand. */
  readonly kind?: "deny" | "dash";
  /** Arrowheads at both ends; naming an overview arrow, it also merges both directions into one. */
  readonly two?: true;
  /** Required on a link into an outside leaf that is not on the left. */
  readonly tags?: readonly Tag[];
};

/** A map: the root of its tree and every link, wherever their ends sit in the tree. */
export type AtlasMap = { readonly root: Root; readonly links: readonly Link[] };

/** What a map sets beside its data. */
export type Config = {
  /** The keys a node's `color` names, and the token each draws with. */
  readonly palette: Readonly<Record<string, Token>>;
};
