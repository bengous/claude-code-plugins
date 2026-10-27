/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "./config.ts";
import { deadlineIn, run } from "./exec.ts";
import type { HookContext } from "./hook.ts";
import { recordField, stringField } from "./json.ts";
import { extractApplyPatchPaths } from "./patch.ts";
import { parseInput } from "./payload.ts";
import { runPostEdit } from "./pre-edit.ts";
import { freshState } from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  fixtureIn,
  readFixture,
  readRepoFile,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";
import { ALLOW } from "./verdict.ts";

const temps: TempRepo[] = [];

beforeEach(() => {
  scrubGitEnv();
});

afterEach(() => {
  for (const temp of temps.splice(0)) {
    removeTempRepo(temp);
  }
});

const QUOTES_CONFIG = `{
  "pre-edit": {
    "exclude": ["generated/**"],
    "fixers": {
      "quotes": { "on": "**/*.{ts,md}", "file": "quotes {file}" },
    },
  },
}`;

function repoWith(config: string, files: Readonly<Record<string, string>> = {}): TempRepo {
  const temp = createTempRepo("agent-hooks-post-edit-", files);
  temps.push(temp);
  writeConfig(temp.repo, config);
  fakeTool(temp.repo, "quotes", `sed -i "s/'/\\"/g" "$1"`);

  return temp;
}

function contextOf(repo: string, payload: Record<string, unknown>): HookContext {
  const input = parseInput(payload);

  if (input === null) {
    throw new Error("payload has no session_id");
  }

  return {
    hook: "post-edit",
    harness: "codex",
    input,
    root: repo,
    config: loadConfig(repo),
    state: freshState("s1", repo),
    deadline: deadlineIn(20_000),
    runner: run,
  };
}

function patchContext(repo: string, patch: string): HookContext {
  return contextOf(repo, {
    session_id: "s1",
    cwd: repo,
    tool_name: "apply_patch",
    tool_input: { command: patch },
  });
}

function patchOf(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

describe("extractApplyPatchPaths", () => {
  test("reads the add, update, delete and move lines, once each", () => {
    const patch = patchOf(
      "*** Add File: /r/new.ts",
      "+let a = 1;",
      "*** Update File: /r/old.ts",
      "*** Move to: /r/moved.ts",
      "@@",
      "-let b = 1;",
      "+let b = 2;",
      "*** Delete File: /r/gone.ts",
      "*** Update File: /r/new.ts",
      "+*** Add File: /r/not-a-header.ts",
    );

    expect(extractApplyPatchPaths(patch)).toEqual([
      "/r/new.ts",
      "/r/old.ts",
      "/r/moved.ts",
      "/r/gone.ts",
    ]);
  });

  test("reads CRLF patches and ignores the other lines", () => {
    expect(
      extractApplyPatchPaths("*** Begin Patch\r\n*** Add File: a.ts\r\n+x\r\n*** End Patch\r\n"),
    ).toEqual(["a.ts"]);
    expect(extractApplyPatchPaths("no patch here")).toEqual([]);
  });

  test("the real patch yields its one absolute path", () => {
    const toolInput =
      recordField(readFixture("codex", "post-edit-apply-patch"), "tool_input") ?? {};

    expect(extractApplyPatchPaths(stringField(toolInput, "command") ?? "")).toEqual([
      "/fixture/user/Work/repo/capture/codex-sample.md",
    ]);
  });
});

describe("runPostEdit", () => {
  test("fixes the patched files in place", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, {
      "src/a.ts": "let a = 'x';\n",
      "src/b.ts": "let b = 'y';\n",
    });

    const verdict = await runPostEdit(
      patchContext(
        repo,
        patchOf(
          `*** Add File: ${path.join(repo, "src/a.ts")}`,
          `*** Update File: ${path.join(repo, "src/b.ts")}`,
        ),
      ),
    );

    expect(verdict).toEqual(ALLOW);
    expect(readRepoFile(repo, "src/a.ts")).toBe('let a = "x";\n');
    expect(readRepoFile(repo, "src/b.ts")).toBe('let b = "y";\n');
  });

  test("fixes the file of the real Codex payload", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, {
      "capture/codex-sample.md": "# Codex sample\nhello 'x'\n",
    });

    const verdict = await runPostEdit(
      contextOf(repo, fixtureIn("codex", "post-edit-apply-patch", repo)),
    );

    expect(verdict).toEqual(ALLOW);
    expect(readRepoFile(repo, "capture/codex-sample.md")).toBe('# Codex sample\nhello "x"\n');
  });

  test("skips a deleted path, a path outside the root and an excluded path", async () => {
    const temp = repoWith(QUOTES_CONFIG, { "generated/a.ts": "let a = 'x';\n" });
    const marker = path.join(temp.dir, "spawned");
    fakeTool(temp.repo, "quotes", `touch "${marker}"`);
    writeRepoFile(temp.dir, "outside.ts", "let o = 'x';\n");

    const verdict = await runPostEdit(
      patchContext(
        temp.repo,
        patchOf(
          `*** Delete File: ${path.join(temp.repo, "gone.ts")}`,
          `*** Update File: ${path.join(temp.dir, "outside.ts")}`,
          `*** Update File: ${path.join(temp.repo, "generated/a.ts")}`,
        ),
      ),
    );

    expect(verdict).toEqual(ALLOW);
    expect(existsSync(marker)).toBeFalse();
  });

  test("a move fixes the destination and skips the source gone from disk", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "moved.ts": "let a = 'x';\n" });

    const verdict = await runPostEdit(
      patchContext(
        repo,
        patchOf(
          `*** Update File: ${path.join(repo, "old.ts")}`,
          `*** Move to: ${path.join(repo, "moved.ts")}`,
        ),
      ),
    );

    expect(verdict).toEqual(ALLOW);
    expect(readRepoFile(repo, "moved.ts")).toBe('let a = "x";\n');
  });

  test("a failing non-looping fixer yields its output as context", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "fmt": { "on": "**/*.ts", "file": "fmt {file}" } } } }`,
      {
        "a.ts": "let (\n",
      },
    );

    fakeTool(repo, "fmt", 'echo "a.ts:1:5: unexpected token" >&2; exit 1');

    const verdict = await runPostEdit(
      patchContext(repo, patchOf(`*** Update File: ${path.join(repo, "a.ts")}`)),
    );

    expect(verdict).toEqual({ kind: "context", text: "fmt\na.ts:1:5: unexpected token" });
  });

  test("a Claude-style file_path is fixed too", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "a.ts": "let a = 'x';\n" });

    const verdict = await runPostEdit(
      contextOf(repo, {
        session_id: "s1",
        cwd: repo,
        tool_name: "Write",
        tool_input: { file_path: "a.ts" },
      }),
    );

    expect(verdict).toEqual(ALLOW);
    expect(readRepoFile(repo, "a.ts")).toBe('let a = "x";\n');
  });

  test("a payload with neither a patch nor a file_path is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);

    expect(
      await runPostEdit(contextOf(repo, { session_id: "s1", cwd: repo, tool_name: "Bash" })),
    ).toEqual(ALLOW);
  });
});
