import type { HttpResponse, On, ProcessSpawnChunk, ProcessSpawnResult } from "claude-code";
import { mock, type MockClock } from "claude-code/testing";

import type { SessionRecord } from "./parse.ts";

/** The world beneath the module in a kit test: what it answers, and what the module did there. */

export const SESSION_ID = "2b7e1c4a-5f0d-4a8e-9c3b-61d2e8f4a7c9";

export const ROOT = "/work/app";

export const SERVER = { port: 4242, token: "tok" } as const;

export const READY = { type: "ready", ...SERVER } as const;

/** A server as the module spawned it: its argv, and the test's hand on what it writes. */
export type Child = {
  readonly argv: readonly string[];
  /** Writes each line on stdout as JSON, all of them in one piece. */
  readonly write: (...lines: readonly object[]) => void;
  readonly exit: (how: ProcessSpawnResult) => void;
  /** Whether the module ended it: `return()` on its stream, which kills a real child. */
  readonly killed: () => boolean;
};

/** What a child does as it starts: by default it writes `ready`; a `deny` is a child that cannot start. */
type Spawn = (child: Child) => { readonly deny: string } | undefined;

const STARTS: Spawn = (child) => {
  child.write(READY);
};

export type Request = { readonly path: string; readonly body: string | undefined };

export type World = {
  id: string;
  /** While set, the next prompts are dropped with this reason. */
  drop: string | undefined;
  readonly clock: MockClock;
  readonly children: Child[];
  readonly requests: Request[];
  readonly prompts: string[];
  readonly statuses: (string | undefined)[];
  readonly logs: string[];
  /** The plugin's store, keyed `session:<id>`. */
  readonly store: Map<string, SessionRecord>;
};

export type WorldOptions = {
  readonly spawn?: Spawn;
  readonly stored?: ReadonlyMap<string, SessionRecord>;
};

/** A child's life beside its pieces: how it ended, once it has, and how to wake its stream. */
type Life = { ended: ProcessSpawnResult | null; killed: boolean; wake: () => void };

function reply(status: number): HttpResponse {
  return { status, ok: status < 300, headers: {}, text: "" };
}

function children(on: On, spawn: Spawn, spawned: Child[]): void {
  on("process.spawn", async function* (_, e, next) {
    const pieces: ProcessSpawnChunk[] = [];
    const life: Life = { ended: null, killed: false, wake: () => {} };

    next.signal.addEventListener("abort", () => {
      life.killed = true;
      life.ended = { code: null, signal: "SIGTERM" };
      life.wake();
    });

    const child: Child = {
      argv: e.argv,
      write: (...lines) => {
        pieces.push({
          stream: "stdout",
          text: lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
        });
        life.wake();
      },
      exit: (how) => {
        life.ended = how;
        life.wake();
      },
      killed: () => life.killed,
    };

    spawned.push(child);
    const refused = spawn(child);

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
}

export function world(on: On, options: WorldOptions = {}): World {
  const built: World = {
    id: SESSION_ID,
    drop: undefined,
    clock: mock.clock(on),
    children: [],
    requests: [],
    prompts: [],
    statuses: [],
    logs: [],
    store: new Map(options.stored ?? []),
  };

  children(on, options.spawn ?? STARTS, built.children);

  on("http.fetch", (_, e) => {
    const { pathname, port } = new URL(e.url);

    if (Number(port) !== SERVER.port) return { deny: `ECONNREFUSED ${e.url}` };
    const prefix = `/t/${SERVER.token}/`;
    built.requests.push({ path: pathname.slice(prefix.length), body: e.init?.body });

    return { value: reply(204) };
  });

  on("prompt.submit", (_, e) => {
    if (built.drop !== undefined) return { drop: built.drop };
    built.prompts.push(e.text);

    return { text: e.text };
  });

  on("store.get", (_, e) => ({ value: built.store.get(e.key) }));

  on("store.set", (_, e) => {
    // SAFETY: the module stores its session records alone, which its parser reads back.
    built.store.set(e.key, e.value as SessionRecord);

    return { value: undefined };
  });

  on("store.delete", (_, e) => {
    built.store.delete(e.key);

    return { value: undefined };
  });

  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.id", () => ({ value: built.id }));
  on("session.root", () => ({ value: ROOT }));
  on("skill.prompt", () => ({ text: "t" }));
  on("command.run", () => ({ text: "" }));

  on("ui.status", (_, e) => {
    built.statuses.push(e.text);

    return { value: undefined };
  });

  on("ui.log", (_, e) => {
    built.logs.push(e.text);

    return { value: undefined };
  });

  return built;
}

/** What the module posted to `api/delivery`, in order. */
export function deliveries(seen: World): (string | undefined)[] {
  return seen.requests
    .filter((request) => request.path === "api/delivery")
    .map((request) => request.body);
}
