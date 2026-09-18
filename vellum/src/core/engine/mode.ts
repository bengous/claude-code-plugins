import type { Timer } from "claude-code";

import type { Host } from "./host.ts";
import {
  parseRelayed,
  parseSession,
  projectDir,
  type ProjectDir,
  sessionId,
  type SessionId,
  type Token,
  type Workdir,
  workdirOf,
} from "./parse.ts";
import { type Relayed, relayedKey, tick } from "./relay.ts";
import { type Launched, reach, type ReviewServer, ServerDown, start } from "./server.ts";

export const POLL_MS = 1_000;

export const HEARTBEAT_MS = 30_000;

export const LOST_RETRY_MS = 30_000;

const SERVER_FAILURES_BEFORE_REVIVE = 3;

const STATUS_LOST = "server lost, retrying";

const STATUS_GONE = "working directory gone, run /vellum:stop";

export type ServerInfo = { readonly port: number; readonly token: Token; readonly pid: number };

/**
 * What `$.store` keeps under `session:<id>`, so a reloaded module finds its server again.
 * `project` is the root the server was started in: the working directory hangs off it, while
 * the session's own directory moves with every `cd` the model runs.
 */
export type Session = {
  readonly id: SessionId;
  readonly server: ServerInfo;
  readonly project: ProjectDir;
  readonly workdir: Workdir;
};

/** A reachable review server and the timer that keeps it alive. */
export type Live = {
  readonly session: Session;
  readonly server: ReviewServer;
  readonly heartbeat: Timer;
};

/**
 * The vellum mode, entered by `/vellum:start` and left by Approve or `/vellum:stop`. While
 * `live` a server answers, the lock holds, and the browser's decision is polled. What is
 * under review lives on the server's disk; every transition here is an engine event or an
 * answer from that server.
 */
export type State =
  | { readonly kind: "idle" }
  | { readonly kind: "live"; readonly live: Live; readonly poll: Timer }
  /** The server is gone and did not come back: the lock holds, a slow timer retries. */
  | { readonly kind: "lost"; readonly session: Session; readonly retry: Timer };

/**
 * How a poll closes the mode from inside a tick: `register.ts` owns the one `state`, and
 * closes `from` only while it is still the current one, so a tick that lands after a new way
 * in leaves the new mode and its timers alone.
 */
export type Settle = (host: Host, from: State) => Promise<void>;

/** The extensions' part of a poll, run after the core's relay; `register.ts` owns the registry. */
export type Ticks = (host: Host, live: Live) => Promise<void>;

/** A mode whose server stopped answering: `register.ts` swaps in the revived one, or `lost`. */
export type Revive = (host: Host, from: State) => Promise<void>;

/** What `register.ts` hands every way into the mode: it owns the one `state` and the registry. */
export type Wiring = {
  readonly settle: Settle;
  readonly ticks: Ticks;
  readonly revive: Revive;
};

/** The session the lock reads: the mode holds one while `live` and while `lost` alike. */
export function sessionOf(state: State): Session | null {
  if (state.kind === "idle") return null;

  return state.kind === "live" ? state.live.session : state.session;
}

export function sessionKey(id: SessionId): string {
  return `session:${id}`;
}

function keepAlive(host: Host, session: Session, server: ReviewServer): Live {
  // oxlint-disable-next-line unicorn/no-array-callback-reference -- `host.every` is `$.clock.every`, a timer, not `Array.prototype.every`.
  const heartbeat = host.every(HEARTBEAT_MS, () => {
    void server.heartbeat();
  });

  return { session, server, heartbeat };
}

function storedSession(host: Host, id: SessionId): Promise<Session | null> {
  return host.storeGet(sessionKey(id)).then(parseSession);
}

/** A server for a session the store kept, before any timer starts: the caller may still drop it. */
type Found =
  | { readonly kind: "up"; readonly session: Session; readonly server: ReviewServer }
  | Exclude<Launched, { kind: "up" }>;

/** A new server on the port, the token and the directory the dead one had. */
async function relaunched(host: Host, stored: Session): Promise<Found> {
  const launched = await start(host, stored.id, stored.project, stored.workdir, stored.server);

  if (launched.kind !== "up") return launched;
  const { server } = launched;
  const kept = reach(host, stored.server);

  // Another port means the kept one was taken, which is evidence the kept server is up, not
  // gone: one probe had failed. It is kept, since the reviewer's tab talks to it; the rival
  // nobody beats or listens to expires by itself.
  if (server.info.port !== stored.server.port && (await kept.alive())) {
    return { kind: "up", session: stored, server: kept };
  }

  return { kind: "up", session: { ...stored, server: server.info }, server };
}

/** The server the store kept when it still answers, as after a module reload; a revived one else. */
async function found(host: Host, stored: Session): Promise<Found> {
  const server = reach(host, stored.server);

  return (await server.alive())
    ? { kind: "up", session: stored, server }
    : relaunched(host, stored);
}

function stopTimers(state: State): void {
  if (state.kind === "idle") return;

  if (state.kind === "lost") {
    state.retry.cancel();

    return;
  }

  state.live.heartbeat.cancel();
  state.poll.cancel();
}

