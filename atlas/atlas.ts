// The format of a map: a tree of nodes, the links between them, and the map's Config. Types only:
// a map's atlas.d.ts is a byte copy of this file, which its data import with `import type` and
// check with `satisfies`.

export type Pair = readonly [string, string];

/**
 * A fact of the map that stays unsettled, with its discussion in threads.json under the same id.
 * `id` is kebab-case, unique on the whole map, and never changes; `text` describes a state, never
 * a step: check.ts refuses the Config's `stepWords`.
 */
export type OpenPoint = { readonly id: string; readonly text: string };

/**
 * The overview column of an outside node: "in" (left) or "out" (right). "both", for a leaf only,
 * draws it twice, its links leaving the left copy and arriving at the right one.
 */
export type Side = "in" | "out" | "both";

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
  /**
   * Extension points, [node id, text]. Any panel shows them; check.ts checks the node ids of the
   * root's only.
   */
  readonly seams?: readonly Pair[];
  /** Couplings to know, [node id, text]; shown and checked as `seams` are. */
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
  /** The short list at the top of its panel; a node with children's only (adapter.ts). */
  readonly brief?: readonly string[];
  /**
   * Ids of the nodes that change when this one is replaced; one side of a coupling lists it. A
   * leaf's only (adapter.ts).
   */
  readonly couples?: readonly string[];
  /** "off": dormant, drawn dashed. A leaf's only (adapter.ts). */
  readonly kind?: "off";
  /** Required on an outside node (check.ts), refused on any other (adapter.ts). */
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
  /**
   * The zone tour of the panel's ← → buttons; depth-first when absent. Given, it lists every node
   * with children and nothing else (check.ts).
   */
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
  /** What it carries, from the Config's `tags`; drawn after its label in the detail. */
  readonly tags?: readonly string[];
};

/** A map: the root of its tree and every link, wherever their ends sit in the tree. */
export type AtlasMap = { readonly root: Root; readonly links: readonly Link[] };

/** The language of the page's own words: its headings, buttons, legend and errors. */
export type Lang = "fr" | "en";

/** A colour on a light page and on a dark one, each any CSS colour. */
export type Swatch = { readonly light: string; readonly dark: string };

/**
 * A line of the legend: an arrow kind (a plain flow, `dash`, `deny`) or a node mark (coupled to
 * the selected leaf, outside, carrying an open point).
 */
export type LegendKey = "flow" | "dash" | "deny" | "coupled" | "outside" | "open";

/**
 * The ends of the overview's arrows: "shared" lets arrows into one box end at the same point and
 * run as one trunk, "exclusive" gives every arrow its own end.
 */
export type Pins = "shared" | "exclusive";

/** The closed list of tags a link may carry. */
export type Tags = {
  readonly names: readonly string[];
  /** "required": a link into an outside leaf that is not on the left carries at least one. */
  readonly outside: "required" | "optional";
};

/** What a map sets beside its data. Every field but `title` and `palette` has a default. */
export type Config = {
  /** The page's title and heading, the breadcrumb's root, and the map's label. */
  readonly title: string;
  /** A line beside the heading; none when absent. */
  readonly subtitle?: string;
  /**
   * The language of the page's own words, "en" when absent; the map's content stays in the
   * language it is written in.
   */
  readonly lang?: Lang;
  /** The human party's name in threads, "human" when absent; its stored role stays "human". */
  readonly human?: string;
  /**
   * Patterns an open point's text must not match, such as step names and step words: they
   * describe a plan's progress, which ages, instead of a state. None when absent.
   */
  readonly stepWords?: readonly RegExp[];
  /** The keys a node's `color` names, each a colour; a key is letters, digits, `-` and `_`. */
  readonly palette: Readonly<Record<string, Swatch>>;
  /** "shared" when absent. */
  readonly pins?: Pins;
  /**
   * The overview's packing: "screen" aims at the drawing area's width / height and packs again
   * when it changes, a number is a fixed width / height. "screen" when absent.
   */
  readonly overview?: { readonly ratio: "screen" | number };
  /** The tags links may carry; none, and none required, when absent. */
  readonly tags?: Tags;
  /** The legend's labels, the dictionary's when absent. The legend shows the lines the map uses. */
  readonly legend?: Readonly<Partial<Record<LegendKey, string>>>;
};
