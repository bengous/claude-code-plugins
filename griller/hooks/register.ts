import type {
  ButtonProps,
  EngineInterface,
  InputProps,
  Register,
  SessionMessage,
} from "claude-code";

const PLUGIN = "griller";

const PANE = PLUGIN;

/** Where the scribe writes, under the session's project root; the folder ignores itself in git. */
const FOLDER = ".claude/griller";

const QUESTION = /^\s*❓/u;

const RECOMMENDATION = /^\s*➡️?/u;

const SEPARATOR = /^\s*-{3,}\s*$/u;

/** The number Claude gives a question, written `**Q4**` at its start; one cited later is another's. */
const NUMBER = /^\*\*Q(\d+)\*\*/u;

/** A choice the question offers, written `**(a)**`. */
const CHOICE = /\*\*\(([a-z])\)\*\*/gu;

const HINT = "Answer first: Claude's answer stays hidden until you peek at it.";

const BAND_HINT = "ctrl+x then tab to focus";

type Asked = { readonly question: string; readonly recommendation: string };

type Question = Asked & {
  readonly n: number;
  /** The answer recorded (Record, a choice, Use Claude's); typing alone records nothing. */
  answer: string;
  isShown: boolean;
  /**
   * The answer is Claude's, set by Use Claude's alone: an answer that matches the recommendation by
   * chance stays the person's own, so the card gives no hidden recommendation away.
   */
  isTaken: boolean;
};

type Round = {
  readonly questions: readonly Question[];
  isInBand: boolean;
  /** Why the last Send kept the round: the save that still failed after its tries. */
  failure: string | null;
};

/** One line of the journal, the person's every gesture; never sent to Claude. */
type Event =
  | { readonly kind: "open" | "reopen" | "send" | "close"; readonly questions: readonly number[] }
  | { readonly kind: "draft" | "answer" | "choice"; readonly q: number; readonly text: string }
  | { readonly kind: "peek" | "hide" | "take"; readonly q: number };

/** A round that left the pane: its answers sent to Claude, or abandoned unsent. */
type Closed = { readonly kind: "sent" | "abandoned"; readonly questions: readonly Question[] };

/** The mod's state for the session: the last question number, the rounds closed, and the round waiting. */
type Saved = {
  readonly last: number;
  readonly closed: readonly Closed[];
  readonly open: readonly Question[] | null;
};

/** The state of a session whose grill has not started. */
const FRESH: Saved = { last: 0, closed: [], open: null };

type Paths = {
  readonly folder: string;
  readonly state: string;
  readonly transcript: string;
  readonly journal: string;
};

/**
 * The session whose grill the module holds, and its files: every write goes there, whatever session
 * `$.session.id()` names by then.
 */
let held: { readonly id: string; readonly paths: Paths } | null = null;

let round: Round | null = null;

/** The number of the last question asked in this session; the next round continues after it. */
let last = 0;

let closed: Closed[] = [];

/** The journal's lines; null when the file on disk could not be read, so it is never overwritten. */
let journal: string | null = "";

/**
 * False when the state file on disk could not be read: it is never overwritten, nor the transcript,
 * which would be drawn again from a state that has lost every earlier round.
 */
let isStateRead = true;

/**
 * The typing in an answer field, journaled as one line once it ends: when the field loses the ring
 * or the person's next gesture comes. A keystroke alone writes nothing.
 */
let typing: { readonly q: number; readonly field: string; text: string } | null = null;

/**
 * What each answer field holds, in memory alone: a round brought back from the state opens each
 * field on the answer recorded from it, without what was typed and not recorded.
 */
const drafts = new WeakMap<Question, string>();

/** Where a line of Claude's text stands in the round format. */
type Place = "outside" | "question" | "recommendation";

/**
 * The one rule the pane and the chat both read Claude's text by: a ❓ line opens a question, a ➡️
 * line opens its recommendation only inside a question, and a separator ends both.
 */
function placeOf(line: string, before: Place): Place {
  if (QUESTION.test(line)) return "question";

  if (SEPARATOR.test(line)) return "outside";

  if (before === "question" && RECOMMENDATION.test(line)) return "recommendation";

  return before;
}

