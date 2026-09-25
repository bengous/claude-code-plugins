import type { ProcessSpawnResult, Timer } from "claude-code";

import type { Host } from "./host.ts";
import {
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
import { follow, type Follower } from "./relay.ts";
import { type Child, type Launched, read, type ReviewServer, start } from "./server.ts";

export const HEARTBEAT_MS = 30_000;

export const LOST_RETRY_MS = 30_000;

/** Heartbeats in a row a server may leave unanswered before it is ended, and revived. */
const HEARTBEATS_MISSED = 2;

/** Unexpected ends of a mode's servers within `CRASH_WINDOW_MS` that stop the revivals. */
export const CRASHES_BEFORE_LOST = 3;

export const CRASH_WINDOW_MS = 60_000;

const STATUS_LOST = "server lost, retrying";

const STATUS_GONE = "working directory gone, run /vellum:stop";

export type ServerInfo = { readonly port: number; readonly token: Token; readonly pid: number };

/**
 * What `$.store` keeps under `session:<id>`, so a reloaded module finds its server again.
 * `project` is the root the server was started in: the working directory hangs off it, while
 * the session's own directory moves with every `cd` the model runs. `final` is where an approval
 * renamed the working directory, once the server said so: a server revived before the approval
 * reached Claude is started there. `pinnedCwd` says vellum set
 * `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` as the mode began and unsets it as the mode returns
 * to idle; the record keeps it, so a reload or a `claude --resume` still knows the value is vellum's.
 */
export type Session = {
  readonly id: SessionId;
  readonly server: ServerInfo;
  readonly project: ProjectDir;
  readonly workdir: Workdir;
  readonly final: Workdir | null;
  readonly pinnedCwd: boolean;
};

/**
 * What a mode keeps across the servers a revival replaces, and drops when it leaves: the follower
 * of its channel, and when its servers ended unexpectedly, within `CRASH_WINDOW_MS`.
 */
export type Tenure = { readonly follower: Follower; readonly crashes: readonly number[] };

/** A review server this module spawned, the timer that keeps it alive, and the mode's tenure. */
export type Live = {
  readonly session: Session;
  readonly server: ReviewServer;
  readonly child: Child;
  readonly heartbeat: Timer;
  readonly tenure: Tenure;
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
  | {
      readonly kind: "lost";
      readonly session: Session;
      readonly retry: Timer;
      readonly tenure: Tenure;
    };

/**
 * How the relayed approval closes the mode of session `id`: `register.ts` owns the one `state`,
 * and closes it only while it holds that session, live or lost, so an approval that lands after a
 * way into another session leaves that mode alone.
 */
export type Settle = (host: Host, id: SessionId) => Promise<void>;

/**
 * Where the plan stands, each time the server says the review changed: for the band, then the
 * extensions' part. `register.ts` owns the band and the registry.
 */
export type Staged = (host: Host, live: Live, stage: StageWire) => Promise<void>;

/**
 * A mode whose server ended while it was the current one, `how` it ended; `null` for the slow
 * retry of `lost`. `register.ts` swaps in the revived mode, or `lost`.
 */
export type Revive = (host: Host, from: State, how: ProcessSpawnResult | null) => Promise<void>;

/** What `register.ts` hands every way into the mode: it owns the one `state` and the registry. */
export type Wiring = {
  readonly settle: Settle;
  readonly staged: Staged;
  readonly revive: Revive;
  /** Whether `from` is still the current state: a server that ends after its mode left is no crash. */
  readonly current: (from: State) => boolean;
};

/** The session the lock reads: the mode holds one while `live` and while `lost` alike. */
export function sessionOf(state: State): Session | null {
  if (state.kind === "idle") return null;

  return state.kind === "live" ? state.live.session : state.session;
}

/** What the mode keeps across its servers; `null` while idle. */
export function tenureOf(state: State): Tenure | null {
  if (state.kind === "idle") return null;

  return state.kind === "live" ? state.live.tenure : state.tenure;
}

export function sessionKey(id: SessionId): string {
  return `session:${id}`;
}

function storedSession(host: Host, id: SessionId): Promise<Session | null> {
  return host.storeGet(sessionKey(id)).then(parseSession);
}

/** The values Claude Code reads as true in a variable. */
const TRUE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/**
 * Whether vellum pins the working directory for the mode it opens. A record that says so keeps
 * it: a reload or a resume finds vellum's own value set. Otherwise a value already true while
 * `state` holds no session vellum pinned is the person's, and vellum never touches it.
 */
async function pinsCwd(host: Host, state: State, stored: Session | null): Promise<boolean> {
  if (stored?.pinnedCwd === true) return true;

  // A value nobody can read is nobody's: vellum sets it, and a failed write is only logged.
  const value = await host.projectCwdFlag().catch((cause: unknown) => {
    host.log(`the project's working directory could not be read: ${String(cause)}`);

    return null;
  });

  const set = value !== null && value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());

  return !set || sessionOf(state)?.pinnedCwd === true;
}

/** The tenure `state` holds for session `id`, else a new one: one follower per session. */
function tenureFor(host: Host, state: State, id: SessionId, wiring: Wiring): Tenure {
  const held = tenureOf(state);

  if (held !== null && sessionOf(state)?.id === id) return held;

  return { follower: follow(host, id, () => wiring.settle(host, id)), crashes: [] };
}

/** A server for a session, spawned, before any timer starts: the caller may still drop it. */
type Found =
  | {
      readonly kind: "up";
      readonly session: Session;
      readonly server: ReviewServer;
      readonly child: Child;
      readonly channel: string;
    }
  | Exclude<Launched, { kind: "up" }>;

/**
 * A new server on the port, the token and the directory the store kept, the final one once an
 * approval renamed it. A server this module did not spawn cannot be read, so the kept one is never
 * taken back: a reload has ended it, and a port another process still holds gives the new server
 * another port, under a new token.
 */
async function relaunched(host: Host, stored: Session): Promise<Found> {
  const { id, project, workdir, server, final } = stored;
  const launched = await start(host, id, project, workdir, server, final);

  if (launched.kind !== "up") return launched;

  return { ...launched, session: { ...stored, server: launched.server.info } };
}

function stopTimers(state: State): void {
  if (state.kind === "idle") return;

  if (state.kind === "lost") {
    state.retry.cancel();

    return;
  }

  state.live.heartbeat.cancel();
}

/** A state a transition never took: its timers stop and its server ends. */
export function discard(state: State): void {
  stopTimers(state);

  if (state.kind === "live") state.live.child.end();
}

/**
 * Never `idle`: the lock opens outside the mode, so a server that fails would hand Claude the
 * repository without an approval. The session is kept, and the retry goes through `revive`.
 */
function lose(
  host: Host,
  session: Session,
  why: "gone" | "failed",
  wiring: Wiring,
  tenure: Tenure,
): State {
  host.status(why === "gone" ? STATUS_GONE : STATUS_LOST);

  // oxlint-disable-next-line unicorn/no-array-callback-reference -- `host.every` is `$.clock.every`, a timer, not `Array.prototype.every`.
  const retry = host.every(LOST_RETRY_MS, () => {
    wiring.revive(host, lost, null).catch((cause: unknown) => {
      host.log(`the review server was not revived: ${String(cause)}`);
    });
  });

  const lost: State = { kind: "lost", session, retry, tenure };

  return lost;
}

async function settled(
  host: Host,
  stored: Session,
  got: Found,
  wiring: Wiring,
  tenure: Tenure,
): Promise<State> {
  if (got.kind !== "up") return lose(host, stored, got.kind, wiring, tenure);
  await host.storeSet(sessionKey(got.session.id), got.session);

  return enter(host, got, wiring, tenure);
}

/**
 * Enters the mode on a spawned server: reads what it writes for as long as it runs, hands the
 * channel to the tenure's follower, and keeps it alive. A server that ends while its mode is the
 * current one is revived, and so is one that leaves `HEARTBEATS_MISSED` heartbeats unanswered,
 * ended first. A line this module does not read is logged, never taken for nothing.
 */
function enter(
  host: Host,
  got: Extract<Found, { kind: "up" }>,
  wiring: Wiring,
  tenure: Tenure,
): State {
  const { session, server, child, channel } = got;
  const current = (): boolean => wiring.current(entered);
  let missed = 0;
  let final = session.final;

  // oxlint-disable-next-line unicorn/no-array-callback-reference -- `host.every` is `$.clock.every`, a timer, not `Array.prototype.every`.
  const heartbeat = host.every(HEARTBEAT_MS, () => {
    tenure.follower.retry();
    void server.heartbeat().then((answered) => {
      missed = answered ? 0 : missed + 1;

      if (missed < HEARTBEATS_MISSED) return;
      host.log(`the review server left ${missed} heartbeats unanswered: ended, to be revived`);
      child.end();
    });
  });

  const live: Live = { session, server, child, heartbeat, tenure };
  const entered: State = { kind: "live", live };

  const revive = (how: ProcessSpawnResult): void => {
    wiring.revive(host, entered, how).catch((cause: unknown) => {
      host.log(`the review server was not revived: ${String(cause)}`);
    });
  };

  // One stage at a time, in the order written: an extension's read for an older one never lands last.
  let staging = Promise.resolve();

  void read(child.lines, {
    line: (line) => {
      if (line.type === "channel") tenure.follower.hand(line.line);

      if (line.type !== "stage") return;

      // Where the review lives once approved, before the approval reaches Claude: a server
      // revived meanwhile is started there, and relays it.
      if (line.stage.kind === "approved" && final === null && current()) {
        final = line.dir;
        void host
          .storeSet(sessionKey(session.id), { ...session, final })
          .catch((cause: unknown) => {
            host.log(`the approved directory was not kept: ${String(cause)}`);
          });
      }

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
      revive(how);
    },
  }).catch((cause: unknown) => {
    if (!current()) return;
    host.log(`the review server could not be read: ${String(cause)}`);
    revive({ code: null, signal: null });
  });

  tenure.follower.serve(server, channel);
  // The band shows the mode; the status line is kept for what went wrong, and a revival ends it.
  host.status(undefined);

  return entered;
}

/**
 * Stops the mode's timers and forgets nothing: the session's record stays, so a `/resume` of
 * that session later finds its directory and restarts a server on it. `register.ts` ends the
 * server as the mode leaves.
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
 * `session.start`: a reload ended every server this module spawned, so the mode the store kept
 * comes back on a relaunched one. The mode of another session is left first; this session's own
 * live mode is kept.
 */
export async function restore(host: Host, state: State, wiring: Wiring): Promise<State> {
  const id = sessionId(await host.sessionId());

  if (state.kind === "live" && state.live.session.id === id) return state;
  const kept = await storedSession(host, id);

  if (kept === null) return state;
  const stored = { ...kept, pinnedCwd: await pinsCwd(host, state, kept) };
  stopTimers(state);
  const tenure = tenureFor(host, state, id, wiring);

  return settled(host, stored, await relaunched(host, stored), wiring, tenure);
}

/** When the mode's servers ended unexpectedly, this one at `now` included, within the window. */
function crashesUntil(tenure: Tenure, now: number): readonly number[] {
  return [...tenure.crashes, now].filter((at) => now - at < CRASH_WINDOW_MS);
}

/**
 * `from`'s server ended, `how` it did; `null` for the slow retry of `lost`. A server that ended
 * `CRASHES_BEFORE_LOST` times within `CRASH_WINDOW_MS` is not revived: the mode goes `lost`, and
 * its slow retry paces what comes next. `null` when `from` was left during the launch: a `/clear`,
 * a `/vellum:stop` or a new way in wins, and the server started for nothing is ended.
 */
export async function revived(
  host: Host,
  from: State,
  still: () => boolean,
  wiring: Wiring,
  how: ProcessSpawnResult | null,
): Promise<State | null> {
  const held = sessionOf(from);
  const kept = tenureOf(from);

  if (held === null || kept === null) return null;
  // The store knows the final directory the moment the server said it; `from` may not. The pin
  // is the mode's own: a relaunch that failed never stored what `restore` decided.
  const session = { ...((await storedSession(host, held.id)) ?? held), pinnedCwd: held.pinnedCwd };
  const crashes = how === null ? kept.crashes : crashesUntil(kept, await host.now());
  const tenure = { ...kept, crashes };

  if (how !== null && crashes.length >= CRASHES_BEFORE_LOST) {
    host.log(
      `the review server ended ${crashes.length} times within ${CRASH_WINDOW_MS / 1000} s, the last with ${JSON.stringify(how)}: not revived`,
    );

    if (!still()) return null;
    stopTimers(from);

    return lose(host, session, "failed", wiring, tenure);
  }

  const got = await relaunched(host, session);

  if (!still()) {
    if (got.kind === "up") got.child.end();

    return null;
  }

  stopTimers(from);

  return settled(host, session, got, wiring, tenure);
}

/**
 * Reaches a server, in order: the one this session already has when it answers, a relaunched one
 * on the directory, the port and the token `$.store` kept, or a new one on a fresh directory. A
 * `/clear` changes the session id, so the mode of another id is left and a new one takes over.
 */
export async function connect(host: Host, state: State, wiring: Wiring): Promise<State> {
  const id = sessionId(await host.sessionId());
  const current = state.kind === "live" ? state.live : null;

  if (current?.session.id === id && (await current.server.alive())) return state;
  const kept = await storedSession(host, id);
  const pinnedCwd = await pinsCwd(host, state, kept);
  stopTimers(state);
  const tenure = tenureFor(host, state, id, wiring);

  if (kept !== null) {
    const stored = { ...kept, pinnedCwd };

    return settled(host, stored, await relaunched(host, stored), wiring, tenure);
  }

  // The root, not the session's directory: the pin sends every command back there.
  const project = projectDir(await host.root());
  const workdir = workdirOf(id, new Date().toISOString().slice(0, 10));
  const launched = await start(host, id, project, workdir, null, null);

  if (launched.kind !== "up") return { kind: "idle" };
  const session = { id, server: launched.server.info, project, workdir, final: null, pinnedCwd };

  return settled(host, session, { ...launched, session }, wiring, tenure);
}