/**
 * Never `idle`: the lock opens outside the mode, so a server that fails would hand Claude the
 * repository without an approval. The session is kept, and the retry goes through `revive`.
 */
function lose(host: Host, session: Session, why: "gone" | "failed", wiring: Wiring): State {
  host.status(why === "gone" ? STATUS_GONE : STATUS_LOST);

  // oxlint-disable-next-line unicorn/no-array-callback-reference -- `host.every` is `$.clock.every`, a timer, not `Array.prototype.every`.
  const retry = host.every(LOST_RETRY_MS, () => {
    void wiring.revive(host, lost);
  });

  const lost: State = { kind: "lost", session, retry };

  return lost;
}

async function settled(host: Host, stored: Session, got: Found, wiring: Wiring): Promise<State> {
  if (got.kind !== "up") return lose(host, stored, got.kind, wiring);
  await host.storeSet(sessionKey(got.session.id), got.session);

  return enter(host, keepAlive(host, got.session, got.server), wiring);
}

/**
 * Enters the mode: one poll a second until it closes. A failed poll is logged and retried; the
 * third one in a row that the server itself failed asks for a revival, once.
 */
async function enter(host: Host, live: Live, wiring: Wiring): Promise<State> {
  let relayed: Relayed = parseRelayed(
    await host.storeGet(relayedKey(live.session.id)),
    live.session.workdir,
  );

  let relaying = false;
  let serverFailures = 0;

  // oxlint-disable-next-line unicorn/no-array-callback-reference -- `host.every` is `$.clock.every`, a timer, not `Array.prototype.every`.
  const poll = host.every(POLL_MS, () => {
    if (relaying) return;
    relaying = true;

    void tick(host, live, relayed)
      .then(async (ticked) => {
        relayed = ticked.relayed;
        serverFailures = 0;

        if (ticked.approved) await wiring.settle(host, entered);
        else await wiring.ticks(host, live);
      })
      .catch((cause: unknown) => {
        host.log(`the review poll failed: ${String(cause)}`);

        if (!(cause instanceof ServerDown)) return;
        serverFailures += 1;

        if (serverFailures === SERVER_FAILURES_BEFORE_REVIVE) void wiring.revive(host, entered);
      })
      .finally(() => {
        relaying = false;
      });
  });

  const entered: State = { kind: "live", live, poll };
  host.status("planning");

  return entered;
}

/**
 * Stops the mode's timers and forgets nothing: the session's record stays, so a `/resume` of
 * that session later finds its directory and its server, or restarts one on the directory.
 */
export function suspend(host: Host, state: State): State {
  if (state.kind === "idle") return state;
  stopTimers(state);
  host.status(undefined);

  return { kind: "idle" };
}

/**
 * Leaves the mode. What was relayed stays in the store: a `/vellum:start` after a stop reuses
 * the session's directory, and what Claude already read must not be named again.
 */
export async function close(host: Host, state: State): Promise<State> {
  const session = sessionOf(state);

  if (session === null) return state;
  await host.storeDelete(sessionKey(session.id));

  return suspend(host, state);
}

/** `session.start`: the module reloaded, so pick the mode back up, on a revived server when the kept one died. */
export async function restore(host: Host, state: State, wiring: Wiring): Promise<State> {
  const stored = await storedSession(host, sessionId(await host.sessionId()));

  return stored === null ? state : settled(host, stored, await found(host, stored), wiring);
}

/**
 * `from`'s server stopped answering. `null` when `from` was left during the launch: a `/clear`,
 * a `/vellum:stop` or a new way in wins, and the server started for nothing exits by itself,
 * with no heartbeat and no tab.
 */
export async function revived(
  host: Host,
  from: State,
  still: () => boolean,
  wiring: Wiring,
): Promise<State | null> {
  const session = sessionOf(from);

  if (session === null) return null;
  const got = await relaunched(host, session);

  if (!still()) return null;
  stopTimers(from);

  return settled(host, session, got, wiring);
}

/**
 * Reaches a server, in order: the one this session already has when it answers, the one
 * `$.store` kept, a revived one on the directory the store kept, or a new one on a fresh
 * directory. A `/clear` changes the session id, so the live server of another id is left to
 * its heartbeat and a new one takes over.
 */
export async function connect(host: Host, state: State, wiring: Wiring): Promise<State> {
  const id = sessionId(await host.sessionId());
  const current = state.kind === "live" ? state.live : null;

  if (current?.session.id === id && (await current.server.alive())) return state;
  stopTimers(state);
  const stored = await storedSession(host, id);

  if (stored !== null) return settled(host, stored, await found(host, stored), wiring);
  const project = projectDir(await host.cwd());
  const workdir = workdirOf(id, new Date().toISOString().slice(0, 10));
  const launched = await start(host, id, project, workdir, null);

  if (launched.kind !== "up") return { kind: "idle" };
  const session = { id, server: launched.server.info, project, workdir };

  return settled(host, session, { kind: "up", session, server: launched.server }, wiring);
}