function placeAfter(text: string, before: Place): Place {
  return text.split("\n").reduce<Place>((place, line) => placeOf(line, place), before);
}

/** The questions of a reply written in the round format, each with its recommendation; none when it holds no round. */
function parseRound(text: string): Asked[] {
  const asked: Asked[] = [];
  let question: string[] = [];
  let recommendation: string[] = [];
  let place: Place = "outside";

  const close = () => {
    const q = question.join("\n").trim();
    const r = recommendation.join("\n").trim();

    if (q !== "" && r !== "") asked.push({ question: q, recommendation: r });
    question = [];
    recommendation = [];
  };

  for (const line of text.split("\n")) {
    place = placeOf(line, place);

    if (QUESTION.test(line)) {
      close();
      question = [line.replace(QUESTION, "").trim()];
    } else if (place === "recommendation") {
      recommendation.push(
        RECOMMENDATION.test(line) ? line.replace(RECOMMENDATION, "").trim() : line,
      );
    } else if (place === "question") {
      question.push(line);
    } else {
      close();
    }
  }

  close();

  return asked;
}

/**
 * Claude's text as the chat draws it, a message or a batch of its lines, `before` being where the
 * text before it in its turn left off: every line the pane reads as a recommendation is hidden, with
 * the newline that ends it, so the batches of a message draw what the whole message draws.
 */
function masked(text: string, before: Place): string {
  let place = before;

  return text
    .split(/(?<=\n)/u)
    .filter((line) => {
      place = placeOf(line, place);

      return place !== "recommendation";
    })
    .join("");
}

/** Each question numbered as Claude wrote it, or after the one before when Claude wrote no number. */
function numbered(asked: readonly Asked[], after: number): Question[] {
  let previous = after;

  return asked.map((a) => {
    const n = Number(NUMBER.exec(a.question)?.[1] ?? previous + 1);

    previous = n;

    return { ...a, n, answer: "", isShown: false, isTaken: false };
  });
}

/**
 * A new round's questions, each one asked again unchanged (its number and its text) keeping the
 * card the round it replaces had for it; its recommendation stays hidden, since it may be new. An
 * answer taken from a recommendation Claude has since changed stays as the person's own: Claude
 * would otherwise read `your recommendation` for one it never made.
 */
function carried(questions: readonly Question[], replaced: readonly Question[]): Question[] {
  return questions.map((q) => {
    const before = replaced.find((b) => b.n === q.n && b.question === q.question);

    if (before === undefined) return q;
    const isTaken = before.isTaken && before.recommendation === q.recommendation;
    const kept: Question = { ...q, answer: before.answer, isTaken };
    const draft = drafts.get(before);

    if (draft !== undefined) drafts.set(kept, draft);

    return kept;
  });
}

function numbersOf(questions: readonly Question[]): number[] {
  return questions.map((q) => q.n);
}

/** The message the round's answers reach Claude as: the final answers alone, the journal keeps the rest. */
function answersOf(r: Round): string {
  const lines = r.questions.map(
    (q) => `Q${q.n}: ${q.isTaken ? "your recommendation" : q.answer.trim()}`,
  );

  return ["Grill answers:", ...lines].join("\n");
}

const ABANDONED = "_Abandoned: not sent to Claude._";

/**
 * The grill as the person reads it: each question, Claude's answer and theirs. Only a round sent
 * shows its recommendations: the file beside the pane would give away the waiting round's, and an
 * abandoned round's, which Claude may ask again.
 */
