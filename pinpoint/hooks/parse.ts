import type { ServerLine } from "../shared/wire.ts";

/**
 * The module's boundary: a line of the server's stdout and a record of `$.store` arrive as text
 * or `unknown`, and are parsed here, once.
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
      (target === null || typeof target === "string")
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

    return typeof target === "string" ? { type: "target", target } : null;
  }

  return null;
}

const ARGUMENTS = /\n\nARGUMENTS: (?<given>.*)$/u;

/**
 * What the person typed after the skill's name, `null` for nothing: with no `$ARGUMENTS` in its
 * file, Claude Code ends the skill's text with `ARGUMENTS: <input>`, before `skill.prompt` runs.
 */
export function argumentsOf(text: string): string | null {
  const given = ARGUMENTS.exec(text)?.groups?.given?.trim() ?? "";

  return given === "" ? null : given;
}

export function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!isRecord(value)) return null;
  const { serverSession, root, port, token, target, relayed } = value;

  return typeof serverSession === "string" &&
    typeof root === "string" &&
    typeof port === "number" &&
    typeof token === "string" &&
    (target === null || typeof target === "string") &&
    typeof relayed === "number"
    ? { serverSession, root, port, token, target, relayed }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */
