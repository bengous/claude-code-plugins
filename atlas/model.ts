// The plan's data types. The data files (data-*.ts) fill them; nothing here
// has a position or a size: engine.ts lays the plan out.

// One colour per zone: a --z-* token of plan.fr.html.
export type Color =
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

// The tags an arrow carries, from a closed list: an arrow into a third-party
// service names them (check.ts), "none" included.
export type Tag = "account" | "order" | "payment" | "none";

export type Pair = readonly [string, string];

// A fact of the plan that stays unsettled, with its discussion in
// threads.json under the same id. `id` is kebab-case, unique on the whole
// plan, and never changes; `text` describes a state, never a step
// (check.ts refuses work-package names and step words).
export type OpenPoint = { readonly id: string; readonly text: string };

// The right panel's content. HTML is allowed (<code>); the fields are
// documented at the top of data-zones.ts, in the order the panel shows them.
export type Info = {
  readonly kicker?: string;
  readonly title: string;
  readonly lead?: string;
  readonly io?: readonly Pair[];
  swap?: string;
  readonly extend?: string;
  readonly pitfalls?: readonly string[];
  readonly seams?: readonly Pair[];
  readonly traps?: readonly Pair[];
  readonly why?: readonly string[];
  readonly alt?: string;
  readonly facts?: readonly Pair[];
  readonly open?: readonly OpenPoint[];
  readonly how?: string;
  readonly see?: readonly string[];
  readonly src?: string;
};

// The overview panel: open points belong to a zone or a brick.
export type Overview = Omit<Info, "open">;

export type Zone = {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly color: Color;
  readonly kw: readonly string[];
  readonly info: Info;
  readonly parent?: string;
  readonly ext?: true;
  readonly side?: "in" | "out";
};

// side: the overview column of a service outside every zone; "both" draws it
// twice, its arrows leaving the left copy and arriving at the right one.
export type Side = "in" | "out" | "both";

export type Brick = {
  readonly id: string;
  readonly zone: string | null;
  readonly label: string;
  readonly sub: string;
  readonly info: Info;
  readonly color: Color;
  readonly couples: readonly string[];
  readonly kind?: "off";
  readonly side?: Side;
};

export type BrickOptions = Pick<Brick, "color" | "couples" | "kind" | "side">;

export type Section = Pick<Brick, "color" | "side">;

export type Edge = {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind?: "deny" | "dash";
  readonly two?: true;
  readonly data?: readonly Tag[];
};

export type EdgeOptions = Pick<Edge, "kind" | "two" | "data">;

// The text drawn on an arrow: its label, then the tags it carries.
export const edgeText = (e: Edge): string =>
  e.data === undefined ? e.label : `${e.label} · ${e.data.join(", ")}`;

export type Plan = {
  readonly overview: Overview;
  readonly zones: readonly Zone[];
  readonly nodes: readonly Brick[];
  readonly edges: readonly Edge[];
  readonly zoneOrder: readonly string[];
};

export type AddBrick = (
  zone: string | null,
  id: string,
  label: string,
  sub: string,
  info: Info,
  options: BrickOptions,
) => void;

export function brickAdder(bricks: Brick[]): AddBrick {
  return (zone, id, label, sub, info, options) => {
    bricks.push({ zone, id, label, sub, info, ...options });
  };
}

export type AddEdge = (from: string, to: string, label: string, options?: EdgeOptions) => void;

export function edgeAdder(edges: Edge[]): AddEdge {
  return (from, to, label, options) => {
    edges.push({ from, to, label, ...options });
  };
}
