import { join } from "node:path";

import { REVIEW_PART } from "./review/server.ts";
import type { ServerWorkflow, WalkOf } from "./runtime/extension.ts";
import { serverExtensions } from "./runtime/server/slices.ts";
import { parseWipDir } from "./workshop/paths.ts";
import type { Refused, Wording } from "./workshop/view.ts";
import { pillOf, refusedNow, viewOf } from "./workshop/view.ts";
import type {
  Effect,
  EventInput,
  Region,
  Step,
  Table,
  TablePart,
  Workflow,
} from "./workshop/workflow.ts";
import { held, next, tableOf } from "./workshop/workflow.ts";

/**
 * The proof of the table, which `workflow.spec.ts` holds and `table.spec.ts` reads its states from:
 * from the empty workflow, every event with every sample, breadth first, each state checked
 * against the invariants. It walks each part of the registry alone, then each pair of parts that
 * meet: one hears an event the other owns, both can hold the review, or one holds while the other
 * refuses an event under a hold. A part brings what the walk reads of its region (`WalkOf`) in
 * a `walk.ts` of its own folder, which names the part it walks: the proof reads every one under
 * `src/`, wherever the folder lies, and matches each to the registry by that name. The runtime
 * never loads one, and the proof names no extension. The tests alone import this module.
 */

/** A part of the table, as the registry holds it, and what the proof reads of its region. */
export type Part = {
  readonly id: string;
  readonly workflow: ServerWorkflow;
  readonly walk: WalkOf;
};

/** Where the proof looks for the parts' `walk.ts`: the whole of `src/`. */
const SRC = import.meta.dir;

/** Every `WALK` under `src/`, by the part it names; a part named twice is refused. */
async function walksFound(): Promise<ReadonlyMap<string, WalkOf>> {
  const found = new Map<string, WalkOf>();

  for (const file of new Bun.Glob("**/walk.ts").scanSync({ cwd: SRC })) {
    const { WALK }: { readonly WALK?: WalkOf } = await import(join(SRC, file));

    if (WALK === undefined) throw new Error(`src/${file} exports no WALK`);

    if (found.has(WALK.part)) throw new Error(`two walk.ts name the part ${WALK.part}`);
    found.set(WALK.part, WALK);
  }

  return found;
}

const WALKS = await walksFound();

function walkOf(id: string): WalkOf {
  const walk = WALKS.get(id);

  if (walk === undefined) {
    throw new Error(
      `the part ${id} has no walk.ts: the proof of the table reads each part's region through the WALK of its folder (WalkOf)`,
    );
  }

  return walk;
}

export const PARTS: readonly Part[] = serverExtensions.flatMap(({ id, workflow }) =>
  workflow === undefined ? [] : [{ id, workflow, walk: walkOf(id) }],
);

const DIR = parseWipDir("plans/2026-09-26/wip-4c2a9d93/");

if (!DIR.ok) throw new Error(DIR.error);

const WORKDIR = DIR.value;

/** The table as the server assembles it: the review's part, then each part's in the registry's order. */
export function tableFor(parts: readonly Part[]): Table {
  return tableOf([REVIEW_PART, ...parts.map(({ workflow }) => workflow)]);
}

/** A workflow where nothing is written yet: drafting, no `plan.md`, each part's empty region. */
export function emptyFor(parts: readonly Part[], dir = WORKDIR): Workflow {
  return {
    workspace: { kind: "drafting", dir, batches: 0 },
    planText: "absent",
    regions: parts.map(({ walk }) => walk.empty),
  };
}

export const TABLE: Table = tableFor(PARTS);

export const EMPTY: Workflow = emptyFor(PARTS);

/** Each part's words for its region, as the server hands them to the view. */
export const WORDINGS: readonly Wording[] = PARTS.map(({ id, workflow }) => ({
  id,
  segment: workflow.segment,
  line: workflow.line,
}));

/** The table with `input` the one sample `event` tries: what a real caller sends. */
function trying(event: string, input: EventInput): Table {
  return {
    ...TABLE,
    events: TABLE.events.map((decl) => (decl.id === event ? { ...decl, samples: [input] } : decl)),
  };
}

