import type { EngineInterface, Register, RenderSurface, Timer } from "claude-code";

import { addressOn, targetOf } from "../shared/target.ts";
import type { Delivery, ServerLine } from "../shared/wire.ts";
import {
  argumentsOf,
  parseServerLine,
  type SessionRecord,
  type Stored,
  storedRecord,
} from "./parse.ts";
import {
  baseOf,
  type Child,
  clean,
  close,
  type Host,
  openBrowser,
  start,
  switchTarget,
  tellDelivery,
} from "./server.ts";

/**
 * The pinpoint mod: `/pinpoint:start [url]` spawns one server per session, which serves the app
 * with the overlay at its address, or asks which app until one is chosen; each batch the server
 * prints is handed to the session as a prompt, in order, and the server told it went in.
 * `/pinpoint:start <other url>` switches the app, `/pinpoint:stop` ends it. A server that dies
 * comes back on its port and token, serving the same app, so the pages reconnect by themselves.
 */

const START_SKILL = "pinpoint:start";

const STOP_SKILL = "pinpoint:stop";

/** The server leaves after 60 s without one (`server/cli.ts`): a `claude` killed hard sends no signal. */
export const HEARTBEAT_MS = 15_000;

/** This many unexpected ends within the window stop the revivals. */
export const CRASHES = 3;

const CRASH_WINDOW_MS = 60_000;

type Batch = Extract<ServerLine, { type: "batch" }>;

/**
 * A session's pinpoint, from `/pinpoint:start` or the restore after a reload to `/pinpoint:stop`,
 * carried across every server a revival replaces: what was handed over, and the one queue every
 * relay of its servers goes through, in order.
 */
type Tenure = {
  /** The Claude Code session; a `/clear` or a `/resume` moves it to the new id, in place. */
  sessionId: string;
  /** The store's copy, rewritten as a server starts and after each relay. */
  record: SessionRecord;
  relays: Promise<void>;
};

type Starting = { readonly kind: "starting"; readonly tenure: Tenure };

type Live = {
  readonly kind: "live";
  readonly tenure: Tenure;
  readonly child: Child;
  readonly heartbeat: Timer;
  /** When the tenure's servers ended on their own, for the crash window. */
  readonly ends: readonly number[];
};

/** A server that could not be revived: its tenure kept, so `/pinpoint:start` tries again on its port. */
type Lost = { readonly kind: "lost"; readonly tenure: Tenure; readonly reason: string };

/** `/pinpoint:stop` under way: its tenure dropped, and only that stop leaves it. */
type Stopping = { readonly kind: "stopping" };

type State = { readonly kind: "idle" } | Starting | Live | Stopping | Lost;

/** The tenure `state` carries: none while idle, nor once a stop dropped it. */
function tenureOf(state: State): Tenure | null {
  return state.kind === "idle" || state.kind === "stopping" ? null : state.tenure;
}

/**
 * The surfaces drawn on this machine, whose person sees a browser opened here: a phone (`mobile`)
 * is elsewhere, a `-p` run draws on none, and Claude Code for VS Code attaches none yet.
 */
const HERE: ReadonlySet<RenderSurface> = new Set(["terminal", "desktop"]);

function recordKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/**
 * How the session hears of its address: the browser opened there, an address for the person to
 * open, or the one a server already running keeps, where its tabs are.
 */
type Reach = "opened" | "open" | "kept";

function startedText(record: SessionRecord, reach: Reach): string {
  const target = record.target === null ? null : new URL(record.target);
  const address = addressOn(record.port, target);
  const opened = reach === "opened";

  const where = {
    opened: `The browser opens ${address}`,
    open: `Open ${address} in the browser`,
    kept: `Its address stays ${address}`,
  }[reach];

  return [
    reach === "kept"
      ? `pinpoint is already live for ${record.root}.`
      : `pinpoint is live for ${record.root}.`,
    target === null
      ? `${where}: "Which app?" lists the apps running on this machine and takes any other address. /pinpoint:start <url> serves one directly.`
      : `${where}: it serves ${target.origin} with the overlay. /pinpoint:start <url> switches to another app at the same address.`,
    ...(opened ? ["If no tab comes up, open that address yourself."] : []),
    "Press Alt+P on the page to point.",
  ].join("\n");
}

