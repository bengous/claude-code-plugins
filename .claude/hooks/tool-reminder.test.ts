import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimSession, createdWriteOf, isTool, noteFor } from "./tool-reminder.ts";

const PROJECT = "/repo";

const ENTRY_POINT = "async function main() {}\nif (import.meta.main) await main();\n";

function writeOf(type: string, path: string, content: string): string {
  return JSON.stringify({
    session_id: "s1",
    tool_input: { file_path: path, content },
    tool_response: { type, filePath: path },
  });
}

describe("createdWriteOf", () => {
  test("reads the file a Write created", () => {
    expect(createdWriteOf(writeOf("create", "/repo/a.ts", "x"))).toEqual({
      sessionId: "s1",
      path: "/repo/a.ts",
      content: "x",
    });
  });

  test("leaves an overwrite alone", () => {
    expect(createdWriteOf(writeOf("update", "/repo/a.ts", "x"))).toBeNull();
  });

  test("leaves an input with no tool_response alone", () => {
    const input = JSON.stringify({
      session_id: "s1",
      tool_input: { file_path: "/repo/a.ts", content: "x" },
    });

    expect(createdWriteOf(input)).toBeNull();
  });
});

describe("isTool", () => {
  test.each([
    ["/repo/scripts/sessions/pr-wait.ts", ENTRY_POINT],
    ["/repo/scripts/x.ts", "#!/usr/bin/env bun\nconsole.log(1);\n"],
    ["/repo/scripts/x.ts", "const pr = process.argv[2];\n"],
    ["/repo/scripts/x.ts", "const pr = Bun.argv[2];\n"],
    ["/repo/scripts/ci/wait-checks.sh", 'gh pr checks "$1"\n'],
  ])("a script that runs: %s", (path, content) => {
    expect(isTool({ path, content }, PROJECT)).toBe(true);
  });

  test.each([
    ["/repo/scripts/lib/duration.ts", "export const seconds = (ms: number) => ms / 1000;\n"],
    ["/repo/scripts/sessions/pr-wait.test.ts", ENTRY_POINT],
    ["/repo/vellum/e2e/foo.spec.ts", ENTRY_POINT],
    ["/repo/scripts/x.fixture.ts", ENTRY_POINT],
    ["/repo/oxlint.config.ts", ENTRY_POINT],
    ["/repo/types/x.d.ts", ENTRY_POINT],
    ["/repo/README.md", ENTRY_POINT],
    ["/tmp/scratch/watch-pr.sh", 'gh pr checks "$1"\n'],
    ["/repository/x.sh", 'gh pr checks "$1"\n'],
    ["/repo/../tmp/scratch/watch-pr.sh", 'gh pr checks "$1"\n'],
  ])("no tool: %s", (path, content) => {
    expect(isTool({ path, content }, PROJECT)).toBe(false);
  });
});

describe("noteFor", () => {
  test("a session's first tool gets the note as PostToolUse context, its other files none", () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-reminder-"));

    try {
      const state = join(dir, "state");
      const tool = "/repo/scripts/sessions/pr-wait.ts";

      expect(noteFor(writeOf("create", "/repo/README.md", ENTRY_POINT), PROJECT, state)).toBeNull();

      const note = noteFor(writeOf("create", tool, ENTRY_POINT), PROJECT, state);

      expect(note === null ? null : JSON.parse(note)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: expect.stringContaining(
            "You just created scripts/sessions/pr-wait.ts, a script that runs.",
          ),
        },
      });

      expect(
        noteFor(writeOf("create", "/repo/scripts/ci/x.sh", "gh\n"), PROJECT, state),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claimSession", () => {
  test("claims a session once", () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-reminder-"));

    try {
      const state = join(dir, "state");

      expect(claimSession(state, "s1")).toBe(true);
      expect(claimSession(state, "s1")).toBe(false);
      expect(claimSession(state, "s2")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
