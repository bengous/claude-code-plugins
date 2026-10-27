/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- these checks parse the state files read back from disk: `parseState`, `stateOf` and their guards are the boundary, and a file of another shape reads as no state. */

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { sha256 } from "./hash.ts";
import { isRecord } from "./json.ts";

export const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const STATE_VERSION = 2;

const TEMPORARY_SUFFIX = ".tmp";

const BEAT_SUFFIX = ".beat";

const REFUSED_SUFFIX = ".refused";

/** Joins a session id and an agent id into a subagent's own state key, `<session>.<agent>`. */
export const AGENT_SEPARATOR = ".";

/** A checkout's baseline: its dirty tree when the agent first reached it. */
export type Photo = {
  readonly head: string | null;
  /** Checkout-relative path to the sha256 of its content, or "deleted" when the path is gone from disk. */
  readonly files: Record<string, string>;
  readonly takenAt: number;
};

export type LaneRun = "ok" | "fail" | "green" | "skipped" | "timeout" | "missing";

export type LastRun = {
  readonly at: number;
  readonly ms: number;
  readonly lanes: Record<string, LaneRun>;
};

/** What one root of the checkout keeps between Stops. */
export type RootRecord = {
  /** "lane@pkg" to the green key of its last successful run. */
  green: Record<string, string>;
  lastRun: LastRun | null;
};

/**
 * The state of one agent in one checkout: its photo, its brake, and the record of each root the Stop ran there.
 * The agent is the session, or one of its subagents under its own key.
 */
export type SessionState = {
  readonly version: typeof STATE_VERSION;
  /** The session id, or `<session>.<agent>` for the own state of one of its subagents. */
  readonly sessionId: string;
  readonly checkout: string;
  photo: Photo | null;
  /** `rootName` of each root the Stop ran in this checkout to its record. */
  roots: Record<string, RootRecord>;
  /** Root-qualified lane to the files that failed at the last Stop. */
  lastFailing: Record<string, readonly string[]> | null;
  /** "lane\u0000file" to the number of diagnostic lines at the last Stop. */
  lastDiagnostics: Record<string, number> | null;
  blocksInTurn: number;
  promptId: string | null;
  updatedAt: number;
};

export function stateDir(): string {
  const override = process.env["AGENT_HOOKS_STATE_DIR"];

  if (override !== undefined && override !== "") {
    return override;
  }

  const xdg = process.env["XDG_STATE_HOME"];

  const base =
    xdg !== undefined && xdg !== ""
      ? xdg
      : path.join(process.env["HOME"] ?? homedir(), ".local", "state");

  return path.join(base, "agent-hooks");
}

export function checkoutKey(checkout: string): string {
  return sha256(path.resolve(checkout)).slice(0, 16);
}

export function statePath(sessionId: string, checkout: string): string {
  return path.join(stateDir(), `${sanitize(sessionId)}__${checkoutKey(checkout)}.json`);
}

export function freshState(sessionId: string, checkout: string, now = Date.now()): SessionState {
  return {
    version: STATE_VERSION,
    sessionId,
    checkout: path.resolve(checkout),
    photo: null,
    roots: {},
    lastFailing: null,
    lastDiagnostics: null,
    blocksInTurn: 0,
    promptId: null,
    updatedAt: now,
  };
}

/** A root's name in the state of its checkout: its path relative to the checkout, `.` for the checkout itself. */
export function rootName(checkout: string, root: string): string {
  return path.relative(path.resolve(checkout), path.resolve(root)) || ".";
}

/** The record of `root` in the state of its checkout, empty until a Stop ran its lanes. */
export function rootRecord(state: SessionState, root: string): RootRecord {
  return (state.roots[rootName(state.checkout, root)] ??= { green: {}, lastRun: null });
}

/** The saved state of the agent in this checkout, or a fresh one; a corrupt file is replaced and reported once. */
export function loadState(sessionId: string, checkout: string, now = Date.now()): SessionState {
  const file = statePath(sessionId, checkout);
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch {
    return freshState(sessionId, checkout, now);
  }

  const parsed = parseState(text, sessionId, checkout);

  if (parsed === null) {
    console.error(`agent-hooks: ${file}: unreadable state, starting fresh`);

    return freshState(sessionId, checkout, now);
  }

  return parsed;
}

function parseState(text: string, sessionId: string, checkout: string): SessionState | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  return isRecord(value) ? stateOf(value, sessionId, checkout) : null;
}

