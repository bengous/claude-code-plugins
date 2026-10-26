// The format of a map: a tree of nodes, the links between them, and the map's Config. Types only:
// a map's atlas.d.ts is a byte copy of this file, which its data import with `import type` and
// check with `satisfies`.

export type Pair = readonly [string, string];

/**
 * A fact of the map that stays unsettled, with its discussion in threads.json under the same id.
 * `id` is kebab-case, unique on the whole map, and never changes; `text` describes a state, never
 * a step: `atlas check` refuses the Config's `stepWords`.
 */
export type OpenPoint = { readonly id: string; readonly text: string };

/**
 * The side of an outside node in the root's view: "in" (left, or above under the Config's
 * direction "DOWN") or "out" (right, or below). "both", for a leaf only, draws it twice, its links
 * leaving the "in" copy and arriving at the "out" one.
 */
export type Side = "in" | "out" | "both";

/**
 * The panel's content, in the order the panel shows it. Its text is HTML (<code>), but for
 * `kicker`, `facts`, `src` and the first of each `io` pair, which the panel shows as written.
 */
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
  /** Extension points, [node id, text]. Any panel shows them; `atlas check` checks the node ids. */
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
 * its `src`). A node with `children` is a container: in its parent's view, a box naming its
 * children as chips; opened, a view of its own. A node without is a leaf, drawn as a card.
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
  /**
   * The short list at the top of its panel, shown as written; a node with children's only
   * (`atlas check`).
   */
  readonly brief?: readonly string[];
  /**
   * Ids of the nodes that change when this one is replaced; one side of a coupling lists it. Any
   * node's: a view outlines a coupling lifted to the boxes and ghosts it shows, on either side.
   */
  readonly couples?: readonly string[];
  /** "off": dormant, drawn dashed. A leaf's only: the page and `atlas check` refuse it elsewhere. */
  readonly kind?: "off";
  /** Required on an outside node, refused on any other. */
  readonly side?: Side;
  /** Outside the system (a client, a third-party service): a child of the root, drawn dashed. */
  readonly outside?: true;
  /**
   * The band it sits in, in its parent's view: an integer from 0 (`atlas check`), the bands
   * following the Config's `direction` in rank order. Once one of its siblings has a rank, a
   * sibling without one sits after every rank.
   */
  readonly rank?: number;
  readonly open?: readonly OpenPoint[];
  /** Drawn inside this node, packed in this order. */
  readonly children?: readonly Node[];
};

/** The top of the tree: the root view's panel and the nodes that view shows. */
export type Root = Panel & {
  readonly title: string;
  /**
   * The tour of the panel's ← → buttons; every container depth-first when absent. Given, it lists
   * every node with children and nothing else (`atlas check`).
   */
  readonly tour?: readonly string[];
  readonly children: readonly Node[];
};

/**
 * An arrow, from → to, between two nodes neither of which holds the other, at any depth. A view
 * draws one arrow per pair of the boxes and ghosts its links join, each end lifted to the one that
 * holds it: a link set directly between that pair names the arrow, and otherwise the arrow joins
 * the first two labels of the links it stands for. A link whose two ends lift to one box shows in
 * that container's own view.
 */
export type Link = {
  readonly from: string;
  readonly to: string;
  /** What moves along it (a call, a protocol, a table): a few words. */
  readonly label: string;
  /** "deny": refused, in red; "dash": dormant, local only, or on demand. */
  readonly kind?: "deny" | "dash";
  /** Arrowheads at both ends; the pair's arrows merge into one two-headed arrow. */
  readonly two?: true;
  /**
   * What it carries, from the Config's `tags`; drawn after its label in a view of leaves alone. A
   * link with a container end names the arrow, whose tags are its leaf links'.
   */
  readonly tags?: readonly string[];
};

/** A map: the root of its tree and every link, wherever their ends sit in the tree. */
export type AtlasMap = { readonly root: Root; readonly links: readonly Link[] };

/** The language of the page's own words: its headings, buttons, legend and errors. */
export type Lang = "fr" | "en";

/**
 * A colour on a light page and on a dark one. Each is a hex colour (#rgb, #rgba, #rrggbb,
 * #rrggbbaa) or rgb(), rgba(), hsl(), hsla(), hwb(), lab(), lch(), oklab() or oklch() with three
 * components and an optional alpha; the page and `atlas check` refuse any other value, named colours, var(),
 * color() and color-mix() included, and the page refuses one its browser does not draw.
 */
export type Swatch = { readonly light: string; readonly dark: string };

/**
 * A line of the legend: an arrow kind (a plain flow, `dash`, `deny`) or a node mark (coupled to
 * the selected node, outside, carrying an open point). The legend shows the lines the open view
 * uses.
 */
export type LegendKey = "flow" | "dash" | "deny" | "coupled" | "outside" | "open";

/**
 * A heading of the panel, by the section it heads: `io`, `swap`, `extend`, `pitfalls`, `seams`,
 * `traps`, `why`, `alt`, `facts`, `how` and `see` head the Panel fields of the same name;
 * `coupledWith` introduces the couplings under `swap`.
 */
export type PanelHeading =
  | "io"
  | "swap"
  | "coupledWith"
  | "extend"
  | "pitfalls"
  | "seams"
  | "traps"
  | "why"
  | "alt"
  | "facts"
  | "how"
  | "see";

/**
 * The ends of the arrows of a view with a container child: "shared" lets arrows into one box end
 * at the same point and run as one trunk, "exclusive" gives every arrow its own end.
 */
export type Pins = "shared" | "exclusive";

/** The way a view reads, its layers or its ranked bands one after the other: "RIGHT" or "DOWN". */
export type Direction = "RIGHT" | "DOWN";

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
  /**
   * The colour of every open-point mark: the badges on the map, the header's button, the panel's
   * open points and the legend's dot. The page's own, an amber, when absent.
   */
  readonly openColor?: Swatch;
  /** "shared" when absent. */
  readonly pins?: Pins;
  /**
   * The packing of a view with a container child: "screen" aims at the drawing area's width /
   * height and packs again when it changes, a number is a fixed width / height. "screen" when
   * absent.
   */
  readonly overview?: { readonly ratio: "screen" | number };
  /** The reading direction of every view, "RIGHT" when absent. */
  readonly direction?: Direction;
  /** The tags links may carry; none, and none required, when absent. */
  readonly tags?: Tags;
  /** The legend's labels, the dictionary's when absent. The legend shows the lines a view uses. */
  readonly legend?: Readonly<Partial<Record<LegendKey, string>>>;
  /**
   * The panel's headings in the map's own words, such as `{ io: "Terrain" }` for a map of people
   * and places; the dictionary's for each one absent. Shown as written: no markup.
   */
  readonly headings?: Readonly<Partial<Record<PanelHeading, string>>>;
};