/** `w` as the whole table reads it: every part's region, the ones `w` lacks empty. */
export function whole(w: Workflow): Workflow {
  const regions = PARTS.map(
    ({ id, walk }) => w.regions.find((region) => region.id === id) ?? walk.empty,
  );

  return { ...w, regions };
}

/** What `refusedNow` lists of `event` on `w` when the one input tried is `input`. */
export function refusedNowWith(w: Workflow, event: string, input: EventInput): readonly Refused[] {
  return refusedNow(whole(w), trying(event, input)).filter((refused) => refused.event === event);
}

/** What `mcp__vellum__state` and the pill list of `event` on `w` when the one input tried is `input`. */
export function stateWith(w: Workflow, event: string, input: EventInput): readonly Refused[] {
  return viewOf(whole(w), trying(event, input), WORDINGS).refused.filter(
    (refused) => refused.event === event,
  );
}

/** The rows of `part` a caller meets, `"<event>: <id>"`: on a state, of an event Claude or the reviewer sends; what is refused now lists each where it applies. */
export function rowsACallerMeets(part: TablePart): readonly string[] {
  const sent = TABLE.events.filter(({ actors }) => actors.some((actor) => actor !== "engine"));

  return part.rules.flatMap(({ event, id, refuses }) =>
    refuses === "state" && sent.some((decl) => decl.id === event) ? [`${event}: ${id}`] : [],
  );
}

/** The texts a step tells Claude through the channel, in order. */
export function told(step: Step): string[] {
  return step.effects.flatMap((effect) =>
    effect.kind === "channel" && effect.entry.kind === "text" ? [effect.entry.text] : [],
  );
}

export function returned(step: Step): Extract<Effect, { kind: "returnToCall" }>[] {
  return step.effects.flatMap((effect) => (effect.kind === "returnToCall" ? [effect] : []));
}

/** What every walk checks, whatever its parts; each part adds its own (`WalkOf.invariants`). */
export const CORE_INVARIANTS = [
  "heldDraftIsShown",
  "approvalClosesEverything",
  "noticeOnceTheLastHoldFalls",
  "answerReachesClaudeOnce",
] as const;

/** Every invariant a walk checks: the core's, then each part's, by name. */
export const INVARIANTS: readonly string[] = [
  ...CORE_INVARIANTS,
  ...PARTS.flatMap(({ walk }) => Object.keys(walk.invariants ?? {})),
];

/** The cases the invariants speak of, each of which some walk must reach. */
const CASES = [
  "heldDraft",
  "approvedOverOpen",
  "returned",
  "prompted",
  "notices",
  "pausedWaits",
  "planGoneInReview",
] as const;

type Case = (typeof CASES)[number];

export type Walked = {
  /** Every state each walk reached, in the order it reached them: the parts alone, then the pairs. */
  readonly states: readonly Workflow[];
  readonly steps: number;
  /** Up to three cases of each invariant broken, by name. */
  readonly violations: Readonly<Record<string, readonly string[]>>;
  readonly reached: Readonly<Record<Case, number>>;
  /** Each walk by its parts' ids. */
  readonly walks: readonly string[];
};

type Walker = {
  readonly parts: readonly Part[];
  readonly table: Table;
  readonly empty: Workflow;
};

function walkerOf(parts: readonly Part[]): Walker {
  return { parts, table: tableFor(parts), empty: emptyFor(parts) };
}

function partOf(walker: Walker, region: Region): Part {
  const part = walker.parts.find(({ id }) => id === region.id);

  if (part === undefined) throw new Error(`no part of the walk holds the region ${region.id}`);

  return part;
}

const keys = new WeakMap<Workflow | Region, string>();

function cached(of: Workflow | Region, make: () => string): string {
  const known = keys.get(of);

  if (known !== undefined) return known;
  const made = make();
  keys.set(of, made);

  return made;
}

/**
 * A state as the invariants tell it apart: the workspace, `plan.md`, and each region by its state,
 * its hold and wait, and what its part says of it. Counters the invariants never read (the Sends
 * on a version) are left out, so the walk ends. Cached by identity: a step leaves every region it
 * does not touch as it was.
 */
