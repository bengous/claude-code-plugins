import type {
  Actor,
  CORE_TRANSITIONS,
  EventDecl,
  EventInput,
  Outcome,
  RefusalStatus,
  Rule,
  TablePart,
  Transition,
  Workflow,
} from "./workflow.ts";
import { HELD, unchanged } from "./workflow.ts";

/**
 * A slice's part of the table, typed by its events: who sends each, the fields its input carries,
 * the rows that refuse it, read top to bottom, and a transition per event; the events of the
 * others it judges or reacts to, typed by what their owner says they carry. `tablePart` turns it
 * into the `TablePart` that `next` judges, so the core reads it as it reads the others.
 */

/** Each event a slice owns: who may send it, one or several, and the fields its input carries. */
export type Events = {
  readonly [event: string]: {
    readonly by: readonly [Actor, ...Actor[]];
    readonly carries: readonly string[];
  };
};

/** The events as written, their senders and fields kept as literals. */
export function events<const E extends Events>(declared: E): E {
  return declared;
}

/** An event another part owns that the slice judges or reacts to: the fields that part says it carries. */
export type Heard = { readonly [event: string]: { readonly carries: readonly string[] } };

/** The core's own events, by name. */
export type CoreEvent = keyof typeof CORE_TRANSITIONS;

/** Core events a slice hears: named, their fields untyped, since the core declares none. */
export type CoreHeard<K extends CoreEvent> = {
  readonly [Event in K]: { readonly carries: readonly string[] };
};

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

/** What a slice reads of an event it hears: the fields its owner says it carries and the stamps, any of them possibly absent. */
export type Read<H extends Heard, K extends keyof H> = {
  readonly [Field in H[K]["carries"][number] | keyof Stamps]?: string;
};

/** The sender a route names when it dispatches `event`: none when the event has one, which it takes. */
export type Sender<E extends Events, K extends keyof E> = E[K]["by"] extends readonly [Actor]
  ? []
  : [by: E[K]["by"][number]];

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

/** A refusal's words: a text, or one read off the workflow when it names what holds there. */
export type Reason = string | ((w: Workflow) => string);

/**
 * A row that refuses `event` when its guard holds, answered with `status` by the slice's routes.
 * `refuses: "state"` is one a real caller meets, `"input"` one only an input naming what is not
 * there meets, which `refusedNow` never lists. `heard`: the event is another part's.
 */
