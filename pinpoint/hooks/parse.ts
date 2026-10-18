import type { ServerLine } from "../shared/wire.ts";

/**
 * The module's boundary: a line of the server's stdout, a record of `$.store` and a key of the
 * settings arrive as text or `unknown`, and are parsed here, once.
 */

/** What the store keeps per Claude Code session, under `session:<id>`, so a reload starts the server again where it was. */
export type SessionRecord = {
  /** The id the server was started under, kept across a `/clear`: its files live under it. */
  readonly serverSession: string;
  readonly root: string;
  readonly port: number;
  readonly token: string;
  /** The app the server serves, as its `ready` or `target` line last said: a revival serves it again. */
  readonly target: string | null;
  /** The last batch handed to the session: a server that tells it again is not relayed twice. */
  readonly relayed: number;
};

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser of the server's stdout and of the plugin's store. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** An app's address as the server writes it, an `http(s)` URL's `href`. */
function isAddress(value: unknown): value is string {
  const url = typeof value === "string" ? URL.parse(value) : null;

  return url !== null && (url.protocol === "http:" || url.protocol === "https:");
}

export function parseServerLine(text: string): ServerLine | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;

  if (value.type === "ready") {
    const { port, token, target } = value;

    return typeof port === "number" &&
      typeof token === "string" &&
      (target === null || isAddress(target))
      ? { type: "ready", port, token, target }
      : null;
  }

  if (value.type === "batch") {
    const { seq, text: said } = value;

    return typeof seq === "number" && typeof said === "string"
      ? { type: "batch", seq, text: said }
      : null;
  }

  if (value.type === "target") {
    const { target } = value;

    return isAddress(target) ? { type: "target", target } : null;
  }

  return null;
}

const ARGUMENTS = "\n\nARGUMENTS: ";

/**
 * What the person typed after the skill's name, `null` for nothing: with no `$ARGUMENTS` in its
 * file, Claude Code ends the skill's text with `ARGUMENTS: <input>`, before `skill.prompt` runs.
 * The input may run over several lines.
 */
export function argumentsOf(text: string): string | null {
  const at = text.lastIndexOf(ARGUMENTS);
  const given = at === -1 ? "" : text.slice(at + ARGUMENTS.length).trim();

  return given === "" ? null : given;
}

export function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!isRecord(value)) return null;
  const { serverSession, root, port, token, relayed } = value;
  // A record the module stored before it kept an app has no `target`: read as none, so a reload
  // still revives its server on the port and token its pages load from, and the batch it last
  // handed over is not handed over twice.
  const target = "target" in value ? value.target : null;

  return typeof serverSession === "string" &&
    typeof root === "string" &&
    typeof port === "number" &&
    typeof token === "string" &&
    (target === null || isAddress(target)) &&
    typeof relayed === "number"
    ? { serverSession, root, port, token, target, relayed }
    : null;
}

/** Claude Code's `cleanupPeriodDays` when no settings set it. */
const CLEANUP_PERIOD_DEFAULT = 30;

/**
 * How many days Claude Code keeps a session's data, as the merged settings' `cleanupPeriodDays`
 * says: `null` for a value it refuses, under which it pauses its own sweep.
 */
export function retentionDays(value: unknown): number | null {
  if (value === undefined) return CLEANUP_PERIOD_DEFAULT;

  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** What `$.store.get` gave for a session: nothing, a record, or a value that is not one. */
export type Stored =
  | { readonly kind: "none" }
  | { readonly kind: "kept"; readonly record: SessionRecord }
  | { readonly kind: "unreadable"; readonly value: string };

export function storedRecord(value: unknown): Stored {
  if (value === undefined) return { kind: "none" };
  const record = parseSessionRecord(value);

  return record === null
    ? { kind: "unreadable", value: JSON.stringify(value).slice(0, 200) }
    : { kind: "kept", record };
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */
