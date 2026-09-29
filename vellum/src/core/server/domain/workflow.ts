import type { ChannelEntry } from "./channel.ts";
import type { FinalDir, Version } from "./paths.ts";
import { parseFinalDir, parseVersion } from "./paths.ts";
import { decideOn } from "./review.ts";
import type { PlanWorkspace } from "./workspace.ts";
import {
  batchFile,
  notesFile,
  PLAN_FILE,
  projectPath,
  REVIEW_DIR,
  versionFile,
} from "./workspace.ts";

/**
 * Where a planning session stands, one value the server owns and every reader reads: the
 * workspace, `plan.md` against its last version, and each extension's region. `next` judges an
 * event against a table of rules held as data, and answers the next value with the effects that
 * make it true; it writes nothing, and the core names no extension: each one brings its events,
 * rules, transitions and reaction, and the table is assembled from outside.
 */

/** `plan.md` against the last version: its text (`none`), a text no version holds yet (`pending`, any `plan.md` while drafting), or no `plan.md` (`absent`). */
export type PlanText = "none" | "pending" | "absent";

/** A call of Claude's waits on the region (`open`), or none does and an answer reaches Claude as a prompt (`paused`). */
export type Wait = "open" | "paused";

/** What an extension keeps of its files in its region, for its own transitions to read back. */
export type RegionData = Readonly<Record<string, string | number>>;

/**
 * An extension's part of the workflow, open or closed. Open, it may hold the review, for a reason
 * that reads `<what> is <how>`, which the notice puts in the past, and a call of Claude's may wait
 * on it. Closed keeps its data too: the next grill's number, a review's last run.
 */
export type Region =
  | { readonly id: string; readonly state: "closed"; readonly data: RegionData }
  | {
      readonly id: string;
      readonly state: "open";
      readonly holds: string | null;
      readonly wait: Wait | null;
      readonly data: RegionData;
    };

export type Workflow = {
  readonly workspace: PlanWorkspace;
  readonly planText: PlanText;
  readonly regions: readonly Region[];
};

export type Actor = "claude" | "reviewer" | "engine";

/**
 * Plain values read before the event is judged: `next` reads no clock, no file, and mints no id.
 * The server stamps two on every event, `at` (the time) and `seq` (the number the step's first
 * entry of the channel takes); the route adds what it read.
 */
export type EventInput = Readonly<Record<string, string>>;

/** The HTTP status a slice's route answers a refusal with: a name that is not there, or a state that refuses. */
export type RefusalStatus = 404 | 409;

/** What the hold's rule does to an event: nothing, or it refuses it or asks a confirmation, in the event's words. */
export type WhileHeld =
  | { readonly effect: "allow" }
  | {
      readonly effect: "refuse" | "confirm";
      readonly reason: (hold: string) => string;
      /** What a slice's route answers it with; a slice's event alone declares one. */
      readonly status?: RefusalStatus;
    };

export type EventDecl = {
  readonly id: string;
  /** `core`, or the id of the extension whose transition applies it. */
  readonly owner: string;
  /** Who sends it (§ 5.3): what only the engine sends is nobody's to try, and the view leaves it out. */
  readonly actors: readonly Actor[];
  readonly whileHeld: WhileHeld;
  /** Whether a hold the event ends ended without a verdict, which the notice says; with one when not given. */
  readonly endsWithoutVerdict?: (input: EventInput) => boolean;
  /** The inputs `refusedNow` and the walk of `workflow.spec.ts` try. */
  readonly samples: readonly EventInput[];
};

export type Rule = {
  readonly id: string;
  readonly event: string;
  /** Its place against the hold's rule, which is 0, as today's code checks them: negative before, positive after. */
  readonly order: number;
  readonly when: (w: Workflow, input: EventInput) => boolean;
  readonly effect: "refuse" | "confirm";
  /**
   * What the row turns down: the state, which a real caller meets; or the input alone, one that
   * names what is not there (a run, a proposal, a version no longer under review) or is malformed,
   * which only a sample sends: `refusedNow` lists no event on its account.
   */
  readonly refuses: "state" | "input";
  readonly reason: (w: Workflow, input: EventInput) => string;
  /** What a slice's route answers it with; a slice's row alone declares one. */
  readonly status?: RefusalStatus;
  /** The named guards `when` is built from, for a reader; a slice's row alone names them. */
  readonly condition?: string;
};

