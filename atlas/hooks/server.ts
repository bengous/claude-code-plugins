import type {
  FsEntry,
  HookStream,
  HttpInit,
  HttpResponse,
  ProcessRunInit,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  Timer,
} from "claude-code";

import type { Beat, Selection } from "../wire.ts";
import { HEARTBEAT_ENV, HEARTBEAT_HEADER, HEARTBEAT_PATH, bunFlags } from "../wire.ts";
import { type MapRecord, parseBeat, readyPort, type SessionRecord } from "./parse.ts";

/**
 * The engine as a hook bound it from its `$`, each member spelled `$.noun.verb(...)` in
 * `register.ts`: the loader follows `$` only into a function declared in the file that registers
 * the hook, so every other file takes this record instead.
 */
export type Host = {
  readonly pluginRoot: string;
  readonly spawn: (
    request: ProcessSpawnRequest,
  ) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>;
  readonly run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>;
  readonly fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>;
  readonly after: (ms: number, fn: () => void) => Timer;
  readonly repeat: (ms: number, fn: () => void) => Timer;
  /** `$.clock.now()`: milliseconds since the epoch, as the engine's clock reads them. */
  readonly now: () => Promise<number>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly sessionId: () => Promise<string>;
  readonly list: (path: string) => Promise<FsEntry[]>;
  /** `$.session.cwd()`: the session's working directory, which follows Claude's `cd`. */
  readonly cwd: () => Promise<string>;
  /** `$.ui.ask`: the label the person picked; rejects when nobody can be asked, or nobody answered. */
  readonly ask: (question: string, options: readonly string[]) => Promise<string>;
  /** Where `path` lands, relative to the session's working directory, every link followed; `null` for nowhere. */
  readonly place: (path: string) => Promise<string | null>;
  readonly exists: (path: string) => Promise<boolean>;
  /** The live server of `folder` the store keeps, `null` when it keeps none that reads. */
  readonly mapRecord: (folder: string) => Promise<MapRecord | null>;
  readonly storeSet: (key: string, value: MapRecord | SessionRecord | Selection) => Promise<void>;
  readonly storeDelete: (key: string) => Promise<void>;
  /** The line under the prompt, for a lost board alone; `undefined` clears it. */
  readonly status: (text: string | undefined) => void;
  readonly log: (text: string) => void;
  /** `$.ui.log` to the debug log alone: the server's own lines, read and dropped. */
  readonly debug: (text: string) => void;
};

/** How long a start waits for the page's address: the first build of a cold cache included. */
export const START_TIMEOUT_MS = 10_000;

/** What a failed start says of the child's stderr, its end being where the error is. */
const STDERR_KEPT = 2_000;

/** The child's stdout after its first line, a line at a time, then how the child ended. */
export type Lines = AsyncGenerator<string, ProcessSpawnResult>;

/**
 * A server this module spawned: its port, the secret only its beat carries, the rest of its
 * output, and the way to end it. `end` returns the engine's stream, which kills the child even
 * while a read is pending.
 */
export type Child = {
  readonly port: number;
  readonly secret: string;
  readonly lines: Lines;
  readonly end: () => void;
};

export type Started = { readonly kind: "started"; readonly child: Child } | Failed;

export type Failed = { readonly kind: "failed"; readonly reason: string };

/** The server's root, which serve.ts redirects to its page, whatever the page's name. */
export function pageUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** Cuts the pieces of stdout on `\n` and keeps the tail for the next piece: a piece ends wherever the child's write did. */
async function* linesOf(
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>,
  heard: { stderr: string },
): Lines {
  let tail = "";

  for await (const { stream: pipe, text } of stream) {
    if (pipe === "stderr") {
      heard.stderr = `${heard.stderr}${text}`.slice(-STDERR_KEPT);
      continue;
    }

    const cut = `${tail}${text}`.split("\n");
    tail = cut.pop() ?? "";
    yield* cut;
  }

  return await stream.result;
}

/**
 * Spawns `serve.ts` for `folder` on `port` (0, a free one) with its heartbeat watchdog and a
 * secret of its own, and reads it up to the page's address, for `START_TIMEOUT_MS` at most; a
 * child that gives none is ended.
 */
