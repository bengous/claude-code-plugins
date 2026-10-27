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

type Asked = { readonly question: string; readonly recommendation: string };

/** What the person did on a question, in order, for the transcript; Claude never reads it. */
type Entry =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "peek" | "take" };

type Question = Asked & {
  readonly n: number;
  /** The answer recorded (Record, a choice, Use Claude's); typing alone records nothing. */
  answer: string;
  /** What the answer field holds. */
  draft: string;
  isShown: boolean;
  readonly log: Entry[];
};

type Round = { readonly questions: readonly Question[]; isInBand: boolean };

/** What the scribe keeps for the session: the last question number, and the round waiting, if any. */
type Saved = { readonly last: number; readonly questions: readonly Question[] | null };

let round: Round | null = null;

/** The number of the last question asked in this session; the next round continues after it. */
let last = 0;

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

    return { ...a, n, answer: "", draft: "", isShown: false, log: [] };
  });
}

/** The message the round's answers reach Claude as: the final answers alone, the transcript keeps the rest. */
function answersOf(r: Round): string {
  const lines = r.questions.map((q) => {
    const final = q.answer.trim();

    return `Q${q.n}: ${final === q.recommendation ? "your recommendation" : final}`;
  });

  return ["Grill answers:", ...lines].join("\n");
}

function entryOf(entry: Entry): string {
  if (entry.kind === "answer") return `- answered: ${entry.text.trim()}`;

  return entry.kind === "peek" ? "- peeked at Claude's" : "- took Claude's";
}

/** The round as the transcript records it once sent: each question, Claude's answer, the person's and how they got there. */
function recordOf(r: Round): string {
  const blocks = r.questions.map((q) =>
    [
      `### Q${q.n}`,
      "",
      q.question,
      "",
      `**Claude:** ${q.recommendation}`,
      "",
      `**Answer:** ${q.answer.trim()}`,
      "",
      ...q.log.map(entryOf),
    ].join("\n"),
  );

  return `${blocks.join("\n\n")}\n\n---\n\n`;
}

async function pathsOf($: EngineInterface) {
  const folder = `${await $.session.root()}/${FOLDER}`;
  const id = await $.session.id();

  return { folder, state: `${folder}/${id}.json`, transcript: `${folder}/${id}.md` };
}

async function save($: EngineInterface): Promise<void> {
  const { folder, state } = await pathsOf($);
  const saved: Saved = { last, questions: round?.questions ?? null };

  if (!(await $.fs.exists(`${folder}/.gitignore`))) await $.fs.write(`${folder}/.gitignore`, "*\n");
  await $.fs.write(state, `${JSON.stringify(saved, null, 2)}\n`);
}

/** A save a press starts: the pane does not wait on it, and a failed one says so. */
function keep($: EngineInterface): void {
  save($).catch((cause: unknown) =>
    $.ui.toast(`${PLUGIN}: the grill was not saved: ${String(cause)}`),
  );
}

async function load($: EngineInterface): Promise<Saved> {
  const { state } = await pathsOf($);

  if (!(await $.fs.exists(state))) return { last: 0, questions: null };

  // SAFETY: only this module writes the file, from a `Saved`.
  return JSON.parse(await $.fs.read(state)) as Saved;
}

async function record($: EngineInterface, r: Round): Promise<void> {
  const { transcript } = await pathsOf($);
  const before = (await $.fs.exists(transcript)) ? await $.fs.read(transcript) : "# Grill\n\n";

  await $.fs.write(transcript, before + recordOf(r));
}

/**
 * The round leaves the pane at the press: the prompt waits until Claude's turn is over, and a pane
 * still open meanwhile would take a second Send. A refused prompt brings the round back.
 */
