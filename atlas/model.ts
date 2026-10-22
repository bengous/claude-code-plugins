// The plan the engine draws on two levels, which adapter.ts makes from the map's tree. Nothing
// here has a position or a size: engine.ts lays the plan out.
import type { OpenPoint, Panel, Side } from "./atlas.ts";

// The right panel's content: the fields of Panel (atlas.ts), its title and its open points.
export type Info = Panel & {
  readonly title: string;
  readonly open?: readonly OpenPoint[];
};

// The overview panel: open points belong to a zone or a brick.
export type Overview = Omit<Info, "open">;

export type Zone = {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly color: string;
  readonly kw: readonly string[];
  readonly info: Info;
  readonly parent?: string;
  readonly ext?: true;
  readonly side?: "in" | "out";
};

export type Brick = {
  readonly id: string;
  readonly zone: string | null;
  readonly label: string;
  readonly sub: string;
  readonly info: Info;
  readonly color: string;
  readonly couples: readonly string[];
  readonly kind?: "off";
  readonly side?: Side;
};

export type Edge = {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind?: "deny" | "dash";
  readonly two?: true;
  readonly data?: readonly string[];
};

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
