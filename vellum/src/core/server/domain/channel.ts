import type { FinalDir, ParseResult, ProjectPath, Version } from "./paths.ts";
import { parseFinalDir, parseProjectPath, parseVersion } from "./paths.ts";
import { REVIEW_DIR } from "./workspace.ts";

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

/** The number the next entry takes: the file's lines so far, plus one. */
export function nextSeq(text: string): number {
  return text.split("\n").length;
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

/** The entries past `after`, in order; an error naming the first line past it that is no entry. */
export function channelAfter(text: string, after: number): ParseResult<ChannelLine[]> {
  const lines: ChannelLine[] = [];

  for (const [index, line] of text.split("\n").slice(0, -1).entries()) {
    const seq = index + 1;

    if (seq <= after) continue;
    const entry = parseEntry(parseLine(line));

    if (entry === null) {
      return {
        ok: false,
        error: `${CHANNEL_FILE}, line ${seq}, is no entry: ${line.slice(0, 200)}`,
      };
    }

    lines.push({ seq, entry });
  }

  return { ok: true, value: lines };
}