export async function start(host: Host, folder: string, port: number): Promise<Started> {
  const argv = bunScript(host.pluginRoot, "serve.ts", folder, String(port), "--heartbeat");
  const secret = crypto.randomUUID();
  const heard = { stderr: "" };
  const stream = host.spawn({ argv, cwd: folder, env: { [HEARTBEAT_ENV]: secret } });
  const lines = linesOf(stream, heard);

  const end = (): void => {
    void stream.return({ code: null, signal: "SIGTERM" });
  };

  const { promise: timeout, resolve: late } = Promise.withResolvers<"late">();
  const timer = host.after(START_TIMEOUT_MS, () => late("late"));

  try {
    const first = await Promise.race([lines.next(), timeout]);

    if (first === "late") {
      end();

      return { kind: "failed", reason: `no address within ${START_TIMEOUT_MS} ms` };
    }

    if (first.done === true) {
      return {
        kind: "failed",
        reason: heard.stderr.trim() || `it ended (${JSON.stringify(first.value)})`,
      };
    }

    const ready = readyPort(first.value);

    if (ready !== null) return { kind: "started", child: { port: ready, secret, lines, end } };
    end();

    return { kind: "failed", reason: `its first line is no address: ${first.value.slice(0, 200)}` };
  } catch (cause) {
    end();

    return { kind: "failed", reason: String(cause) };
  } finally {
    timer.cancel();
  }
}

async function heartbeat(
  host: Host,
  port: number,
  headers: Record<string, string>,
): Promise<Beat | null> {
  const response = await host
    .fetch(`http://127.0.0.1:${port}/${HEARTBEAT_PATH}`, { method: "POST", headers })
    .catch(() => null);

  return response?.ok === true ? parseBeat(response.text) : null;
}

/** Asks the server on `port` what it serves, keeping nothing up: `null` when nothing there answers as one. */
export function probe(host: Host, port: number): Promise<Beat | null> {
  return heartbeat(host, port, {});
}

/** Beats a server this session spawned, with its secret: the beat that keeps it up. */
export function beat(host: Host, child: Child): Promise<Beat | null> {
  return heartbeat(host, child.port, { [HEARTBEAT_HEADER]: child.secret });
}

/** Hands the page's address to the desktop's browser (`open.ts`); the reason when none opened. */
export async function openBrowser(host: Host, url: string): Promise<string | null> {
  const ran = await host
    .run(bunScript(host.pluginRoot, "open.ts", url))
    .catch((cause: unknown) => ({ exitCode: 1, stderr: String(cause) }));

  return ran.exitCode === 0 ? null : ran.stderr.trim() || `open.ts exited ${ran.exitCode}`;
}

/** The command line of one of the plugin's scripts, with the flags every bun of atlas takes. */
export function bunScript(root: string, script: string, ...args: readonly string[]): string[] {
  return ["bun", ...bunFlags(root), `${root}/${script}`, ...args];
}

/** The engine's command lines the agent's tools run, each on a map folder. */
export const SCRIPTS = {
  open: (root: string, folder: string) => bunScript(root, "cli.ts", "check", folder, "--open"),
  check: (root: string, folder: string) => bunScript(root, "cli.ts", "check", folder),
  reply: (root: string, folder: string, id: string, text: string) =>
    bunScript(root, "cli.ts", "reply", folder, id, "--as", "agent", text),
  query: (root: string, folder: string, id: string) => bunScript(root, "query.ts", folder, id),
} as const;

/** A command line's end: whether it exited 0, and what it wrote, stdout then stderr. */
export type Ran = { readonly ok: boolean; readonly text: string };

export async function runScript(host: Host, argv: readonly string[], folder: string): Promise<Ran> {
  const ran = await host
    .run(argv, { cwd: folder, timeoutMs: 60_000 })
    .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: String(cause) }));

  const text = [ran.stdout.trim(), ran.stderr.trim()].filter((t) => t !== "").join("\n");

  return { ok: ran.exitCode === 0, text: text || `exited ${ran.exitCode}` };
}

/** The directories a search for map folders never enters. */
const SKIPPED = new Set(["node_modules"]);

export const SEARCH_DEPTH = 5;

/**
 * The map folders under `dir`, each a folder holding `atlas.config.ts`, at most `SEARCH_DEPTH`
 * levels down; a map folder's own folders (its drafts) and dot folders are not searched.
 */
export async function mapFolders(host: Host, dir: string, depth = SEARCH_DEPTH): Promise<string[]> {
  // A folder the session cannot list holds no map it could serve.
  const entries = await host.list(dir).catch(() => []);

  if (entries.some((entry) => entry.kind === "file" && entry.name === "atlas.config.ts")) {
    return [dir];
  }

  if (depth === 0) return [];

  const below = entries.filter(
    (entry) => entry.kind === "dir" && !entry.name.startsWith(".") && !SKIPPED.has(entry.name),
  );

  const found = await Promise.all(
    below.map((entry) => mapFolders(host, `${dir}/${entry.name}`, depth - 1)),
  );

  return found.flat();
}
