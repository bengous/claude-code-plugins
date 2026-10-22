import { join } from "node:path";

import type { Brick, Edge, Plan, Zone } from "./model.ts";
import { PLAN, zoneBox } from "./plan.ts";
import type { Threads } from "./threads.ts";
import { firstLine, openItems, plainText, readThreads, waitsFor } from "./threads.ts";

// Validates the plan's data and threads.json without a browser:
//   bun atlas/check.ts          validate
//   bun atlas/check.ts --open   list the open points
// The types (atlas.ts) already hold the shape of every field, and toPlan
// (adapter.ts) refuses a tree the engine cannot draw; this checks what they
// cannot, and fails on what would break the page or mislead a reader:
//   - duplicate ids, and references to ids that do not exist (arrows,
//     couplings, `see`, `seams`, `traps`, the zone order);
//   - a zone whose `parent` is unknown or loops back on itself;
//   - an ext zone or an outside service without a `side`;
//   - an overview label ("z:" arrow) that no brick arrow backs: the engine
//     would never draw it;
//   - an arrow into a third-party service (a brick outside every zone, on
//     the right) that does not name the tags it carries;
//   - an open point whose id is not unique or not kebab-case, or whose text
//     names a work package or a step: an open point describes a state;
//   - a thread of threads.json under an unknown open id, or with a `who`
//     outside the enumeration.
// Layout is not checked here: ELK and libavoid lay the plan out in the
// browser, and nothing overlaps by construction. Look at the rendered page
// (serve.ts) for the rest.
export const THREADS_FILE = join(import.meta.dir, "threads.json");

type Index = {
  readonly nodes: ReadonlyMap<string, Brick>;
  readonly zones: ReadonlyMap<string, Zone>;
};

function indexIds(p: Plan, errors: string[]): Index {
  const nodes = new Map<string, Brick>();

  for (const node of p.nodes) {
    if (nodes.has(node.id)) {
      errors.push(`duplicate brick id: ${node.id}`);
    }

    nodes.set(node.id, node);
  }

  const zones = new Map<string, Zone>();

  for (const zone of p.zones) {
    if (zones.has(zone.id)) {
      errors.push(`duplicate zone id: ${zone.id}`);
    }

    zones.set(zone.id, zone);
  }

  return { nodes, zones };
}

function checkZones(p: Plan, { zones }: Index, errors: string[]): void {
  for (const zone of p.zones) {
    if (zone.parent !== undefined && !zones.has(zone.parent)) {
      errors.push(`zone ${zone.id}: unknown parent ${zone.parent}`);
    }

    const seen = new Set([zone.id]);

    for (let parent = zone.parent; parent !== undefined; parent = zones.get(parent)?.parent) {
      if (seen.has(parent)) {
        errors.push(`zone ${zone.id}: its parents loop through ${parent}`);
        break;
      }

      seen.add(parent);
    }

    if (zone.ext === true && zone.side === undefined) {
      errors.push(`zone ${zone.id}: an ext zone needs side "in" or "out"`);
    }
  }

  for (const id of p.zoneOrder) {
    if (!zones.has(id)) {
      errors.push(`zoneOrder lists unknown zone ${id}`);
    }
  }

  for (const zone of p.zones) {
    if (!p.zoneOrder.includes(zone.id)) {
      errors.push(`zone ${zone.id} missing from zoneOrder`);
    }
  }
}

function checkBricks(p: Plan, { nodes, zones }: Index, errors: string[]): void {
  for (const node of p.nodes) {
    if (node.zone !== null && !zones.has(node.zone)) {
      errors.push(`brick ${node.id}: unknown zone ${node.zone}`);
    }

    if (node.zone === null && node.side === undefined) {
      errors.push(
        `brick ${node.id}: a service outside every zone needs side "in", "out" or "both"`,
      );
    }

    for (const id of node.couples) {
      if (!nodes.has(id)) {
        errors.push(`brick ${node.id}: couples unknown brick ${id}`);
      }
    }
  }
}

