import type { Brick, Edge, Zone } from "./model.ts";
import { OWN, PLAN, kidsOf, nests } from "./plan.ts";

const ZONES_BY_ID = new Map(PLAN.zones.map((z) => [z.id, z]));

const NODES_BY_ID = new Map(PLAN.nodes.map((n) => [n.id, n]));

export function zone(id: string): Zone {
  const z = ZONES_BY_ID.get(id);

  if (z === undefined) {
    throw new Error(`plan: unknown zone ${id}`);
  }

  return z;
}

export function node(id: string): Brick {
  const n = NODES_BY_ID.get(id);

  if (n === undefined) {
    throw new Error(`plan: unknown brick ${id}`);
  }

  return n;
}

// A layout result that must hold this key: a missing one is a layout bug.
export function got<V>(map: ReadonlyMap<string, V>, key: string, what: string): V {
  const v = map.get(key);

  if (v === undefined) {
    throw new Error(`${what}: nothing for ${key}`);
  }

  return v;
}

export const isZone = (id: string): boolean => ZONES_BY_ID.has(id);

export const isNode = (id: string): boolean => NODES_BY_ID.has(id);

export const zoneOfNode = (id: string): string | null => node(id).zone;

export const nestsZone = (zid: string): boolean => nests(PLAN, zid);

export const kidsOfZone = (zid: string): string[] => kidsOf(PLAN, zid);

// An arrow with a "z:<zone>" end is not drawn: it names the overview arrow
// between two boxes (data-edges.ts).
export const isZoneRef = (ref: string): boolean => ref.startsWith("z:");

export const links: readonly Edge[] = PLAN.edges.filter(
  (e) => !isZoneRef(e.from) && !isZoneRef(e.to),
);

export const outside: readonly Brick[] = PLAN.nodes.filter((n) => n.zone === null);

// A zone, then its sub-zones: the drawing order of frames, so a parent's fill
// never covers a child.
export const nestOrder = (zid: string): string[] => [
  zid,
  ...kidsOfZone(zid).flatMap((k) => nestOrder(k)),
];

export const roots: readonly Zone[] = PLAN.zones.filter((z) => z.parent === undefined);

// A service with side "both" is drawn twice: its arrows leave from
// the left copy and arrive at the right copy "<id>~out". One box on either
// side would loop every arrow around the whole server.
export const OUT = "~out";

export const realId = (id: string): string => (id.endsWith(OUT) ? id.slice(0, -OUT.length) : id);

export const arrival = (id: string): string =>
  isNode(id) && node(id).side === "both" ? id + OUT : id;

// Each group's parent group, for ELK: a zone's parent zone, and a nesting
// zone for its "~own" group.
export function parentMap(): Map<string, string> {
  const parents = new Map<string, string>();

  for (const z of PLAN.zones) {
    if (z.parent !== undefined) {
      parents.set(z.id, z.parent);
    }

    if (nestsZone(z.id)) {
      parents.set(z.id + OWN, z.id);
    }
  }

  return parents;
}