function keyOf(walker: Walker, w: Workflow): string {
  return cached(w, () => {
    const { workspace } = w;
    const version = workspace.kind === "drafting" ? 0 : workspace.version;
    const sent = workspace.kind !== "approved" && workspace.batches > 0;

    const regions = w.regions.map((region) =>
      cached(region, () => {
        const open = region.state === "open" ? [region.holds !== null, region.wait] : [];

        return JSON.stringify([
          region.id,
          region.state,
          ...open,
          partOf(walker, region).walk.key(region),
        ]);
      }),
    );

    return JSON.stringify([workspace.kind, version, sent, w.planText, ...regions]);
  });
}

/** At most 3 versions (§ 5.10), and each region inside its part's bounds, so the walk ends. */
function bounded(walker: Walker, w: Workflow): boolean {
  const { workspace } = w;

  return (
    (workspace.kind === "drafting" || workspace.version <= 3) &&
    w.regions.every((region) => partOf(walker, region).walk.bounded?.(region) ?? true)
  );
}

function stateBroken(walker: Walker, w: Workflow): string[] {
  const hold = held(w);

  const core = [
    ...(hold !== null &&
    w.planText === "pending" &&
    pillOf(w).text !== `Held · ${hold} · plan.md waits`
      ? ["heldDraftIsShown"]
      : []),
    ...(w.workspace.kind === "approved" && w.regions.some(({ state }) => state !== "closed")
      ? ["approvalClosesEverything"]
      : []),
  ];

  const parts = walker.parts.flatMap(({ walk }) =>
    Object.entries(walk.invariants ?? {}).flatMap(([name, broken]) => (broken(w) ? [name] : [])),
  );

  return [...core, ...parts];
}

type Call = { readonly call: string; readonly wait: "open" | "paused" };

/** The wait an allowed event answers, `null` with none: the part whose wait that event answers, if its region waits. */
function answeredWait(
  walker: Walker,
  from: Workflow,
  event: string,
  input: EventInput,
): Call | null {
  for (const region of from.regions) {
    const hints = partOf(walker, region).walk;

    if (hints.answers?.(event, input) !== true) continue;

    if (region.state !== "open" || region.wait === null || hints.call === undefined) return null;

    return { call: hints.call(region), wait: region.wait };
  }

  return null;
}

function stepBroken(
  walker: Walker,
  from: Workflow,
  event: string,
  input: EventInput,
  step: Step,
): string[] {
  const lifted =
    held(from) !== null && held(step.workflow) === null && step.workflow.planText === "pending";

  const notices = told(step).filter((text) => text.startsWith("plan.md changed while")).length;
  const calls = returned(step).map(({ call }) => call);
  const channel = step.effects.findIndex(({ kind }) => kind === "channel");
  const firstCall = step.effects.findIndex(({ kind }) => kind === "returnToCall");
  const answered = step.verdict.kind === "allow" ? answeredWait(walker, from, event, input) : null;

  const once =
    new Set(calls).size === calls.length &&
    (firstCall === -1 || (channel !== -1 && channel < firstCall)) &&
    (answered === null
      ? calls.length === 0
      : answered.wait === "open"
        ? calls.length === 1 && calls[0] === answered.call && channel !== -1
        : calls.length === 0 && channel !== -1);

  return [
    ...(notices === (lifted ? 1 : 0) ? [] : ["noticeOnceTheLastHoldFalls"]),
    ...(once ? [] : ["answerReachesClaudeOnce"]),
  ];
}

type Tally = {
  readonly states: Workflow[];
  steps: number;
  readonly violations: Record<string, string[]>;
  readonly reached: Record<Case, number>;
};

function tried(walker: Walker, w: Workflow, event: string, input: EventInput): Step {
  return next(w, walker.table, event, input, "engine");
}

