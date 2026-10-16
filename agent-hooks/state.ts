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

import { isRecord } from "./json.ts";
import { sha256 } from "./scope.ts";

export const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const STATE_VERSION = 1;

const TEMPORARY_SUFFIX = ".tmp";

/** Joins a session id and an agent id into a subagent's own state key, `<session>.<agent>`. */
export const AGENT_SEPARATOR = ".";

export type Photo = {
  readonly head: string | null;
  /** Repo-relative path to the sha256 of its content, or "deleted" when the path is gone from disk. */
  readonly files: Record<string, string>;
  readonly takenAt: number;
};

export type LaneRun = "ok" | "fail" | "green" | "skipped" | "timeout" | "missing";

export type LastRun = {
  readonly at: number;
  readonly ms: number;
  readonly lanes: Record<string, LaneRun>;
};

export type SessionState = {
  readonly version: typeof STATE_VERSION;
  /** The session id, or `<session>.<agent>` for the own state of one of its subagents. */
  readonly sessionId: string;
  readonly root: string;
  photo: Photo | null;
  /** "lane@pkg" to the green key of its last successful run. */
  green: Record<string, string>;
  /** Lane to the files that failed at the last Stop. */
  lastFailing: Record<string, readonly string[]> | null;
  /** "lane\u0000file" to the number of diagnostic lines at the last Stop. */
  lastDiagnostics: Record<string, number> | null;
  lastRun: LastRun | null;
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

export function rootKey(root: string): string {
  return sha256(path.resolve(root)).slice(0, 16);
}

export function statePath(sessionId: string, root: string): string {
  return path.join(stateDir(), `${sanitize(sessionId)}__${rootKey(root)}.json`);
}

export function freshState(sessionId: string, root: string, now = Date.now()): SessionState {
  return {
    version: STATE_VERSION,
    sessionId,
    root: path.resolve(root),
    photo: null,
    green: {},
    lastFailing: null,
    lastDiagnostics: null,
    lastRun: null,
    blocksInTurn: 0,
    promptId: null,
    updatedAt: now,
  };
}

/** The saved state of the session for this root, or a fresh one; a corrupt file is replaced and reported once. */
export function loadState(sessionId: string, root: string, now = Date.now()): SessionState {
  const file = statePath(sessionId, root);
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch {
    return freshState(sessionId, root, now);
  }

  const parsed = parseState(text, sessionId, root);

  if (parsed === null) {
    console.error(`agent-hooks: ${file}: unreadable state, starting fresh`);

    return freshState(sessionId, root, now);
  }

  return parsed;
}

function parseState(text: string, sessionId: string, root: string): SessionState | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  return isRecord(value) ? stateOf(value, sessionId, root) : null;
}

function stateOf(
  value: Readonly<Record<string, unknown>>,
  sessionId: string,
  root: string,
): SessionState | null {
  if (
    value["version"] !== STATE_VERSION ||
    typeof value["blocksInTurn"] !== "number" ||
    typeof value["updatedAt"] !== "number" ||
    !isRecord(value["green"])
  ) {
    return null;
  }

  const photo = value["photo"];
  const promptId = value["promptId"];
  const lastFailing = value["lastFailing"];
  const lastDiagnostics = value["lastDiagnostics"];
  const lastRun = value["lastRun"];

  if (
    !(photo === null || isPhoto(photo)) ||
    !(promptId === null || typeof promptId === "string") ||
    !(lastFailing === null || isStringArrayRecord(lastFailing)) ||
    !(lastDiagnostics === null || isNumberRecord(lastDiagnostics)) ||
    !(lastRun === null || isLastRun(lastRun)) ||
    !isStringRecord(value["green"])
  ) {
    return null;
  }

  return {
    version: STATE_VERSION,
    sessionId,
    root: path.resolve(root),
    photo,
    green: value["green"],
    lastFailing,
    lastDiagnostics,
    lastRun,
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

/**
 * Writes the state through a temporary file and a rename, so a reader never sees a half-written file. Each write
 * has its own temporary name: two hooks of one session save at once, and a shared name lets one rename the other's.
 */
export function saveState(state: SessionState, now = Date.now()): void {
  const file = statePath(state.sessionId, state.root);
  const temporary = `${file}.${process.pid}.${randomUUID()}${TEMPORARY_SUFFIX}`;
  state.updatedAt = now;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, file);
}

/**
 * Removes every state file whose `updatedAt` is older than the TTL, unreadable files counting as old, and every
 * temporary file older than `staleTemporaryMs`, dated by its mtime and never parsed: a save writes and renames its
 * own within one hook, so a younger one may be a save under way, half written.
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

    const stale = file.endsWith(TEMPORARY_SUFFIX)
      ? now - modifiedAt(filePath) > staleTemporaryMs
      : file.endsWith(".json") && now - updatedAtOf(filePath) > STATE_TTL_MS;

    if (stale) {
      try {
        unlinkSync(filePath);
      } catch {
        // A file removed by a concurrent session is not an error.
      }
    }
  }
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

/** Every saved state of this session, one per root, sorted by root, each file read once: a Stop picks its roots there. */
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

      const root = isRecord(value) ? value["root"] : undefined;

      const state =
        isRecord(value) && typeof root === "string" ? stateOf(value, sessionId, root) : null;

      return state === null ? [] : [state];
    })
    .toSorted((left, right) => (left.root < right.root ? -1 : Number(left.root > right.root)));
}

/**
 * The most recent main-session state file of this root: what `doctor` shows as the last Stop and `verify` takes its
 * scope from. A subagent's state, `<session>.<agent>`, holds that subagent's photo only.
 */
export function latestStateForRoot(root: string): SessionState | null {
  const suffix = `__${rootKey(root)}.json`;
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
      const parsed = parseState(readFileSync(path.join(stateDir(), file), "utf8"), sessionId, root);

      return parsed === null ? [] : [parsed];
    } catch {
      return [];
    }
  });

  return states.toSorted((left, right) => right.updatedAt - left.updatedAt).at(0) ?? null;
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}
