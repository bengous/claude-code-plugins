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
import { reach, type ReviewServer, start } from "./server.ts";

export const POLL_MS = 1_000;

export const HEARTBEAT_MS = 30_000;

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
  | { readonly kind: "live"; readonly live: Live; readonly poll: Timer };

/**
 * How a poll closes the mode from inside a tick: `register.ts` owns the one `state`, and
 * closes `from` only while it is still the current one, so a tick that lands after a new way
 * in leaves the new mode and its timers alone.
 */
export type Settle = (host: Host, from: State) => Promise<void>;

/** The extensions' part of a poll, run after the core's relay; `register.ts` owns the registry. */
export type Ticks = (host: Host, live: Live) => Promise<void>;

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

/** The session `$.store` kept across a module reload, when its server still answers. */
async function restored(host: Host, stored: Session | null): Promise<Live | null> {
  if (stored === null) return null;
  const server = reach(host, stored.server);

  return (await server.alive()) ? keepAlive(host, stored, server) : null;
}

async function started(
  host: Host,
  id: SessionId,
  project: ProjectDir,
  workdir: Workdir,
): Promise<Live | null> {
  const server = await start(host, id, project, workdir);

  if (server === null) return null;
  const session = { id, server: server.info, project, workdir };
  await host.storeSet(sessionKey(id), session);

  return keepAlive(host, session, server);
}

function stopTimers(state: State): void {
  if (state.kind === "idle") return;
  state.live.heartbeat.cancel();
  state.poll.cancel();
}

/** Enters the mode: one poll a second until it closes. A failed poll is logged and retried. */
async function enter(host: Host, live: Live, settle: Settle, ticks: Ticks): Promise<State> {
  let relayed: Relayed = parseRelayed(
    await host.storeGet(relayedKey(live.session.id)),
    live.session.workdir,
  );

  let relaying = false;

  // oxlint-disable-next-line unicorn/no-array-callback-reference -- `host.every` is `$.clock.every`, a timer, not `Array.prototype.every`.
  const poll = host.every(POLL_MS, () => {
    if (relaying) return;
    relaying = true;

    void tick(host, live, relayed)
      .then(async (ticked) => {
        relayed = ticked.relayed;

        if (ticked.approved) await settle(host, entered);
        else await ticks(host, live);
      })
      .catch((cause: unknown) => {
        host.log(`the review poll failed: ${String(cause)}`);
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
  if (state.kind === "idle") return state;
  await host.storeDelete(sessionKey(state.live.session.id));

  return suspend(host, state);
}

/** `session.start`: the module reloaded, so pick the mode back up when the server still answers. */
export async function restore(
  host: Host,
  state: State,
  settle: Settle,
  ticks: Ticks,
): Promise<State> {
  const id = sessionId(await host.sessionId());
  const live = await restored(host, await storedSession(host, id));

  return live === null ? state : enter(host, live, settle, ticks);
}

/**
 * Reaches a server, in order: the one this session already has when it answers, the one
 * `$.store` kept, a new one on the directory the store kept, or on a fresh one. A `/clear`
 * changes the session id, so the live server of another id is left to its heartbeat and a
 * new one takes over.
 */
export async function connect(
  host: Host,
  state: State,
  settle: Settle,
  ticks: Ticks,
): Promise<State> {
  const id = sessionId(await host.sessionId());
  const current = state.kind === "idle" ? null : state.live;

  if (current?.session.id === id && (await current.server.alive())) return state;
  stopTimers(state);
  const stored = await storedSession(host, id);
  const date = new Date().toISOString().slice(0, 10);
  const project = stored?.project ?? projectDir(await host.cwd());
  const workdir = stored?.workdir ?? workdirOf(id, date);
  const live = (await restored(host, stored)) ?? (await started(host, id, project, workdir));

  if (live === null) return { kind: "idle" };

  return enter(host, live, settle, ticks);
}
