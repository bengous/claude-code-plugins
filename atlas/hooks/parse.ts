import type { Beat, Selection, ServerLine } from "../wire.ts";

/**
 * The module's boundary: the server's stdout and answers, the plugin's store, a skill's text and a
 * tool's input arrive as text or `unknown`, and are parsed here, once.
 */

/**
 * A map folder's server, under `map:<folder>`: the live one and the session that started it, or
 * the claim of a session starting one, and when it claimed, so a second session waits for it.
 */
export type MapRecord =
  | { readonly kind: "live"; readonly port: number; readonly session: string }
  | { readonly kind: "claimed"; readonly session: string; readonly at: number };

/** The map folders a Claude Code session shows, under `session:<id>`: a reload attaches them again. */
export type SessionRecord = { readonly folders: readonly string[] };

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser of the server's output, the plugin's store, and a tool's input. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536;
}

function recordOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseSelection(value: unknown): Selection | null {
  if (!isRecord(value)) return null;
  const { id, label } = value;

  if (id === null) return { id: null };

  return typeof id === "string" && typeof label === "string" ? { id, label } : null;
}

/** A JSON line of serve.ts after its address; `null` for its plain lines, a rebuild's. */
export function parseServerLine(text: string): ServerLine | null {
  const value = recordOf(text);

  if (value?.type !== "selection") return null;
  const selection = parseSelection(value);

  return selection === null ? null : { type: "selection", ...selection };
}

export function parseBeat(text: string): Beat | null {
  const value = recordOf(text);

  return typeof value?.folder === "string" ? { folder: value.folder } : null;
}

/** The port of serve.ts's first line, the page's address `http://127.0.0.1:<port>/<page>`. */
export function readyPort(line: string): number | null {
  const url = URL.parse(line.trim());
  const port = url === null ? null : Number(url.port);

  return url?.hostname === "127.0.0.1" && isPort(port) ? port : null;
}

export function parseMapRecord(value: unknown): MapRecord | null {
  if (!isRecord(value) || typeof value.session !== "string") return null;
  const { kind, session } = value;

  if (kind === "live") return isPort(value.port) ? { kind, port: value.port, session } : null;

  return kind === "claimed" && typeof value.at === "number" && Number.isFinite(value.at)
    ? { kind, session, at: value.at }
    : null;
}

export function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!isRecord(value) || !Array.isArray(value.folders)) return null;
  const folders = value.folders.filter((folder): folder is string => typeof folder === "string");

  return folders.length === value.folders.length ? { folders } : null;
}

/** A tool's string argument, trimmed; `null` when the model gave none. */
export function textArgument(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";

  return text === "" ? null : text;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

const ARGUMENTS = "\n\nARGUMENTS: ";

/**
 * The words the person typed after the skill's name, a word in double or single quotes taken
 * whole, spaces and all: with no `$ARGUMENTS` in its file, Claude Code ends the skill's text with
 * `ARGUMENTS: <input>` before `skill.prompt` runs.
 */
export function argumentsOf(text: string): readonly string[] {
  const at = text.lastIndexOf(ARGUMENTS);

  if (at === -1) return [];
  const typed = text.slice(at + ARGUMENTS.length);

  return [...typed.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)].map(
    ([word = "", doubled, single]) => doubled ?? single ?? word,
  );
}
