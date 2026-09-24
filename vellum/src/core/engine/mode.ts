import type { Timer } from "claude-code";

import type { Host } from "./host.ts";
import {
  parseRelayed,
  parseSession,
  projectDir,
  type ProjectDir,
  sessionId,
  type SessionId,
  type StageWire,
  type Token,
  type Workdir,
  workdirOf,
} from "./parse.ts";
import { follow, relayedKey } from "./relay.ts";
import { type Launched, type Lines, read, type ReviewServer, start } from "./server.ts";

export const HEARTBEAT_MS = 30_000;

export const LOST_RETRY_MS = 30_000;

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

/** A review server this module spawned, and the timer that keeps it alive. */
export type Live = {
  readonly session: Session;
  readonly server: ReviewServer;
  readonly heartbeat: Timer;
};

/**
 * The vellum mode, entered by `/vellum:start` and left by Approve or `/vellum:stop`. While
 * `live` a server answers, the lock holds, and what the server writes on its stdout is read.
 * What is under review lives on the server's disk; every transition here is an engine event or
 * a line of that server.
 */
export type State =
  | { readonly kind: "idle" }
  | { readonly kind: "live"; readonly live: Live }
  /** The server is gone and did not come back: the lock holds, a slow timer retries. */
  | { readonly kind: "lost"; readonly session: Session; readonly retry: Timer };

/**
 * How the relayed approval closes the mode: `register.ts` owns the one `state`, and closes
 * `from` only while it is still the current one, so an approval that lands after a new way in
 * leaves the new mode and its timers alone.
 */
export type Settle = (host: Host, from: State) => Promise<void>;

/**
 * Where the plan stands, each time the server says the review changed: for the band, then the
 * extensions' part, until a transition leaves `live`. `register.ts` owns the band and the
 * registry.
 */
export type Staged = (host: Host, live: Live, stage: StageWire) => Promise<void>;

/** A mode whose server ended: `register.ts` swaps in the revived one, or `lost`. */
export type Revive = (host: Host, from: State) => Promise<void>;

/** What `register.ts` hands every way into the mode: it owns the one `state` and the registry. */
export type Wiring = {
  readonly settle: Settle;
  readonly staged: Staged;
  readonly revive: Revive;
  /** Whether a transition left `live`: the lines of its server reach nobody from then on. */
  readonly left: (live: Live) => boolean;
};

/** The session the lock reads: the mode holds one while `live` and while `lost` alike. */
export function sessionOf(state: State): Session | null {
  if (state.kind === "idle") return null;

  return state.kind === "live" ? state.live.session : state.session;
}

export function sessionKey(id: SessionId): string {
  return `session:${id}`;
}

function storedSession(host: Host, id: SessionId): Promise<Session | null> {
  return host.storeGet(sessionKey(id)).then(parseSession);
}

/** A server for a session, spawned, before any timer starts: the caller may still drop it. */
type Found =
  | {
      readonly kind: "up";
      readonly session: Session;
      readonly server: ReviewServer;
      readonly lines: Lines;
    }
  | Exclude<Launched, { kind: "up" }>;

/**
 * A new server on the port, the token and the directory the store kept. A server this module did
 * not spawn cannot be read, so the kept one is never taken back: a reload has ended it, and a
 * port another process still holds gives the new server another port, under a new token.
 */
async function relaunched(host: Host, stored: Session): Promise<Found> {
  const launched = await start(host, stored.id, stored.project, stored.workdir, stored.server);

  if (launched.kind !== "up") return launched;
  const { server, lines } = launched;

  return { kind: "up", session: { ...stored, server: server.info }, server, lines };
}

function stopTimers(state: State): void {
  if (state.kind === "idle") return;

  if (state.kind === "lost") {
    state.retry.cancel();

    return;
  }

  state.live.heartbeat.cancel();
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

  return enter(host, got, wiring);
}

/**
 * Enters the mode on a spawned server: reads what it writes for as long as it runs, relays the
 * channel from the number the store kept, and keeps it alive. A server that ends while its mode
 * is current is revived; a line this module does not read is logged, never taken for nothing.
 */
async function enter(
  host: Host,
  got: Extract<Found, { kind: "up" }>,
  wiring: Wiring,
): Promise<State> {
  const { session, server, lines } = got;
  const from = parseRelayed(await host.storeGet(relayedKey(session.id)), session.workdir);
  const current = (): boolean => !wiring.left(live);

  // oxlint-disable-next-line unicorn/no-array-callback-reference -- `host.every` is `$.clock.every`, a timer, not `Array.prototype.every`.
  const heartbeat = host.every(HEARTBEAT_MS, () => {
    void server.heartbeat();
    follower.retry();
  });

  const live: Live = { session, server, heartbeat };
  const approved = (): Promise<void> => wiring.settle(host, entered);
  const follower = follow(host, live, from, { current, approved });
  const entered: State = { kind: "live", live };
  // One stage at a time, in the order written: an extension's read for an older one never lands last.
  let staging = Promise.resolve();

  void read(lines, {
    line: (line) => {
      if (line.type === "channel") follower.hand(line.line);

      if (line.type !== "stage") return;

      staging = staging
        .then(() => wiring.staged(host, live, line.stage))
        .catch((cause: unknown) => {
          host.log(`the review's stage was not drawn: ${String(cause)}`);
        });
    },
    unread: (text) => {
      host.log(`the review server wrote a line this module does not read: ${text.slice(0, 200)}`);
    },
    ended: (how) => {
      if (!current()) return;
      host.log(`the review server ended: ${JSON.stringify(how)}`);
      void wiring.revive(host, entered);
    },
  }).catch((cause: unknown) => {
    if (!current()) return;
    host.log(`the review server could not be read: ${String(cause)}`);
    void wiring.revive(host, entered);
  });

  follower.catchUp();
  // The band shows the mode; the status line is kept for what went wrong, and a revival ends it.
  host.status(undefined);

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

/**
 * `session.start`: the module reloaded, which ended every server it had spawned, so the mode the
 * store kept comes back on a relaunched one.
 */
export async function restore(host: Host, state: State, wiring: Wiring): Promise<State> {
  const id = sessionId(await host.sessionId());

  if (state.kind === "live" && state.live.session.id === id) return state;
  const stored = await storedSession(host, id);

  return stored === null ? state : settled(host, stored, await relaunched(host, stored), wiring);
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
 * Reaches a server, in order: the one this session already has when it answers, a relaunched one
 * on the directory, the port and the token `$.store` kept, or a new one on a fresh directory. A
 * `/clear` changes the session id, so the live server of another id is left to its watchdog and a
 * new one takes over.
 */
export async function connect(host: Host, state: State, wiring: Wiring): Promise<State> {
  const id = sessionId(await host.sessionId());
  const current = state.kind === "live" ? state.live : null;

  if (current?.session.id === id && (await current.server.alive())) return state;
  stopTimers(state);
  const stored = await storedSession(host, id);

  if (stored !== null) return settled(host, stored, await relaunched(host, stored), wiring);
  const project = projectDir(await host.cwd());
  const workdir = workdirOf(id, new Date().toISOString().slice(0, 10));
  const launched = await start(host, id, project, workdir, null);

  if (launched.kind !== "up") return { kind: "idle" };
  const session = { id, server: launched.server.info, project, workdir };

  return settled(host, session, { ...launched, session }, wiring);
}