function transcriptOf(rounds: readonly Closed[], open: readonly Question[] | null): string {
  const answerOf = (q: Question, isWaiting: boolean) => {
    const final = q.answer.trim();

    if (final === "") return isWaiting ? "_not answered yet_" : "_not answered_";

    return q.isTaken ? "Claude's" : final;
  };

  const block = (q: Question, state: Closed["kind"] | "waiting") =>
    [
      q.question,
      "",
      ...(state === "sent" ? [`**Claude:** ${q.recommendation}`, ""] : []),
      `**Answer:** ${answerOf(q, state === "waiting")}`,
    ].join("\n");

  const section = (questions: readonly Question[], state: Closed["kind"] | "waiting") =>
    [...(state === "abandoned" ? [ABANDONED] : []), ...questions.map((q) => block(q, state))].join(
      "\n\n",
    );

  const sections = [
    ...rounds.map((r) => section(r.questions, r.kind)),
    ...(open === null ? [] : [section(open, "waiting")]),
  ];

  return `# Grill\n\n${sections.join("\n\n---\n\n")}\n`;
}

async function pathsOf($: EngineInterface, id: string): Promise<Paths> {
  const folder = `${await $.session.root()}/${FOLDER}`;

  return {
    folder,
    state: `${folder}/${id}.json`,
    transcript: `${folder}/${id}.md`,
    journal: `${folder}/${id}.jsonl`,
  };
}

async function writeAll($: EngineInterface): Promise<void> {
  if (held === null) throw new Error("no session's grill is loaded yet");
  const { paths } = held;
  const open = round?.questions ?? null;
  const saved: Saved = { last, closed, open };

  if (!(await $.fs.exists(`${paths.folder}/.gitignore`))) {
    await $.fs.write(`${paths.folder}/.gitignore`, "*\n");
  }

  if (isStateRead) await $.fs.write(paths.state, `${JSON.stringify(saved, null, 2)}\n`);

  if (isStateRead && (closed.length > 0 || open !== null)) {
    await $.fs.write(paths.transcript, transcriptOf(closed, open));
  }

  if (journal !== null) await $.fs.write(paths.journal, journal);
}

let writing: Promise<void> | null = null;

let isDirty = false;

/**
 * One write at a time, each of the whole state as it stands then: a burst of gestures costs a few.
 *
 * The writer lets go in the step that finds nothing left to write, not a tick later, so a call that
 * comes after starts a writer of its own. That step follows a write, so it never comes before
 * `writing` holds the writer.
 */
function flush($: EngineInterface): Promise<void> {
  isDirty = true;

  if (writing !== null) return writing;

  writing = (async () => {
    try {
      while (isDirty) {
        isDirty = false;
        await writeAll($);
      }
    } finally {
      writing = null;
    }
  })();

  return writing;
}

/** The line that ends the typing in a field, if any. */
function endTyping(): Event | null {
  if (typing === null) return null;
  const { q, text } = typing;

  typing = null;

  return { kind: "draft", q, text };
}

/** A gesture journaled after the typing it ends; an answer recorded from that field carries its text. */
async function note($: EngineInterface, event: Event): Promise<void> {
  if (event.kind === "answer" && event.q === typing?.q) typing = null;
  const ended = endTyping();
  const events = ended === null ? [event] : [ended, event];
  const at = new Date(await $.clock.now()).toISOString();

  if (journal !== null) journal += events.map((e) => `${JSON.stringify({ at, ...e })}\n`).join("");
}

function unsaved($: EngineInterface): (cause: unknown) => void {
  return (cause) => $.ui.toast(`${PLUGIN}: the grill was not saved: ${String(cause)}`);
}

/** A gesture journaled and saved without the pane waiting, a failure said. */
function keep($: EngineInterface, event: Event): Promise<void> {
  return note($, event)
    .then(() => flush($))
    .catch(unsaved($));
}

function stopTyping($: EngineInterface): Promise<void> {
  const ended = endTyping();

  return ended === null ? Promise.resolve() : keep($, ended);
}

const TRIES = 3;

const RETRY_MS = 200;

/** A save tried again while a write fails, `TRIES` times in all: the last failure, or null once one holds. */
async function failedSave($: EngineInterface): Promise<string | null> {
  for (let tried = 1; ; tried += 1) {
    try {
      await flush($);

      return null;
    } catch (cause) {
      if (tried === TRIES) return String(cause);
      await $.clock.sleep(RETRY_MS);
    }
  }
}

type Loaded = {
  readonly paths: Paths;
  readonly journal: string | null;
  /** Null when the file on disk could not be read. */
  readonly saved: Saved | null;
};