async function send($: EngineInterface, r: Round): Promise<void> {
  if (round !== r) return;
  round = null;
  await $.ui.close({ id: PANE });
  $.ui.invalidate("ui.render");
  await save($);
  const sent = await $.prompt.submit({ text: answersOf(r), asUser: true });

  if (sent.drop === undefined) {
    await record($, r);

    return;
  }

  round = r;
  await save($);
  await $.ui.open({ id: PANE, title: "Grill", focus: true });
  $.ui.invalidate("ui.render");
  $.ui.toast(`${PLUGIN}: the answers were not sent: ${sent.drop}`);
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
  const current: Round = { questions, isInBand: false };

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

function drawRound($: EngineInterface, e: Typed, r: Round) {
  const { Box, Text, Button, Input, Markdown } = $.ui.resolve(e);

  const changed = () => {
    $.ui.invalidate("ui.render");
    keep($);
  };

  const blocks = r.questions.map((q, at) => {
    const n = at + 1;
    const answered = q.answer.trim();
    const isAnswered = answered !== "";
    const isTaken = isAnswered && answered === q.recommendation;

    const letters = choicesOf(q.question);
    const isChosen = letters.some((letter) => answered === `(${letter})`);

    const choices = letters.map((letter) => {
      const choice: ButtonProps = {
        key: `choice-${n}-${letter}`,
        label: `(${letter})`,
        onPress: () => {
          q.answer = `(${letter})`;
          q.log.push({ kind: "answer", text: q.answer });
          changed();
        },
      };

      if (answered === choice.label) choice.variant = "primary";
      else if (isChosen) choice.dimColor = true;

      return Button(choice);
    });

    const field: InputProps = {
      key: `answer-${n}`,
      placeholder: letters.length > 0 ? "Or write your own" : "Your answer",
      value: q.draft,
      rows: 2,
      submitLabel: isAnswered ? "Update" : "Record",
      onInput: (text) => {
        q.draft = text;
      },
      onSubmit: (text) => {
        q.draft = text;

        if (text.trim() !== "") {
          q.answer = text;
          q.log.push({ kind: "answer", text });
        }

        changed();
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

          if (q.isShown) q.log.push({ kind: "peek" });
          changed();
        },
      });

    const use = Button({
      key: `take-${n}`,
      label: "Use Claude's",
      onPress: () => {
        q.answer = q.recommendation;
        q.draft = q.recommendation;
        q.log.push({ kind: "take" });
        changed();
      },
    });

    // What commits an answer sits on the right; a peek, which commits nothing, on the left.
    const below = isTaken
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
  const used = r.questions.filter((q) => q.answer.trim() === q.recommendation).length;

  const progress = Text({
    size: "footnote",
    dimColor: true,
    children: `${done} of ${r.questions.length} answered · ${used} used Claude's`,
  });

  const footer =
    done === r.questions.length
      ? [
          progress,
          Button({
            key: "send",
            label: "Send answers",
            variant: "primary",
            onPress: () => send($, r),
          }),
        ]
      : [progress];

  return Box({
    flexDirection: "column",
    gap: 2,
    paddingX: 1,
    children: [
      Text({ size: "footnote", dimColor: true, children: HINT }),
      ...blocks,
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
  // The module's variables go with a reload or a restart: the scribe's state gives them back.
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    const saved = await load($);

    last = saved.last;
    round = null;

    if (saved.questions !== null) await openRound($, saved.questions);

    return started;
  });

  // A turn whose replies hold a round opens it in the pane once it ends.
  on("turn.complete", async ($, e, next) => {
    const done = await next(e);

    if (e.agentId !== undefined || e.isAborted) return done;
    const asked = parseRound(await lastTurnText($, e.answer));

    if (asked.length === 0) return done;
    const questions = numbered(asked, last);

    last = questions.at(-1)?.n ?? last;
    await openRound($, questions);
    await save($);

    return done;
  });

  on("ui.close", ($, e, next) => {
    // The person's close drops the round unsent; the close after Send finds it gone already.
    if (e.id === PANE && round !== null && !round.isInBand) {
      round = null;
      keep($);
    }

    return next(e);
  }).catch((_$, e, next) => next(e));

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
