import type {
  EventInput,
  PlanText,
  Region,
  RuleVerdict,
  Table,
  Wait,
  Workflow,
} from "./workflow.ts";
import { APPROVED, declOf, HELD, held, regionIn, verdictOf } from "./workflow.ts";
import type { PlanWorkspace } from "./workspace.ts";

/**
 * The workflow as a reader takes it: what is refused now, each region in its part's words, the
 * pill, and the stage the band draws. Read off the table and the workflow `next` answered; it
 * decides nothing.
 */

export type Refused = {
  readonly event: string;
  readonly input: EventInput;
  readonly effect: "refuse" | "confirm";
  readonly reason: string;
};

export type Pill = { readonly text: string; readonly tone: "neutral" | "ok" | "err" };

/**
 * A region as a reader takes it: its state, what it holds and what waits on it, and its line in
 * its extension's words, never the files its data keeps.
 */
export type RegionView =
  | { readonly id: string; readonly state: "closed"; readonly line: string }
  | {
      readonly id: string;
      readonly state: "open";
      readonly holds: string | null;
      readonly wait: Wait | null;
      readonly line: string;
    };

/** The workflow as a reader takes it: what `plan.md` is, what holds, each region, what is refused now, the pill. */
export type WorkflowView = {
  readonly planText: PlanText;
  readonly held: string | null;
  readonly regions: readonly RegionView[];
  readonly refused: readonly Refused[];
  readonly pill: Pill;
};

/**
 * Where the review stands for the band above the prompt, ready-made, since the hooks module
 * imports nothing of the server: the pill, and the plan's segment, then each extension's.
 */
export type Stage = {
  readonly workspace: PlanWorkspace;
  readonly pill: Pill;
  readonly segments: readonly string[];
};

/** How an extension words its region: its segment of the band, `null` for none, and its line in the view. */
export type Wording = {
  readonly id: string;
  readonly segment: (region: Region) => string | null;
  readonly line: (region: Region) => string;
};

/** The pill: a hold first, in drafting as in review, with `plan.md` waiting under it; else today's words. */
export function pillOf(w: Workflow): Pill {
  const { workspace } = w;
  const hold = held(w);

  if (workspace.kind === "approved") return { text: "Approved", tone: "ok" };

  if (hold !== null) {
    const waits = w.planText === "pending" ? " · plan.md waits" : "";

    return { text: `Held · ${hold}${waits}`, tone: "neutral" };
  }

  if (workspace.kind === "drafting") {
    const sent = workspace.batches === 0 ? "" : ` · ${workspace.batches} sent`;

    return { text: `Drafting${sent}`, tone: "neutral" };
  }

  if (workspace.finalizeError !== null) return { text: "Approval failed", tone: "err" };
  const sent = workspace.batches === 0 ? "" : ` · ${workspace.batches} sent`;

  return { text: `In review${sent}`, tone: "neutral" };
}

/** A refusal a real caller meets: the approval, the hold, or a row that turns the state down. */
function met(table: Table, event: string, verdict: RuleVerdict): boolean {
  if (verdict.kind === "allow") return false;

  if (verdict.rule === APPROVED || verdict.rule === HELD) return true;
  const row = table.rules.find((rule) => rule.event === event && rule.id === verdict.rule);

  if (row === undefined) throw new Error(`no row ${verdict.rule} of ${event} in the table`);

  return row.refuses === "state";
}

/**
 * Every event no sample of which passes now, once, in the words of the first sample a real caller
 * would meet: what the pill opens on, and what `mcp__vellum__state` lists. An event one sample
 * passes is not refused, and one that only rows of the input refuse is not either: nobody sends
 * that input, and nothing it names is there to try.
 */
export function refusedNow(w: Workflow, table: Table): readonly Refused[] {
  return table.events.flatMap((decl) => {
    const judged = decl.samples.map((input) => ({
      input,
      verdict: verdictOf(w, table, decl.id, input),
    }));

    if (judged.some(({ verdict }) => verdict.kind === "allow")) return [];
    const first = judged.find(({ verdict }) => met(table, decl.id, verdict));

    return first === undefined || first.verdict.kind === "allow"
      ? []
      : [
          {
            event: decl.id,
            input: first.input,
            effect: first.verdict.kind,
            reason: first.verdict.reason,
          },
        ];
  });
}

function regionView(region: Region, line: string): RegionView {
  const { id } = region;

  return region.state === "closed"
    ? { id, state: "closed", line }
    : { id, state: "open", holds: region.holds, wait: region.wait, line };
}

/** What only the engine sends names what the engine read, a run or a proposal: nobody reading can try it. */
function tried(table: Table, refused: Refused): boolean {
  return declOf(table, refused.event).actors.some((actor) => actor !== "engine");
}

/** The view: each region with the line its extension words, in the registry's order. */
export function viewOf(w: Workflow, table: Table, extensions: readonly Wording[]): WorkflowView {
  return {
    planText: w.planText,
    held: held(w),
    regions: extensions.map(({ id, line }) => {
      const region = regionIn(w, id);

      return regionView(region, line(region));
    }),
    refused: refusedNow(w, table).filter((refused) => tried(table, refused)),
    pill: pillOf(w),
  };
}

function planSegmentOf(workspace: PlanWorkspace): string {
  switch (workspace.kind) {
    case "drafting":
      return "plan draft";
    case "inReview":
      return `plan v${workspace.version} · in review`;
    case "approved":
      return `plan v${workspace.version} · approved`;
  }
}

/** The stage: the plan's segment first, then each extension's in the registry's order; `null` says nothing. */
export function stageOf(w: Workflow, extensions: readonly Wording[]): Stage {
  const segments = extensions.flatMap(({ id, segment }) => segment(regionIn(w, id)) ?? []);

  return {
    workspace: w.workspace,
    pill: pillOf(w),
    segments: [planSegmentOf(w.workspace), ...segments],
  };
}
