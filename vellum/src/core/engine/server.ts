import type {
  HookStream,
  HttpInit,
  HttpResponse,
  ProcessSpawnChunk,
  ProcessSpawnResult,
} from "claude-code";

import type { ExtensionApi } from "./extension.ts";
import type { Host } from "./host.ts";
import type { ServerInfo } from "./mode.ts";
import {
  type ChannelLineWire,
  type GateWire,
  parseChannel,
  parseGate,
  parseServerLine,
  type ProjectDir,
  type SessionId,
  type ServerLineWire,
  type Workdir,
} from "./parse.ts";

/**
 * What a submit does with a `plan.md` whose text is the version under review: `record` opens
 * a new version after a feedback, as the model's explicit call means it; `keep` never does.
 */
export type Unchanged = "record" | "keep";

const EXIT_WORKDIR_GONE = 3;

/** How long a start waits for `ready`, as the launcher's own timeout once did: a hook that waits longer holds the way in. */
export const START_TIMEOUT_MS = 5_000;

/** What a failed start says of the child's stderr, its end being where the error is. */
const STDERR_KEPT = 2_000;

/** The child's stdout after `ready`, a line at a time, then how the child ended. */
export type Lines = AsyncGenerator<string, ProcessSpawnResult>;

/**
 * A server this module spawned: the rest of its output, and the way to end it. `end` returns the
 * engine's stream, which kills the child even while a read is pending (measured,
 * `docs/plugin-testing/hook-runtime.md`), where returning `lines` would wait for that read.
 */
export type Child = { readonly lines: Lines; readonly end: () => void };

/**
 * What the launcher did: `up` holds the child, which its mode reads for as long as it runs, and
 * its channel's identity; `gone` is a revival whose directory someone removed.
 */
export type Launched =
  | {
      readonly kind: "up";
      readonly server: ReviewServer;
      readonly child: Child;
      readonly channel: string;
    }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

/** The review server's client: every route, the token header and the page's address. */
export type ReviewServer = {
  readonly info: ServerInfo;
  readonly url: string;
  alive: () => Promise<boolean>;
  gate: (unchanged: Unchanged) => Promise<GateWire>;
  /** The channel's entries past `after`, for a (re)spawn and for an entry the stdout skipped. */
  channel: (after: number) => Promise<ChannelLineWire[]>;
  open: () => Promise<void>;
  /** Whether the server answered it: one that no longer does is ended, and revived. */
  heartbeat: () => Promise<boolean>;
  extension: (id: string) => ExtensionApi;
};

/** What the reader loop hands on, each line as it comes: nothing it calls may wait on the session. */
export type Reader = {
  readonly line: (line: ServerLineWire) => void;
  readonly unread: (text: string) => void;
  readonly ended: (how: ProcessSpawnResult) => void;
};

/** The page's address on `hostname`: the server listens on 127.0.0.1, which `localhost` reaches too. */
export function pageUrl(info: ServerInfo, hostname: "127.0.0.1" | "localhost"): string {
  return `http://${hostname}:${info.port}/t/${info.token}/`;
}

function api(host: Host, info: ServerInfo, path: string, init?: HttpInit): Promise<HttpResponse> {
  return host.fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: { "x-vellum-token": info.token, "content-type": "application/json" },
  });
}

export function reach(host: Host, info: ServerInfo): ReviewServer {
  const answered = (path: string): Promise<boolean> =>
    api(host, info, path, { method: "POST" }).then(
      (response) => response.ok,
      () => false,
    );

  return {
    info,
    url: pageUrl(info, "127.0.0.1"),
    alive: () =>
      api(host, info, "/api/review").then(
        (response) => response.ok,
        () => false,
      ),
    gate: (unchanged) =>
      api(host, info, "/api/gate", { method: "POST", body: JSON.stringify({ unchanged }) }).then(
        parseGate,
      ),
    channel: async (after) => {
      const response = await api(host, info, `/api/channel?after=${after}`);

      if (!response.ok) {
        throw new Error(
          `GET /api/channel answered ${response.status}: ${response.text.slice(0, 200)}`,
        );
      }

      return parseChannel(response.text);
    },
    // Told, not asked: a server that misses it is found by the heartbeat.
    open: () => answered("/api/open").then(() => {}),
    heartbeat: () => answered("/api/heartbeat"),
    extension: (id) => ({
      get: (path) => api(host, info, `/api/x/${id}/${path}`),
      post: (path, json) => api(host, info, `/api/x/${id}/${path}`, { method: "POST", body: json }),
    }),
  };
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
 * Reads the child's lines until it ends, handing each one on as it comes. It awaits nothing but
 * the next line: a child whose output is left unread past about a megabyte blocks on its write.
 */
export async function read(lines: Lines, reader: Reader): Promise<void> {
  for (;;) {
    const next = await lines.next();

    if (next.done === true) {
      reader.ended(next.value);

      return;
    }

    const line = parseServerLine(next.value);

    if (line === null) reader.unread(next.value);
    else reader.line(line);
  }
}

/**
 * Spawns the server on the working directory, from the project's root, a child of the module that tells its news on
 * stdout, and reads it up to `ready`, for `START_TIMEOUT_MS` at most. `kept` revives one: the port
 * and the token the reviewer's tab knows, on a directory that must still be there, or on `final`
 * once an approval renamed it. A child that gives no `ready` is ended.
 */
export async function start(
  host: Host,
  id: SessionId,
  project: ProjectDir,
  workdir: Workdir,
  kept: ServerInfo | null,
  final: Workdir | null,
): Promise<Launched> {
  const argv = [
    "bun",
    `${host.pluginRoot}/src/core/server/cli.ts`,
    "serve",
    "--session",
    id,
    "--project",
    project,
    "--workdir",
    workdir,
    ...(kept === null ? [] : ["--port", String(kept.port), "--token", kept.token, "--existing"]),
    ...(final === null ? [] : ["--final", final]),
  ];

  const heard = { stderr: "" };
  // At the project's root: the session's directory follows every `cd` Claude runs, and a server
  // started inside the working directory holds the folder its approval renames (Windows refuses).
  const stream = host.spawn({ argv, cwd: project });

  const child: Child = {
    lines: linesOf(stream, heard),
    end: () => {
      void stream.return({ code: null, signal: "SIGTERM" });
    },
  };

  const { promise: timeout, resolve: late } = Promise.withResolvers<"late">();
  const timer = host.after(START_TIMEOUT_MS, () => late("late"));

  try {
    const first = await Promise.race([child.lines.next(), timeout]);

    if (first === "late") {
      child.end();
      host.log(`the review server did not start: no ready line within ${START_TIMEOUT_MS} ms`);

      return { kind: "failed" };
    }

    if (first.done === true) {
      if (first.value.code === EXIT_WORKDIR_GONE) return { kind: "gone" };
      const why = heard.stderr.trim() || `it ended (${JSON.stringify(first.value)})`;
      host.log(`the review server did not start: ${why}`);

      return { kind: "failed" };
    }

    const ready = parseServerLine(first.value);

    if (ready?.type === "ready") {
      return { kind: "up", server: reach(host, ready.info), child, channel: ready.channel };
    }

    child.end();
    host.log(
      `the review server did not start: its first line is not ready: ${first.value.slice(0, 200)}`,
    );
  } catch (cause) {
    host.log(`the review server did not start: ${String(cause)}`);
  } finally {
    timer.cancel();
  }

  return { kind: "failed" };
}