function stateOf(
  value: Readonly<Record<string, unknown>>,
  sessionId: string,
  checkout: string,
): SessionState | null {
  if (
    value["version"] !== STATE_VERSION ||
    typeof value["blocksInTurn"] !== "number" ||
    typeof value["updatedAt"] !== "number"
  ) {
    return null;
  }

  const photo = value["photo"];
  const roots = value["roots"];
  const promptId = value["promptId"];
  const lastFailing = value["lastFailing"];
  const lastDiagnostics = value["lastDiagnostics"];

  if (
    !(photo === null || isPhoto(photo)) ||
    !isRootRecords(roots) ||
    !(promptId === null || typeof promptId === "string") ||
    !(lastFailing === null || isStringArrayRecord(lastFailing)) ||
    !(lastDiagnostics === null || isNumberRecord(lastDiagnostics))
  ) {
    return null;
  }

  return {
    version: STATE_VERSION,
    sessionId,
    checkout: path.resolve(checkout),
    photo,
    roots,
    lastFailing,
    lastDiagnostics,
    blocksInTurn: value["blocksInTurn"],
    promptId,
    updatedAt: value["updatedAt"],
  };
}

function isRootRecords(value: unknown): value is Record<string, RootRecord> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (record) =>
        isRecord(record) &&
        isStringRecord(record["green"]) &&
        (record["lastRun"] === null || isLastRun(record["lastRun"])),
    )
  );
}

function isPhoto(value: unknown): value is Photo {
  return (
    isRecord(value) &&
    (value["head"] === null || typeof value["head"] === "string") &&
    isStringRecord(value["files"]) &&
    typeof value["takenAt"] === "number"
  );
}

function isLastRun(value: unknown): value is LastRun {
  return (
    isRecord(value) &&
    typeof value["at"] === "number" &&
    typeof value["ms"] === "number" &&
    isStringRecord(value["lanes"])
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "number");
}

function isStringArrayRecord(value: unknown): value is Record<string, readonly string[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"),
    )
  );
}

/**
 * Writes `text` through a temporary file and a rename, so a reader never sees a half-written file. Each write has its
 * own temporary name: two hooks writing one file at once must not rename each other's.
 */
export function writeAtomically(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}${TEMPORARY_SUFFIX}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

export function saveState(state: SessionState, now = Date.now()): void {
  state.updatedAt = now;
  writeAtomically(statePath(state.sessionId, state.checkout), JSON.stringify(state));
}

/**
 * Removes every state file whose `updatedAt` is older than the TTL, unreadable files counting as old, every
 * heartbeat and refused-messages file whose mtime is older than the TTL, and every temporary file older than
 * `staleTemporaryMs`, dated by its mtime and never parsed: a save writes and renames its own within one hook, so a
 * younger one may be a save under way, half written.
 */
export function pruneStates(staleTemporaryMs: number, now = Date.now()): void {
  let files: string[];

  try {
    files = readdirSync(stateDir());
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = path.join(stateDir(), file);

    if (isStale(file, filePath, staleTemporaryMs, now)) {
      try {
        unlinkSync(filePath);
      } catch {
        // A file removed by a concurrent session is not an error.
      }
    }
  }
}

function isStale(file: string, filePath: string, staleTemporaryMs: number, now: number): boolean {
  if (file.endsWith(TEMPORARY_SUFFIX)) {
    return now - modifiedAt(filePath) > staleTemporaryMs;
  }

  if (file.endsWith(BEAT_SUFFIX) || file.endsWith(REFUSED_SUFFIX)) {
    return now - modifiedAt(filePath) > STATE_TTL_MS;
  }

  return file.endsWith(".json") && now - updatedAtOf(filePath) > STATE_TTL_MS;
}

function modifiedAt(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function updatedAtOf(filePath: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));

    return isRecord(value) && typeof value["updatedAt"] === "number" ? value["updatedAt"] : 0;
  } catch {
    return 0;
  }
}

/**
 * Every saved state of this agent, one per checkout, sorted by checkout, each file read once: the checkouts a Stop
 * measures.
 */
export function statesOf(sessionId: string): SessionState[] {
  const prefix = `${sanitize(sessionId)}__`;
  let files: string[];

  try {
    files = readdirSync(stateDir()).filter(
      (file) => file.startsWith(prefix) && file.endsWith(".json"),
    );
  } catch {
    return [];
  }

  return files
    .flatMap((file) => {
      let value: unknown;

      try {
        value = JSON.parse(readFileSync(path.join(stateDir(), file), "utf8"));
      } catch {
        return [];
      }

      const checkout = isRecord(value) ? value["checkout"] : undefined;

      const state =
        isRecord(value) && typeof checkout === "string"
          ? stateOf(value, sessionId, checkout)
          : null;

      return state === null ? [] : [state];
    })
    .toSorted((left, right) =>
      left.checkout < right.checkout ? -1 : Number(left.checkout > right.checkout),
    );
}

