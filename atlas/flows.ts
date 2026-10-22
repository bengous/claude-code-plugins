import type { Graph } from "./graph.ts";
import { isZoneRef } from "./graph.ts";
import type { Edge } from "./model.ts";

// One overview arrow: kind "" draws it plain, which it is also when its bricks' arrows differ.
export type Flow = {
  readonly from: string;
  readonly to: string;
  readonly bricks: readonly string[];
  readonly two: boolean;
  readonly kind: string;
  readonly label: string;
};

// The bricks' arrows grouped by the pair of boxes they join. An overview label
// (a "z:" arrow, a Link with a zone end) names the arrow; with `two`, it also merges
// both directions into one arrow. Without a label, the arrow carries the
// first two labels of its bricks.
const refBox = (graph: Graph, ref: string, arriving: boolean): string => {
  if (!isZoneRef(ref)) {
    return arriving ? graph.arrival(ref) : ref;
  }

  return graph.zoneBox(ref.slice(2));
};

const boxOfNode = (graph: Graph, id: string): string => graph.groupOf(graph.node(id)) ?? id;

type FlowSum = {
  from: string;
  to: string;
  bricks: Set<string>;
  labels: string[];
  kinds: Set<string>;
  two: boolean;
  named: Edge | undefined;
};

export function flowsOf(graph: Graph): Flow[] {
  const named = new Map<string, Edge>();

  for (const e of graph.plan.edges) {
    if (isZoneRef(e.from) || isZoneRef(e.to)) {
      named.set(`${refBox(graph, e.from, false)}>${refBox(graph, e.to, true)}`, e);
    }
  }

  const sums = new Map<string, FlowSum>();

  for (const e of graph.links) {
    let a = boxOfNode(graph, e.from);
    let b = graph.arrival(e.to) === e.to ? boxOfNode(graph, e.to) : graph.arrival(e.to);

    if (a === b) {
      continue;
    }

    if (named.get(`${b}>${a}`)?.two === true) {
      [a, b] = [b, a];
    }

    const key = `${a}>${b}`;

    const sum = sums.get(key) ?? {
      from: a,
      to: b,
      bricks: new Set<string>(),
      labels: [],
      kinds: new Set<string>(),
      two: false,
      named: named.get(key),
    };

    sums.set(key, sum);
    sum.bricks.add(e.from).add(e.to);

    if (!sum.labels.includes(e.label)) {
      sum.labels.push(e.label);
    }

    sum.kinds.add(e.kind ?? "");
    sum.two ||= e.two === true || sum.named?.two === true;
  }

  return [...sums.values()].map((s) => ({
    from: s.from,
    to: s.to,
    bricks: [...s.bricks],
    two: s.two,
    kind: s.kinds.size === 1 ? ([...s.kinds][0] ?? "") : "",
    label: s.named?.label ?? s.labels.slice(0, 2).join(" · "),
  }));
}