async function load($: EngineInterface, id: string): Promise<Loaded> {
  const paths = await pathsOf($, id);

  const lines = (await $.fs.exists(paths.journal))
    ? await $.fs.read(paths.journal).catch((cause: unknown) => {
        $.ui.toast(
          `${PLUGIN}: the journal could not be read, so it is left as is: ${String(cause)}`,
        );

        return null;
      })
    : "";

  if (!(await $.fs.exists(paths.state))) {
    return { paths, journal: lines, saved: FRESH };
  }

  // SAFETY: only this module writes the file, from a `Saved`; a write cut short fails the parse.
  const saved = await $.fs
    .read(paths.state)
    .then((text) => JSON.parse(text) as Saved)
    .catch((cause: unknown) => {
      $.ui.toast(
        `${PLUGIN}: ${paths.state} could not be read, so it and the transcript are left as they are: ${String(cause)}`,
      );

      return null;
    });

  return { paths, journal: lines, saved };
}

/**
 * Session `id`'s grill takes the module's place, its waiting round back in the pane. The grill held
 * before leaves the pane and keeps its files as its last write left them.
 */
async function hold($: EngineInterface, id: string): Promise<void> {
  const loaded = await load($, id);

  // A write under way is the previous session's, into its files; its failure was said where it was asked.
  for (let pending = writing; pending !== null; pending = writing) {
    await Promise.allSettled([pending]);
  }

  const wasPlaced = round !== null && !round.isInBand;
  const saved = loaded.saved ?? FRESH;

  held = { id, paths: loaded.paths };
  journal = loaded.journal;
  isStateRead = loaded.saved !== null;
  last = saved.last;
  closed = [...saved.closed];
  round = null;
  typing = null;

  if (saved.open !== null) {
    await openRound($, saved.open);
    await note($, { kind: "reopen", questions: numbersOf(saved.open) });
    await flush($).catch(unsaved($));

    return;
  }

  if (wasPlaced) await $.ui.close({ id: PANE });
  $.ui.invalidate("ui.render");
}

function restore(r: Round): void {
  closed = closed.filter((c) => c.questions !== r.questions);
  round = r;
}

/** The round leaves unsent: the transcript keeps it as abandoned, and the journal notes its close. */
function abandon(r: Round): Event {
  if (round === r) round = null;
  closed.push({ kind: "abandoned", questions: r.questions });

  return { kind: "close", questions: numbersOf(r.questions) };
}

/**
 * The round is saved as sent, then leaves the pane: the prompt waits until Claude's turn is over, a
 * reload meanwhile must not bring it back, and a pane still open would take a second Send. A save
 * that still fails keeps the round with the failure, unless the person sends it anyway; a refused
 * prompt brings the round back.
 */
async function send($: EngineInterface, r: Round, isForced = false): Promise<void> {
  if (round !== r) return;
  round = null;
  closed.push({ kind: "sent", questions: r.questions });
  const failure = await failedSave($);

  if (failure !== null && !isForced) {
    restore(r);
    r.failure = failure;
    $.ui.invalidate("ui.render");
    // The state may have been written as sent before a later file failed.
    await flush($).catch(unsaved($));

    return;
  }

  r.failure = null;
  await $.ui.close({ id: PANE });
  $.ui.invalidate("ui.render");
  const submitted = await $.prompt.submit({ text: answersOf(r), asUser: true });

  if (submitted.drop === undefined) {
    await note($, { kind: "send", questions: numbersOf(r.questions) });
    await flush($).catch(unsaved($));

    return;
  }

  restore(r);
  await flush($).catch(unsaved($));
  await openRound($, r.questions);
  $.ui.toast(`${PLUGIN}: the answers were not sent: ${submitted.drop}`);
}

/** A message that starts a turn: one the person or a plugin sent, never a tool's result. */
function isPrompt(m: SessionMessage): boolean {
  return m.role === "user" && m.text.trim() !== "" && (m.toolResults ?? []).length === 0;
}

