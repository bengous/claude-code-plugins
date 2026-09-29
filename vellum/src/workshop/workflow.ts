import type { ChannelEntry } from "./channel.ts";
import type { FinalDir, Version } from "./paths.ts";
import type { PlanWorkspace } from "./workspace.ts";
import { notesFile, projectPath, REVIEW_DIR } from "./workspace.ts";

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

/** The HTTP status a route answers a refusal with: a name that is not there, or a state that refuses. */
export type RefusalStatus = 404 | 409;

/** What the hold's rule does to an event: nothing, or it refuses it or asks a confirmation, in the event's words. */
export type WhileHeld =
  | { readonly effect: "allow" }
  | {
      readonly effect: "refuse" | "confirm";
      readonly reason: (hold: string) => string;
      /** What its owner's route answers it with. */
      readonly status?: RefusalStatus;
    };

export type EventDecl = {
  readonly id: string;
  /** The id of the part whose transition applies it: `review`, or a slice's. */
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
  /** What its owner's route answers it with. */
  readonly status?: RefusalStatus;
  /** The named guards `when` is built from, for a reader. */
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

/** What the review and each part bring to the table. */
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

/** The journal's line for `line`, judged at `at`. */
export function journalText(line: JournalLine, at: Date): string {
  return `${JSON.stringify({ at: at.toISOString(), ...line })}\n`;
}

/** The voice of the machine's own entries in the channel: a hold that ended while `plan.md` changed. */
export const CORE = "core";

const ALLOW: RuleVerdict = { kind: "allow" };

/** The one rule the core applies before any row: an approved plan takes no event (R11). */
export const APPROVED = "approved";

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

export function declOf(table: Table, event: string): EventDecl {
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

/** The version under review, for a row whose earlier rows refused every other workspace. */
export function reviewed(w: Workflow): Version {
  if (w.workspace.kind !== "inReview") throw new Error("no version is under review");

  return w.workspace.version;
}

/** The one sample time of the table: a transition that stamps a file reads it from its input. */
export const SAMPLE_AT = "2026-09-26T10:00:00.000Z";

/** The parts in the order the runtime hands them, the review's first: its rows, then each part's in the registry's order. */
export function tableOf(parts: readonly TablePart[]): Table {
  const all = parts;
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
