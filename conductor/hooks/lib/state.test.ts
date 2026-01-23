/**
 * Tests for state.ts filesystem functions using real temp directories
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  getSessionDir,
  findSessionDir,
  readState,
  writeState,
  ensureGitignore,
} from "./state";
import { createTempDir, cleanupTempDir, createTestState } from "./test-utils";

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir("state-test");
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("getSessionDir", () => {
  test("constructs correct path", () => {
    const result = getSessionDir("/project", "session-123");
    expect(result).toBe("/project/.t-plan/session-123");
  });

  test("handles trailing slash in cwd", () => {
    const result = getSessionDir("/project/", "session-456");
    expect(result).toBe("/project/.t-plan/session-456");
  });

  test("handles complex session IDs", () => {
    const result = getSessionDir("/home/user", "abc-def-123-456");
    expect(result).toBe("/home/user/.t-plan/abc-def-123-456");
  });
});

describe("findSessionDir", () => {
  test("finds session dir in current directory", async () => {
    const sessionId = "test-session";
    const sessionDir = join(tempDir, ".t-plan", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), "{}");

    const result = findSessionDir(tempDir, sessionId);
    expect(result).toBe(sessionDir);
  });

  test("finds session dir when walking upward", async () => {
    const sessionId = "parent-session";
    const sessionDir = join(tempDir, ".t-plan", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), "{}");

    // Create nested directory to search from
    const nestedDir = join(tempDir, "nested", "deeply", "here");
    mkdirSync(nestedDir, { recursive: true });

    const result = findSessionDir(nestedDir, sessionId);
    expect(result).toBe(sessionDir);
  });

  test("returns null when session not found", () => {
    const result = findSessionDir(tempDir, "nonexistent-session");
    expect(result).toBeNull();
  });

  test("returns null when .t-plan exists but session dir missing", async () => {
    mkdirSync(join(tempDir, ".t-plan"), { recursive: true });

    const result = findSessionDir(tempDir, "missing-session");
    expect(result).toBeNull();
  });

  test("returns null when session dir exists but state.json missing", async () => {
    const sessionId = "no-state";
    const sessionDir = join(tempDir, ".t-plan", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    // No state.json created

    const result = findSessionDir(tempDir, sessionId);
    expect(result).toBeNull();
  });

  test("finds closest session dir when multiple exist", async () => {
    const sessionId = "duplicate-session";

    // Create session in parent
    const parentSession = join(tempDir, ".t-plan", sessionId);
    mkdirSync(parentSession, { recursive: true });
    writeFileSync(join(parentSession, "state.json"), '{"level": "parent"}');

    // Create session in child
    const childDir = join(tempDir, "child");
    const childSession = join(childDir, ".t-plan", sessionId);
    mkdirSync(childSession, { recursive: true });
    writeFileSync(join(childSession, "state.json"), '{"level": "child"}');

    // Search from child should find child's session
    const result = findSessionDir(childDir, sessionId);
    expect(result).toBe(childSession);
  });
});

describe("readState", () => {
  test("reads valid state.json", async () => {
    const sessionDir = join(tempDir, "session");
    mkdirSync(sessionDir, { recursive: true });

    const expectedState = createTestState();
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify(expectedState, null, 2)
    );

    const result = readState(sessionDir);
    expect(result).toEqual(expectedState);
  });

  test("returns null for missing file", () => {
    const sessionDir = join(tempDir, "empty-session");
    mkdirSync(sessionDir, { recursive: true });

    const result = readState(sessionDir);
    expect(result).toBeNull();
  });

  test("returns null for invalid JSON", async () => {
    const sessionDir = join(tempDir, "bad-json");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), "{ invalid json }");

    const result = readState(sessionDir);
    expect(result).toBeNull();
  });

  test("returns null for empty file", async () => {
    const sessionDir = join(tempDir, "empty-file");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "state.json"), "");

    const result = readState(sessionDir);
    expect(result).toBeNull();
  });

  test("returns null for non-existent directory", () => {
    const result = readState(join(tempDir, "does-not-exist"));
    expect(result).toBeNull();
  });
});

describe("writeState", () => {
  test("creates directory and writes state", async () => {
    const sessionDir = join(tempDir, ".t-plan", "new-session");
    const state = createTestState({ phase: "SCOUT" });

    writeState(sessionDir, state);

    expect(existsSync(sessionDir)).toBe(true);
    const content = readFileSync(join(sessionDir, "state.json"), "utf8");
    expect(JSON.parse(content)).toEqual(state);
  });

  test("overwrites existing state atomically", async () => {
    const sessionDir = join(tempDir, "existing-session");
    mkdirSync(sessionDir, { recursive: true });

    const originalState = createTestState({ phase: "EXPLORE" });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify(originalState, null, 2)
    );

    const newState = createTestState({ phase: "VALIDATE", draft_version: 1 });
    writeState(sessionDir, newState);

    const content = readFileSync(join(sessionDir, "state.json"), "utf8");
    expect(JSON.parse(content)).toEqual(newState);
  });

  test("does not leave .tmp file after write", async () => {
    const sessionDir = join(tempDir, "no-tmp");
    const state = createTestState();

    writeState(sessionDir, state);

    expect(existsSync(join(sessionDir, "state.json.tmp"))).toBe(false);
  });

  test("formats JSON with 2-space indent and trailing newline", async () => {
    const sessionDir = join(tempDir, "formatted");
    const state = createTestState();

    writeState(sessionDir, state);

    const content = readFileSync(join(sessionDir, "state.json"), "utf8");
    expect(content).toMatch(/^\{[\s\S]*\}\n$/); // Ends with newline
    expect(content).toContain('  "'); // 2-space indent
  });

  test("handles deeply nested paths", async () => {
    const sessionDir = join(tempDir, "a", "b", "c", ".t-plan", "deep-session");
    const state = createTestState();

    writeState(sessionDir, state);

    expect(existsSync(join(sessionDir, "state.json"))).toBe(true);
  });
});

describe("ensureGitignore", () => {
  test("creates .gitignore in new directory", async () => {
    const tplanDir = join(tempDir, ".t-plan");

    ensureGitignore(tplanDir);

    const gitignorePath = join(tplanDir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);

    const content = readFileSync(gitignorePath, "utf8");
    expect(content).toContain("*");
    expect(content).toContain("!.gitignore");
  });

  test("preserves existing .gitignore", async () => {
    const tplanDir = join(tempDir, ".t-plan");
    mkdirSync(tplanDir, { recursive: true });

    const customContent = "# Custom gitignore\n*.log\n";
    writeFileSync(join(tplanDir, ".gitignore"), customContent);

    ensureGitignore(tplanDir);

    const content = readFileSync(join(tplanDir, ".gitignore"), "utf8");
    expect(content).toBe(customContent);
  });

  test("creates directory if needed", async () => {
    const tplanDir = join(tempDir, "new-tplan-dir");

    ensureGitignore(tplanDir);

    expect(existsSync(tplanDir)).toBe(true);
    expect(existsSync(join(tplanDir, ".gitignore"))).toBe(true);
  });

  test("is idempotent", async () => {
    const tplanDir = join(tempDir, ".t-plan");

    ensureGitignore(tplanDir);
    const firstContent = readFileSync(join(tplanDir, ".gitignore"), "utf8");

    ensureGitignore(tplanDir);
    const secondContent = readFileSync(join(tplanDir, ".gitignore"), "utf8");

    expect(secondContent).toBe(firstContent);
  });
});
