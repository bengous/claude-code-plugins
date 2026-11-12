/**
 * The map's logic, pure: a measured graph and a config in, the page's data and a report out.
 * The graph is what was measured (files, sizes, file-to-file links). The config says how to read it:
 * views (arrangements of the same files), bands, rules, annotations and copy. See references/config.md.
 */

import { globMatch, literalPrefix } from "./glob.ts";

export const LEVEL = { ok: 0, warn: 1, bad: 2 } as const;

export type VerdictName = keyof typeof LEVEL;

export type Level = (typeof LEVEL)[VerdictName];

export type GraphNode = { readonly path: string; readonly size: number };

export type Link = readonly [from: string, to: string];

export type Graph = {
  readonly root?: string;
  readonly unit?: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly Link[];
};

export type BandConfig = {
  readonly label?: string;
  readonly role?: string;
  readonly dirs: readonly string[];
  readonly columns?: boolean;
  readonly rootLabel?: string;
};

export type ContractConfig = {
  readonly band: number | string;
  readonly files: readonly string[];
  readonly verdict?: VerdictName;
};

export type OverrideConfig = {
  readonly from?: string;
  readonly to?: string;
  readonly verdict: VerdictName;
};

export type RulesConfig = {
  readonly layers?: boolean;
  readonly contracts?: readonly ContractConfig[];
  readonly overrides?: readonly OverrideConfig[];
};

export type NewFileConfig = { readonly path: string; readonly why?: string };

export type Move = readonly [pattern: string, destination: string];

export type ViewConfig = {
  readonly id: string;
  readonly label?: string;
  readonly moves?: readonly Move[];
  readonly new?: readonly NewFileConfig[];
  readonly bands?: readonly BandConfig[];
  readonly rules?: RulesConfig;
  readonly rulesText?: readonly string[];
  readonly roles?: Readonly<Record<string, string>>;
  readonly feedback?: boolean;
  readonly note?: string;
  readonly strayLabel?: string;
};

export type PageLink = { readonly label: string; readonly href: string };

export type DropRule = { readonly match: string; readonly maxSize?: number };

export type CollapseRule = {
  readonly match: string;
  readonly into: string;
  readonly label?: string;
};

export type MapConfig = {
  readonly name?: string;
  readonly title?: string;
  readonly root?: string;
  readonly unit?: string;
  readonly lang?: string;
  readonly start?: string;
  readonly note?: string;
  readonly links?: readonly PageLink[];
  readonly drop?: readonly DropRule[];
  readonly collapse?: readonly CollapseRule[];
  readonly splits?: Readonly<Record<string, readonly string[]>>;
  readonly views?: readonly ViewConfig[];
  readonly viewLabel?: string;
  readonly strings?: Readonly<Record<string, string>>;
  readonly fonts?: string;
  readonly css?: string;
};

export type PageNode = {
  readonly s: number;
  readonly g?: number;
  readonly gl?: string;
  readonly split?: readonly string[];
  readonly new?: string;
};

export type PageBand = {
  readonly label: string;
  readonly role: string;
  readonly columns: boolean;
  readonly dirs: readonly string[];
  readonly rootLabel: string;
};

export type PageView = {
  readonly id: string;
  readonly label: string;
  readonly bands: readonly PageBand[];
  readonly roles: Readonly<Record<string, string>>;
  readonly layers: boolean;
  readonly judges: boolean;
  readonly contracts: readonly { readonly band: number; readonly files: readonly string[] }[];
  readonly rulesText?: readonly string[];
  readonly feedback: boolean;
  readonly note: string;
};

/** Where a file sits in one view: its path, its band, the column of that band. */
export type Place = readonly [path: string, band: number, column: number];

export type PageData = {
  readonly meta: {
    readonly title: string;
    readonly root: string;
    readonly unit: string;
    readonly lang: string;
    readonly start: number;
    readonly links: readonly PageLink[];
    readonly note: string;
  };
  readonly strings: Readonly<Record<string, string>>;
  readonly views: readonly PageView[];
  readonly nodes: readonly PageNode[];
  readonly place: readonly (readonly (Place | null)[])[];
  /** `[from, to, verdict in view 0, verdict in view 1, ...]`, node indexes and levels. */
  readonly edges: readonly (readonly number[])[];
};

export type ViewReport = {
  readonly id: string;
  readonly counts: readonly [ok: number, warn: number, bad: number];
  readonly moved: number | null;
  readonly stays: number;
  readonly worst: readonly (readonly [path: string, links: number])[];
};

export type MapReport = {
  readonly files: number;
  readonly links: number;
  readonly notes: readonly string[];
  readonly views: readonly ViewReport[];
};

export type BuiltMap = { readonly data: PageData; readonly report: MapReport };

export class MapError extends Error {
  override readonly name = "MapError";
}

