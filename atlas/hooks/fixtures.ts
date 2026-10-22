import type {
  FsEntry,
  HttpResponse,
  On,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  RenderSurface,
} from "claude-code";
import { mock, type MockClock } from "claude-code/testing";

import type { Selection } from "../wire.ts";
import { HEARTBEAT_HEADER } from "../wire.ts";
import type { MapRecord, SessionRecord } from "./parse.ts";

/** The world beneath the module in a kit test: what it answers, and what the module did there. */

export const SESSION_ID = "2b7e1c4a-5f0d-4a8e-9c3b-61d2e8f4a7c9";

export const CWD = "/work/repo";

export const MAP = `${CWD}/docs/map`;

export const OTHER_MAP = `${CWD}/maps/other`;

export const DRAFT = `${MAP}/drafts/rewire`;

/** A map folder outside the session's directory. */
export const ELSEWHERE = "/elsewhere/map";

/** A link to the map folder: the module keys a map by where it lands. */
export const LINKED = "/work/linked-map";

/** The first port a server on port 0 is given. */
export const FIRST_PORT = 4242;

/** The address the module gives: the server's root, which serve.ts redirects to its page. */
export const page = (port: number): string => `http://127.0.0.1:${port}/`;

/** A server as the module spawned it: its argv, and the test's hand on what it writes. */
export type Child = {
  readonly argv: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  /** What the module asked of serve.ts: the folder it serves and the port it asked for, "0" a free one. */
  readonly folder: string;
  readonly asked: string;
  /** Takes `port`, which it frees as it ends. */
  readonly listen: (port: number) => void;
  /** Writes each line on stdout, all of them in one piece. */
  readonly write: (...lines: readonly string[]) => void;
  readonly select: (selection: Selection) => void;
  readonly exit: (how: ProcessSpawnResult) => void;
  /** Breaks its stream: the module's next read of it rejects with `cause`. */
  readonly fail: (cause: string) => void;
  /** Whether the module ended it: `return()` on its stream, which kills a real child. */
  readonly killed: () => boolean;
  readonly alive: () => boolean;
};

/** What a child does as it starts: by default serve.ts's own start (`STARTS`). */
type Spawn = (child: Child, world: World) => void;

export type Ran = { readonly argv: readonly string[]; readonly cwd: string | undefined };

export type Beaten = { readonly port: number; readonly secret: string | null };

/** What the store may hold: the module's records, or a value of no shape it reads. */
export type Stored = MapRecord | SessionRecord | Selection | { readonly broken: true };

export type World = {
  id: string;
  cwd: string;
  /** What the session draws on: none, as in a `-p` run, unless a test puts a person there. */
  surfaces: readonly RenderSurface[];
  /** What the person picks in `$.ui.ask`, or `null` for a dialog nobody answers (`-p`). */
  pick: string | null;
  /** Answers each `$.process.run` but the browser's opener, which succeeds unless `noOpener`. */
  answer: (argv: readonly string[]) => Partial<ProcessRunResult>;
  noOpener: string | undefined;
  /** While set, the session drops each prompt, for this reason. */
  dropping: string | undefined;
  /** Runs after each write of the module's to the store: another session writing right after it. */
  afterSet: (key: string) => void;
  /** A reason to refuse a write of the module's to the store, as a store that fails; none by default. */
  refuse: (key: string, value: Stored) => string | undefined;
  /** Runs as each heartbeat or probe reaches `port`, before it is answered: another session acting while this one waits on it. */
  probing: (port: number) => void;
  /** Every atlas server listening, by port: the folder it serves, whoever started it. */
  readonly servers: Map<number, string>;
  nextPort: number;
  readonly clock: MockClock;
  readonly children: Child[];
  readonly runs: Ran[];
  /** Each heartbeat posted, by port: the secret it carried, `null` for a probe. */
  readonly beats: Beaten[];
  readonly asked: (readonly string[])[];
  readonly registered: string[];
  readonly contexts: (readonly string[])[];
  readonly statuses: (string | undefined)[];
  readonly logs: string[];
  readonly store: Map<string, Stored>;
  /** Every file under the session's directory, by its absolute path. */
  readonly files: Set<string>;
};

export type WorldOptions = {
  readonly spawn?: Spawn;
  readonly stored?: ReadonlyMap<string, Stored>;
  readonly files?: readonly string[];
};

type End = { readonly exit: ProcessSpawnResult } | { readonly fail: string };