/** How much of a message a start hides: each place hides all that the one before it does. */
const DEPTH: Readonly<Record<Place, number>> = { outside: 0, question: 1, recommendation: 2 };

/**
 * Where each of Claude's messages starts, by its text: where the earlier messages of its turn left off.
 * Two messages of the same text share the start that hides the most: a drawing names no message.
 */
function startsIn(messages: readonly SessionMessage[]): Map<string, Place> {
  const starts = new Map<string, Place>();
  let place: Place = "outside";

  for (const m of messages) {
    if (isPrompt(m)) {
      place = "outside";
    } else if (m.role === "assistant") {
      const known = starts.get(m.text);

      if (known === undefined || DEPTH[place] > DEPTH[known]) starts.set(m.text, place);
      place = placeAfter(m.text, place);
    }
  }

  return starts;
}

let starts = new Map<string, Place>();

/** Where the turn streaming on screen has left Claude's text, by the turn's id as the stream names it. */
let streaming: { readonly turn: string; readonly place: Place } | null = null;

let reading: Promise<void> | null = null;

/** The conversation read again for `starts`; the drawings that ask meanwhile share the reading. */
function reread($: EngineInterface): Promise<void> {
  reading ??= (async () => {
    starts = startsIn(await $.session.messages());
  })().finally(() => {
    reading = null;
  });

  return reading;
}

/**
 * Where a message of Claude's starts; a text the conversation does not hold starts outside. A reading
 * already under way may predate the message, so one of its own follows it; a drawing starts at most
 * one, since a reply still streaming is a new text at each drawing.
 */
async function startOf($: EngineInterface, text: string): Promise<Place> {
  if (!starts.has(text) && reading !== null) await reading;

  if (!starts.has(text)) await reread($);

  return starts.get(text) ?? "outside";
}

/**
 * Claude's text since the user's last prompt, `answer` added when the transcript does not hold it yet:
 * a round followed by a tool call is still found.
 */
async function lastTurnText($: EngineInterface, answer: string): Promise<string> {
  const messages = await $.session.messages();
  const prompt = messages.findLastIndex((m) => isPrompt(m));

  const text = messages
    .slice(prompt + 1)
    .filter((m) => m.role === "assistant")
    .map((m) => m.text)
    .join("\n");

  return text.includes(answer.trim()) ? text : `${text}\n${answer}`;
}

async function openRound($: EngineInterface, questions: readonly Question[]): Promise<void> {
  const current: Round = { questions, isInBand: false, failure: null };

  round = current;
  const opened = await $.ui.open({ id: PANE, title: "Grill", focus: true });

  if (!opened.isPlaced) {
    current.isInBand = true;
    await $.ui.close({ id: PANE });
    $.ui.toast("Claude asks a grill round: press ctrl+x then tab to answer above the prompt", {
      timeoutMs: 10_000,
    });
  }

  $.ui.invalidate("ui.render");
}

type Drawn = Parameters<EngineInterface["ui"]["resolve"]>[0];

/** A surface that draws an `Input`: every one but mobile, whose table has none. */
type Typed = Drawn & { readonly surface: "terminal" | "desktop" | "vscode" };

/** The letters of the choices a question offers, in the order it writes them. */
function choicesOf(question: string): string[] {
  return [...new Set([...question.matchAll(CHOICE)].map((m) => m[1] ?? ""))];
}

function isComplete(r: Round): boolean {
  return r.questions.every((q) => q.answer.trim() !== "");
}

