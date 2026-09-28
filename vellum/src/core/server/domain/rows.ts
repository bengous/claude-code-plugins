import type {
  Actor,
  EventDecl,
  EventInput,
  Outcome,
  RefusalStatus,
  Rule,
  TablePart,
  Transition,
  Workflow,
} from "./workflow.ts";
import { HELD } from "./workflow.ts";

/**
 * A slice's part of the table, typed by its events: who sends each, the fields its input carries,
 * the rows that refuse it, read top to bottom, and a transition per event. `tablePart` turns it
 * into the `TablePart` that `next` judges, so the core reads it as it reads the others.
 */

/** Each event a slice owns: who sends it, and the fields its input carries. */
export type Events = {
  readonly [event: string]: { readonly by: Actor; readonly carries: readonly string[] };
};

/** The events as written, their senders and fields kept as literals. */
export function events<const E extends Events>(declared: E): E {
  return declared;
}

/** What the server stamps on every event: the time, and the number its step's first entry of the channel takes. */
export type Stamps = { readonly at: string; readonly seq: string };

/** The fields `event` carries, as a route dispatches it. */
export type Sent<E extends Events, K extends keyof E> = E[K] extends {
  readonly carries: infer Fields extends readonly string[];
}
  ? { readonly [Field in Fields[number]]: string }
  : never;

/** What a row and a transition read of `event`: the fields it carries and the stamps, `""` for any the input lacks. */
export type Carried<E extends Events, K extends keyof E> = E[K] extends {
  readonly carries: infer Fields extends readonly string[];
}
  ? { readonly [Field in Fields[number] | keyof Stamps]: string }
  : never;

/**
 * A condition a row is built from, named and read in one line: it states the fields it reads, and
 * a row takes it only on an event that carries them. Its name is what a reader of the table sees.
 */
export type Guard<I> = (w: Workflow, input: I) => boolean;

/** `guard` under the name `condition`, as the table prints it. */
function named<I>(guard: Guard<I>, condition: string): Guard<I> {
  Object.defineProperty(guard, "name", { value: condition });

  return guard;
}

function conditionOf<I>(guard: Guard<I>): string {
  return guard.name === "" ? "an unnamed guard" : guard.name;
}

/** A guard's name as a part of a larger condition: parenthesised when it is itself a combination. */
function termOf<I>(guard: Guard<I>): string {
  const name = conditionOf(guard);

  return / (?:and|or) /u.test(name) ? `(${name})` : name;
}

export function allOf<I>(...guards: readonly Guard<I>[]): Guard<I> {
  return named(
    (w, input) => guards.every((guard) => guard(w, input)),
    guards.map((guard) => termOf(guard)).join(" and "),
  );
}

export function anyOf<I>(...guards: readonly Guard<I>[]): Guard<I> {
  return named(
    (w, input) => guards.some((guard) => guard(w, input)),
    guards.map((guard) => termOf(guard)).join(" or "),
  );
}

/**
 * A row that refuses `event` when its guard holds, answered with `status` by the slice's routes.
 * `refuses: "state"` is one a real caller meets, `"input"` one only an input naming what is not
 * there meets, which `refusedNow` never lists.
 */
export type RefuseRow<K extends string, Id extends string> = {
  readonly kind: "refuse";
  readonly event: K;
  readonly id: Id;
  readonly refuses: "state" | "input";
  readonly status: RefusalStatus;
  readonly reason: string;
  readonly condition: string;
  readonly when: (w: Workflow, input: EventInput) => boolean;
};

/** The hold's row: `event` is refused while the review is held, in words built from the hold's own. */
export type HeldRow<K extends string> = {
  readonly kind: "held";
  readonly event: K;
  readonly id: typeof HELD;
  readonly status: RefusalStatus;
  readonly reason: (hold: string) => string;
};

export type Row<K extends string = string, Id extends string = string> =
  | RefuseRow<K, Id>
  | HeldRow<K>;

/** `"<event>: <id>"`, one per row: what a suite keys its one test per row by. */
export type RowKey<R> =
  R extends RefuseRow<infer K, infer Id>
    ? `${K}: ${Id}`
    : R extends HeldRow<infer K>
      ? `${K}: ${typeof HELD}`
      : never;

export type Rows<E extends Events> = {
  /** Refuses `event` when `when` holds: a state a real caller meets, listed by `refusedNow`. */
  readonly refuse: <K extends keyof E & string, Id extends string>(
    event: K,
    id: Id,
    when: Guard<Carried<E, K>>,
    status: RefusalStatus,
    reason: string,
  ) => RefuseRow<K, Id>;
  /** Refuses `event` when `when` holds on an input naming what is not there: only a sample meets it. */
  readonly refuseInput: <K extends keyof E & string, Id extends string>(
    event: K,
    id: Id,
    when: Guard<Carried<E, K>>,
    status: RefusalStatus,
    reason: string,
  ) => RefuseRow<K, Id>;
  /** Refuses `event` while the review is held; an event with no such row passes a hold. */
  readonly whileHeld: <K extends keyof E & string>(
    event: K,
    status: RefusalStatus,
    reason: (hold: string) => string,
  ) => HeldRow<K>;
};

