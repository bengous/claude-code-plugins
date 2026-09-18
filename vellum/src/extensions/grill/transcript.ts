import type { Question } from "./protocol.ts";

/**
 * The transcript as text: every function takes the file and returns the file. What the page and
 * the hooks module need to know is read off it, so the file is the only state a grill has.
 */

export type Phase = "working" | "waiting";

/** The file cut for the page: Markdown to render, and each question as data. */
export type Segment =
  | { readonly kind: "markdown"; readonly text: string }
  | ({ readonly kind: "question"; readonly id: string; readonly open: boolean } & Question);

export const REVIEWER = "Reviewer";

const CLAUDE = "Claude";

/** A round heading followed by its voice: a bare `## Round 1` inside Claude's own text is not one. */
const ROUND = /^## Round (\d+)\n\n### ([^\n]+)\n/gmu;

const ANSWER = `\n### ${CLAUDE}\n\n`;

const FOOTER = /\n---\n\nClosed \d{4}-\d{2}-\d{2} \d{2}:\d{2} · ([a-z]+)\n$/u;

/** As `appendQuestions` writes it, and as Claude types it by hand: a dash of any length, the colon or none. */
const QUESTION = /^❓\s*\*\*(Q\d+)\*\*\s*[-–—]\s*\*\*(.+?)\*\*:?\s*(.*)$/u;

const RECOMMENDATION = /^➡️ ?(.*)$/u;

const RULE = /^\s*-{3,}\s*$/u;

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

export function appendPrompt(doc: string, author: string, text: string): string {
  const round = (doc.match(ROUND)?.length ?? 0) + 1;

  return `${doc}\n## Round ${round}\n\n### ${author}\n\n${text.trim()}\n`;
}

export function isClosed(doc: string): boolean {
  return FOOTER.test(doc);
}

/** The reason the footer gives; `null` while the grill is open. */
export function closedBy(doc: string): string | null {
  return FOOTER.exec(doc)?.[1] ?? null;
}

/** Working while the last round has no answer after its prompt. */
export function phaseOf(doc: string): Phase {
  const round = [...doc.matchAll(ROUND)].at(-1);

  return round !== undefined && doc.lastIndexOf(ANSWER) < round.index ? "working" : "waiting";
}

/** Claude's final text; after an `ask` of the same turn it continues that voice under the questions. */
export function appendAnswer(doc: string, text: string, reason: string): string {
  const asked = phaseOf(doc) === "waiting" && doc.includes(ANSWER);
  const ended = reason === "answer" ? "" : `_(turn ${reason})_`;
  const body = [text.trim(), ended].filter((part) => part !== "").join("\n\n");

  if (asked) return body === "" ? doc : `${doc}\n${body}\n`;

  return `${doc}${ANSWER}${body === "" ? "_(no text)_" : body}\n`;
}

/** Numbers run across the whole grill: the next one follows the highest already asked. */
export function nextQuestion(doc: string): number {
  return (
    Math.max(0, ...[...doc.matchAll(/^❓ \*\*Q(\d+)\*\*/gmu)].map((match) => Number(match[1]))) + 1
  );
}

/** Writes a round of questions under Claude's voice, each closed by a rule. */
export function appendQuestions(doc: string, questions: readonly Question[]): string {
  const first = nextQuestion(doc);
  const voice = phaseOf(doc) === "working" ? ANSWER : "\n";

  const round = questions
    .map(
      (question, index) =>
        `❓ **Q${first + index}** - **${question.title}**: ${question.ask}\n\n➡️ ${question.rec}\n\n---\n`,
    )
    .join("\n");

  return `${doc}${voice}${round}`;
}

export function appendFooter(doc: string, reason: string, date: Date): string {
  return `${doc}\n---\n\nClosed ${stamp(date)} · ${reason}\n`;
}

/**
 * The last round the reviewer wrote, while no answer of Claude follows it. A round typed in the
 * terminal meanwhile does not cancel it: the reviewer's words still have to reach Claude.
 */
export function reviewerRound(
  doc: string,
): { readonly round: number; readonly text: string } | null {
  const rounds = [...doc.matchAll(ROUND)];
  const at = rounds.findLastIndex((round) => round[2] === REVIEWER);
  const last = rounds[at];

  if (last === undefined || doc.includes(ANSWER, last.index)) return null;
  const end = rounds[at + 1]?.index ?? doc.length;

  return { round: Number(last[1]), text: doc.slice(last.index + last[0].length, end).trim() };
}

function lineText(lines: readonly string[]): string {
  return lines.join("\n").trim();
}

/** A question runs from its `❓` line to the rule that closes it; what follows is Markdown again. */
function cut(text: string, open: boolean): Segment[] {
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
        open,
      },
      { kind: "markdown", text: lines.slice(end + 1, next).join("\n") },
    );
  }

  return segments.filter((segment) => segment.kind === "question" || segment.text.trim() !== "");
}

/**
 * The whole file for the page. Every question is a card, so the markers never reach the screen;
 * the ones asked since Claude's last voice take an answer while the grill waits for the reviewer.
 */
export function segmentsOf(doc: string): Segment[] {
  const voice = doc.lastIndexOf(ANSWER);
  const at = voice === -1 ? doc.length : voice;
  const waiting = !isClosed(doc) && phaseOf(doc) === "waiting";

  return [...cut(doc.slice(0, at), false), ...cut(doc.slice(at), waiting)];
}