/** The record `stored` holds; one that does not read is logged, and the session starts afresh. */
function recordIn(host: Host, stored: Stored): SessionRecord | null {
  if (stored.kind === "unreadable") {
    host.log(
      `pinpoint: the session's stored record does not read, so no server comes back for it (${stored.value}); run /pinpoint:start to start one`,
    );
  }

  return stored.kind === "kept" ? stored.record : null;
}

function switchedText(record: SessionRecord, target: URL): string {
  return `pinpoint now serves ${target.origin} at ${addressOn(record.port, target)}; reload the tabs open there.`;
}

function selfText(record: SessionRecord, asked: string, opened: boolean): string {
  const address = addressOn(record.port, null);
  const pick = opened ? `The browser opens ${address}` : `Open ${address}`;

  return `pinpoint did not take ${asked}: it is this pinpoint server's own address, which would serve itself. ${pick} to pick the app, or run /pinpoint:start with the app's address.`;
}

function notAnAddressText(given: string): string {
  return `pinpoint: "${given}" is not an http(s) address, so nothing changed. Run /pinpoint:start <url>, as /pinpoint:start http://localhost:5173/, or /pinpoint:start alone to pick the app in the browser.`;
}

const NOT_STARTED =
  "pinpoint did not start its server; the transcript's log line says why. Run /pinpoint:start again once it is fixed.";

/** What `/pinpoint:start` says of the state it finds, or finds again once a stop or another way in got there first. */
function wayInText(state: State): string {
  switch (state.kind) {
    case "live":
      return startedText(state.tenure.record, "kept");
    case "starting":
      return "pinpoint is starting its server; run /pinpoint:start again in a moment to see where it listens.";
    case "lost":
      return NOT_STARTED;
    case "stopping":
    case "idle":
      return "pinpoint was stopped meanwhile; run /pinpoint:start again to start it.";
  }
}

/**
 * Binds this dispatch's `$`, the one place it is spelled: the loader follows it only into a
 * function declared at the top of this file. A timer or a read loop keeps the host of the dispatch
 * that started it.
 */