/** Breadth first from the walk's empty workflow, every event with every sample, and a confirmation asked, confirmed. */
function walkInto(walker: Walker, tally: Tally): void {
  const seen = new Set([keyOf(walker, walker.empty)]);
  const queue = [walker.empty];

  const broke = (names: readonly string[], what: string): void => {
    for (const name of names) {
      const cases = (tally.violations[name] ??= []);

      if (cases.length < 3) cases.push(what);
    }
  };

  for (let at = 0; at < queue.length; at += 1) {
    const from = queue[at] ?? walker.empty;
    tally.states.push(from);

    broke(stateBroken(walker, from), keyOf(walker, from));

    if (held(from) !== null && from.planText === "pending") tally.reached.heldDraft += 1;

    if (from.workspace.kind === "inReview" && from.planText === "absent")
      tally.reached.planGoneInReview += 1;

    if (from.regions.some((region) => region.state === "open" && region.wait === "paused"))
      tally.reached.pausedWaits += 1;

    for (const decl of walker.table.events) {
      for (const sample of decl.samples) {
        const first = tried(walker, from, decl.id, sample);

        const confirmed =
          first.verdict.kind === "confirm" ? [{ ...sample, confirmed: held(from) ?? "" }] : [];

        for (const input of [sample, ...confirmed]) {
          const step = input === sample ? first : tried(walker, from, decl.id, input);
          tally.steps += 1;
          broke(
            stepBroken(walker, from, decl.id, input, step),
            `${decl.id} ${JSON.stringify(input)} from ${keyOf(walker, from)}`,
          );
          tally.reached.returned += returned(step).length;
          tally.reached.notices += told(step).filter((text) =>
            text.startsWith("plan.md changed while"),
          ).length;

          if (
            step.verdict.kind === "allow" &&
            answeredWait(walker, from, decl.id, input)?.wait === "paused"
          )
            tally.reached.prompted += 1;

          if (
            step.workflow.workspace.kind === "approved" &&
            from.workspace.kind !== "approved" &&
            from.regions.some(({ state }) => state === "open")
          )
            tally.reached.approvedOverOpen += 1;
          const key = keyOf(walker, step.workflow);

          if (!bounded(walker, step.workflow) || seen.has(key)) continue;
          seen.add(key);
          queue.push(step.workflow);
        }
      }
    }
  }
}

/** The events a part owns, as the table reads them. */
function owns(part: Part): readonly string[] {
  return part.workflow.events.map(({ id }) => id);
}

/** Whether `one` hears an event `other` owns. */
function hears(one: Part, other: Part): boolean {
  return (one.workflow.hears ?? []).some((event) => owns(other).includes(event));
}

/** Whether a hold refuses one of the part's events. */
function heldBack(part: Part): boolean {
  return part.workflow.events.some(({ whileHeld }) => whileHeld.effect !== "allow");
}

/** Whether the part's region held the review somewhere on its walk alone. */
function holds(part: Part, states: readonly Workflow[]): boolean {
  return states.some((w) =>
    w.regions.some(
      (region) => region.id === part.id && region.state === "open" && region.holds !== null,
    ),
  );
}

/** Whether two parts meet: one hears the other's event, both hold, or one holds while the other is held back. */
function meet(one: Part, other: Part, holding: ReadonlySet<string>): boolean {
  const oneHolds = holding.has(one.id);
  const otherHolds = holding.has(other.id);

  return (
    hears(one, other) ||
    hears(other, one) ||
    (oneHolds && otherHolds) ||
    (oneHolds && heldBack(other)) ||
    (otherHolds && heldBack(one))
  );
}

let walked: Walked | null = null;

/** Each part alone, then each pair of parts that meet, in the registry's order. */
export function proof(): Walked {
  if (walked !== null) return walked;

  const tally: Tally = {
    states: [],
    steps: 0,
    violations: Object.fromEntries(INVARIANTS.map((name) => [name, []])),
    reached: {
      heldDraft: 0,
      approvedOverOpen: 0,
      returned: 0,
      prompted: 0,
      notices: 0,
      pausedWaits: 0,
      planGoneInReview: 0,
    },
  };

  const walks: string[] = [];
  const holding = new Set<string>();

  for (const part of PARTS) {
    const from = tally.states.length;
    walkInto(walkerOf([part]), tally);
    walks.push(part.id);

    if (holds(part, tally.states.slice(from))) holding.add(part.id);
  }

  for (const [at, one] of PARTS.entries()) {
    for (const other of PARTS.slice(at + 1)) {
      if (!meet(one, other, holding)) continue;
      walkInto(walkerOf([one, other]), tally);
      walks.push(`${one.id} + ${other.id}`);
    }
  }

  walked = { ...tally, walks };

  return walked;
}
