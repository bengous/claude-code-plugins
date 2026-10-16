/** Under the repository's git common directory: every worktree records into the same buffer, and no commit carries it. */
export const FINDINGS_DIR = "todos/findings";

export const COMMAND = "todos-finding";

export const FINDING_ID = /^[0-9a-f]{8}$/u;

const FINDING_FILE = /^([0-9a-f]{8})\.json$/u;

const TARGET_LINE = /^(.+):(\d+)$/u;

// One simple command and nothing a shell expands: single quotes, double quotes without `$`, a backtick or a backslash, and plain words.
const PLAIN_COMMAND = new RegExp(
  String.raw`^${COMMAND}(?:[ \t]+(?:'[^']*'|"[^"$\x60\\]*"|[\w./:@%+=,-])+)*[ \t]*$`,
  "u",
);

export type FindingKind = "finding" | "security";

/** What `<id>.json` in the buffer holds. */
export type FindingRecord = {
  readonly path: string;
  readonly line: number | null;
  readonly why: string;
  readonly kind: FindingKind;
  readonly recordedAt: string;
};

export type Target = { readonly path: string; readonly line: number | null };

/** The one rule for a line, at the command and in a record: a whole number from 1. */
function isLineNumber(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function findingIdOf(fileName: string): string | null {
  return FINDING_FILE.exec(fileName)?.[1] ?? null;
}

/** `src/a.ts:12` names line 12 of `src/a.ts`; a path without `:<digits>` names the whole file. */
export function parseTarget(raw: string): Target {
  const match = TARGET_LINE.exec(raw);

  if (match?.[1] === undefined) return { path: raw, line: null };
  const line = Number(match[2]);

  if (!isLineNumber(line)) throw new Error(`${raw}: lines start at 1`);

  return { path: match[1], line };
}

export function formatRecord(record: FindingRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/* oxlint-disable anti-slop/no-runtime-typeof -- this function IS the boundary parser: a finding's file arrives as JSON text, a hand edit included, and nothing past it sees the record untyped. */
export function parseRecord(text: string): FindingRecord {
  const value: unknown = JSON.parse(text);

  if (
    typeof value !== "object" ||
    value === null ||
    !("path" in value && "line" in value && "why" in value && "kind" in value) ||
    !("recordedAt" in value)
  )
    throw new Error("not an object of path, line, why, kind and recordedAt");
  const { path, line, why, kind, recordedAt } = value;

  if (typeof path !== "string" || path === "") throw new Error("`path` is not a path");

  if (line !== null && !isLineNumber(line))
    throw new Error("`line` is neither null nor a line number");

  if (typeof why !== "string" || why.trim() === "") throw new Error("`why` is empty");

  if (kind !== "finding" && kind !== "security")
    throw new Error('`kind` is neither "finding" nor "security"');

  if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt)))
    throw new Error("`recordedAt` is not a date");

  return { path, line, why, kind, recordedAt };
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** A `todos-finding` call the band lets run unasked: it writes only the buffer, and a shell expands nothing in it. */
export function isPlainFindingCommand(command: string): boolean {
  return PLAIN_COMMAND.test(command);
}
