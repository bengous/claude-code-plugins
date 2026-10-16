import type {
  HookStream,
  HttpInit,
  HttpResponse,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  PromptSubmitResult,
  Timer,
} from "claude-code";

import type { Delivery } from "../shared/wire.ts";
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
 * A server this module spawned: the rest of its output, and the way to end it. `end` returns the
 * engine's stream, which kills the child even while a read is pending.
 */
export type Child = { readonly address: Address; readonly lines: Lines; readonly end: () => void };

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
 * most; `kept` asks for the port and the token the app's pages already load from. A child that
 * gives no `ready` is ended, and `null` answered with the reason logged.
 */
export async function start(
  host: Host,
  serverSession: string,
  root: string,
  kept: Address | null,
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

    if (ready?.type === "ready")
      return { address: { port: ready.port, token: ready.token }, lines, end };
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