const quoted = (text: string): string => JSON.stringify(text);

const dirname = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const topOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Group = { readonly count: number; readonly label: string };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type DrawnFiles = {
  readonly sizes: Map<string, number>;
  readonly edges: readonly Link[];
  readonly groups: Map<string, Group>;
};

/** Drop and collapse files, then keep each link once, between two files still drawn. */
export function drawnFiles(graph: Graph, config: MapConfig, notes: string[]): DrawnFiles {
  const sizes = new Map(graph.nodes.map((node) => [node.path, node.size] as const));

  for (const rule of config.drop ?? []) {
    const limit = rule.maxSize ?? Number.POSITIVE_INFINITY;

    for (const [path, size] of sizes)
      if (globMatch(rule.match, path) && size <= limit) sizes.delete(path);
  }

  const alias = new Map<string, string>();
  const groups = new Map<string, Group>();

  for (const rule of config.collapse ?? []) {
    const members = [...sizes.keys()].filter((path) => globMatch(rule.match, path));

    if (members.length === 0) {
      notes.push(`collapse ${quoted(rule.match)} matched no file`);
      continue;
    }

    let total = 0;

    for (const member of members) {
      total += sizes.get(member) ?? 0;
      sizes.delete(member);
      alias.set(member, rule.into);
    }

    sizes.set(rule.into, total);
    groups.set(rule.into, {
      count: members.length,
      label: rule.label ?? `${basename(rule.into)}/`,
    });
  }

  const seen = new Set<string>();
  const edges: Link[] = [];

  for (const [rawFrom, rawTo] of graph.edges) {
    const from = alias.get(rawFrom) ?? rawFrom;
    const to = alias.get(rawTo) ?? rawTo;
    const key = `${from}\n${to}`;

    if (from === to || !sizes.has(from) || !sizes.has(to) || seen.has(key)) continue;
    seen.add(key);
    edges.push([from, to]);
  }

  return {
    sizes,
    groups,
    edges: edges.toSorted((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1])),
  };
}

/** First matching move wins. A destination ending in `/` keeps what follows the pattern's fixed prefix. */
export function movedPath(path: string, moves: readonly Move[], hits: number[]): string {
  for (const [index, [pattern, destination]] of moves.entries()) {
    if (!globMatch(pattern, path)) continue;
    hits[index] = (hits[index] ?? 0) + 1;

    if (!destination.endsWith("/")) return destination;

    const prefix = literalPrefix(pattern);
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : basename(path);

    return (destination === "./" ? "" : destination) + rest;
  }

  return path;
}

type Slot = readonly [band: number, column: number];

type Resolved = { readonly bands: readonly BandConfig[]; readonly slots: readonly (Slot | null)[] };

function holds(dir: string, path: string): boolean {
  return dir === "." ? !path.includes("/") : path === dir || path.startsWith(`${dir}/`);
}

/** Each file goes to the band whose folder is the longest prefix of its path. `.` holds root-level files. */
export function resolveBands(
  view: ViewConfig,
  paths: readonly (string | null)[],
  notes: string[],
): Resolved {
  const declared = view.bands ?? [];
  const slots: (Slot | null)[] = [];
  const stray: string[] = [];

  for (const path of paths) {
    let best: Slot | null = null;
    let bestLength = -1;

    if (path !== null) {
      for (const [bandIndex, band] of declared.entries()) {
        for (const [columnIndex, dir] of band.dirs.entries()) {
          if (holds(dir, path) && dir.length > bestLength) {
            best = [bandIndex, columnIndex];
            bestLength = dir.length;
          }
        }
      }

      if (best === null) stray.push(path);
    }

    slots.push(best);
  }

  if (stray.length === 0) return { bands: declared, slots };

  const tops = [...new Set(stray.map((path) => topOf(path)))].toSorted((a, b) => byCodePoint(a, b));
  const label = declared.length === 0 ? "" : (view.strayLabel ?? "other");
  const bands = [...declared, { label, dirs: tops, columns: declared.length === 0 }];
  const last = bands.length - 1;

  if (declared.length > 0) {
    notes.push(
      `view ${quoted(view.id)}: ${stray.length} file(s) fit no band, shown in ${quoted(label)}: ${tops.join(", ")}`,
    );
  }

  return {
    bands,
    slots: slots.map((slot, index) => {
      const path = paths[index];

      return slot !== null || path === null || path === undefined
        ? slot
        : [last, tops.indexOf(topOf(path))];
    }),
  };
}

function contractBand(bands: readonly BandConfig[], ref: number | string): number {
  if (Number.isInteger(ref)) return Number(ref);

  const found = bands.findIndex((band) => band.label === ref);

  if (found === -1) throw new MapError(`a contract names an unknown band ${quoted(String(ref))}`);

  return found;
}

