import type { On, ProcessSpawnChunk, ProcessSpawnResult } from "claude-code";

import { SERVER } from "./server.ts";

/** A review server as the module spawned it: its argv, and the test's hand on what it writes. */
export type Child = {
  readonly argv: readonly string[];
  /** Writes each line on stdout as JSON, all of them in one piece. */
  readonly write: (...lines: readonly unknown[]) => void;
  /** Writes text on stdout as it is: a line in two pieces, a line that is no JSON. */
  readonly print: (text: string) => void;
  readonly exit: (how: ProcessSpawnResult) => void;
};

/**
 * What a child does as it starts, by its rank from 1: by default it writes `ready`, and a
 * `deny` is a child that cannot start. The pieces it writes after are the test's.
 */
type Started = { readonly deny: string } | undefined;

/** A child's life beside its pieces: how it ended, once it has, and how to wake its stream. */
type Life = { ended: ProcessSpawnResult | null; wake: () => void };

export type Spawn = (child: Child, run: number) => Started | Promise<Started>;

export const READY = { type: "ready", ...SERVER };

export const STARTS: Spawn = (child) => {
  child.write(READY);
};

/** Every child the module spawned, in order; each one runs until the test ends it. */
export function children(on: On, spawn: Spawn = STARTS): Child[] {
  const spawned: Child[] = [];

  on("process.spawn", async function* (_, e) {
    const pieces: ProcessSpawnChunk[] = [];

    const life: Life = { ended: null, wake: () => {} };

    const print = (text: string): void => {
      pieces.push({ stream: "stdout", text });
      life.wake();
    };

    const child: Child = {
      argv: e.argv,
      write: (...lines) => {
        print(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
      },
      print,
      exit: (how) => {
        life.ended = how;
        life.wake();
      },
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