export type RefuseRow<K extends string, Id extends string> = {
  readonly kind: "refuse";
  readonly event: K;
  readonly id: Id;
  readonly refuses: "state" | "input";
  readonly status: RefusalStatus;
  readonly reason: Reason;
  readonly condition: string;
  readonly heard: boolean;
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

export type Rows<E extends Events, H extends Heard> = {
  /** Refuses `event` when `when` holds: a state a real caller meets, listed by `refusedNow`. */
  readonly refuse: <K extends keyof E & string, Id extends string>(
    event: K,
    id: Id,
    when: Guard<Carried<E, K>>,
    status: RefusalStatus,
    reason: Reason,
  ) => RefuseRow<K, Id>;
  /** Refuses `event` when `when` holds on an input naming what is not there: only a sample meets it. */
  readonly refuseInput: <K extends keyof E & string, Id extends string>(
    event: K,
    id: Id,
    when: Guard<Carried<E, K>>,
    status: RefusalStatus,
    reason: Reason,
  ) => RefuseRow<K, Id>;
  /** Refuses `event` while the review is held; an event with no such row passes a hold. */
  readonly whileHeld: <K extends keyof E & string>(
    event: K,
    status: RefusalStatus,
    reason: (hold: string) => string,
  ) => HeldRow<K>;
  /**
   * `refuse` on an event another part owns, judged after every row that part declares on it; its
   * guard reads what that part says the event carries, each field possibly absent.
   */
  readonly refuseHeard: <K extends keyof H & string, Id extends string>(
    event: K,
    id: Id,
    when: Guard<Read<H, K>>,
    status: RefusalStatus,
    reason: Reason,
  ) => RefuseRow<K, Id>;
  /** `refuseInput` on an event another part owns, as `refuseHeard`. */
  readonly refuseInputHeard: <K extends keyof H & string, Id extends string>(
    event: K,
    id: Id,
    when: Guard<Read<H, K>>,
    status: RefusalStatus,
    reason: Reason,
  ) => RefuseRow<K, Id>;
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

/** What a slice reads of an event it hears, as the core hands it: every field is optional there. */
function readOf<H extends Heard, K extends keyof H>(input: EventInput): Read<H, K> {
  // SAFETY: `Read<H, K>` holds optional strings alone, and `input` is a record of strings: every `EventInput` is one. tsgo does not relate a record to a mapped type over a generic key.
  return input as Read<H, K>;
}

type Judged = Omit<RefuseRow<string, string>, "kind" | "event" | "id">;

function rowOf<K extends string, Id extends string>(
  event: K,
  id: Id,
  judged: Judged,
): RefuseRow<K, Id> {
  return { kind: "refuse", event, id, ...judged };
}

/**
 * The row helpers of a slice, bound to its events and to those it hears (`H`, given as a type): a
 * row on an event it neither owns nor hears, or a guard reading a field the event does not carry,
 * does not compile.
 */
export function rows<E extends Events, H extends Heard = Record<never, never>>(
  declared: E,
): Rows<E, H> {
  function own<K extends keyof E & string>(event: K, when: Guard<Carried<E, K>>): Judged["when"] {
    return (w, input) => when(w, carried(declared, event, input));
  }

  function heard<K extends keyof H & string>(when: Guard<Read<H, K>>): Judged["when"] {
    return (w, input) => when(w, readOf<H, K>(input));
  }

  return {
    refuse: (event, id, when, status, reason) =>
      rowOf(event, id, {
        refuses: "state",
        heard: false,
        status,
        reason,
        condition: conditionOf(when),
        when: own(event, when),
      }),
    refuseInput: (event, id, when, status, reason) =>
      rowOf(event, id, {
        refuses: "input",
        heard: false,
        status,
        reason,
        condition: conditionOf(when),
        when: own(event, when),
      }),
    whileHeld: (event, status, reason) => ({ kind: "held", event, id: HELD, status, reason }),
    refuseHeard: (event, id, when, status, reason) =>
      rowOf(event, id, {
        refuses: "state",
        heard: true,
        status,
        reason,
        condition: conditionOf(when),
        when: heard(when),
      }),
    refuseInputHeard: (event, id, when, status, reason) =>
      rowOf(event, id, {
        refuses: "input",
        heard: true,
        status,
        reason,
        condition: conditionOf(when),
        when: heard(when),
      }),
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

/** Its answer to the events of the others it hears, each reading what that event's owner says it carries. */
export type Reactions<H extends Heard> = {
  readonly [K in keyof H]?: (w: Workflow, input: Read<H, K>) => Outcome;
};

export type SlicePart<E extends Events, H extends Heard> = {
  readonly events: E;
  /** Read top to bottom per event: a row above the event's hold row is judged before the hold, one below it after. */
  readonly rules: readonly Row<(keyof E | keyof H) & string>[];
  readonly samples: Samples<E>;
  readonly transitions: Transitions<E>;
  readonly reactions: Reactions<H>;
};

function namesOf<E extends Events>(declared: E): (keyof E & string)[] {
  return Object.keys(declared).filter((name): name is keyof E & string =>
    Object.hasOwn(declared, name),
  );
}

/** Where a row on another part's event stands: after every row that part declares on it. */
const AFTER_THE_OWNER = 100;

function reasonOf(reason: Reason): (w: Workflow) => string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- `reason` is the contract's own union of a text and a wording read off the workflow, never input: `typeof` tells the two apart, and nothing here is parsed.
  return typeof reason === "string" ? () => reason : reason;
}

/**
 * The event's rows as the core orders them: the hold's at 0, a row above it negative, one below
 * it positive; a row on an event another part owns after all of that part's.
 */
function rulesOf(event: string, all: readonly Row[]): readonly Rule[] {
  const own = all.filter((row) => row.event === event && !(row.kind === "refuse" && row.heard));
  const heard = all.filter((row) => row.event === event && row.kind === "refuse" && row.heard);
  const held = own.filter((row) => row.kind === "held");

  if (held.length > 1) throw new Error(`${event} has ${held.length} hold rows: one at most`);
  const at = held[0] === undefined ? -1 : own.indexOf(held[0]);

  return [
    ...own.map((row, index) => ({ row, order: index - at })),
    ...heard.map((row, index) => ({ row, order: AFTER_THE_OWNER + index })),
  ].flatMap(({ row, order }) =>
    row.kind === "held"
      ? []
      : [
          {
            id: row.id,
            event,
            order,
            when: row.when,
            effect: "refuse",
            refuses: row.refuses,
            reason: reasonOf(row.reason),
            status: row.status,
            condition: row.condition,
          },
        ],
  );
}

function declOf<E extends Events, H extends Heard, K extends keyof E & string>(
  owner: string,
  part: SlicePart<E, H>,
  event: K,
): EventDecl {
  const held = part.rules.find((row) => row.event === event && row.kind === "held");

  return {
    id: event,
    owner,
    actors: declaredOf(part.events, event).by,
    whileHeld:
      held?.kind === "held"
        ? { effect: "refuse", reason: held.reason, status: held.status }
        : { effect: "allow" },
    samples: part.samples[event],
  };
}

function transitionOf<E extends Events, H extends Heard, K extends keyof E & string>(
  part: SlicePart<E, H>,
  event: K,
): Transition {
  const transition = part.transitions[event];

  return (w, _event, input) => transition(w, carried(part.events, event, input));
}

function heardOf<H extends Heard>(reactions: Reactions<H>): (keyof H & string)[] {
  return Object.keys(reactions).filter((name): name is keyof H & string =>
    Object.hasOwn(reactions, name),
  );
}

function reactionTo<H extends Heard, K extends keyof H & string>(
  reactions: Reactions<H>,
  event: K,
): Transition {
  return (w, _event, input) => reactions[event]?.(w, readOf<H, K>(input)) ?? unchanged(w);
}

/** One reaction for every event: the slice's own for an event it hears, none for the others. */
function reactionOf<H extends Heard>(reactions: Reactions<H>): Transition {
  const byEvent = new Map(heardOf(reactions).map((event) => [event, reactionTo(reactions, event)]));

  return (w, event, input) => byEvent.get(event)?.(w, event, input) ?? unchanged(w);
}

/** The part `next` judges: each event with its senders, hold row and samples, the rows ordered, the transitions, the reactions. */
export function tablePart<E extends Events, H extends Heard>(
  owner: string,
  part: SlicePart<E, H>,
): TablePart {
  const names = namesOf(part.events);

  const heard = [...new Set(part.rules.map(({ event }) => event))].filter(
    (event) => !Object.hasOwn(part.events, event),
  );

  return {
    events: names.map((event) => declOf(owner, part, event)),
    rules: [...names, ...heard].flatMap((event) => rulesOf(event, part.rules)),
    transitions: Object.fromEntries(
      names.map((event): [string, Transition] => [event, transitionOf(part, event)]),
    ),
    reaction: reactionOf(part.reactions),
  };
}
