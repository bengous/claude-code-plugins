import type { Question, Relay } from "./protocol.ts";

/**
 * The transcript as text: every function takes the file and returns the file. What the page and
 * the hooks module need to know is read off it, so the file is the only state a grill has.
 */

export type Phase = "working" | "waiting";

/** The file cut for the page: Markdown to render, and each question as data, beside its answer. */
export type Segment =
  | { readonly kind: "markdown"; readonly text: string }
  | ({ readonly kind: "question"; readonly id: string; readonly answer: string | null } & Question);

/** An answer the reviewer typed for one question, by its id (`Q3`). */
export type Answer = { readonly id: string; readonly text: string };

/** What a question the reviewer left empty is answered with, when its round is sent or the grill ends. */
export const TAKEN_BY_DEFAULT = "As recommended, by default.";

/**
 * A round is Claude's: `appendQuestions` alone opens one, and the reviewer's reply is written
 * in it. A harness event is a line of its own kind and opens nothing.
 */
const ROUND = /^## Round \d+\n\n### Claude\n/gmu;

const CLAUDE_VOICE = "\n### Claude\n\n";

const REVIEWER_VOICE = "\n### Reviewer\n\n";

/** A reply runs to the next voice, round, event or footer. */
const REPLY =
  /^### Reviewer\n\n([\s\S]*?)(?=^### |^## Round |^_\(session: |^---\n\nClosed |(?![\s\S]))/gmu;

const FOOTER = /\n---\n\nClosed \d{4}-\d{2}-\d{2} \d{2}:\d{2} · ([a-z]+)\n$/u;

/** As `appendQuestions` writes it, and as Claude types it by hand: a dash of any length, the colon or none. */
const QUESTION = /^❓\s*\*\*(Q\d+)\*\*\s*[-–—]\s*\*\*(.+?)\*\*:?\s*(.*)$/u;

/** Every question's number, read as `QUESTION` reads a question: one reader, or a hand-typed number is reused. */
const ASKED = /^❓\s*\*\*Q(\d+)\*\*/gmu;

const EVENT = /^_\(session: .*\)_$/u;

const RECOMMENDATION = /^➡️ ?(.*)$/u;

const RULE = /^\s*-{3,}\s*$/u;

const ANSWER_LINE = /^(Q\d+): /u;

const NOTE = "Note: ";

const REVIEWER_PREFIX = "Reviewer: ";

const ALL_AS_RECOMMENDED = "all open questions as recommended.";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-09-16 14:02`, local time. */
export function stamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function header(subject: string, session: string, date: Date): string {
  return `# Grill: ${subject}\n\nStarted ${stamp(date)} · session ${session}\n`;
}

export function subjectOf(doc: string): string {
  return /^# Grill: (.*)$/mu.exec(doc)?.[1] ?? "";
}

export function isClosed(doc: string): boolean {
  return FOOTER.test(doc);
}

export function appendFooter(doc: string, reason: string, date: Date): string {
  return `${doc}\n---\n\nClosed ${stamp(date)} · ${reason}\n`;
}

/** A command of the session (`/vellum:start`, `/clear`): the harness's, never the reviewer's words. */
export function appendEvent(doc: string, command: string): string {
  return `${doc}\n_(session: ${command.trim().split("\n")[0] ?? ""})_\n`;
}

/** Numbers run across the whole grill: the next one follows the highest already asked. */
export function nextQuestion(doc: string): number {
  return Math.max(0, ...[...doc.matchAll(ASKED)].map((match) => Number(match[1]))) + 1;
}

/** Opens a round: the questions under Claude's voice, each closed by a rule. */
export function appendQuestions(doc: string, questions: readonly Question[]): string {
  const first = nextQuestion(doc);
  const n = (doc.match(ROUND)?.length ?? 0) + 1;

  const round = questions
    .map(
      (question, index) =>
        `❓ **Q${first + index}** - **${question.title}**: ${question.ask}\n\n➡️ ${question.rec}\n\n---\n`,
    )
    .join("\n");

  return `${doc}\n## Round ${n}\n${CLAUDE_VOICE}${round}`;
}

function replies(doc: string): RegExpExecArray[] {
  return [...doc.matchAll(REPLY)];
}

type Parts = { readonly answers: readonly Answer[]; readonly note: string };

/** One reply as its parts: an answer runs from its `Qn: ` line to the next one, or to the note. */
function partsOf(reply: string): Parts {
  const chunks = reply.trim().split(/^(?=Q\d+: |Note: )/mu);

  const answers = chunks.flatMap((chunk) => {
    const id = ANSWER_LINE.exec(chunk)?.[1];

    return id === undefined ? [] : [{ id, text: chunk.slice(id.length + 2).trim() }];
  });

  const note = chunks
    .filter((chunk) => !ANSWER_LINE.test(chunk))
    .map((chunk) => (chunk.startsWith(NOTE) ? chunk.slice(NOTE.length) : chunk))
    .join("\n")
    .trim();

  return { answers, note };
}

/** Every answer of the file, by question id; the first one stands. */
export function answersOf(doc: string): ReadonlyMap<string, string> {
  const answers = new Map<string, string>();

  for (const reply of replies(doc)) {
    for (const { id, text } of partsOf(reply[1] ?? "").answers) {
      if (!answers.has(id)) answers.set(id, text);
    }
  }

  return answers;
}

/** The questions no reply answered, in the order they were asked, whatever happened since. */
export function unanswered(doc: string): string[] {
  const answers = answersOf(doc);

  return doc
    .split("\n")
    .flatMap((line) => QUESTION.exec(line)?.[1] ?? [])
    .filter((id) => !answers.has(id));
}

