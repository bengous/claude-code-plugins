import type { On, ProcessSpawnChunk, ProcessSpawnResult } from "claude-code";

import { SERVER } from "./server.ts";

/** A review server as the module spawned it: its argv, and the test's hand on what it writes. */
export type Child = {
  readonly argv: readonly string[];
  /** The working directory it was spawned in; `undefined` is the session's, which follows every `cd`. */
  readonly cwd: string | undefined;
  /** Writes each line on stdout as JSON, all of them in one piece. */
  readonly write: (...lines: readonly unknown[]) => void;
  /** Writes text on stdout as it is: a line in two pieces, a line that is no JSON. */
  readonly print: (text: string) => void;
  readonly exit: (how: ProcessSpawnResult) => void;
  /** Whether the module ended it: `return()` on its stream, which kills a real child. */
  readonly killed: () => boolean;
};

/**
 * What a child does as it starts, by its rank from 1: by default it writes `ready`, and a
 * `deny` is a child that cannot start. The pieces it writes after are the test's.
 */
type Started = { readonly deny: string } | undefined;

/** A child's life beside its pieces: how it ended, once it has, and how to wake its stream. */
type Life = { ended: ProcessSpawnResult | null; killed: boolean; wake: () => void };

export type Spawn = (child: Child, run: number) => Started | Promise<Started>;

/** The identity of the channel every fake server serves, as `.review/channel.id` holds it. */
export const CHANNEL = "5d8f3c1e-channel";

export const READY = { type: "ready", ...SERVER, channel: CHANNEL };

export const STARTS: Spawn = (child) => {
  child.write(READY);
};

/** Every child the module spawned, in order; each one runs until the test ends it. */
export function children(on: On, spawn: Spawn = STARTS): Child[] {
  const spawned: Child[] = [];

  on("process.spawn", async function* (_, e, next) {
    const pieces: ProcessSpawnChunk[] = [];

    const life: Life = { ended: null, killed: false, wake: () => {} };

    next.signal.addEventListener("abort", () => {
      life.killed = true;
      life.ended = { code: null, signal: "SIGTERM" };
      life.wake();
    });

    const print = (text: string): void => {
      pieces.push({ stream: "stdout", text });
      life.wake();
    };

    const child: Child = {
      argv: e.argv,
      cwd: e.cwd,
      write: (...lines) => {
        print(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
      },
      print,
      exit: (how) => {
        life.ended = how;
        life.wake();
      },
      killed: () => life.killed,
    };

    spawned.push(child);
    const refused = await spawn(child, spawned.length);

    if (refused !== undefined) return refused;

    for (;;) {
      const piece = pieces.shift();

      if (piece !== undefined) {
        yield piece;
        continue;
      }

      if (life.ended !== null) return { value: life.ended };
      await new Promise<void>((resolve) => {
        life.wake = resolve;
      });
    }
  });

  return spawned;
}