// An overview label names the arrow between two boxes, as engine.ts sees
// them: a zone that nests others keeps its own bricks in a box of their own.
function checkArrows(p: Plan, { nodes, zones }: Index, errors: string[]): void {
  const boxOf = (ref: string): string => {
    if (ref.startsWith("z:")) {
      return zoneBox(p, ref.slice(2));
    }

    const zone = nodes.get(ref)?.zone ?? null;

    return zone === null ? ref : zoneBox(p, zone);
  };

  const isRef = (ref: string): boolean =>
    ref.startsWith("z:") ? zones.has(ref.slice(2)) : nodes.has(ref);

  const brickArrows = p.edges.filter((e) => !e.from.startsWith("z:") && !e.to.startsWith("z:"));

  for (const e of brickArrows) {
    const to = nodes.get(e.to);

    if (
      to !== undefined &&
      to.zone === null &&
      to.side !== "in" &&
      (e.data === undefined || e.data.length === 0)
    ) {
      errors.push(`arrow ${e.from} → ${e.to}: an arrow into a third-party service names its tags`);
    }
  }

  const backs = (edge: Edge, a: string, b: string): boolean =>
    brickArrows.some((e) => {
      const [x, y] = [boxOf(e.from), boxOf(e.to)];

      return (x === a && y === b) || (edge.two === true && x === b && y === a);
    });

  const labels = new Set<string>();

  for (const edge of p.edges) {
    const ends = [edge.from, edge.to];
    const unknown = ends.filter((end) => !isRef(end));

    for (const end of unknown) {
      errors.push(`arrow ${edge.from} → ${edge.to}: unknown end ${end}`);
    }

    if (unknown.length > 0 || !ends.some((end) => end.startsWith("z:"))) {
      continue;
    }

    const [a, b] = [boxOf(edge.from), boxOf(edge.to)];

    if (labels.has(`${a}>${b}`)) {
      errors.push(`overview label ${edge.from} → ${edge.to}: a second label for the same boxes`);
    }

    labels.add(`${a}>${b}`);

    if (!backs(edge, a, b)) {
      errors.push(
        `overview label ${edge.from} → ${edge.to}: no brick arrow joins these boxes in that direction`,
      );
    }
  }
}

function checkLinks(p: Plan, { nodes, zones }: Index, errors: string[]): void {
  for (const item of [
    p.overview,
    ...p.zones.map((zone) => zone.info),
    ...p.nodes.map((node) => node.info),
  ]) {
    for (const id of item.see ?? []) {
      if (!nodes.has(id) && !zones.has(id)) {
        errors.push(`${item.title}: see unknown id ${id}`);
      }
    }
  }

  for (const [id] of [...(p.overview.seams ?? []), ...(p.overview.traps ?? [])]) {
    if (!nodes.has(id)) {
      errors.push(`overview: unknown brick ${id}`);
    }
  }
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// Step names (A1, F2a, I1) and step words: they describe a plan's progress,
// which ages, instead of a state of the system.
const STEP_WORDS = [/\b[A-J][0-9][ab]?\b/u, /\b(?:prévu|pas fait|après l'étape|bientôt)/iu];

function checkOpen(p: Plan, threads: Threads, errors: string[]): void {
  const ids = new Set<string>();

  for (const item of openItems(p)) {
    const where = `${item.kind} ${item.owner}: open point ${item.id}`;

    if (ids.has(item.id)) {
      errors.push(`${where}: duplicate open id`);
    }

    ids.add(item.id);

    if (!KEBAB.test(item.id)) {
      errors.push(`${where}: the id must be kebab-case`);
    }

    const word = STEP_WORDS.map((re) => re.exec(plainText(item.text))?.[0]).find(
      (w) => w !== undefined,
    );

    if (word !== undefined) {
      errors.push(`${where}: "${word}" names a step; an open point describes a state`);
    }
  }

  for (const id of Object.keys(threads)) {
    if (!ids.has(id)) {
      errors.push(`threads.json: thread for unknown open id ${id}`);
    }
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- threads is the content of threads.json as JSON.parse left it: readThreads below is its parser, and its errors join the plan's.
export function validate(p: Plan, threads: unknown): string[] {
  const errors: string[] = [];
  const index = indexIds(p, errors);
  checkZones(p, index, errors);
  checkBricks(p, index, errors);
  checkArrows(p, index, errors);
  checkLinks(p, index, errors);
  const read = readThreads(threads);
  errors.push(...read.errors);
  checkOpen(p, read.threads, errors);

  return errors;
}

export function openReport(p: Plan, threads: Threads): string {
  const items = openItems(p);

  const rows = items.map((item) => [
    item.id,
    `${item.kind} ${item.owner}`,
    `waits: ${waitsFor(threads[item.id]) ?? "nobody"}`,
    firstLine(item.text),
  ]);

  const widths = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c]?.length ?? 0)));

  const lines = rows.map((r) =>
    r
      .map((cell, c) => cell.padEnd(widths[c] ?? 0))
      .join("  ")
      .trimEnd(),
  );

  const count = (who: string): number =>
    items.filter((i) => waitsFor(threads[i.id]) === who).length;

  return [
    ...lines,
    `${items.length} open points: ${count("agent")} wait for agent, ${count("human")} wait for human`,
  ].join("\n");
}

if (import.meta.main) {
  const raw: unknown = await Bun.file(THREADS_FILE).json();

  if (process.argv.includes("--open")) {
    const { threads, errors } = readThreads(raw);

    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exit(1);
    }

    console.log(openReport(PLAN, threads));
    process.exit(0);
  }

  const errors = validate(PLAN, raw);

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }

  console.log(
    `plan ok: ${PLAN.zones.length} zones, ${PLAN.nodes.length} bricks, ${PLAN.edges.length} arrows`,
  );
}
