/**
 * T-Plan State Management
 *
 * Utilities for reading and writing t-plan session state.
 * Self-contained within conductor for marketplace portability.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import type { TPlanState } from "./types";

/**
 * Find the session directory by walking upward from start path.
 * Returns null if no .t-plan/{sessionId}/state.json found.
 */
export function findSessionDir(
  startPath: string,
  sessionId: string
): string | null {
  let current = startPath;

  while (true) {
    const sessionDir = join(current, ".t-plan", sessionId);
    const stateFile = join(sessionDir, "state.json");

    if (existsSync(stateFile)) {
      return sessionDir;
    }

    const parent = join(current, "..");
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}

/**
 * Read state.json from a session directory.
 * Returns null if file doesn't exist or is invalid.
 */
export function readState(sessionDir: string): TPlanState | null {
  const path = join(sessionDir, "state.json");
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, "utf8");
    return JSON.parse(content) as TPlanState;
  } catch {
    return null;
  }
}

/**
 * Write state.json to a session directory.
 * Creates the directory if it doesn't exist.
 * Uses atomic write pattern (temp file + rename).
 */
export function writeState(sessionDir: string, state: TPlanState): void {
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, "state.json");
  const tmpPath = `${path}.tmp`;
  const content = JSON.stringify(state, null, 2) + "\n";
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

/**
 * Ensure .t-plan/.gitignore exists to exclude session artifacts.
 */
export function ensureGitignore(tplanDir: string): void {
  const gitignorePath = join(tplanDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    mkdirSync(tplanDir, { recursive: true });
    writeFileSync(gitignorePath, "*\n!.gitignore\n");
  }
}

/**
 * Get the session directory path (without checking existence).
 */
export function getSessionDir(cwd: string, sessionId: string): string {
  return join(cwd, ".t-plan", sessionId);
}