/** A child's life beside its pieces: how it ended, once it has, its port, and how to wake its stream. */
type Life = { end: End | null; killed: boolean; port: number | null; wake: () => void };

/** serve.ts as it starts: a port another server holds is refused, port 0 is a free one. */
export const STARTS: Spawn = (child, seen) => {
  const port = Number(child.asked);

  if (port !== 0 && seen.servers.has(port)) {
    child.exit({ code: 1, signal: null });

    return;
  }

  const given = port === 0 ? seen.nextPort++ : port;
  child.listen(given);
  // As serve.ts prints it, its page's own name after the root, which the module never reads.
  child.write(`${page(given)}page.html`);
};

/** The files the world holds unless a test names others: the map folders under the session's directory. */
export const MAPS = [MAP, OTHER_MAP, DRAFT].map((folder) => `${folder}/atlas.config.ts`);

function reply(status: number, text = ""): HttpResponse {
  return { status, ok: status < 300, headers: {}, text };
}

/** `path` as the session's file system lands it: under its directory when relative, `..` folded, a link followed. */
export function landed(path: string, cwd = CWD): string {
  const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
  const parts: string[] = [];

  for (const part of absolute.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }

  const folded = `/${parts.join("/")}`;

  return folded === LINKED || folded.startsWith(`${LINKED}/`)
    ? `${MAP}${folded.slice(LINKED.length)}`
    : folded;
}

function dirsOf(files: ReadonlySet<string>): Set<string> {
  const dirs = new Set<string>();

  for (const file of files) {
    for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) {
      dirs.add(file.slice(0, at));
    }
  }

  return dirs;
}

function entry(name: string, kind: "file" | "dir"): FsEntry {
  return { name, kind, size: 0, mtimeMs: 0, isLink: false };
}

function listing(seen: World, dir: string): FsEntry[] {
  const dirs = dirsOf(seen.files);

  const under = (path: string): string | null => {
    const rest = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;

    return rest === null || rest.includes("/") ? null : rest;
  };

  return [
    ...[...dirs].flatMap((path) => {
      const name = under(path);

      return name === null ? [] : [entry(name, "dir")];
    }),
    ...[...seen.files].flatMap((path) => {
      const name = under(path);

      return name === null ? [] : [entry(name, "file")];
    }),
  ];
}