export type RuleVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "refuse" | "confirm"; readonly rule: string; readonly reason: string };

/** Where every event judged is observed, one line each: the workflow is never rebuilt from it (D11). */
export const JOURNAL_FILE = `${REVIEW_DIR}/events.jsonl`;

/** A line of `.review/events.jsonl` as `next` judged it; the interpreter stamps its `at` as it appends it. */
export type JournalLine = {
  readonly actor: Actor;
  readonly event: string;
  readonly input: EventInput;
  readonly verdict: RuleVerdict["kind"];
  readonly rule?: string;
  readonly reason?: string;
};

/**
 * What the interpreter runs, in order. A file is named under the plan's directory, resolved at the
 * write, since the approval moves it. `returnToCall` hands a waiting call the answer and claims the
 * channel entry its step appended before it, which then reaches Claude as that call's result only.
 */
export type Effect =
  | { readonly kind: "recordVersion" }
  | {
      readonly kind: "writeFile";
      readonly owner: string;
      readonly file: string;
      readonly text: string;
    }
  | {
      readonly kind: "appendFile";
      readonly owner: string;
      readonly file: string;
      readonly text: string;
    }
  | { readonly kind: "channel"; readonly entry: ChannelEntry }
  | { readonly kind: "returnToCall"; readonly call: string; readonly text: string }
  | { readonly kind: "approveDirectory"; readonly dir: FinalDir; readonly notes: string | null }
  | { readonly kind: "journal"; readonly line: JournalLine };

export type Outcome = { readonly workflow: Workflow; readonly effects: readonly Effect[] };

export type Transition = (w: Workflow, event: string, input: EventInput) => Outcome;

/** What the core and each extension bring to the table. */
export type TablePart = {
  readonly events: readonly EventDecl[];
  readonly rules: readonly Rule[];
  readonly transitions: Readonly<Record<string, Transition>>;
  /** Its answer to the events of the others. */
  readonly reaction?: Transition | undefined;
  /** The events of the others it judges or reacts to, when it says them: a slice's declaration does. */
  readonly hears?: readonly string[];
};

export type Table = {
  readonly events: readonly EventDecl[];
  readonly rules: readonly Rule[];
  readonly transitions: Readonly<Record<string, Transition>>;
  /** Each extension's answer to the events of the others, in the registry's order. */
  readonly reactions: readonly Transition[];
};

export type Step = {
  readonly verdict: RuleVerdict;
  readonly workflow: Workflow;
  readonly effects: readonly Effect[];
};

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

/** The journal's line for `line`, judged at `at`. */
export function journalText(line: JournalLine, at: Date): string {
  return `${JSON.stringify({ at: at.toISOString(), ...line })}\n`;
}

/** The owner of the core's events, and the voice of its own entries in the channel. */
export const CORE = "core";

const ALLOW: RuleVerdict = { kind: "allow" };

/** The one rule the core applies before any row: an approved plan takes no event (R11). */
const APPROVED = "approved";

/** The id of the hold's rule, which every event the hold refuses or asks to confirm meets. */
export const HELD = "held";

/** What the transitions leave as it is. */
export function unchanged(w: Workflow): Outcome {
  return { workflow: w, effects: [] };
}

/** The region an extension's transition works on; a table that lacks it was assembled wrong. */
export function regionIn(w: Workflow, id: string): Region {
  const region = w.regions.find((one) => one.id === id);

  if (region === undefined) throw new Error(`the workflow holds no region ${id}`);

  return region;
}

