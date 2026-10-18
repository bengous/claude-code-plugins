import type {
  HookStream,
  HttpInit,
  HttpResponse,
  ProcessRunResult,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  PromptSubmitResult,
  Timer,
} from "claude-code";

import type { Delivery, TargetRequest } from "../shared/wire.ts";
import { parseServerLine, type SessionRecord } from "./parse.ts";

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
  /** `$.process.run`. */
  readonly run: (argv: readonly string[]) => Promise<ProcessRunResult>;
  readonly fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>;
  readonly submit: (text: string) => Promise<PromptSubmitResult>;
  readonly after: (ms: number, fn: () => void) => Timer;
  /** `$.clock.every`. */
  readonly repeat: (ms: number, fn: () => void) => Timer;
  /** `$.clock.now()`: milliseconds since the epoch, as the engine's clock reads them. */
  readonly now: () => Promise<number>;
  readonly storeSet: (key: string, value: SessionRecord) => Promise<void>;
  /** The line under the prompt, for a failure alone; `undefined` clears it. */
  readonly status: (text: string | undefined) => void;
  readonly log: (text: string) => void;
};

/** How long a start waits for `ready`: a hook that waits longer holds the way in. */
export const START_TIMEOUT_MS = 5_000;

/** What a failed start says of the child's stderr, its end being where the error is. */
const STDERR_KEPT = 2_000;

export type Address = { readonly port: number; readonly token: string };

/** The child's stdout after `ready`, a line at a time, then how the child ended. */
type Lines = AsyncGenerator<string, ProcessSpawnResult>;

/**
 * A server this module spawned: the app its `ready` said it serves, the rest of its output, and
 * the way to end it. `end` returns the engine's stream, which kills the child even while a read is
 * pending.
 */
export type Child = {
  readonly address: Address;
  readonly target: string | null;
  readonly lines: Lines;
  readonly end: () => void;
};

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

export function baseOf(address: Address): string {
  return `http://127.0.0.1:${address.port}/t/${address.token}/`;
}

/**
 * Spawns the server at the session's root and reads it up to `ready`, for `START_TIMEOUT_MS` at
 * most; `kept` asks for the port and the token the app's pages already load from, `target` for the
 * app to serve, `open` for the browser opened at the address once it listens. A child that gives
 * no `ready` is ended, and `null` answered with the reason logged.
 */
export async function start(
  host: Host,
  serverSession: string,
  root: string,
  kept: Address | null,
  target: string | null,
  open: boolean,
): Promise<Child | null> {
  const argv = [
    "bun",
    `${host.pluginRoot}/server/cli.ts`,
    "serve",
    "--session",
    serverSession,
    "--root",
    root,
    ...(kept === null ? [] : ["--port", String(kept.port), "--token", kept.token]),
    ...(target === null ? [] : ["--target", target]),
    ...(open ? ["--open"] : []),
  ];

  const heard = { stderr: "" };
  const stream = host.spawn({ argv, cwd: root });
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
      host.log(`pinpoint: the server did not start: no ready line within ${START_TIMEOUT_MS} ms`);

      return null;
    }

    if (first.done === true) {
      host.log(
        `pinpoint: the server did not start: ${heard.stderr.trim() || `it ended (${JSON.stringify(first.value)})`}`,
      );

      return null;
    }

    const ready = parseServerLine(first.value);

    if (ready?.type === "ready") {
      return {
        address: { port: ready.port, token: ready.token },
        target: ready.target,
        lines,
        end,
      };
    }

    end();
    host.log(
      `pinpoint: the server did not start: its first line is not ready: ${first.value.slice(0, 200)}`,
    );
  } catch (cause) {
    host.log(`pinpoint: the server did not start: ${String(cause)}`);
  } finally {
    timer.cancel();
  }

  return null;
}

/** Asks the server to remove its files and exit; `false` when it did not answer that it would. */
export async function close(host: Host, address: Address): Promise<boolean> {
  const response = await host
    .fetch(`${baseOf(address)}api/close`, { method: "POST" })
    .catch(() => ({ ok: false }));

  return response.ok;
}

/**
 * Asks the server to serve `url` from now on: `null` once it does, else why not, in its words
 * or the fetch's. The server's `target` line follows, which the read loop records.
 */
export async function switchTarget(
  host: Host,
  address: Address,
  url: string,
): Promise<string | null> {
  const request: TargetRequest = { url };

  const response = await host
    .fetch(`${baseOf(address)}api/target`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
    .catch((cause: unknown) => ({ ok: false, status: 0, text: String(cause) }));

  return response.ok ? null : response.text.trim() || `the server answered ${response.status}`;
}

/** Tells the server what became of a batch, so the page says it; a server that does not hear is logged. */
export async function tellDelivery(
  host: Host,
  address: Address,
  delivery: Delivery,
): Promise<void> {
  const response = await host
    .fetch(`${baseOf(address)}api/delivery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery),
    })
    .catch((cause: unknown) => ({ ok: false, status: 0, text: String(cause) }));

  if (!response.ok)
    host.log(
      `pinpoint: the server did not take the delivery of batch ${delivery.seq}: ${response.status} ${response.text}`,
    );
}

/** Removes the files of a session whose server is gone, which no server is left to remove: `cli.ts clean`. */
export async function clean(host: Host, serverSession: string): Promise<void> {
  const ran = await host
    .run(["bun", `${host.pluginRoot}/server/cli.ts`, "clean", "--session", serverSession])
    .catch((cause: unknown) => ({ exitCode: null, stderr: String(cause) }));

  if (ran.exitCode !== 0) {
    host.log(`pinpoint: the session's files were not removed: ${ran.stderr.trim()}`);
  }
}
