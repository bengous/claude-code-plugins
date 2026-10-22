import { join, resolve } from "node:path";

import { toPlan } from "./adapter.ts";
import type { AtlasMap, Config } from "./atlas.ts";
import { THREADS_FILE, loadFolder, planOf } from "./folder.ts";
import { graphOf } from "./graph.ts";
import type { Brick, Edge, Plan, Zone } from "./model.ts";
import { PlanError } from "./model.ts";
import type { Settings } from "./settings.ts";
import { settingsOf } from "./settings.ts";
import type { Threads } from "./threads.ts";
import { firstLine, openItems, plainText, readThreads, waitsFor } from "./threads.ts";

// Validates a map folder's data and threads.json without a browser:
//   bun atlas/check.ts <map folder>          validate
//   bun atlas/check.ts <map folder> --open   list the open points
// The types (atlas.ts) already hold the shape of every field, and toPlan
// (adapter.ts) refuses a tree the engine cannot draw: a duplicate id, a link
// end that is no node, a colour outside the palette among them. This checks
// what they cannot, and fails on what would break the page or mislead a
// reader:
//   - references to ids that do not exist (couplings, `see`, the root's
//     `seams` and `traps`);
//   - a root's `tour` that names what is no node with children, or misses one;
//   - an ext zone or an outside service without a `side`;
//   - an overview label ("z:" arrow) that no brick arrow backs: the engine
//     would never draw it;
//   - a tag outside the Config's `tags`, and, when they say so, an arrow
//     into a third-party service (a brick outside every zone, on the right)
//     that does not name the tags it carries;
//   - an open point whose id is not unique or not kebab-case, or whose text
//     matches one of the Config's `stepWords`: an open point describes a state;
//   - a thread of threads.json under an unknown open id, or with a `who`
//     outside the enumeration.
// Layout is not checked here: ELK and libavoid lay the plan out in the
// browser, and nothing overlaps by construction. Look at the rendered page
// (serve.ts) for the rest.
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
      errors.push(`tour lists ${id}, which is no node with children`);
    }
  }

  for (const zone of p.zones) {
    if (!p.zoneOrder.includes(zone.id)) {
      errors.push(`tour misses ${zone.id}, a node with children`);
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
function checkArrows(p: Plan, s: Settings, { nodes, zones }: Index, errors: string[]): void {
  const { zoneBox } = graphOf(p);

  const boxOf = (ref: string): string => {
    if (ref.startsWith("z:")) {
      return zoneBox(ref.slice(2));
    }

    const zone = nodes.get(ref)?.zone ?? null;

    return zone === null ? ref : zoneBox(zone);
  };

  const isRef = (ref: string): boolean =>
    ref.startsWith("z:") ? zones.has(ref.slice(2)) : nodes.has(ref);

  const brickArrows = p.edges.filter((e) => !e.from.startsWith("z:") && !e.to.startsWith("z:"));

  for (const e of brickArrows) {
    const to = nodes.get(e.to);

    if (
      s.tags.outside === "required" &&
      to !== undefined &&
      to.zone === null &&
      to.side !== "in" &&
      (e.data === undefined || e.data.length === 0)
    ) {
      errors.push(`arrow ${e.from} → ${e.to}: an arrow into a third-party service names its tags`);
    }
  }

  for (const e of p.edges) {
    for (const tag of e.data ?? []) {
      if (!s.tags.names.includes(tag)) {
        errors.push(`arrow ${e.from} → ${e.to}: tag ${tag} is not in the config's tags`);
      }
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

function checkOpen(p: Plan, s: Settings, threads: Threads, errors: string[]): void {
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

    const word = s.stepWords
      .map((re) => re.exec(plainText(item.text))?.[0])
      .find((w) => w !== undefined);

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
export function validate(p: Plan, s: Settings, threads: unknown): string[] {
  const errors: string[] = [];
  const index = indexIds(p, errors);
  checkZones(p, index, errors);
  checkBricks(p, index, errors);
  checkArrows(p, s, index, errors);
  checkLinks(p, index, errors);
  const read = readThreads(threads);
  errors.push(...read.errors);
  checkOpen(p, s, read.threads, errors);

  return errors;
}

// A map folder's data as check.ts sees it: toPlan's refusal, or what validate finds.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- threads is threads.json as JSON.parse left it, which validate hands to its parser.
export function checkMap(map: AtlasMap, config: Config, threads: unknown): string[] {
  let plan: Plan;

  try {
    plan = toPlan(map, config);
  } catch (error: unknown) {
    if (error instanceof PlanError) {
      return [error.message];
    }

    throw error;
  }

  return validate(plan, settingsOf(config), threads);
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
  const open = process.argv.includes("--open");
  const [dir, ...extra] = process.argv.slice(2).filter((a) => a !== "--open");

  if (dir === undefined || extra.length > 0) {
    console.error("usage: bun check.ts <map folder> [--open]");
    process.exit(1);
  }

  const folder = resolve(dir);
  const raw: unknown = await Bun.file(join(folder, THREADS_FILE)).json();

  if (open) {
    const { threads, errors } = readThreads(raw);

    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exit(1);
    }

    console.log(openReport(await planOf(folder), threads));
    process.exit(0);
  }

  const { map, config } = await loadFolder(folder);
  const errors = checkMap(map, config, raw);

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }

  const plan = toPlan(map, config);
  console.log(
    `plan ok: ${plan.zones.length} zones, ${plan.nodes.length} bricks, ${plan.edges.length} arrows`,
  );
}