function drawRound($: EngineInterface, e: Typed, r: Round) {
  const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e);

  const changed = (event: Event) => {
    $.ui.invalidate("ui.render");
    keep($, event);
  };

  /** The answer that completes the round brings Send into view: a long round puts it below the fold. */
  const answered = async (record: () => Event) => {
    const wasComplete = isComplete(r);

    changed(record());

    if (wasComplete || !isComplete(r) || r.isInBand) return;

    await $.ui
      .scroll({ in: PANE, to: "end" })
      .catch((cause: unknown) =>
        $.ui.toast(`${PLUGIN}: Send could not be scrolled to: ${String(cause)}`),
      );
  };

  const blocks = r.questions.map((q, at) => {
    const n = at + 1;
    const recorded = q.answer.trim();
    const isAnswered = recorded !== "";

    const letters = choicesOf(q.question);
    const isChosen = letters.some((letter) => recorded === `(${letter})`);

    const choices = letters.map((letter) => {
      const choice: ButtonProps = {
        key: `choice-${n}-${letter}`,
        label: `(${letter})`,
        onPress: () =>
          answered(() => {
            q.answer = `(${letter})`;
            q.isTaken = false;

            return { kind: "choice", q: q.n, text: q.answer };
          }),
      };

      if (recorded === choice.label) choice.variant = "primary";
      else if (isChosen) choice.dimColor = true;

      return Button(choice);
    });

    const key = `answer-${n}`;

    const field: InputProps = {
      key,
      placeholder: letters.length > 0 ? "Or write your own" : "Your answer",
      value: drafts.get(q) ?? (isChosen ? "" : q.answer),
      rows: 2,
      submitLabel: isAnswered ? "Update" : "Record",
      onInput: (text) => {
        drafts.set(q, text);

        if (typing?.field === key) {
          typing.text = text;
        } else {
          void stopTyping($);
          typing = { q: q.n, field: key, text };
        }
      },
      onSubmit: (text) => {
        drafts.set(q, text);

        if (text.trim() === "") return;

        void answered(() => {
          q.isTaken = q.isTaken && text === q.answer;
          q.answer = text;

          return { kind: "answer", q: q.n, text };
        });
      },
    };

    if (at === 0) field.autoFocus = true;

    const toggle = (label: string) =>
      Button({
        key: `toggle-${n}`,
        label,
        dimColor: true,
        onPress: () => {
          q.isShown = !q.isShown;
          changed({ kind: q.isShown ? "peek" : "hide", q: q.n });
        },
      });

    const use = Button({
      key: `take-${n}`,
      label: "Use Claude's",
      onPress: () =>
        answered(() => {
          q.answer = q.recommendation;
          drafts.set(q, q.recommendation);
          q.isTaken = true;

          return { kind: "take", q: q.n };
        }),
    });

    // What commits an answer sits on the right; a peek, which commits nothing, on the left.
    const below = q.isTaken
      ? [Text({ size: "caption", dimColor: true, children: "Using Claude's answer" })]
      : q.isShown
        ? [
            Text({ size: "caption", dimColor: true, children: "Claude" }),
            Markdown({ key: `recommendation-${n}`, text: q.recommendation }),
            Box({
              flexDirection: "row",
              justifyContent: "space-between",
              gap: 1,
              children: [toggle("Hide"), use],
            }),
          ]
        : [Box({ flexDirection: "row", children: [toggle("Peek at Claude's")] })];

    return Box({
      flexDirection: "column",
      gap: 1,
      borderStyle: "round",
      borderDimColor: true,
      padding: 1,
      children: [
        Markdown({ key: `question-${n}`, text: q.question, dimColor: isAnswered }),
        ...(letters.length > 0
          ? [Box({ flexDirection: "row", flexWrap: "wrap", gap: 1, children: choices })]
          : []),
        Input(field),
        ...below,
      ],
    });
  });

  const done = r.questions.filter((q) => q.answer.trim() !== "").length;
  const used = r.questions.filter((q) => q.isTaken).length;

  const progress = Text({
    size: "footnote",
    dimColor: true,
    children: `${done} of ${r.questions.length} answered · ${used} used Claude's`,
  });

  const sendAnyway = Button({
    key: "send-anyway",
    label: "Send anyway",
    onPress: () => send($, r, true),
  });

  // The band has no close mark: this button drops the round as the pane's close does.
  const drop = Button({
    key: "drop",
    label: "Drop round",
    onPress: () => {
      if (round !== r) return;
      const event = abandon(r);

      $.ui.invalidate("ui.render");

      return keep($, event);
    },
  });

  const buttons = [
    ...(isComplete(r)
      ? [
          Button({
            key: "send",
            label: "Send answers",
            variant: "primary",
            onPress: () => send($, r),
          }),
          ...(r.failure === null ? [] : [sendAnyway]),
        ]
      : []),
    ...(r.isInBand ? [drop] : []),
  ];

  const footer =
    buttons.length === 0
      ? [progress]
      : [progress, Box({ flexDirection: "row", gap: 1, children: buttons })];

  const failure =
    r.failure === null
      ? []
      : [
          Text({
            color: "error",
            children: `Answers not sent: the grill could not be saved after ${TRIES} tries. ${r.failure}`,
          }),
        ];

  return Box({
    flexDirection: "column",
    gap: 2,
    paddingX: 1,
    children: [
      // A band shows its first rows: the keys go there, not under the cards.
      Box({
        flexDirection: "column",
        children: [
          Text({ size: "footnote", dimColor: true, children: HINT }),
          ...(r.isInBand ? [Text({ size: "footnote", dimColor: true, children: BAND_HINT })] : []),
        ],
      }),
      ...blocks,
      ...failure,
      Box({
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        children: footer,
      }),
    ],
  });
}