/** The workflow with `region` in the place of the one of its id. */
export function withRegion(w: Workflow, region: Region): Workflow {
  return { ...w, regions: w.regions.map((one) => (one.id === region.id ? region : one)) };
}

/** What holds the review: the reason of the first region that holds it, in the registry's order. */
export function held(w: Workflow): string | null {
  for (const region of w.regions) {
    if (region.state === "open" && region.holds !== null) return region.holds;
  }

  return null;
}

/** Whether `plan.md` is there, in drafting as in review. */
export function planExists(w: Workflow): boolean {
  return w.planText !== "absent";
}

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

function declOf(table: Table, event: string): EventDecl {
  const decl = table.events.find((one) => one.id === event);

  if (decl === undefined) throw new Error(`no event ${event} in the table`);

  return decl;
}

function holdRule(decl: EventDecl, hold: string | null): readonly Rule[] {
  const { whileHeld } = decl;

  if (hold === null || whileHeld.effect === "allow") return [];

  return [
    {
      id: HELD,
      event: decl.id,
      order: 0,
      when: () => true,
      effect: whileHeld.effect,
      refuses: "state",
      reason: () => whileHeld.reason(hold),
    },
  ];
}

function verdictOfRule(rule: Rule, w: Workflow, input: EventInput): RuleVerdict {
  return { kind: rule.effect, rule: rule.id, reason: rule.reason(w, input) };
}

/**
 * The verdict alone, nothing applied: an approved plan refuses every event; then the event's rows
 * and the hold's rule in today's order, the first refusal winning, else the first confirmation,
 * which passes once `input.confirmed` names the hold it was asked under.
 */
export function verdictOf(
  w: Workflow,
  table: Table,
  event: string,
  input: EventInput,
): RuleVerdict {
  const decl = declOf(table, event);

  if (w.workspace.kind === "approved") {
    const reason =
      event === "record"
        ? `plan v${w.workspace.version} is already approved`
        : "the plan is approved";

    return { kind: "refuse", rule: APPROVED, reason };
  }

  const hold = held(w);

  const fired = [...table.rules.filter((rule) => rule.event === event), ...holdRule(decl, hold)]
    .toSorted((a, b) => a.order - b.order)
    .filter((rule) => rule.when(w, input));

  const refused = fired.find((rule) => rule.effect === "refuse");

  if (refused !== undefined) return verdictOfRule(refused, w, input);
  const asked = fired.find((rule) => rule.effect === "confirm");

  return asked === undefined || (hold !== null && input.confirmed === hold)
    ? ALLOW
    : verdictOfRule(asked, w, input);
}

function lineOf(actor: Actor, event: string, input: EventInput, verdict: RuleVerdict): JournalLine {
  return verdict.kind === "allow"
    ? { actor, event, input, verdict: verdict.kind }
    : { actor, event, input, verdict: verdict.kind, rule: verdict.rule, reason: verdict.reason };
}

/** The approval's entry closes its step, after every extension closed what it held (`approve()`'s order). */
function approvalOf(before: Workflow, after: Workflow): readonly Effect[] {
  const { workspace } = after;

  if (before.workspace.kind === "approved" || workspace.kind !== "approved") return [];
  const { version, dir } = workspace;
  const notes = workspace.notes ? projectPath(`${dir}${notesFile(version)}`) : null;

  return [{ kind: "channel", entry: { kind: "approved", version, dir, notes } }];
}

/** A hold's reason in the past: `grill 1 is open` was open once it ended. */
function pastOf(hold: string): string {
  return hold.replace(" is ", " was ");
}

/**
 * The notice: the step that lifts the last hold while `plan.md` waits tells Claude once, and the
 * end of its next turn records the version (P7, P9).
 */
function noticeOf(
  before: Workflow,
  after: Workflow,
  decl: EventDecl,
  input: EventInput,
): readonly Effect[] {
  const hold = held(before);

  if (hold === null || held(after) !== null || after.planText !== "pending") return [];
  const past = pastOf(hold);

  const text =
    decl.endsWithoutVerdict?.(input) === true
      ? `plan.md changed while ${past}, which ended without a verdict: check plan.md, then end your turn.`
      : `plan.md changed while ${past}: integrate what it settled, then end your turn.`;

  return [{ kind: "channel", entry: { kind: "text", from: CORE, text } }];
}