function children(on: On, seen: World, spawn: Spawn): void {
  on("process.spawn", async function* (_, e, next) {
    const pieces: ProcessSpawnChunk[] = [];
    const life: Life = { end: null, killed: false, port: null, wake: () => {} };

    // An ended server frees its port.
    const ended = (end: End): void => {
      life.end = end;

      if (life.port !== null) seen.servers.delete(life.port);
      life.wake();
    };

    next.signal.addEventListener("abort", () => {
      life.killed = true;
      ended({ exit: { code: null, signal: "SIGTERM" } });
    });

    const at = e.argv.findIndex((arg) => arg.endsWith("/serve.ts"));

    const child: Child = {
      argv: e.argv,
      cwd: e.cwd,
      env: e.env ?? {},
      folder: e.argv[at + 1] ?? "",
      asked: e.argv[at + 2] ?? "0",
      listen: (port) => {
        life.port = port;
        seen.servers.set(port, child.folder);
      },
      write: (...lines) => {
        pieces.push({ stream: "stdout", text: lines.map((line) => `${line}\n`).join("") });
        life.wake();
      },
      select: (selection) => {
        child.write(JSON.stringify({ type: "selection", ...selection }));
      },
      exit: (how) => ended({ exit: how }),
      fail: (cause) => ended({ fail: cause }),
      killed: () => life.killed,
      alive: () => life.end === null,
    };

    seen.children.push(child);
    spawn(child, seen);

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
    cwd: CWD,
    surfaces: [],
    pick: null,
    answer: () => ({}),
    noOpener: undefined,
    dropping: undefined,
    afterSet: () => {},
    refuse: () => {},
    probing: () => {},
    servers: new Map(),
    nextPort: FIRST_PORT,
    clock: mock.clock(on),
    children: [],
    runs: [],
    beats: [],
    asked: [],
    registered: [],
    contexts: [],
    statuses: [],
    logs: [],
    store: new Map(options.stored ?? []),
    files: new Set(options.files ?? MAPS),
  };

  children(on, built, options.spawn ?? STARTS);

  on("http.fetch", (_, e) => {
    const { pathname, port } = new URL(e.url);

    if (pathname !== "/heartbeat" || e.init?.method !== "POST")
      return { deny: `unexpected ${e.url}` };
    built.beats.push({ port: Number(port), secret: e.init.headers?.[HEARTBEAT_HEADER] ?? null });
    built.probing(Number(port));
    const folder = built.servers.get(Number(port));

    return folder === undefined
      ? { deny: `ECONNREFUSED ${e.url}` }
      : { value: reply(200, JSON.stringify({ folder })) };
  });

  on("process.run", (_, e) => {
    built.runs.push({ argv: e.argv, cwd: e.init?.cwd });
    const isOpener = e.argv.some((arg) => arg.endsWith("/open.ts"));

    if (isOpener && built.noOpener !== undefined) {
      return {
        value: {
          exitCode: 1,
          stdout: "",
          stderr: built.noOpener,
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      };
    }

    const answered = isOpener ? {} : built.answer(e.argv);

    return {
      value: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
        ...answered,
      },
    };
  });

  on("fs.list", (_, e) => ({ value: listing(built, landed(e.path ?? built.cwd, built.cwd)) }));

  on("fs.stat", (_, e) => {
    const path = landed(e.path, built.cwd);
    const isFile = built.files.has(path);

    if (!isFile && !dirsOf(built.files).has(path))
      return { deny: `$.fs.stat(${e.path}) failed: ENOENT` };

    return {
      value: { kind: isFile ? "file" : "dir", size: 0, mtimeMs: 0, isLink: false, realPath: path },
    };
  });

  on("fs.exists", (_, e) => {
    const path = landed(e.path, built.cwd);

    return { value: built.files.has(path) || dirsOf(built.files).has(path) };
  });

  on("store.get", (_, e) => ({ value: built.store.get(e.key) }));

  on("store.set", (_, e) => {
    // SAFETY: the module stores its own records alone, which its parsers read back.
    const value = e.value as Stored;
    const refused = built.refuse(e.key, value);

    if (refused !== undefined) return { deny: refused };
    built.store.set(e.key, value);
    built.afterSet(e.key);

    return { value: undefined };
  });

  on("store.delete", (_, e) => {
    built.store.delete(e.key);

    return { value: undefined };
  });

  // `$.ui.ask` is a call of AskUserQuestion through every hook but the module's own.
  on("tool.call", { tool: "AskUserQuestion" }, (_, e) => {
    const question = e.questions[0];
    built.asked.push(question?.options.map((option) => option.label) ?? []);

    if (built.pick === null || question === undefined) return { deny: "nobody to ask" };

    return { result: { questions: e.questions, answers: { [question.question]: built.pick } } };
  });

  on("tool.register", (_, e) => {
    built.registered.push(e.name);

    return { value: { tool: `mcp__atlas__${e.name}` } };
  });

  on("prompt.submit", (_, e) => {
    built.contexts.push(e.context ?? []);

    return built.dropping === undefined ? { text: e.text } : { drop: built.dropping };
  });

  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.id", () => ({ value: built.id }));
  on("session.cwd", () => ({ value: built.cwd }));
  on("session.surfaces", () => ({ value: built.surfaces }));
  on("skill.prompt", () => ({ text: "t" }));
  on("command.run", () => ({ text: "" }));

  on("ui.status", (_, e) => {
    built.statuses.push(e.text);

    return { value: undefined };
  });

  on("ui.log", (_, e) => {
    if (e.to !== "debug") built.logs.push(e.text);

    return { value: undefined };
  });

  return built;
}

const STEP_MS = 50;

/**
 * Awaits `work` while the clock moves on in steps: a start waits on the clock for its claim to
 * settle (CLAIM_SETTLE_MS), so a test that awaits one drives the clock until it is done.
 */
export async function settled<T>(seen: World, work: Promise<T>): Promise<T> {
  const progress = { done: false };

  const watched = work.finally(() => {
    progress.done = true;
  });

  for (let steps = 0; steps < 200 && !progress.done; steps += 1) {
    await seen.clock.advance(STEP_MS);
  }

  return await watched;
}

/** Moves the clock on by a second, in steps: what a server's end set going (a revival) runs out. */
export async function drain(seen: World): Promise<void> {
  for (let steps = 0; steps < 20; steps += 1) await seen.clock.advance(STEP_MS);
}

/** The serve.ts children still running. */
export function running(seen: World): Child[] {
  return seen.children.filter(
    (child) => child.argv.some((arg) => arg.endsWith("/serve.ts")) && child.alive(),
  );
}
