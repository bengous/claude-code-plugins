import type { RegistryEntry } from "./wire.ts";

/**
 * The registry entry as its two readers take it: the server, which prunes the entries of servers
 * gone, and the Vite plugin, which loads the overlay of a live one.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser of the registry, files another process wrote. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function entryOf(value: unknown): RegistryEntry | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const { session, root, port, token, pid, started } = value;

  return typeof session === "string" &&
    typeof root === "string" &&
    typeof port === "number" &&
    typeof token === "string" &&
    typeof pid === "number" &&
    typeof started === "number"
    ? { version: 1, session, root, port, token, pid, started }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

/** The entry a file's text holds; `null` for any other text, such as a file another server is still writing. */
export function parseEntry(text: string): RegistryEntry | null {
  try {
    return entryOf(JSON.parse(text));
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    // EPERM: the process is there, another user's.
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}
