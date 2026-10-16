import type { EngineInterface, Register, Timer } from "claude-code";

import type { ServerLine } from "../shared/wire.ts";
import { parseServerLine, parseSessionRecord, type SessionRecord } from "./parse.ts";
import { type Address, baseOf, type Child, type Host, start, tellDelivery } from "./server.ts";

/**
 * The pinpoint mod: `/pinpoint:start` spawns one server per session, which the app's pages load
 * the overlay from; each batch the server prints is handed to the session as a prompt, in order,
 * and the server told it went in. `/pinpoint:stop` ends it. A server that dies comes back on its
 * port and token, so the pages reconnect by themselves.
 */

const START_SKILL = "pinpoint:start";

const STOP_SKILL = "pinpoint:stop";

/** The server leaves after 60 s without one (`server/cli.ts`): a `claude` killed hard sends no signal. */
export const HEARTBEAT_MS = 15_000;

/** This many unexpected ends within the window stop the revivals. */
export const CRASHES = 3;

const CRASH_WINDOW_MS = 60_000;

type Batch = Extract<ServerLine, { type: "batch" }>;

type Live = {
  readonly kind: "live";
  /** The Claude Code session the server serves; a `/clear` moves it to the new id, in place. */
  sessionId: string;
  /** Rewritten after each relay, as the store's copy is. */
  record: SessionRecord;
  readonly child: Child;
  readonly heartbeat: Timer;
  /** When the servers of this session ended on their own, for the crash window. */
  readonly ends: readonly number[];
  /** The relays, one after the other: the read loop never waits on the session. */
  relays: Promise<void>;
};

/** A server that could not be revived: its record kept, so `/pinpoint:start` tries again on its port. */
type Lost = {
  readonly kind: "lost";
  readonly sessionId: string;
  readonly record: SessionRecord;
  readonly reason: string;
};

type State = { readonly kind: "idle" } | Live | Lost;

function recordKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function startedText(record: SessionRecord): string {
  return [
    `pinpoint is live for ${record.root}.`,
    `Server: http://localhost:${record.port}/ (the overlay loads from it).`,
    "A Vite app at or under that directory loads the overlay once its vite.config.ts uses the plugin at ~/.claude/pinpoint/vite.mjs (see the skill). Reload the page, then press Alt+P.",
  ].join("\n");
}

const NOT_STARTED =
  "pinpoint did not start its server; the transcript's log line says why. Run /pinpoint:start again once it is fixed.";

/**
 * Binds this dispatch's `$`, the one place it is spelled: the loader follows it only into a
 * function declared at the top of this file. A timer or a read loop keeps the host of the dispatch
 * that started it.
 */
function hostOf($: EngineInterface): Host {
  return {
    pluginRoot: $.plugin.root,
    spawn: (request) => $.process.spawn(request),
    fetch: (url, init) => $.http.fetch(url, init),
    submit: (text) => $.prompt.submit({ text }),
    after: (ms, fn) => $.clock.after(ms, fn),
    repeat: (ms, fn) => $.clock.every(ms, fn),
    now: () => $.clock.now(),
    storeSet: (key, value) => $.store.set(key, value),
    status: (text) => $.ui.status(text),
    log: (text) => $.ui.log(text),
  };
}

