import { AS_RECOMMENDED } from "./protocol.ts";
import type { Answer, CloseReason, GrillPosts, Phase, Question, Relay } from "./protocol.ts";

/**
 * The transcript as text: every function takes the file and returns the file. What the page and
 * the hooks module need to know is read off it, so the file is the only state a grill has.
 */

/**
 * The file cut for the page: its opening and its end as data, so the page says them in its own
 * words and never the session; Markdown to render; each question as data, beside its answer.
 */
export type Segment =
  | { readonly kind: "opened"; readonly subject: string; readonly at: string }
  | { readonly kind: "closed"; readonly at: string; readonly reason: CloseReason | "approved" }
  | { readonly kind: "markdown"; readonly text: string }
  | ({
      readonly kind: "question";
      readonly id: string;
      readonly round: number;
      readonly answer: Answer;
    } & Question);

/** An answer the reviewer sent for one question, by its id (`Q3`). */
export type TypedAnswer = { readonly id: string; readonly text: string };

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

const STAMP = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}`;

const FOOTER = new RegExp(String.raw`\n---\n\nClosed (${STAMP}) · ([a-z]+)\n$`, "u");

/** As `header` writes it: the subject, the stamp, and the session the page never shows. */
const HEADER = new RegExp(String.raw`^# Grill: (.*)\n\nStarted (${STAMP}) · session \w*\n`, "u");

/** As `appendQuestions` writes it, and as Claude types it by hand: a dash of any length, the colon or none. */
const QUESTION = /^❓\s*\*\*(Q\d+)\*\*\s*[-–—]\s*\*\*(.+?)\*\*:?\s*(.*)$/u;

/** Every question's number, read as `QUESTION` reads a question: one reader, or a hand-typed number is reused. */
const ASKED = /^❓\s*\*\*Q(\d+)\*\*/gmu;

/** As `appendQuestions` writes it; quoted text cannot, its `#` escaped. */
const ROUND_HEADING = /^## Round (\d+)$/u;

const EVENT = /^_\(session: .*\)_$/u;

/** As `appendAnswer` writes a turn that did not end on Claude's answer; quoted text cannot, its `_` escaped. */
const TURN_CUT = /^_\(turn [^)\n]*\)_$/u;

const RECOMMENDATION = /^➡️ ?(.*)$/u;

const RULE = /^\s*-{3,}\s*$/u;

const ANSWER_LINE = /^(Q\d+): /u;

const NOTE = "Note: ";

const REVIEWER_PREFIX = "Reviewer: ";

const ALL_AS_RECOMMENDED = "all open questions as recommended.";

/**
 * A line of the reviewer's text that a reader of the file could take for its own: a voice, a
 * round, an event, a footer, a rule, a question, a recommendation, an answer or the note, behind
 * any backslashes the reviewer typed.
 */
const REVIEWER_MARKER = String.raw`(?=#|_\(session: |❓|➡|Q\d+: |Note: |[^\S\n\r\u2028\u2029]*-{3,}\s*$)`;

const REVIEWER_LINE = new RegExp(String.raw`^(\\*)${REVIEWER_MARKER}`, "gmu");

const REVIEWER_QUOTED = new RegExp(String.raw`^\\(\\*)${REVIEWER_MARKER}`, "gmu");

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

/**
 * Opens a round: the questions under Claude's voice, each closed by a rule. A question's texts are
 * quoted as Claude's own; its title comes on one line, as the parser takes it.
 */
export function appendQuestions(doc: string, questions: readonly Question[]): string {
  const first = nextQuestion(doc);
  const n = (doc.match(ROUND)?.length ?? 0) + 1;

  const round = questions
    .map(
      (question, index) =>
        `❓ **Q${first + index}** - **${question.title}**: ${quotedQuestion(question.ask)}\n\n➡️ ${quotedQuestion(question.rec)}\n\n---\n`,
    )
    .join("\n");

  return `${doc}\n## Round ${n}\n${CLAUDE_VOICE}${round}`;
}

function replies(doc: string): RegExpExecArray[] {
  return [...doc.matchAll(REPLY)];
}

type Parts = { readonly answers: readonly TypedAnswer[]; readonly note: string };

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

/**
 * The reviewer's text as the file keeps it: one backslash more before each line a reader could
 * take for the file's own, so `unquotedReviewer` gives it back whole.
 */
function quotedReviewer(text: string): string {
  return text.replaceAll(REVIEWER_LINE, "\\$1");
}