/**
 * The most recent main-session state of this checkout: what `doctor` shows as a root's last Stop and `verify` takes
 * its scope from. A subagent's state, `<session>.<agent>`, holds that subagent's photo only.
 */
export function latestStateForCheckout(checkout: string): SessionState | null {
  const suffix = `__${checkoutKey(checkout)}.json`;
  let files: string[];

  try {
    files = readdirSync(stateDir()).filter(
      (file) => file.endsWith(suffix) && !file.slice(0, -suffix.length).includes(AGENT_SEPARATOR),
    );
  } catch {
    return null;
  }

  const states = files.flatMap((file) => {
    try {
      const sessionId = file.slice(0, -suffix.length);

      const parsed = parseState(
        readFileSync(path.join(stateDir(), file), "utf8"),
        sessionId,
        checkout,
      );

      return parsed === null ? [] : [parsed];
    } catch {
      return [];
    }
  });

  return states.toSorted((left, right) => right.updatedAt - left.updatedAt).at(0) ?? null;
}

export function beatPath(key: string, checkout: string): string {
  return path.join(stateDir(), `${sanitize(key)}__${checkoutKey(checkout)}${BEAT_SUFFIX}`);
}

/** Marks agent `key` live in the checkout: an empty file whose mtime is the last kit hook the agent ran there. */
export function beat(key: string, checkout: string): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(beatPath(key, checkout), "");
}

/**
 * The keys of the agents of other sessions, subagents included, that beat in this checkout at `since` or later;
 * `sessionId` and its own subagents left out.
 */
export function liveOthers(checkout: string, sessionId: string, since: number): string[] {
  const here = checkoutKey(checkout);

  return beatFiles().flatMap(({ file, key, checkout: beatCheckout }) =>
    beatCheckout !== here || isOfSession(key, sessionId) || !beatSince(file, since) ? [] : [key],
  );
}

/** Removes the beats of a session that ended and of its subagents, in every checkout. */
export function endBeats(sessionId: string): void {
  for (const { file, key } of beatFiles()) {
    if (isOfSession(key, sessionId)) {
      try {
        unlinkSync(path.join(stateDir(), file));
      } catch {
        // A file removed by a concurrent session is not an error.
      }
    }
  }
}

type BeatFile = { readonly file: string; readonly key: string; readonly checkout: string };

/** The beats in the state dir, each with the agent key and the checkout key its name holds; none without the dir. */
function beatFiles(): BeatFile[] {
  let files: string[];

  try {
    files = readdirSync(stateDir());
  } catch {
    return [];
  }

  return files.flatMap((file) => {
    const name = file.endsWith(BEAT_SUFFIX) ? file.slice(0, -BEAT_SUFFIX.length) : "";
    const split = name.lastIndexOf("__");

    return split === -1
      ? []
      : [{ file, key: name.slice(0, split), checkout: name.slice(split + "__".length) }];
  });
}

function isOfSession(key: string, sessionId: string): boolean {
  const own = sanitize(sessionId);

  return key === own || key.startsWith(`${own}${AGENT_SEPARATOR}`);
}

/** Whether the beat was refreshed at `since` or later: one removed since the dir was listed is not live. */
function beatSince(file: string, since: number): boolean {
  try {
    return statSync(path.join(stateDir(), file)).mtimeMs >= since;
  } catch {
    return false;
  }
}

/**
 * The file holding the hashes of the commit messages the judge refused to agent `key`: each of them, committed again
 * unchanged, passes. Kept apart from the state files, which are per checkout and saved by the edit hooks.
 */
export function refusedPath(key: string): string {
  return path.join(stateDir(), `${sanitize(key)}${REFUSED_SUFFIX}`);
}

/** The hashes the judge refused to agent `key`; none when absent, and none when unreadable, which is reported. */
export function loadRefused(key: string): string[] {
  const file = refusedPath(key);
  let value: unknown;

  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.error(`agent-hooks: ${file}: unreadable refused messages, ignored`);
    }

    return [];
  }

  if (!Array.isArray(value) || !value.every((hash) => typeof hash === "string")) {
    console.error(`agent-hooks: ${file}: unreadable refused messages, ignored`);

    return [];
  }

  return value;
}

export function saveRefused(key: string, hashes: readonly string[]): void {
  writeAtomically(refusedPath(key), JSON.stringify(hashes));
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}