type Judge = {
  readonly bands: readonly BandConfig[];
  readonly contracts: readonly {
    readonly band: number;
    readonly files: readonly string[];
    readonly level: Level;
  }[];
  readonly overrides: readonly OverrideConfig[];
  readonly layers: boolean;
};

/** The verdict of one link in one view, in the order references/config.md states. */
export function judge(rules: Judge, from: Place, to: Place): Level {
  const [fromPath, fromBand, fromColumn] = from;
  const [toPath, toBand, toColumn] = to;

  for (const override of rules.overrides) {
    if (globMatch(override.from ?? "**", fromPath) && globMatch(override.to ?? "**", toPath)) {
      return LEVEL[override.verdict];
    }
  }

  if (dirname(fromPath) === dirname(toPath)) return LEVEL.ok;

  if (fromBand === toBand) {
    if (fromColumn === toColumn) return LEVEL.ok;

    const contract = rules.contracts.find((candidate) => candidate.band === fromBand);

    if (contract === undefined) return LEVEL.ok;

    const column = rules.bands[toBand]?.dirs[toColumn] ?? ".";
    const doors = contract.files.map((file) => (column === "." ? file : `${column}/${file}`));

    return doors.includes(toPath) ? LEVEL.ok : contract.level;
  }

  if (rules.layers) return toBand > fromBand ? LEVEL.ok : LEVEL.bad;

  return LEVEL.ok;
}

/** The page's data and the build report. Throws a MapError when the config contradicts itself. */
export function buildMap(graph: Graph, config: MapConfig): BuiltMap {
  const notes: string[] = [];
  const { sizes, edges, groups } = drawnFiles(graph, config, notes);
  const order = [...sizes.keys()].toSorted((a, b) => byCodePoint(a, b));
  const index = new Map(order.map((path, position) => [path, position] as const));
  const splits = config.splits ?? {};

  for (const path of Object.keys(splits))
    if (!index.has(path)) notes.push(`split names an unknown file ${quoted(path)}`);

  const nodes: PageNode[] = order.map((path) => {
    const group = groups.get(path);
    const split = splits[path];

    const node: Mutable<PageNode> = { s: sizes.get(path) ?? 0 };

    if (group !== undefined) {
      node.g = group.count;
      node.gl = group.label;
    }

    if (split !== undefined) node.split = split;

    return node;
  });

  const viewConfigs: readonly ViewConfig[] = config.views ?? [
    { id: "tree", label: config.viewLabel ?? "Tree" },
  ];

  const newIndex = new Map<string, number>();

  for (const view of viewConfigs) {
    for (const item of view.new ?? []) {
      if (newIndex.has(item.path)) continue;
      newIndex.set(item.path, nodes.length);
      nodes.push({ s: 0, new: item.why ?? "" });
    }
  }

  const views: PageView[] = [];
  const judges: Judge[] = [];
  const place: (Place | null)[][] = [];
  const reportViews: ViewReport[] = [];

  for (const view of viewConfigs) {
    const moves = view.moves ?? [];
    const hits = moves.map(() => 0);

    const paths: (string | null)[] = [
      ...order.map((path) => movedPath(path, moves, hits)),
      ...Array.from(newIndex, () => null),
    ];

    for (const item of view.new ?? []) {
      const at = newIndex.get(item.path);

      if (at !== undefined) paths[at] = item.path;
    }

    const counted = new Map<string, number>();

    for (const path of paths) if (path !== null) counted.set(path, (counted.get(path) ?? 0) + 1);

    const clash = [...counted]
      .flatMap(([path, count]) => (count > 1 ? [path] : []))
      .toSorted((a, b) => byCodePoint(a, b));

    if (clash.length > 0) {
      throw new MapError(
        `view ${quoted(view.id)}: several files land on the same path: ${clash.slice(0, 5).join(", ")}`,
      );
    }

    for (const [position, count] of hits.entries()) {
      if (count === 0)
        notes.push(
          `view ${quoted(view.id)}: move ${quoted(moves[position]?.[0] ?? "")} matched no file`,
        );
    }

    const { bands, slots } = resolveBands(view, paths, notes);
    const rules = view.rules ?? {};

    judges.push({
      bands,
      layers: rules.layers === true,
      overrides: rules.overrides ?? [],
      contracts: (rules.contracts ?? []).map((contract) => ({
        band: contractBand(bands, contract.band),
        files: contract.files,
        level: LEVEL[contract.verdict ?? "warn"],
      })),
    });

    const pageView: Mutable<PageView> = {
      id: view.id,
      label: view.label ?? view.id,
      bands: bands.map((band) => ({
        label: band.label ?? "",
        role: band.role ?? "",
        columns: band.columns === true,
        dirs: band.dirs,
        rootLabel: band.rootLabel ?? "",
      })),
      roles: view.roles ?? {},
      layers: rules.layers === true,
      judges:
        rules.layers === true ||
        (rules.contracts ?? []).length > 0 ||
        (rules.overrides ?? []).length > 0,
      contracts: (judges.at(-1)?.contracts ?? []).map(({ band, files }) => ({ band, files })),
      feedback: view.feedback === true,
      note: view.note ?? "",
    };

    if (view.rulesText !== undefined) pageView.rulesText = view.rulesText;

    views.push(pageView);

    place.push(
      paths.map((path, position) => {
        const slot = slots[position];

        return path === null || slot === null || slot === undefined
          ? null
          : [path, slot[0], slot[1]];
      }),
    );

    const stays = order.filter((path, position) => paths[position] === path).length;

    reportViews.push({
      id: view.id,
      counts: [0, 0, 0],
      moved: moves.length > 0 ? order.length - stays : null,
      stays,
      worst: [],
    });
  }

  const pageEdges: number[][] = [];

  for (const [from, to] of edges) {
    const source = index.get(from);
    const target = index.get(to);

    if (source === undefined || target === undefined) continue;

    const levels = judges.map((rules, view) => {
      const a = place[view]?.[source];
      const b = place[view]?.[target];

      return a === null || a === undefined || b === null || b === undefined
        ? LEVEL.ok
        : judge(rules, a, b);
    });

    pageEdges.push([source, target, ...levels]);
  }

  const startId = config.start ?? views.at(-1)?.id;
  const found = views.findIndex((view) => view.id === startId);
  const startIndex = found === -1 ? views.length - 1 : found;

  const data: PageData = {
    meta: {
      title: config.title ?? "Architecture map",
      root: config.root ?? (graph.root === undefined || graph.root === "" ? "" : `${graph.root}/`),
      unit: config.unit ?? graph.unit ?? "lines",
      lang: config.lang ?? "en",
      start: startIndex,
      links: config.links ?? [],
      note: config.note ?? "",
    },
    strings: config.strings ?? {},
    views,
    nodes,
    place,
    edges: pageEdges,
  };

  const report: MapReport = {
    files: nodes.filter((node) => node.new === undefined && node.g === undefined).length,
    links: pageEdges.length,
    notes,
    views: reportViews.map((view, position) => {
      const counts: [number, number, number] = [0, 0, 0];
      const worst = new Map<string, number>();

      for (const edge of pageEdges) {
        const level = edge[2 + position] ?? 0;
        const sourcePlace = place[position]?.[edge[0] ?? -1];

        counts[level === 2 ? 2 : level === 1 ? 1 : 0] += 1;

        if (level > 0 && sourcePlace)
          worst.set(sourcePlace[0], (worst.get(sourcePlace[0]) ?? 0) + 1);
      }

      return {
        ...view,
        counts,
        worst: [...worst].toSorted((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0])).slice(0, 5),
      };
    }),
  };

  return { data, report };
}