/** The reviewer's text as they typed it, for the page. */
function unquotedReviewer(text: string): string {
  return text.replaceAll(REVIEWER_QUOTED, "$1");
}

/**
 * The reviewer's text as Claude reads it: as typed, but for a line that starts like an answer,
 * which keeps a backslash, or Claude would take it for that question's answer (`grilling.md`).
 */
function relayedReviewer(text: string): string {
  return unquotedReviewer(text).replaceAll(/^(\\*)(?=Q\d+: )/gmu, "\\$1");
}

/** Every answer of the file, by question id, as the reviewer typed it; the first one stands. */
export function answersOf(doc: string): ReadonlyMap<string, string> {
  const answers = new Map<string, string>();

  for (const reply of replies(doc)) {
    for (const { id, text } of partsOf(reply[1] ?? "").answers) {
      if (!answers.has(id)) answers.set(id, unquotedReviewer(text));
    }
  }

  return answers;
}

/** The questions no reply answered, in the order they were asked, whatever happened since. */
export function unanswered(doc: string): string[] {
  const answers = answersOf(doc);

  return [...new Set(doc.split("\n").flatMap((line) => QUESTION.exec(line)?.[1] ?? []))].filter(
    (id) => !answers.has(id),
  );
}

/**
 * The reviewer's reply, written in the round of its questions. It closes every open question:
 * one the reviewer left empty takes the recommendation, and says it did so by default. `null`
 * when there is nothing to write.
 */
export function appendReply(
  doc: string,
  answers: readonly TypedAnswer[],
  note: string,
): string | null {
  const typed = new Map(answers.map(({ id, text }) => [id, quotedReviewer(text.trim())]));

  const lines = unanswered(doc).map((id) => `${id}: ${typed.get(id) || TAKEN_BY_DEFAULT}`);

  if (note.trim() !== "") lines.push(`${NOTE}${quotedReviewer(note.trim())}`);

  return lines.length === 0 ? null : `${doc}${REVIEWER_VOICE}${lines.join("\n\n")}\n`;
}

/**
 * Claude's text as a quotation: the file's structure is read off its lines, so a heading, an
 * event, a turn's end or a footer inside the text would speak for the reviewer, open a round,
 * stop the turn or close the grill. A backslash keeps each one text, and Markdown draws it as it
 * was typed.
 */
