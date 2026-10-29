import type { ButtonProps, EngineInterface, InputProps, Register } from "claude-code";

const PLUGIN = "griller";

const PANE = PLUGIN;

/** Where the scribe writes, under the session's project root; the folder ignores itself in git. */
const FOLDER = ".claude/griller";

const QUESTION = /^\s*❓/u;

const RECOMMENDATION = /^\s*➡️?/u;

const SEPARATOR = /^\s*-{3,}\s*$/u;

/** The number Claude gives a question, written `**Q4**`. */
const NUMBER = /\*\*Q(\d+)\*\*/u;

/** A choice the question offers, written `**(a)**`. */
const CHOICE = /\*\*\(([a-z])\)\*\*/gu;

const HINT = "Answer first: Claude's answer stays hidden until you peek at it.";

const BAND_HINT = "ctrl+x then tab to focus";

type Asked = { readonly question: string; readonly recommendation: string };

type Question = Asked & {
  readonly n: number;
  /** The answer recorded (Record, a choice, Use Claude's); typing alone records nothing. */
  answer: string;
  /** What the answer field holds. */
  draft: string;
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

/** One line of the journal, the person's every gesture; Claude never reads it. */
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

/** The questions of a reply written in the round format, each with its recommendation; none when it holds no round. */
function parseRound(text: string): Asked[] {
  const asked: Asked[] = [];
  let question: string[] = [];
  let recommendation: string[] | null = null;

  const close = () => {
    const q = question.join("\n").trim();
    const r = recommendation?.join("\n").trim() ?? "";

    if (q !== "" && r !== "") asked.push({ question: q, recommendation: r });
    question = [];
    recommendation = null;
  };

  for (const line of text.split("\n")) {
    if (QUESTION.test(line)) {
      close();
      question = [line.replace(QUESTION, "").trim()];
    } else if (RECOMMENDATION.test(line) && question.length > 0) {
      recommendation = [line.replace(RECOMMENDATION, "").trim()];
    } else if (SEPARATOR.test(line)) {
      close();
    } else if (recommendation !== null) {
      recommendation.push(line);
    } else if (question.length > 0) {
      question.push(line);
    }
  }

  close();

  return asked;
}

/**
 * A reply as the chat draws it: in a reply that holds a question, every recommendation is hidden from
 * its ➡️ line to the next separator or question, or to the end of what has streamed so far.
 */
function masked(text: string): string {
  if (!text.split("\n").some((line) => QUESTION.test(line))) return text;
  const shown: string[] = [];
  let isHiding = false;

  for (const line of text.split("\n")) {
    if (RECOMMENDATION.test(line)) {
      isHiding = true;
    } else if (isHiding && (SEPARATOR.test(line) || QUESTION.test(line))) {
      isHiding = false;
    }

    if (!isHiding) shown.push(line);
  }

  return shown.join("\n");
}

/** Each question numbered as Claude wrote it, or after the one before when Claude wrote no number. */
function numbered(asked: readonly Asked[], after: number): Question[] {
  let previous = after;

  return asked.map((a) => {
    const n = Number(NUMBER.exec(a.question)?.[1] ?? previous + 1);

    previous = n;

    return { ...a, n, answer: "", draft: "", isShown: false, isTaken: false };
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

    return { ...q, answer: before.answer, draft: before.draft, isTaken };
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

/** One write at a time, each of the whole state as it stands then: a burst of gestures costs a few. */
function flush($: EngineInterface): Promise<void> {
  isDirty = true;

  if (writing !== null) return writing;

  writing = (async () => {
    while (isDirty) {
      isDirty = false;
      await writeAll($);
    }
  })().finally(() => {
    writing = null;
  });

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
    await flush($);

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

/**
 * Claude's text since the user's last prompt, `answer` added when the transcript does not hold it yet:
 * a round followed by a tool call is still found.
 */
async function lastTurnText($: EngineInterface, answer: string): Promise<string> {
  const messages = await $.session.messages();

  const prompt = messages.findLastIndex(
    (m) => m.role === "user" && m.text.trim() !== "" && (m.toolResults ?? []).length === 0,
  );

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
      value: q.draft,
      rows: 2,
      submitLabel: isAnswered ? "Update" : "Record",
      onInput: (text) => {
        q.draft = text;

        if (typing?.field === key) {
          typing.text = text;
        } else {
          void stopTyping($);
          typing = { q: q.n, field: key, text };
        }
      },
      onSubmit: (text) => {
        q.draft = text;

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
          q.draft = q.recommendation;
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
    last = questions.at(-1)?.n ?? last;
    await openRound($, replaced === null ? questions : carried(questions, replaced.questions));
    await note($, { kind: "open", questions: numbersOf(questions) });
    await flush($);

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

  // Every draw of a reply, each piece of a streamed one included, hides its recommendations.
  on("ui.render", { component: "AssistantMessage" }, (_$, e, next) => {
    const text = masked(e.props.text);

    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } });
  });

  on("ui.render", { component: "Pane", requestId: "griller" }, ($, e, next) => {
    if (e.surface === "mobile") return next(e);

    if (round !== null) return drawRound($, e, round);
    const { Text } = $.ui.resolve(e);

    return Text({ dimColor: true, children: "No round is waiting for your answers." });
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) =>
    round === null || !round.isInBand || e.surface === "mobile" ? next(e) : drawRound($, e, round),
  );
};
