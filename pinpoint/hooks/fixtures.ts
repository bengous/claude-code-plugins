import type {
  HttpResponse,
  On,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnResult,
} from "claude-code";
import { mock, type MockClock } from "claude-code/testing";

import type { SessionRecord } from "./parse.ts";

/** The world beneath the module in a kit test: what it answers, and what the module did there. */

export const SESSION_ID = "2b7e1c4a-5f0d-4a8e-9c3b-61d2e8f4a7c9";

export const ROOT = "/work/app";

export const SERVER = { port: 4242, token: "tok" } as const;

export const READY = { type: "ready", ...SERVER, target: null } as const;

/** A server as the module spawned it: its argv, and the test's hand on what it writes. */
export type Child = {
  readonly argv: readonly string[];
  /** Writes each line on stdout as JSON, all of them in one piece. */
  readonly write: (...lines: readonly object[]) => void;
  readonly exit: (how: ProcessSpawnResult) => void;
  /** Breaks its stream: the module's next read of it rejects with `cause`. */
  readonly fail: (cause: string) => void;
  /** Whether the module ended it: `return()` on its stream, which kills a real child. */
  readonly killed: () => boolean;
};

/**
 * What a child does as it starts: by default it writes `ready`, serving the app its `--target`
 * names; a `deny` is a child that cannot start.
 */
type Spawn = (child: Child) => { readonly deny: string } | undefined;

const STARTS: Spawn = (child) => {
  const at = child.argv.indexOf("--target");
  child.write({ ...READY, target: at === -1 ? null : (child.argv[at + 1] ?? null) });
};

export type Request = { readonly path: string; readonly body: string | undefined };

export type World = {
  id: string;
  /** While set, the next prompts are dropped with this reason. */
  drop: string | undefined;
  /** While set, each prompt waits for it before it enters, as one waits for the session's turn. */
  turn: Promise<void> | undefined;
  /** While set, each delete from the store waits for it before it lands. */
  deleting: Promise<void> | undefined;
  /** While set, the server refuses each app `api/target` asks for, in these words. */
  refuse: string | undefined;
  readonly clock: MockClock;
  readonly children: Child[];
  readonly requests: Request[];
  /** What the module ran to its end, `$.process.run`, each argv. */
  readonly runs: (readonly string[])[];
  readonly prompts: string[];
  readonly statuses: (string | undefined)[];
  readonly logs: string[];
  /** The plugin's store, keyed `session:<id>`. */
  readonly store: Map<string, StoredValue>;
};

/** What the store may hold for a session: a record, or one an earlier version wrote, without `target`. */
export type StoredValue = SessionRecord | Omit<SessionRecord, "target">;

export type WorldOptions = {
  readonly spawn?: Spawn;
  readonly stored?: ReadonlyMap<string, StoredValue>;
};

type End = { readonly exit: ProcessSpawnResult } | { readonly fail: string };

/** A child's life beside its pieces: how it ended, once it has, and how to wake its stream. */
type Life = { end: End | null; killed: boolean; wake: () => void };

const RAN: ProcessRunResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  isStdoutTruncated: false,
  isStderrTruncated: false,
};

function reply(status: number, text = ""): HttpResponse {
  return { status, ok: status < 300, headers: {}, text };
}

function children(on: On, spawn: Spawn, spawned: Child[]): void {
  on("process.spawn", async function* (_, e, next) {
    const pieces: ProcessSpawnChunk[] = [];
    const life: Life = { end: null, killed: false, wake: () => {} };

    next.signal.addEventListener("abort", () => {
      life.killed = true;
      life.end = { exit: { code: null, signal: "SIGTERM" } };
      life.wake();
    });

    const ended = (end: End): void => {
      life.end = end;
      life.wake();
    };

    const child: Child = {
      argv: e.argv,
      write: (...lines) => {
        pieces.push({
          stream: "stdout",
          text: lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
        });
        life.wake();
      },
      exit: (how) => ended({ exit: how }),
      fail: (cause) => ended({ fail: cause }),
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

      if (life.end !== null) {
        if ("fail" in life.end) throw new Error(life.end.fail);

        return { value: life.end.exit };
      }

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
    turn: undefined,
    deleting: undefined,
    refuse: undefined,
    clock: mock.clock(on),
    children: [],
    requests: [],
    runs: [],
    prompts: [],
    statuses: [],
    logs: [],
    store: new Map(options.stored ?? []),
  };

  children(on, options.spawn ?? STARTS, built.children);

  on("http.fetch", (_, e) => {
    const { pathname, port } = new URL(e.url);

    if (Number(port) !== SERVER.port) return { deny: `ECONNREFUSED ${e.url}` };
    const path = pathname.slice(`/t/${SERVER.token}/`.length);
    built.requests.push({ path, body: e.init?.body });

    // As the real server does: its files removed, it answers, then its process ends.
    if (path === "api/close") built.children.at(-1)?.exit({ code: 0, signal: null });

    if (path === "api/target" && built.refuse !== undefined) {
      return { value: reply(400, built.refuse) };
    }

    return { value: reply(204) };
  });

  on("process.run", (_, e) => {
    built.runs.push(e.argv);

    return { value: RAN };
  });

  on("prompt.submit", async (_, e) => {
    if (built.turn !== undefined) await built.turn;

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

  on("store.delete", async (_, e) => {
    if (built.deleting !== undefined) await built.deleting;
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

/** What the module posted to `path`, in order. */
export function posted(seen: World, path: string): (string | undefined)[] {
  return seen.requests.filter((request) => request.path === path).map((request) => request.body);
}

/** What the module posted to `api/delivery`, in order. */
export function deliveries(seen: World): (string | undefined)[] {
  return posted(seen, "api/delivery");
}