export const register: Register = (on) => {
  let state: State = { kind: "idle" };

  /** Every write of `state`: leaving a live state ends its server and its heartbeat. */
  function become(host: Host, next: State): void {
    const was = state;
    state = next;

    if (was.kind === "live" && next !== was) {
      was.heartbeat.cancel();
      was.child.end();
    }

    host.status(next.kind === "lost" ? next.reason : undefined);
  }

  async function relay(host: Host, live: Live, batch: Batch): Promise<void> {
    const { address } = live.child;

    // A server started anew tells again what it holds: a batch already handed over is only acknowledged.
    if (batch.seq <= live.record.relayed) {
      await tellDelivery(host, address, { seq: batch.seq, outcome: "delivered" });

      return;
    }

    const entered = await host
      .submit(batch.text)
      .catch((cause: unknown) => ({ drop: String(cause) }));

    if (entered.drop !== undefined) {
      host.log(`pinpoint: batch ${batch.seq} did not enter the session: ${entered.drop}`);
      await tellDelivery(host, address, {
        seq: batch.seq,
        outcome: "dropped",
        reason: entered.drop,
      });

      return;
    }

    live.record = { ...live.record, relayed: batch.seq };
    await host.storeSet(recordKey(live.sessionId), live.record);
    await tellDelivery(host, address, { seq: batch.seq, outcome: "delivered" });
  }

  /** Starts the server for `record`, on its port and token when it has them; `null` when it cannot. */
  async function launch(
    host: Host,
    sessionId: string,
    record: SessionRecord,
    ends: readonly number[],
  ): Promise<Live | null> {
    const kept: Address | null =
      record.port === 0 ? null : { port: record.port, token: record.token };

    const child = await start(host, record.serverSession, record.root, kept);

    if (child === null) return null;
    const started = { ...record, port: child.address.port, token: child.address.token };
    await host.storeSet(recordKey(sessionId), started);

    // A beat that fails says nothing the read loop does not: a server that died ends its stream.
    const heartbeat = host.repeat(HEARTBEAT_MS, () => {
      void host.fetch(`${baseOf(child.address)}api/heartbeat`, { method: "POST" }).catch(() => {});
    });

    const live: Live = {
      kind: "live",
      sessionId,
      record: started,
      child,
      heartbeat,
      ends,
      relays: Promise.resolve(),
    };

    follow(host, live).catch((cause: unknown) => {
      // A reload or the end of a kit test tears the environment down under the loop: its `$`
      // then refuses every call, the log included, and nobody is left to tell.
      try {
        host.log(`pinpoint: the server's read loop failed: ${String(cause)}`);
      } catch {
        // Gone with the environment: there is no transcript left to write to.
      }
    });

    return live;
  }

  /** What a server that ended on its own leaves: a new one on its port, or `lost` past the crash window. */
  async function revived(host: Host, live: Live): Promise<State> {
    const now = await host.now();
    const ends = [...live.ends.filter((at) => now - at < CRASH_WINDOW_MS), now];
    const { sessionId, record } = live;

    if (ends.length >= CRASHES) {
      const reason = `pinpoint: the server ended ${ends.length} times within a minute; run /pinpoint:start to try again`;

      return { kind: "lost", sessionId, record, reason };
    }

    const next = await launch(host, sessionId, record, ends);
    const reason = "pinpoint: the server ended and did not start again; run /pinpoint:start";

    return next ?? { kind: "lost", sessionId, record, reason };
  }

  /** Reads the child until it ends, queueing each batch; an end nobody asked for revives the server. */
  async function follow(host: Host, live: Live): Promise<void> {
    for (;;) {
      const next = await live.child.lines.next();

      if (next.done === true) break;
      const line = parseServerLine(next.value);

      if (line?.type === "batch") {
        live.relays = live.relays
          .then(() => relay(host, live, line))
          .catch((cause: unknown) => {
            host.log(`pinpoint: batch ${line.seq} was not relayed: ${String(cause)}`);
          });
      } else {
        host.log(
          `pinpoint: the server printed a line the module does not read: ${next.value.slice(0, 200)}`,
        );
      }
    }

    if (state !== live) return;
    const next = await revived(host, live);

    // Left meanwhile (`/pinpoint:stop`): the server started for nothing ends.
    if (state !== live) {
      if (next.kind === "live") {
        next.heartbeat.cancel();
        next.child.end();
      }

      return;
    }

    become(host, next);
  }

  // A reload of the module ends its children: the session's record starts the server again.
  on("session.start", async ($, e, next) => {
    const result = await next(e);

    if (state.kind !== "idle") return result;
    const host = hostOf($);
    const sessionId = await $.session.id();
    const record = parseSessionRecord(await $.store.get(recordKey(sessionId)));

    if (record === null) return result;
    const live = await launch(host, sessionId, record, []);
    const reason = "pinpoint: the server did not start again after a reload; run /pinpoint:start";
    become(host, live ?? { kind: "lost", sessionId, record, reason });

    return result;
  });

  on("skill.prompt", { skill: START_SKILL }, async ($, e, next) => {
    const result = await next(e);

    if (state.kind === "live") return { text: `${result.text}\n\n${startedText(state.record)}` };
    const host = hostOf($);
    const sessionId = await $.session.id();
    const stored = parseSessionRecord(await $.store.get(recordKey(sessionId)));

    const record = stored ?? {
      serverSession: sessionId,
      root: await $.session.root(),
      port: 0,
      token: "",
      relayed: 0,
    };

    const live = await launch(host, sessionId, record, []);

    if (live === null) return { text: `${result.text}\n\n${NOT_STARTED}` };
    become(host, live);

    return { text: `${result.text}\n\n${startedText(live.record)}` };
  });

  on("skill.prompt", { skill: STOP_SKILL }, async ($, e, next) => {
    const result = await next(e);
    const host = hostOf($);
    const was = state;

    if (was.kind === "idle") return { text: `${result.text}\n\nNo pinpoint server was running.` };

    // The server removes its files, pending batches included: stopping is the user's word.
    if (was.kind === "live") {
      await host.fetch(`${baseOf(was.child.address)}api/close`, { method: "POST" }).catch(() => {});
    }

    await $.store.delete(recordKey(was.sessionId));
    become(host, { kind: "idle" });

    return {
      text: `${result.text}\n\npinpoint stopped: its server ended, and the app's overlay disconnects.`,
    };
  });

  // A `/clear` mints a new session id, and `/resume` may land in another: the server carries over.
  on("command.run", { command: ["clear", "resume"] }, async ($, e, next) => {
    const result = await next(e);

    if (state.kind === "idle") return result;
    const sessionId = await $.session.id();

    if (sessionId === state.sessionId) return result;
    await $.store.delete(recordKey(state.sessionId));
    await $.store.set(recordKey(sessionId), state.record);

    // A live state keeps its identity: its read loop knows it is current by it.
    if (state.kind === "live") state.sessionId = sessionId;
    else state = { ...state, sessionId };

    return result;
  });
};
