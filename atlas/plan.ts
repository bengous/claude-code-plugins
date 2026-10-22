import { edges } from "./data-edges.ts";
import { bricks } from "./data-nodes.ts";
import { OVERVIEW, ZONES, ZONE_ORDER } from "./data-zones.ts";
import type { Brick, Plan } from "./model.ts";

export const PLAN: Plan = {
  overview: OVERVIEW,
  zones: ZONES,
  nodes: bricks,
  edges,
  zoneOrder: ZONE_ORDER,
};

export const kidsOf = (p: Plan, zid: string): string[] =>
  p.zones.filter((z) => z.parent === zid).map((z) => z.id);

export const nests = (p: Plan, zid: string): boolean => p.zones.some((z) => z.parent === zid);

// A zone that holds sub-zones keeps its own bricks in a
// borderless group "<zone>~own", laid out like a sub-zone. Without it, ELK
// would scatter those bricks among the sub-zones.
export const OWN = "~own";

export const zoneBox = (p: Plan, zid: string): string => (nests(p, zid) ? zid + OWN : zid);

export const groupOf = (p: Plan, n: Brick): string | null =>
  n.zone === null ? null : zoneBox(p, n.zone);
