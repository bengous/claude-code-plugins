import type { FinalDir, ProjectPath, Version } from "./paths.ts";
import { parseFinalDir, parseProjectPath, parseVersion } from "./paths.ts";
import type { PlanWorkspace } from "./workspace.ts";
import { notesFile, projectPath, REVIEW_DIR } from "./workspace.ts";

/**
 * What reaches Claude, one line per entry, appended and never cut: an entry's number is its line
 * number. The approval's rename rewrites the paths inside the lines, as it does in every text file
 * of the directory, and never their order.
 *
 * FIXME: the lock lets Claude write in the working directory, `.review/` included, so a line it
 * appended here reaches Claude at the next catch-up. It stays attributed to the plugin, never to
 * the user.
 */
export const CHANNEL_FILE = `${REVIEW_DIR}/channel.jsonl`;

/**
 * The channel's identity, minted with it and carried by the approval's rename: the hooks module
 * keys what it relayed by it, since a new working directory at the same path is another channel.
 */
export const CHANNEL_ID_FILE = `${REVIEW_DIR}/channel.id`;

/** A feedback file of `.review/`: `v0.feedback-<k>.md` while drafting, `v<N>.feedback.md` after. */
const FEEDBACK_FILE = /^v(\d+)\.feedback(?:-(\d+))?\.md$/u;

/**
 * One thing the reviewer did that Claude must hear of. The core words `sent` and `approved`; an
 * extension words its own `text`, which the core relays as it is.
 */
export type ChannelEntry =
  | { readonly kind: "sent"; readonly file: ProjectPath }
  | {
      readonly kind: "approved";
      readonly version: Version;
      readonly dir: FinalDir;
      readonly notes: ProjectPath | null;
    }
  | { readonly kind: "text"; readonly from: string; readonly text: string };

export type ChannelLine = { readonly seq: number; readonly entry: ChannelEntry };

export function channelLine(entry: ChannelEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/** What `appended` answers: the text to append, and the entry's number once it is there. */
export type Appended = { readonly text: string; readonly seq: number };

/**
 * What an entry appends to the file as it stands, and the number it takes there. A last line with
 * no newline, written by hand, is ended first: it becomes a line of its own, and no entry is glued
 * to it.
 */
export function appended(text: string, entry: ChannelEntry): Appended {
  const ended = text === "" || text.endsWith("\n") ? "" : "\n";

  return { text: `${ended}${channelLine(entry)}`, seq: `${text}${ended}`.split("\n").length };
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- the block below IS the boundary parser the rules ask for: the channel file lies in the working directory, which Claude may write too, so every line is read back as `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pathOf(value: unknown): ProjectPath | null {
  const parsed = typeof value === "string" ? parseProjectPath(value) : null;

  return parsed?.ok === true ? parsed.value : null;
}

function parseEntry(value: unknown): ChannelEntry | null {
  if (!isRecord(value)) return null;

  if (value.kind === "sent") {
    const file = pathOf(value.file);

    return file === null ? null : { kind: "sent", file };
  }

  if (value.kind === "text") {
    return typeof value.from === "string" && typeof value.text === "string"
      ? { kind: "text", from: value.from, text: value.text }
      : null;
  }

  if (value.kind !== "approved" || typeof value.version !== "number") return null;
  const version = parseVersion(value.version);
  const dir = typeof value.dir === "string" ? parseFinalDir(value.dir) : null;
  const notes = value.notes === null ? null : pathOf(value.notes);

  if (!version.ok || dir?.ok !== true || (value.notes !== null && notes === null)) return null;

  return { kind: "approved", version: version.value, dir: dir.value, notes };
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */

/**
 * The entries past `after`, in order, each under its line's number. A line that is no entry is
 * left out, never answered in its place: the hooks module sees the number it skips.
 */
export function channelAfter(text: string, after: number): ChannelLine[] {
  return text
    .split("\n")
    .slice(0, -1)
    .flatMap((line, index) => {
      const entry = index + 1 > after ? parseEntry(parseLine(line)) : null;

      return entry === null ? [] : [{ seq: index + 1, entry }];
    });
}

/** `v<N>` then `k`, so the batches before the first version come first, in the order sent. */
function feedbackOrder(name: string): readonly [number, number] | null {
  const match = FEEDBACK_FILE.exec(name);

  return match === null ? null : [Number(match[1]), Number(match[2] ?? 0)];
}

/**
 * The entries the directory implies and the channel lacks: a `sent` for each feedback file no
 * entry names, and the approval of an approved directory. A write that landed while its entry did
 * not (a failed append, a server killed between the two) is told at the next start.
 */
export function untold(
  workspace: PlanWorkspace,
  names: ReadonlySet<string>,
  lines: readonly ChannelLine[],
): ChannelEntry[] {
  const named = new Set(lines.flatMap(({ entry }) => (entry.kind === "sent" ? [entry.file] : [])));

  const sent = [...names]
    .flatMap((name) => {
      const order = feedbackOrder(name);

      return order === null
        ? []
        : [{ order, file: projectPath(`${workspace.dir}${REVIEW_DIR}/${name}`) }];
    })
    .filter(({ file }) => !named.has(file))
    .toSorted((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
    .map(({ file }): ChannelEntry => ({ kind: "sent", file }));

  if (workspace.kind !== "approved" || lines.some(({ entry }) => entry.kind === "approved")) {
    return sent;
  }

  const { version, dir } = workspace;
  const notes = workspace.notes ? projectPath(`${dir}${notesFile(version)}`) : null;

  return [...sent, { kind: "approved", version, dir, notes }];
}