function quoted(text: string): string {
  return text
    .replaceAll(/^(?=#|_\((?:session: |turn ))/gmu, "\\")
    .replaceAll(/^(?=-{3,}\s*\n\s*\nClosed )/gmu, "\\");
}

/**
 * A question's text as a quotation, and more than Claude's: a line that opens a question, gives
 * a recommendation or closes a card would cut the question where Claude did not. A backslash
 * escapes no emoji in Markdown, so those two go as an entity, which it draws as the emoji. Every
 * break becomes `\n`: the `❓` and `➡️` lines are read by `\n`, and a CR or a line separator on
 * their first line would end the question's line where its reader does not.
 */
function quotedQuestion(text: string): string {
  return quoted(text.replaceAll(/\r\n?|[\u2028\u2029]/gu, "\n"))
    .replaceAll(/^([^\S\n\r\u2028\u2029]*)(?=-{3,}\s*$)/gmu, "$1\\")
    .replaceAll(/^❓/gmu, "&#x2753;")
    .replaceAll(/^➡/gmu, "&#x27A1;");
}

/** Where the last round's questions end: at the first reply that follows them, else at the end of the file. */
function roundEnd(doc: string): number {
  const round = [...doc.matchAll(ROUND)].at(-1)?.index;
  const reply = round === undefined ? -1 : doc.indexOf(REVIEWER_VOICE, round);

  return reply === -1 ? doc.length : reply;
}

/**
 * Claude's final text, kept only when its turn belongs to the grill: the turn that asked a round,
 * whoever started it, closes that round, before any reply sent meanwhile, since the reply still
 * waits for Claude; a turn a vellum relay started speaks in a voice of its own. A turn the
 * terminal started is not the grill's, whatever the file's last voice is.
 */
export function appendAnswer(doc: string, turn: GrillPosts["answer"]): string {
  const ended = turn.reason === "answer" ? "" : `_(turn ${turn.reason})_`;
  const body = [quoted(turn.text.trim()), ended].filter((part) => part !== "").join("\n\n");

  if (turn.asked) {
    const at = roundEnd(doc);

    return body === "" ? doc : `${doc.slice(0, at)}\n${body}\n${doc.slice(at)}`;
  }

  return turn.own ? `${doc}${CLAUDE_VOICE}${body === "" ? "_(no text)_" : body}\n` : doc;
}

/** A reply as the agent reads it: the note first, then the answers the reviewer typed. A default never goes: `grilling.md` says an absent question took the recommendation. */
function replyText(reply: string): string {
  const { answers, note } = partsOf(reply);

  const typed = answers
    .filter((answer) => answer.text !== TAKEN_BY_DEFAULT)
    .map((answer) => `${answer.id}: ${relayedReviewer(answer.text)}`);

  const parts = [relayedReviewer(note), ...typed].filter((part) => part !== "");

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

  if (FOOTER.exec(doc)?.[2] === "page") entries.push({ kind: "ended", seq: all.length + 1, name });

  return entries.filter((entry) => entry.seq > after);
}

/**
 * Asking while a question waits for the reviewer; working while the reviewer spoke last, the
 * opening or a reply no voice of Claude follows; else Claude's last voice says how its turn ended.
 */
export function phaseOf(doc: string): Phase {
  if (unanswered(doc).length > 0) return "asking";
  const voice = doc.lastIndexOf(CLAUDE_VOICE);

  if (voice === -1 || voice < (replies(doc).at(-1)?.index ?? 0)) return "working";

  const said = doc
    .slice(voice)
    .split("\n")
    .findLast((line) => line.trim() !== "" && !EVENT.test(line));

  return TURN_CUT.test(said ?? "") ? "stopped" : "idle";
}

function lineText(lines: readonly string[]): string {
  return lines.join("\n").trim();
}

/** An answer's text as the file wrote it, by its kind; `undefined` while no reply gave one. */
function answerOf(text: string | undefined): Answer {
  if (text === undefined) return { kind: "open" };

  if (text === TAKEN_BY_DEFAULT) return { kind: "default" };

  return text === AS_RECOMMENDED ? { kind: "recommended" } : { kind: "typed", text };
}

/** The round each line stands in: the last `## Round n` above it, 0 before the first. */
function roundsOfLines(lines: readonly string[]): number[] {
  const rounds: number[] = [];

  for (const line of lines) {
    const heading = ROUND_HEADING.exec(line)?.[1];
    rounds.push(heading === undefined ? (rounds.at(-1) ?? 0) : Number.parseInt(heading, 10));
  }

  return rounds;
}

/** A question runs from its `❓` line to the rule that closes it; what follows is Markdown again. */
function cut(text: string, answers: ReadonlyMap<string, string>): Segment[] {
  const lines = text.split("\n");
  const rounds = roundsOfLines(lines);
  // A number is one question, as it is one answer: a card typed again under it stays text.
  const seen = new Set<string>();

  const starts = lines.flatMap((line, index) => {
    const id = QUESTION.exec(line)?.[1];

    if (id === undefined || seen.has(id)) return [];
    seen.add(id);

    return [index];
  });

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
        round: rounds[start] ?? 0,
        title,
        ask: lineText([ask, ...asked]),
        rec: rec === -1 ? "" : lineText([recommended, ...body.slice(rec + 1)]),
        answer: answerOf(answers.get(id)),
      },
      { kind: "markdown", text: lines.slice(end + 1, next).join("\n") },
    );
  }

  return segments.filter((segment) => segment.kind !== "markdown" || segment.text.trim() !== "");
}

function closeReasonOf(word: string): CloseReason | "approved" | null {
  return word === "page" || word === "stop" || word === "approved" ? word : null;
}

/**
 * The whole file for the page. The opening and the end are data; every question is a card, so
 * the markers never reach the screen; an answer is read beside its question: of a reply, only
 * the note stays as text.
 */
export function segmentsOf(doc: string): Segment[] {
  const head = HEADER.exec(doc);
  const foot = FOOTER.exec(doc);
  const reason = foot === null ? null : closeReasonOf(foot[2] ?? "");

  const opened: Segment[] =
    head === null ? [] : [{ kind: "opened", subject: head[1] ?? "", at: head[2] ?? "" }];

  const closed: Segment[] =
    foot === null || reason === null ? [] : [{ kind: "closed", at: foot[1] ?? "", reason }];

  const body = doc.slice(
    head?.[0].length ?? 0,
    reason === null || foot === null ? doc.length : foot.index,
  );

  const shown = body.replaceAll(REPLY, (_, reply: string) => {
    const { note } = partsOf(reply);

    return note === "" ? "" : `### Reviewer\n\n${quotedQuestion(unquotedReviewer(note))}\n\n`;
  });

  return [...opened, ...cut(shown, answersOf(doc)), ...closed];
}