function hostOf($: EngineInterface): Host {
  return {
    pluginRoot: $.plugin.root,
    spawn: (request) => $.process.spawn(request),
    run: (argv) => $.process.run(argv),
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

  /**
   * Every write of `state`. Leaving a live state stops its heartbeat and ends its server, but for
   * `stopping`: the stop closes the server first, and the close removes its files.
   */
  function become(host: Host, next: State): void {
    const was = state;
    state = next;

    if (was.kind === "live" && next !== was) {
      was.heartbeat.cancel();

      if (next.kind !== "stopping") was.child.end();
    }

    host.status(next.kind === "lost" ? next.reason : undefined);
  }

  /** Whether `state` is still `from`, read through a call: the compiler keeps a narrowing of `state` across an await. */
  function holds(from: State): boolean {
    return state === from;
  }

  /** Tells the tenure's server what became of a batch; with none up, the next one tells the batch again. */
  async function tell(host: Host, tenure: Tenure, delivery: Delivery): Promise<void> {
    if (state.kind === "live" && state.tenure === tenure) {
      await tellDelivery(host, state.child.address, delivery);
    }
  }

  async function relay(host: Host, tenure: Tenure, batch: Batch): Promise<void> {
    if (tenureOf(state) !== tenure) return;

    // A server started anew tells again what it holds: a batch already handed over is only acknowledged.
    if (batch.seq <= tenure.record.relayed) {
      await tell(host, tenure, { seq: batch.seq, outcome: "delivered" });

      return;
    }

    const entered = await host
      .submit(batch.text)
      .catch((cause: unknown) => ({ drop: String(cause) }));

    if (tenureOf(state) !== tenure) return;

    if (entered.drop !== undefined) {
      host.log(`pinpoint: batch ${batch.seq} did not enter the session: ${entered.drop}`);
      await tell(host, tenure, { seq: batch.seq, outcome: "dropped", reason: entered.drop });

      return;
    }

    tenure.record = { ...tenure.record, relayed: batch.seq };
    await host.storeSet(recordKey(tenure.sessionId), tenure.record);
    await tell(host, tenure, { seq: batch.seq, outcome: "delivered" });
  }

  /**
   * Starts the server of `from`'s tenure, on its port and token when it has them, and makes it the
   * state. A server that does not start leaves `from` as it is, for the caller to say what follows;
   * a `from` left meanwhile takes nothing, and the server started for it ends.
   */
  async function enter(host: Host, from: Starting, ends: readonly number[]): Promise<void> {
    const { tenure } = from;
    const child = await start(host, tenure.record);

    if (child === null) return;

    if (!holds(from)) {
      child.end();

      return;
    }

    tenure.record = {
      ...tenure.record,
      port: child.address.port,
      token: child.address.token,
      target: child.target,
    };
    await host.storeSet(recordKey(tenure.sessionId), tenure.record);

    if (!holds(from)) {
      child.end();

      return;
    }

    // A beat that fails says nothing the read loop does not: a server that died ends its stream.
    const heartbeat = host.repeat(HEARTBEAT_MS, () => {
      void host.fetch(`${baseOf(child.address)}api/heartbeat`, { method: "POST" }).catch(() => {});
    });

    const live: Live = { kind: "live", tenure, child, heartbeat, ends };
    become(host, live);

    follow(host, live).catch((cause: unknown) => {
      // A reload or the end of a kit test tears the environment down under the loop: its `$`
      // then refuses every call, the log included, and nobody is left to tell.
      try {
        host.log(`pinpoint: the server's read loop failed: ${String(cause)}`);
      } catch {
        // Gone with the environment: there is no transcript left to write to.
      }
    });
  }

  /** What a server that ended on its own leaves: a new one on its port, or `lost` past the crash window. */
  async function revive(host: Host, from: Live): Promise<void> {
    const now = await host.now();

    if (!holds(from)) return;
    const ends = [...from.ends.filter((at) => now - at < CRASH_WINDOW_MS), now];
    const { tenure } = from;

    if (ends.length >= CRASHES) {
      const reason = `pinpoint: the server ended ${ends.length} times within a minute; run /pinpoint:start to try again`;
      become(host, { kind: "lost", tenure, reason });

      return;
    }

    const starting: Starting = { kind: "starting", tenure };
    become(host, starting);
    await enter(host, starting, ends);

    if (holds(starting)) {
      const reason = "pinpoint: the server ended and did not start again; run /pinpoint:start";
      become(host, { kind: "lost", tenure, reason });
    }
  }

  /**
   * Reads the child until it ends, queueing each batch on the tenure's relays and recording each
   * app it says it serves, which a revival serves again.
   */
  async function read(host: Host, live: Live): Promise<void> {
    const { tenure } = live;

    for (;;) {
      const next = await live.child.lines.next();

      if (next.done === true) return;
      const line = parseServerLine(next.value);

      if (line?.type === "batch") {
        tenure.relays = tenure.relays
          .then(() => relay(host, tenure, line))
          .catch((cause: unknown) => {
            host.log(`pinpoint: batch ${line.seq} was not relayed: ${String(cause)}`);
          });
      } else if (line?.type === "target") {
        if (!holds(live)) continue;
        tenure.record = { ...tenure.record, target: line.target };
        await host.storeSet(recordKey(tenure.sessionId), tenure.record);
      } else {
        host.log(
          `pinpoint: the server printed a line the module does not read: ${next.value.slice(0, 200)}`,
        );
      }
    }
  }

  /** Reads the child to its end, a read that fails being one: an end nobody asked for revives the server. */
  async function follow(host: Host, live: Live): Promise<void> {
    await read(host, live).catch((cause: unknown) => {
      if (holds(live)) host.log(`pinpoint: the server's read loop failed: ${String(cause)}`);
    });

    if (holds(live)) await revive(host, live);
  }

  // A reload of the module ends its children: the session's record starts the server again.
  on("session.start", async ($, e, next) => {
    const result = await next(e);

    if (state.kind !== "idle") return result;
    const from = state;
    const host = hostOf($);
    const sessionId = await $.session.id();
    const record = recordIn(host, storedRecord(await $.store.get(recordKey(sessionId))));

    if (record === null || !holds(from)) return result;
    const tenure: Tenure = { sessionId, record, relays: Promise.resolve() };
    const starting: Starting = { kind: "starting", tenure };
    become(host, starting);
    await enter(host, starting, []);

    if (holds(starting)) {
      const reason = "pinpoint: the server did not start again after a reload; run /pinpoint:start";
      become(host, { kind: "lost", tenure, reason });
    }

    return result;
  });

  on("skill.prompt", { skill: START_SKILL }, async ($, e, next) => {
    const result = await next(e);
    const host = hostOf($);
    const from = state;
    const said = (line: string) => ({ text: `${result.text}\n\n${line}` });
    const given = argumentsOf(e.text);
    const asked = given === null ? null : targetOf(given);

    if (given !== null && asked === null) return said(notAnAddressText(given));

    if (from.kind === "live" && asked !== null) {
      const refused = await switchTarget(host, from.child.address, asked.href);

      if (refused !== null) return said(`pinpoint kept the app it serves: ${refused}`);

      return said(switchedText(from.tenure.record, asked));
    }

    if (from.kind !== "idle" && from.kind !== "lost") return said(wayInText(from));
    let tenure: Tenure;

    if (from.kind === "lost") {
      tenure = from.tenure;
    } else {
      const sessionId = await $.session.id();
      const stored = recordIn(host, storedRecord(await $.store.get(recordKey(sessionId))));

      const record = stored ?? {
        serverSession: sessionId,
        root: await $.session.root(),
        port: 0,
        token: "",
        target: null,
        relayed: 0,
      };

      if (!holds(from)) return said(wayInText(state));
      tenure = { sessionId, record, relays: Promise.resolve() };
    }

    if (asked !== null) tenure.record = { ...tenure.record, target: asked.href };
    const starting: Starting = { kind: "starting", tenure };
    become(host, starting);
    await enter(host, starting, []);

    if (!holds(starting)) {
      if (state.kind !== "live") return said(wayInText(state));
      const live: Live = state;

      // From `lost` the server comes back on its kept address, the one its tabs hold already.
      const opened =
        from.kind === "idle" &&
        (await $.session.surfaces()).some((surface) => HERE.has(surface)) &&
        holds(live) &&
        (await openBrowser(host, live.child.address));

      // A stop, or an end and a revival, came meanwhile: no tab opened is said of what is left.
      if (!holds(live)) {
        return said(
          state.kind === "live" ? startedText(state.tenure.record, "open") : wayInText(state),
        );
      }

      // The server refuses a `--target` that is its own address, which only its bind could tell.
      return asked !== null && live.child.target === null
        ? said(selfText(live.tenure.record, asked.href, opened))
        : said(startedText(live.tenure.record, opened ? "opened" : "open"));
    }

    become(host, from);

    return said(NOT_STARTED);
  });

  on("skill.prompt", { skill: STOP_SKILL }, async ($, e, next) => {
    const result = await next(e);
    const host = hostOf($);
    const was = state;
    const said = (line: string) => ({ text: `${result.text}\n\n${line}` });

    if (was.kind === "idle") return said("No pinpoint server was running.");

    if (was.kind === "stopping") return said("pinpoint is already stopping.");
    become(host, { kind: "stopping" });

    // The server removes its files, pending batches included: stopping is the user's word.
    const closed = was.kind === "live" && (await close(host, was.child.address));

    if (was.kind === "live") was.child.end();

    if (!closed) await clean(host, was.tenure.record.serverSession);
    await $.store.delete(recordKey(was.tenure.sessionId));
    become(host, { kind: "idle" });

    return said("pinpoint stopped: its server ended, and the app's overlay disconnects.");
  });

  // A `/clear` mints a new session id, and `/resume` may land in another: the tenure carries over.
  on("command.run", { command: ["clear", "resume"] }, async ($, e, next) => {
    const result = await next(e);
    const sessionId = await $.session.id();
    const tenure = tenureOf(state);

    if (tenure === null || sessionId === tenure.sessionId) return result;
    const left = tenure.sessionId;
    tenure.sessionId = sessionId;
    await $.store.delete(recordKey(left));

    // A first server not up yet has no record to move: its start writes one under the new id.
    if (tenureOf(state) === tenure && tenure.record.port !== 0) {
      await $.store.set(recordKey(sessionId), tenure.record);
    }

    return result;
  });
};