export const register: Register = (on) => {
  // The module's variables go with a reload or a restart: the saved state gives them back.
  on("session.start", async ($, e, next) => {
    const started = await next(e);

    await hold($, await $.session.id());

    return started;
  });

  // A /clear or a resume puts another session in the process and raises no `session.start`; after
  // a resume, `$.session.id()` names the new session only once the event is over.
  on("classic.SessionStart", async ($, e, next) => {
    const started = await next(e);

    if (held !== null && e.session_id !== held.id) await hold($, e.session_id);

    return started;
  }).catch(($, e, next) => {
    $.ui.toast(
      `${PLUGIN}: this session's grill could not be loaded: ${next.error.message ?? next.error.kind}`,
    );

    return next(e);
  });

  // A turn whose replies hold a round opens it in the pane once it ends, in place of the round waiting.
  on("turn.complete", async ($, e, next) => {
    const done = await next(e);

    if (e.agentId !== undefined || e.isAborted) return done;
    const asked = parseRound(await lastTurnText($, e.answer));

    if (asked.length === 0) return done;
    const questions = numbered(asked, last);
    const replaced = round;

    if (replaced !== null) await note($, abandon(replaced));
    last = Math.max(last, ...numbersOf(questions));
    await openRound($, replaced === null ? questions : carried(questions, replaced.questions));
    await note($, { kind: "open", questions: numbersOf(questions) });
    await flush($).catch(unsaved($));

    return done;
  });

  on("ui.close", async ($, e, next) => {
    // The person's close drops the round unsent; the close after Send finds it gone already.
    if (e.id === PANE && round !== null && !round.isInBand) await keep($, abandon(round));

    return next(e);
  }).catch((_$, e, next) => next(e));

  on("ui.focus", async ($, e, next) => {
    const moved = await next(e);

    if (moved.deny === undefined && e.element !== typing?.field) await stopTyping($);

    return moved;
  });

  // Every draw of a message hides its recommendations, those of a round an earlier message opened too.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    const text = masked(e.props.text, await startOf($, e.props.text));

    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } });
  });

  // A reply streams to the terminal in batches of whole lines that no drawing above sees; each is
  // hidden by the same rule, read on from where the turn's batches before it left off.
  on("classic.MessageDisplay", async (_$, e, next) => {
    const done = await next(e);
    const before = streaming?.turn === e.turn_id ? streaming.place : "outside";
    // Another hook may have rewritten the batch already: the hiding applies to what it shows.
    const shown = done.displayContent ?? e.delta;
    const text = masked(shown, before);

    streaming = { turn: e.turn_id, place: placeAfter(e.delta, before) };

    return text === shown ? done : { ...done, displayContent: text };
  });

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e, next) => {
    if (e.surface === "mobile") return next(e);

    if (round !== null) return drawRound($, e, round);
    const { Text } = $.ui.resolve(e);

    return Text({ dimColor: true, children: "No round is waiting for your answers." });
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) =>
    round === null || !round.isInBand || e.surface === "mobile" ? next(e) : drawRound($, e, round),
  );
};