const PREVIEW_HEAD =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>";

const escapeTitle = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

/** The page: the template with the data, the title, and the config's fonts and CSS laid in. */
export function renderPage(template: string, data: PageData, config: MapConfig): string {
  if (!template.includes("/*DATA*/null"))
    throw new MapError("the template has no /*DATA*/null placeholder");

  const payload = JSON.stringify(data).replaceAll("</", String.raw`<\/`);
  const name = config.name ?? config.title ?? "Architecture map";
  let html = template.replace("/*DATA*/null", () => payload);

  html = html.replace(/<title>[\s\S]*?<\/title>/u, () => `<title>${escapeTitle(name)}</title>`);

  if (config.fonts !== undefined) {
    const fonts = config.fonts;

    html = html.replace(
      /(<link rel="stylesheet" href=")[^"]*(")/u,
      (_match, open: string, close: string) => open + fonts + close,
    );
  }

  if (config.css !== undefined) html = html.replace("/*EXTRA-CSS*/", () => config.css ?? "");

  return html;
}

/** A standalone copy with its own document shell, to open over a local HTTP server. */
export function previewPage(html: string): string {
  return `${PREVIEW_HEAD}${html}</body></html>`;
}

/** The report as the build prints it. */
export function reportLines(report: MapReport): string[] {
  const lines = report.notes.map((note) => `  note: ${note}`);

  for (const view of report.views) {
    const [ok, warn, bad] = view.counts;
    let line = `  view ${quoted(view.id)}: ok ${ok}, warn ${warn}, bad ${bad}`;

    if (view.moved !== null) line += `; ${view.moved} file(s) moved, ${view.stays} stay`;
    lines.push(line);

    if (view.worst.length > 0) {
      lines.push(
        `    most links to fix: ${view.worst.map(([path, count]) => `${path} (${count})`).join(", ")}`,
      );
    }
  }

  return lines;
}
