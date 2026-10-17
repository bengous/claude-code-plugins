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
    const { port, token } = value;

    return typeof port === "number" && typeof token === "string"
      ? { type: "ready", port, token }
      : null;
  }

  if (value.type === "batch") {
    const { seq, text: said } = value;

    return typeof seq === "number" && typeof said === "string"
      ? { type: "batch", seq, text: said }
      : null;
  }

  return null;
}

export function parseSessionRecord(value: unknown): SessionRecord | null {
  if (!isRecord(value)) return null;
  const { serverSession, root, port, token, relayed } = value;

  return typeof serverSession === "string" &&
    typeof root === "string" &&
    typeof port === "number" &&
    typeof token === "string" &&
    typeof relayed === "number"
    ? { serverSession, root, port, token, relayed }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */
