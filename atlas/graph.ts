import type { Brick, Edge, Plan, Zone } from "./model.ts";

// A zone that holds sub-zones keeps its own bricks in a borderless group "<zone>~own", laid out
// like a sub-zone. Without it, ELK would scatter those bricks among the sub-zones.
export const OWN = "~own";

// A service with side "both" is drawn twice: its arrows leave from the left copy and arrive at the
// right copy "<id>~out". One box on either side would loop every arrow around the whole server.
export const OUT = "~out";

export const realId = (id: string): string => (id.endsWith(OUT) ? id.slice(0, -OUT.length) : id);

// An arrow with a "z:<zone>" end is not drawn: it names the overview arrow
// between two boxes (Link in atlas.ts).
export const isZoneRef = (ref: string): boolean => ref.startsWith("z:");

// A layout result that must hold this key: a missing one is a layout bug.
export function got<V>(map: ReadonlyMap<string, V>, key: string, what: string): V {
  const v = map.get(key);

  if (v === undefined) {
    throw new Error(`${what}: nothing for ${key}`);
  }

  return v;
}

// The plan the page draws, with the lookups both drawings and the panel share. engine.ts builds it
// once from the map the page was given; check.ts builds one to read the overview's boxes.
export type Graph = {
  readonly plan: Plan;
  readonly zone: (id: string) => Zone;
  readonly node: (id: string) => Brick;
  readonly isZone: (id: string) => boolean;
  readonly isNode: (id: string) => boolean;
  readonly zoneOfNode: (id: string) => string | null;
  readonly nestsZone: (zid: string) => boolean;
  readonly kidsOfZone: (zid: string) => string[];
  readonly zoneBox: (zid: string) => string;
  readonly groupOf: (n: Brick) => string | null;
  // A zone, then its sub-zones: the drawing order of frames, so a parent's fill never covers a child.
  readonly nestOrder: (zid: string) => string[];
  readonly arrival: (id: string) => string;
  readonly links: readonly Edge[];
  readonly outside: readonly Brick[];
  readonly roots: readonly Zone[];
  // Each group's parent group, for ELK: a zone's parent zone, and a nesting zone for its "~own" group.
  readonly parents: ReadonlyMap<string, string>;
};

export function graphOf(plan: Plan): Graph {
  const zones = new Map(plan.zones.map((z) => [z.id, z]));
  const nodes = new Map(plan.nodes.map((n) => [n.id, n]));

  const zone = (id: string): Zone => {
    const z = zones.get(id);

    if (z === undefined) {
      throw new Error(`plan: unknown zone ${id}`);
    }

    return z;
  };

  const node = (id: string): Brick => {
    const n = nodes.get(id);

    if (n === undefined) {
      throw new Error(`plan: unknown brick ${id}`);
    }

    return n;
  };

  const nestsZone = (zid: string): boolean => plan.zones.some((z) => z.parent === zid);

  const kidsOfZone = (zid: string): string[] =>
    plan.zones.filter((z) => z.parent === zid).map((z) => z.id);

  const zoneBox = (zid: string): string => (nestsZone(zid) ? zid + OWN : zid);

  const nestOrder = (zid: string): string[] => [
    zid,
    ...kidsOfZone(zid).flatMap((k) => nestOrder(k)),
  ];

  const parents = new Map<string, string>();

  for (const z of plan.zones) {
    if (z.parent !== undefined) {
      parents.set(z.id, z.parent);
    }

    if (nestsZone(z.id)) {
      parents.set(z.id + OWN, z.id);
    }
  }

  return {
    plan,
    zone,
    node,
    isZone: (id) => zones.has(id),
    isNode: (id) => nodes.has(id),
    zoneOfNode: (id) => node(id).zone,
    nestsZone,
    kidsOfZone,
    zoneBox,
    groupOf: (n) => (n.zone === null ? null : zoneBox(n.zone)),
    nestOrder,
    arrival: (id) => (nodes.get(id)?.side === "both" ? id + OUT : id),
    links: plan.edges.filter((e) => !isZoneRef(e.from) && !isZoneRef(e.to)),
    outside: plan.nodes.filter((n) => n.zone === null),
    roots: plan.zones.filter((z) => z.parent === undefined),
    parents,
  };
}