function declaredOf<E extends Events, K extends keyof E & string>(declared: E, event: K): E[K] {
  const one: E[K] | undefined = declared[event];

  if (one === undefined) throw new Error(`no event ${event} in the slice's events`);

  return one;
}

/** What `event` carries and both stamps, read off the core's input, `""` for any it lacks. */
function carried<E extends Events, K extends keyof E & string>(
  declared: E,
  event: K,
  input: EventInput,
): Carried<E, K> {
  const read = Object.fromEntries(
    [...declaredOf(declared, event).carries, "at", "seq"].map((field): [string, string] => [
      field,
      input[field] ?? "",
    ]),
  );

  // SAFETY: `read` holds a string under every field `event` carries and under both stamps, set just above.
  return read as Carried<E, K>;
}

/** The row helpers of a slice, bound to its events: a row on an event it does not own, or a guard reading a field the event does not carry, does not compile. */
export function rows<E extends Events>(declared: E): Rows<E> {
  function judged<K extends keyof E & string>(
    event: K,
    when: Guard<Carried<E, K>>,
  ): (w: Workflow, input: EventInput) => boolean {
    return (w, input) => when(w, carried(declared, event, input));
  }

  return {
    refuse: (event, id, when, status, reason) => ({
      kind: "refuse",
      event,
      id,
      refuses: "state",
      status,
      reason,
      condition: conditionOf(when),
      when: judged(event, when),
    }),
    refuseInput: (event, id, when, status, reason) => ({
      kind: "refuse",
      event,
      id,
      refuses: "input",
      status,
      reason,
      condition: conditionOf(when),
      when: judged(event, when),
    }),
    whileHeld: (event, status, reason) => ({ kind: "held", event, id: HELD, status, reason }),
  };
}

/** The inputs `refusedNow` and the walk of `workflow.spec.ts` try, per event: what its route sends, stamps given where a transition reads them. */
export type Samples<E extends Events> = {
  readonly [K in keyof E]: readonly (Sent<E, K> & Partial<Stamps>)[];
};

/** One transition per event the slice owns, reading what that event carries. */
export type Transitions<E extends Events> = {
  readonly [K in keyof E]: (w: Workflow, input: Carried<E, K>) => Outcome;
};

export type SlicePart<E extends Events> = {
  readonly events: E;
  /** Read top to bottom per event: a row above the event's hold row is judged before the hold, one below it after. */
  readonly rules: readonly Row<keyof E & string>[];
  readonly samples: Samples<E>;
  readonly transitions: Transitions<E>;
  /** Its answer to the events of the others, which it reads as the core hands them. */
  readonly reaction?: Transition;
};

function namesOf<E extends Events>(declared: E): (keyof E & string)[] {
  return Object.keys(declared).filter((name): name is keyof E & string =>
    Object.hasOwn(declared, name),
  );
}

/** The event's rows as the core orders them: the hold's at 0, a row above it negative, one below it positive. */
function rulesOf(event: string, all: readonly Row[]): readonly Rule[] {
  const own = all.filter((row) => row.event === event);
  const held = own.filter((row) => row.kind === "held");

  if (held.length > 1) throw new Error(`${event} has ${held.length} hold rows: one at most`);
  const at = held[0] === undefined ? -1 : own.indexOf(held[0]);

  return own.flatMap((row, index) =>
    row.kind === "held"
      ? []
      : [
          {
            id: row.id,
            event,
            order: index - at,
            when: row.when,
            effect: "refuse",
            refuses: row.refuses,
            reason: () => row.reason,
            status: row.status,
            condition: row.condition,
          },
        ],
  );
}

function declOf<E extends Events, K extends keyof E & string>(
  owner: string,
  part: SlicePart<E>,
  event: K,
): EventDecl {
  const held = part.rules.find((row) => row.event === event && row.kind === "held");

  return {
    id: event,
    owner,
    actors: [declaredOf(part.events, event).by],
    whileHeld:
      held?.kind === "held"
        ? { effect: "refuse", reason: held.reason, status: held.status }
        : { effect: "allow" },
    samples: part.samples[event],
  };
}

function transitionOf<E extends Events, K extends keyof E & string>(
  part: SlicePart<E>,
  event: K,
): Transition {
  const transition = part.transitions[event];

  return (w, _event, input) => transition(w, carried(part.events, event, input));
}

/** The part `next` judges: each event with its sender, hold row and samples, the rows ordered, the transitions. */
export function tablePart<E extends Events>(owner: string, part: SlicePart<E>): TablePart {
  const names = namesOf(part.events);

  return {
    events: names.map((event) => declOf(owner, part, event)),
    rules: names.flatMap((event) => rulesOf(event, part.rules)),
    transitions: Object.fromEntries(
      names.map((event): [string, Transition] => [event, transitionOf(part, event)]),
    ),
    reaction: part.reaction,
  };
}
