/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- these checks parse the state files read back from disk: `stateOf` and its guards are the boundary, and a file of another shape reads as no state. */
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Photo } from "./checkout.ts";
import { sha256 } from "./core/util/hash.ts";
import { isRecord } from "./core/util/json.ts";
import { writeAtomicSync } from "./lib/platform/fs.ts";
import { messageOf } from "./lib/platform/pure.ts";

export const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const STATE_VERSION = 3;

const TEMPORARY_SUFFIX = ".tmp";

/** Joins a session id and an agent id into a subagent's own state key, `<session>.<agent>`. */
const AGENT_SEPARATOR = ".";

export type LaneRun = "ok" | "fail" | "green" | "skipped" | "timeout" | "missing";

export type LastRun = {
  readonly at: number;
  readonly ms: number;
  readonly lanes: Record<string, LaneRun>;
};

/**
 * What one agent keeps in one checkout between hooks: its photo, the green keys and last run of its lanes, and the
 * loop guard's memory. The agent is the session, or one of its subagents under its own key.
 */
export type SessionState = {
  readonly version: typeof STATE_VERSION;
  /** The session id, or `<session>.<agent>` for one of its subagents. */
  readonly key: string;
  readonly checkout: string;
  photo: Photo | null;
  /** "lane@pkg" to the green key of its last successful run. */
  green: Record<string, string>;
  lastRun: LastRun | null;
  /** Lane to the files that failed at the last Stop. */
  lastFailing: Record<string, readonly string[]> | null;
  /** "lane\u0000file" to the number of diagnostic lines at the last Stop. */
  lastDiagnostics: Record<string, number> | null;
  blocksInTurn: number;
  promptId: string | null;
  updatedAt: number;
};

/** The state key of a hook's agent: the session, or for a subagent its own under the session. */
export function stateKey(sessionId: string, agentId: string | undefined): string {
  return agentId === undefined ? sessionId : `${sessionId}${AGENT_SEPARATOR}${agentId}`;
}

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

function checkoutKey(checkout: string): string {
  return sha256(path.resolve(checkout)).slice(0, 16);
}

function statePath(key: string, checkout: string): string {
  return path.join(stateDir(), `${sanitize(key)}__${checkoutKey(checkout)}.json`);
}

export function freshState(key: string, checkout: string, now = Date.now()): SessionState {
  return {
    version: STATE_VERSION,
    key,
    checkout: path.resolve(checkout),
    photo: null,
    green: {},
    lastRun: null,
    lastFailing: null,
    lastDiagnostics: null,
    blocksInTurn: 0,
    promptId: null,
    updatedAt: now,
  };
}

/** The saved state of the agent in this checkout, or a fresh one when none can be read. */
export function loadState(key: string, checkout: string, now = Date.now()): SessionState {
  return readState(statePath(key, checkout), key) ?? freshState(key, checkout, now);
}

function readState(file: string, key: string): SessionState | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));

    return isRecord(value) ? stateOf(value, key) : null;
  } catch {
    return null;
  }
}

function stateOf(value: Readonly<Record<string, unknown>>, key: string): SessionState | null {
  const checkout = value["checkout"];
  const photo = value["photo"];
  const green = value["green"];
  const lastRun = value["lastRun"];
  const lastFailing = value["lastFailing"];
  const lastDiagnostics = value["lastDiagnostics"];
  const promptId = value["promptId"];

  if (
    value["version"] !== STATE_VERSION ||
    typeof checkout !== "string" ||
    typeof value["blocksInTurn"] !== "number" ||
    typeof value["updatedAt"] !== "number" ||
    !(photo === null || isPhoto(photo)) ||
    !isStringRecord(green) ||
    !(lastRun === null || isLastRun(lastRun)) ||
    !(promptId === null || typeof promptId === "string") ||
    !(lastFailing === null || isStringArrayRecord(lastFailing)) ||
    !(lastDiagnostics === null || isNumberRecord(lastDiagnostics))
  ) {
    return null;
  }

  return {
    version: STATE_VERSION,
    key,
    checkout,
    photo,
    green,
    lastRun,
    lastFailing,
    lastDiagnostics,
    blocksInTurn: value["blocksInTurn"],
    promptId,
    updatedAt: value["updatedAt"],
  };
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

/** Writes the state through a temporary file and a rename, so a reader never sees a half-written file. */
export function saveState(state: SessionState, now = Date.now()): void {
  state.updatedAt = now;
  writeAtomicSync(statePath(state.key, state.checkout), JSON.stringify(state), { mkdir: true });
}

/**
 * Saves the state, or says why it could not: a hook's answer never fails on its state. Returns the reason, null once
 * saved.
 */
export function persist(state: SessionState, now = Date.now()): string | null {
  try {
    saveState(state, now);

    return null;
  } catch (error) {
    const reason = messageOf(error);
    console.error(`agent-hooks: state not saved: ${reason}`);

    return reason;
  }
}

/** Every saved state of this agent, one per checkout, sorted by checkout: the checkouts a Stop measures. */
export function statesOf(key: string): SessionState[] {
  const prefix = `${sanitize(key)}__`;

  return stateFiles()
    .filter((file) => file.startsWith(prefix))
    .flatMap((file) => readState(path.join(stateDir(), file), key) ?? [])
    .toSorted((left, right) =>
      left.checkout < right.checkout ? -1 : Number(left.checkout > right.checkout),
    );
}

/**
 * The most recent main-session state of this checkout: what `doctor` shows as the last Stop and `verify` takes its
 * scope from. A subagent's state, `<session>.<agent>`, holds that subagent's photo only.
 */
export function latestMainState(checkout: string): SessionState | null {
  const suffix = `__${checkoutKey(checkout)}.json`;

  const states = stateFiles()
    .filter((file) => file.endsWith(suffix))
    .flatMap((file) => {
      const key = file.slice(0, -suffix.length);

      return key.includes(AGENT_SEPARATOR)
        ? []
        : (readState(path.join(stateDir(), file), key) ?? []);
    });

  return states.toSorted((left, right) => right.updatedAt - left.updatedAt).at(0) ?? null;
}

function stateFiles(): string[] {
  try {
    return readdirSync(stateDir()).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * Removes every state file whose `updatedAt` is older than the TTL, an unreadable file counting as old, and every
 * temporary file older than `staleTemporaryMs` by its mtime: a younger one may be a save under way.
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
    try {
      return now - statSync(filePath).mtimeMs > staleTemporaryMs;
    } catch {
      return false;
    }
  }

  if (!file.endsWith(".json")) {
    return false;
  }

  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    const updatedAt = isRecord(value) ? value["updatedAt"] : undefined;

    return typeof updatedAt !== "number" || now - updatedAt > STATE_TTL_MS;
  } catch {
    return true;
  }
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}