/**
 * The reviewer's reply, written in the round of its questions. It closes every open question:
 * one the reviewer left empty takes the recommendation, and says it did so by default. `null`
 * when there is nothing to write.
 */
export function appendReply(doc: string, answers: readonly Answer[], note: string): string | null {
  const typed = new Map(answers.map(({ id, text }) => [id, text.trim()]));

  const lines = unanswered(doc).map((id) => `${id}: ${typed.get(id) || TAKEN_BY_DEFAULT}`);

  if (note.trim() !== "") lines.push(`${NOTE}${note.trim()}`);

  return lines.length === 0 ? null : `${doc}${REVIEWER_VOICE}${lines.join("\n\n")}\n`;
}

/**
 * Claude's text as a quotation: the file's structure is read off its lines, so a heading, an
 * event or a footer inside the text would speak for the reviewer, open a round or close the
 * grill. A backslash keeps each one text, and Markdown draws it as it was typed.
 */
function quoted(text: string): string {
  return text
    .replaceAll(/^(?=#|_\(session: )/gmu, "\\")
    .replaceAll(/^(?=-{3,}\s*\n\s*\nClosed )/gmu, "\\");
}

/**
 * Claude's final text, kept only when its turn belongs to the grill: `own`, a turn a vellum
 * relay started, or the turn that just asked the round the file ends on. A turn the terminal
 * started is not the grill's, whatever the file's last voice is.
 */
export function appendAnswer(doc: string, text: string, reason: string, own: boolean): string {
  const ended = reason === "answer" ? "" : `_(turn ${reason})_`;
  const body = [quoted(text.trim()), ended].filter((part) => part !== "").join("\n\n");

  // An event line after the round changes nothing: Claude has still said nothing under it.
  const spoken = doc.split("\n").findLast((line) => line.trim() !== "" && !EVENT.test(line));

  if (RULE.test(spoken ?? "")) {
    return body === "" ? doc : `${doc}\n${body}\n`;
  }

  return own ? `${doc}${CLAUDE_VOICE}${body === "" ? "_(no text)_" : body}\n` : doc;
}

/** A reply as the agent reads it: the note first, then the answers the reviewer typed. A default never goes: `grilling.md` says an absent question took the recommendation. */
function replyText(reply: string): string {
  const { answers, note } = partsOf(reply);

  const typed = answers
    .filter((answer) => answer.text !== TAKEN_BY_DEFAULT)
    .map((answer) => `${answer.id}: ${answer.text}`);

  const parts = [note, ...typed].filter((part) => part !== "");

  return `${REVIEWER_PREFIX}${parts.length === 0 ? ALL_AS_RECOMMENDED : parts.join("\n\n")}`;
}

/**
 * What the engine submits, past its cursor and in file order. Nothing Claude says cancels an
 * entry, and the end comes after the replies still due.
 *
 * FIXME: the lock lets Claude write in the working directory, so a `Reviewer` block it forged
 * is relayed under the prefix. It stays attributed to the plugin, never to the user.
 */
export function relaysOf(doc: string, name: string, after: number): Relay[] {
  const all = replies(doc);

  const entries: Relay[] = [
    { kind: "opened", seq: 0, name, subject: subjectOf(doc) },
    ...all.map((reply, index): Relay => ({
      kind: "reply",
      seq: index + 1,
      text: replyText(reply[1] ?? ""),
    })),
  ];

  if (FOOTER.exec(doc)?.[1] === "page") entries.push({ kind: "ended", seq: all.length + 1, name });

  return entries.filter((entry) => entry.seq > after);
}

/** Working while the reviewer spoke last: the opening, or a reply no voice of Claude follows. */
export function phaseOf(doc: string): Phase {
  return doc.includes(CLAUDE_VOICE, replies(doc).at(-1)?.index ?? 0) ? "waiting" : "working";
}

function lineText(lines: readonly string[]): string {
  return lines.join("\n").trim();
}

/** A question runs from its `❓` line to the rule that closes it; what follows is Markdown again. */
function cut(text: string, answers: ReadonlyMap<string, string>): Segment[] {
  const lines = text.split("\n");
  const starts = lines.flatMap((line, index) => (QUESTION.test(line) ? [index] : []));
  const segments: Segment[] = [{ kind: "markdown", text: lines.slice(0, starts[0]).join("\n") }];

  for (const [index, start] of starts.entries()) {
    const next = starts[index + 1] ?? lines.length;
    const rule = lines.slice(start, next).findIndex((line) => RULE.test(line));
    const end = rule === -1 ? next : start + rule;
    const body = lines.slice(start + 1, end);
    const rec = body.findIndex((line) => RECOMMENDATION.test(line));
    const [, id = "", title = "", ask = ""] = QUESTION.exec(lines[start] ?? "") ?? [];
    const asked = rec === -1 ? body : body.slice(0, rec);
    const recommended = RECOMMENDATION.exec(body[rec] ?? "")?.[1] ?? "";

    segments.push(
      {
        kind: "question",
        id,
        title,
        ask: lineText([ask, ...asked]),
        rec: rec === -1 ? "" : lineText([recommended, ...body.slice(rec + 1)]),
        answer: answers.get(id) ?? null,
      },
      { kind: "markdown", text: lines.slice(end + 1, next).join("\n") },
    );
  }

  return segments.filter((segment) => segment.kind === "question" || segment.text.trim() !== "");
}

/**
 * The whole file for the page. Every question is a card, so the markers never reach the screen,
 * and an answer is read beside its question: of a reply, only the note stays as text.
 */
export function segmentsOf(doc: string): Segment[] {
  const shown = doc.replaceAll(REPLY, (_, reply: string) => {
    const { note } = partsOf(reply);

    return note === "" ? "" : `### Reviewer\n\n${note}\n\n`;
  });

  return cut(shown, answersOf(doc));
}
