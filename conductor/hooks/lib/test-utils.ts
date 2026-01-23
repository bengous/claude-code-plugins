/**
 * Test Utilities for Conductor Plugin
 *
 * Shared utilities for filesystem-based testing using real temp directories.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TPlanState } from "./types";

/**
 * Create a unique temporary directory for test isolation.
 */
export async function createTempDir(prefix = "conductor-test"): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clean up a temporary directory and all contents.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Set up a .t-plan session directory with optional state.
 * Returns the full path to the session directory.
 */
export async function setupSessionDir(
  tempDir: string,
  sessionId: string,
  state?: TPlanState
): Promise<string> {
  const sessionDir = join(tempDir, ".t-plan", sessionId);
  mkdirSync(sessionDir, { recursive: true });

  if (state) {
    const statePath = join(sessionDir, "state.json");
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  }

  return sessionDir;
}

/**
 * Create a default TPlanState for testing.
 */
export function createTestState(overrides: Partial<TPlanState> = {}): TPlanState {
  return {
    schema_version: 1,
    session_id: "test-session-123",
    phase: "EXPLORE",
    draft_version: 0,
    validation_version: 0,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}