/**
 * Judges `event`; allowed, applies its owner's transition, then each extension's reaction, then
 * the approval's entry and the notice, if the step makes them. The journal line comes last, and
 * comes for a refused event too.
 */
export function next(
  w: Workflow,
  table: Table,
  event: string,
  input: EventInput,
  actor: Actor,
): Step {
  const verdict = verdictOf(w, table, event, input);
  const journal: Effect = { kind: "journal", line: lineOf(actor, event, input, verdict) };

  if (verdict.kind !== "allow") return { verdict, workflow: w, effects: [journal] };
  const transition = table.transitions[event];

  if (transition === undefined) throw new Error(`no transition for ${event} in the table`);
  let outcome = transition(w, event, input);

  for (const reaction of table.reactions) {
    const reacted = reaction(outcome.workflow, event, input);
    outcome = { workflow: reacted.workflow, effects: [...outcome.effects, ...reacted.effects] };
  }

  const after = outcome.workflow;

  const effects = [
    ...outcome.effects,
    ...approvalOf(w, after),
    ...noticeOf(w, after, declOf(table, event), input),
    journal,
  ];

  return { verdict, workflow: after, effects };
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

function versionAfter(workspace: PlanWorkspace): Version {
  const after = parseVersion(workspace.kind === "drafting" ? 1 : workspace.version + 1);

  if (!after.ok) throw new Error(after.error);

  return after.value;
}

/** The version under review, for a row whose earlier rows refused every other workspace. */
export function reviewed(w: Workflow): Version {
  if (w.workspace.kind !== "inReview") throw new Error("no version is under review");

  return w.workspace.version;
}

/** The version a Send's or an approval's edit names, `""` for none, is no longer under review. */
function isStale(w: Workflow, edit: string): boolean {
  const { workspace } = w;

  return edit !== "" && (workspace.kind !== "inReview" || edit !== String(workspace.version));
}

function writeFile(file: string, text: string): Effect {
  return { kind: "writeFile", owner: CORE, file, text };
}

const STALE = "your edit is of a version no longer under review";

/** The one sample time of the table: a transition that stamps a file reads it from its input. */
export const SAMPLE_AT = "2026-09-26T10:00:00.000Z";

export const CORE_EVENTS: readonly EventDecl[] = [
  {
    id: "record",
    owner: CORE,
    actors: ["claude", "reviewer"],
    whileHeld: {
      effect: "refuse",
      reason: (hold) => `${hold}: plan.md waits; you are told when it ends`,
    },
    samples: [{ unchanged: "keep" }, { unchanged: "record" }],
  },
  {
    id: "sendEdit",
    owner: CORE,
    actors: ["reviewer"],
    whileHeld: {
      effect: "refuse",
      reason: (hold) => `${hold}: the edit waits in the draft until it ends`,
    },
    samples: [
      { edit: "1", text: "# Plan\n\nThe reviewer's edit.\n" },
      { edit: "2", text: "# Plan\n\nThe reviewer's edit.\n" },
    ],
  },
  {
    id: "send",
    owner: CORE,
    actors: ["reviewer"],
    whileHeld: { effect: "allow" },
    samples: [
      { parts: "true", edit: "", names: "held", comments: "false", text: "## Grill\n" },
      { parts: "false", edit: "", names: "held", comments: "true", text: "## Comments\n" },
      { parts: "false", edit: "", names: "changed", comments: "true", text: "## Comments\n" },
      { parts: "false", edit: "", names: "withoutEdit", comments: "true", text: "## Comments\n" },
      { parts: "false", edit: "1", names: "held", comments: "true", text: "## Comments\n" },
    ],
  },
  {
    id: "approve",
    owner: CORE,
    actors: ["reviewer"],
    whileHeld: { effect: "confirm", reason: (hold) => `The review is held: ${hold}.` },
    samples: [
      {
        confirmed: "",
        edit: "",
        text: "",
        notes: "",
        dir: "plans/2026-09-26/the-plan/",
        at: SAMPLE_AT,
      },
      {
        confirmed: "",
        edit: "1",
        text: "# Plan\n\nApproved as edited.\n",
        notes: "Ship it.",
        dir: "plans/2026-09-26/the-plan/",
        at: SAMPLE_AT,
      },
    ],
  },
  {
    id: "planWritten",
    owner: CORE,
    actors: ["claude"],
    whileHeld: { effect: "allow" },
    samples: [{ plan: "pending" }, { plan: "none" }, { plan: "absent" }],
  },
];

export const CORE_RULES: readonly Rule[] = [
  {
    id: "no-plan",
    event: "record",
    order: 1,
    when: (w) => !planExists(w),
    effect: "refuse",
    refuses: "state",
    reason: (w) => `write ${PLAN_FILE} in ${w.workspace.dir} first`,
  },
  {
    id: "stale",
    event: "sendEdit",
    order: -1,
    when: (w, input) => isStale(w, input.edit ?? ""),
    effect: "refuse",
    refuses: "input",
    reason: () => STALE,
  },
  {
    id: "changed",
    event: "send",
    order: 1,
    when: (_w, input) => input.names === "changed",
    effect: "refuse",
    refuses: "input",
    reason: () => "the saved draft no longer holds what you sent, changed in another tab",
  },
  {
    id: "stale",
    event: "send",
    order: 2,
    when: (w, input) => isStale(w, input.edit ?? ""),
    effect: "refuse",
    refuses: "input",
    reason: () => STALE,
  },
  {
    id: "edit",
    event: "send",
    order: 3,
    when: (w, input) =>
      w.workspace.kind === "inReview" && (input.edit ?? "") === "" && input.names === "withoutEdit",
    effect: "refuse",
    refuses: "input",
    reason: () => "a comment on the plan goes with your edit",
  },
  {
    id: "no-version",
    event: "approve",
    order: 1,
    when: (w) => w.workspace.kind === "drafting",
    effect: "refuse",
    refuses: "state",
    reason: () => "no version is under review yet",
  },
  {
    id: "approve-stale",
    event: "approve",
    order: 2,
    when: (w, input) => isStale(w, input.edit ?? ""),
    effect: "refuse",
    refuses: "input",
    reason: (w, input) => `v${reviewed(w)} is under review, not v${input.edit ?? ""}`,
  },
  {
    id: "approve-draft",
    event: "approve",
    order: 3,
    when: (w) => w.workspace.kind === "inReview" && w.planText === "pending",
    effect: "refuse",
    refuses: "state",
    reason: (w) => {
      const since = `plan.md changed since v${reviewed(w)}`;
      const hold = held(w);

      return hold === null
        ? `${since}: record it before approving`
        : `${since} while ${hold}: end it, then record plan.md before approving`;
    },
  },
];

/** `gateVersion`'s logic: a text the version lacks, or a Send on it, records the next one; `keep` never records the same text. */
function record(w: Workflow, _event: string, input: EventInput): Outcome {
  const { workspace } = w;

  if (workspace.kind === "approved") return unchanged(w);

  const kept =
    workspace.kind === "inReview" &&
    w.planText === "none" &&
    (input.unchanged === "keep" || workspace.batches === 0);

  if (kept) return unchanged(w);

  const recorded: PlanWorkspace = {
    kind: "inReview",
    dir: workspace.dir,
    version: versionAfter(workspace),
    batches: 0,
    finalizeError: null,
  };

  return {
    workflow: { ...w, planText: "none", workspace: recorded },
    effects: [{ kind: "recordVersion" }],
  };
}

/** The reviewer's edit is the next version, `plan.md` first, as a Send writes it. */
function sendEdit(w: Workflow, _event: string, input: EventInput): Outcome {
  const { workspace } = w;

  if (workspace.kind !== "inReview") return unchanged(w);
  const version = versionAfter(workspace);
  const text = input.text ?? "";

  return {
    workflow: { ...w, planText: "none", workspace: { ...workspace, version, batches: 0 } },
    effects: [writeFile(PLAN_FILE, text), writeFile(versionFile(version), text)],
  };
}

/** The batch, numbered after the Sends on its version, then its entry: the Send's commit point. */
function send(w: Workflow, _event: string, input: EventInput): Outcome {
  const { workspace } = w;

  if (workspace.kind === "approved") return unchanged(w);
  const version = workspace.kind === "drafting" ? null : workspace.version;
  const batches = workspace.batches + 1;
  const file = batchFile(version, batches);
  const sent: ChannelEntry = { kind: "sent", file: projectPath(`${workspace.dir}${file}`) };

  return {
    workflow: { ...w, workspace: { ...workspace, batches } },
    effects: [writeFile(file, input.text ?? ""), { kind: "channel", entry: sent }],
  };
}

/**
 * The reviewer's edit as the next version, then the directory approved under the name the route
 * resolved (`input.dir`); the extensions close theirs by reaction, and the entry comes last. It
 * names the notes file this approval writes, or the one a first attempt left (`input.noted`).
 */
function approve(w: Workflow, _event: string, input: EventInput): Outcome {
  const { workspace } = w;

  if (workspace.kind !== "inReview") return unchanged(w);
  const text = input.text ?? "";
  const edit = (input.edit ?? "") === "" ? null : { version: workspace.version, text };
  const decided = decideOn(workspace, null, { kind: "approve", edit, notes: input.notes ?? "" });
  const dir = parseFinalDir(input.dir ?? "");

  if (decided.kind === "refused") throw new Error("an approval the rows passed was refused");

  if (!dir.ok) throw new Error(dir.error);
  const { version, notes } = decided;

  const edited =
    decided.edit === null
      ? []
      : [writeFile(PLAN_FILE, text), writeFile(versionFile(version), text)];

  const approved: PlanWorkspace = {
    kind: "approved",
    dir: dir.value,
    version,
    notes: notes !== null || input.noted === "true",
  };

  return {
    workflow: { ...w, planText: "none", workspace: approved },
    effects: [...edited, { kind: "approveDirectory", dir: dir.value, notes: notes?.text ?? null }],
  };
}

function planTextIn(input: EventInput): PlanText {
  const { plan } = input;

  if (plan === "none" || plan === "pending" || plan === "absent") return plan;

  throw new Error(`planWritten carries none, pending or absent, not ${plan ?? "nothing"}`);
}

/** What the watcher read of `plan.md` against the last version. */
function planWritten(w: Workflow, _event: string, input: EventInput): Outcome {
  return { workflow: { ...w, planText: planTextIn(input) }, effects: [] };
}

export const CORE_TRANSITIONS = {
  record,
  sendEdit,
  send,
  approve,
  planWritten,
} satisfies Readonly<Record<string, Transition>>;

export const CORE_PART: TablePart = {
  events: CORE_EVENTS,
  rules: CORE_RULES,
  transitions: CORE_TRANSITIONS,
};

/** The core's part first, then each extension's in the registry's order. */
export function tableOf(parts: readonly TablePart[]): Table {
  const all = [CORE_PART, ...parts];
  const owners = new Map<string, string>();

  for (const { id, owner } of all.flatMap(({ events }) => events)) {
    const first = owners.get(id);

    if (first !== undefined) throw new Error(`${id} is declared by both ${first} and ${owner}`);
    owners.set(id, owner);
  }

  return {
    events: all.flatMap(({ events }) => events),
    rules: all.flatMap(({ rules }) => rules),
    transitions: Object.fromEntries(all.flatMap(({ transitions }) => Object.entries(transitions))),
    reactions: all.flatMap(({ reaction }) => (reaction === undefined ? [] : [reaction])),
  };
}
