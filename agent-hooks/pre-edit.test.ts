/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "./config.ts";
import { deadlineIn, run } from "./exec.ts";
import type { HookContext } from "./hook.ts";
import { ALLOW, parseInput } from "./hook.ts";
import { recordField } from "./json.ts";
import { runPreEdit } from "./pre-edit.ts";
import { freshState } from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  fixtureIn,
  readFixture,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

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
    "fixers": {
      "quotes": { "on": "**/*.ts", "file": "quotes {file}" },
    },
  },
}`;

function repoWith(config: string, files: Readonly<Record<string, string>> = {}): TempRepo {
  const temp = createTempRepo("agent-hooks-pre-edit-", files);
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
    hook: "pre-edit",
    harness: "claude",
    input,
    root: repo,
    config: loadConfig(repo),
    state: freshState("s1", repo),
    roots: new Map([[repo, null]]),
    deadline: deadlineIn(20_000),
    runner: run,
  };
}

function toolContext(
  repo: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): HookContext {
  return contextOf(repo, {
    session_id: "s1",
    cwd: repo,
    tool_name: toolName,
    tool_input: toolInput,
  });
}

// Suites running in parallel create their own temp dirs under the shared tmpdir: the run under test gets a private one.
async function inPrivateTmpdir<T>(
  body: () => Promise<T>,
): Promise<{ result: T; leftover: string[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-private-tmp-"));
  const previous = process.env["TMPDIR"];
  process.env["TMPDIR"] = dir;

  try {
    const result = await body();

    return { result, leftover: readdirSync(dir) };
  } finally {
    if (previous === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = previous;
    }

    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Write", () => {
  test("a fixed content rewrites the tool input and leaves no scratch dir", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);
    const toolInput = { file_path: path.join(repo, "src/a.ts"), content: "const a = 'x';\n" };

    const { result: verdict, leftover } = await inPrivateTmpdir(() =>
      runPreEdit(toolContext(repo, "Write", toolInput)),
    );

    expect(verdict).toEqual({
      kind: "rewrite",
      updatedInput: { ...toolInput, content: 'const a = "x";\n' },
      text: "agent-hooks: fixed and formatted src/a.ts before writing",
    });
    expect(leftover).toEqual([]);
    expect(existsSync(path.join(repo, "src/a.ts"))).toBeFalse();
    expect(readdirSync(repo, { recursive: true, encoding: "utf8" })).not.toContainEqual(
      expect.stringContaining(".agent-hooks-"),
    );
  });

  test("keeps the tool input fields of the real payload", async () => {
    const fixture = readFixture("claude", "pre-edit-write");
    const fixtureInput = recordField(fixture, "tool_input") ?? {};
    const { repo } = repoWith(QUOTES_CONFIG);
    const toolInput = { file_path: path.join(repo, "a.ts"), content: "let a = 'x';\n" };

    expect(fixture["tool_name"]).toBe("Write");
    expect(Object.keys(toolInput).toSorted()).toEqual(Object.keys(fixtureInput).toSorted());

    const verdict = await runPreEdit(
      contextOf(repo, { ...fixture, session_id: "s1", cwd: repo, tool_input: toolInput }),
    );

    expect(verdict).toMatchObject({ kind: "rewrite", updatedInput: { content: 'let a = "x";\n' } });
  });

  test("the real payload, which writes to a scratchpad outside the root, is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);

    expect(await runPreEdit(contextOf(repo, fixtureIn("claude", "pre-edit-write", repo)))).toEqual(
      ALLOW,
    );
  });

  test("an already clean content is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);

    const verdict = await runPreEdit(
      toolContext(repo, "Write", {
        file_path: path.join(repo, "a.ts"),
        content: 'const a = "x";\n',
      }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("an empty content is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);

    expect(
      await runPreEdit(
        toolContext(repo, "Write", { file_path: path.join(repo, "a.ts"), content: "" }),
      ),
    ).toEqual(ALLOW);
  });

  test("a write into a directory that does not exist yet is rewritten", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);

    const verdict = await runPreEdit(
      toolContext(repo, "Write", {
        file_path: path.join(repo, "new/deep/dir/a.ts"),
        content: "let a = 'x';\n",
      }),
    );

    expect(verdict).toMatchObject({ kind: "rewrite", updatedInput: { content: 'let a = "x";\n' } });
  });

  test("CRLF line endings survive a fixer that touches nothing else", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);

    const verdict = await runPreEdit(
      toolContext(repo, "Write", {
        file_path: path.join(repo, "a.ts"),
        content: "let a = 'x';\r\nlet b = 1;\r\n",
      }),
    );

    expect(verdict).toMatchObject({
      kind: "rewrite",
      updatedInput: { content: 'let a = "x";\r\nlet b = 1;\r\n' },
    });
  });
});

describe("Edit", () => {
  test("a unique old_string rewrites the edit into a whole-file replacement", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "a.ts": "let a = 1;\nlet b = 2;\n" });
    const filePath = path.join(repo, "a.ts");

    const verdict = await runPreEdit(
      toolContext(repo, "Edit", {
        file_path: filePath,
        old_string: "1",
        new_string: "'x'",
        replace_all: false,
      }),
    );

    expect(verdict).toEqual({
      kind: "rewrite",
      updatedInput: {
        file_path: filePath,
        old_string: "let a = 1;\nlet b = 2;\n",
        new_string: 'let a = "x";\nlet b = 2;\n',
        replace_all: false,
      },
      text: "agent-hooks: fixed and formatted a.ts before writing",
    });
  });

  test("the real Edit payload is rewritten", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "title": { "on": "**/*.md", "file": "title {file}" } } } }`,
      { "capture/sample.md": "# Sample\n\nhello\n" },
    );

    fakeTool(repo, "title", `sed -i "s/world/World/" "$1"`);

    const verdict = await runPreEdit(contextOf(repo, fixtureIn("claude", "pre-edit-edit", repo)));

    expect(verdict).toEqual({
      kind: "rewrite",
      updatedInput: {
        file_path: path.join(repo, "capture/sample.md"),
        old_string: "# Sample\n\nhello\n",
        new_string: "# Sample\n\nhello World\n",
        replace_all: false,
      },
      text: "agent-hooks: fixed and formatted capture/sample.md before writing",
    });
  });

  test("an old_string absent from the file is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "a.ts": "let a = 1;\n" });

    const verdict = await runPreEdit(
      toolContext(repo, "Edit", {
        file_path: path.join(repo, "a.ts"),
        old_string: "9",
        new_string: "'x'",
      }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("an old_string present twice without replace_all is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "a.ts": "let a = 1;\nlet b = 1;\n" });

    const verdict = await runPreEdit(
      toolContext(repo, "Edit", {
        file_path: path.join(repo, "a.ts"),
        old_string: "1",
        new_string: "'x'",
      }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("an old_string present twice with replace_all replaces both", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "a.ts": "let a = 1;\nlet b = 1;\n" });

    const verdict = await runPreEdit(
      toolContext(repo, "Edit", {
        file_path: path.join(repo, "a.ts"),
        old_string: "1",
        new_string: "'x'",
        replace_all: true,
      }),
    );

    expect(verdict).toMatchObject({
      kind: "rewrite",
      updatedInput: {
        old_string: "let a = 1;\nlet b = 1;\n",
        new_string: 'let a = "x";\nlet b = "x";\n',
        replace_all: false,
      },
    });
  });

  test("an empty old_string is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "a.ts": "let a = 1;\n" });

    const verdict = await runPreEdit(
      toolContext(repo, "Edit", {
        file_path: path.join(repo, "a.ts"),
        old_string: "",
        new_string: "'x'",
      }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("a fix that undoes the edit is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "a.ts": 'let a = "x";\n' });

    const verdict = await runPreEdit(
      toolContext(repo, "Edit", {
        file_path: path.join(repo, "a.ts"),
        old_string: '"x"',
        new_string: "'x'",
      }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("an edit of a file that does not exist is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);

    const verdict = await runPreEdit(
      toolContext(repo, "Edit", {
        file_path: path.join(repo, "a.ts"),
        old_string: "1",
        new_string: "'x'",
      }),
    );

    expect(verdict).toEqual(ALLOW);
  });
});

describe("fixers", () => {
  test("the looping fixers run first, then the others, in the configured order", async () => {
    const { repo } = repoWith(`{
      "pre-edit": {
        "fixers": {
          "once1": { "on": "**/*.ts", "file": "rec {root}/order.log once1" },
          "loop1": { "on": "**/*.ts", "file": "rec {root}/order.log loop1", "loop": true },
          "once2": { "on": "**/*.ts", "file": "rec {root}/order.log once2" },
          "loop2": { "on": "**/*.ts", "file": "rec {root}/order.log loop2", "loop": true },
        },
      },
    }`);

    fakeTool(repo, "rec", 'echo "$2" >> "$1"');

    await runPreEdit(
      toolContext(repo, "Write", { file_path: path.join(repo, "a.ts"), content: "x\n" }),
    );

    expect(readFileSync(path.join(repo, "order.log"), "utf8")).toBe("loop1\nloop2\nonce1\nonce2\n");
  });

  test("a looping stdin fixer that exits 1 leaves the content unchanged", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "squeeze": { "on": "**/*.ts", "stdin": "squeeze", "loop": true } } } }`,
    );

    fakeTool(repo, "squeeze", "sed 's/  */ /g'; exit 1");

    const verdict = await runPreEdit(
      toolContext(repo, "Write", { file_path: path.join(repo, "a.ts"), content: "a  b\n" }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("a non-looping stdin fixer that exits 1 reports its failure without a rewrite", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "squeeze": { "on": "**/*.ts", "stdin": "squeeze" } } } }`,
    );

    fakeTool(repo, "squeeze", "sed 's/  */ /g'; echo 'syntax error' >&2; exit 1");

    const verdict = await runPreEdit(
      toolContext(repo, "Write", { file_path: path.join(repo, "a.ts"), content: "a  b\n" }),
    );

    expect(verdict.kind).toBe("context");
    expect(verdict).not.toHaveProperty("updatedInput");
  });

  test("a stdin fixer with an empty stdout is allowed", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "silent": { "on": "**/*.ts", "stdin": "silent" } } } }`,
    );

    fakeTool(repo, "silent", "cat > /dev/null");

    const verdict = await runPreEdit(
      toolContext(repo, "Write", { file_path: path.join(repo, "a.ts"), content: "a  b\n" }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("a stdin fixer with output rewrites the content", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "squeeze": { "on": "**/*.ts", "stdin": "squeeze" } } } }`,
    );

    fakeTool(repo, "squeeze", "sed 's/  */ /g'");

    const verdict = await runPreEdit(
      toolContext(repo, "Write", { file_path: path.join(repo, "a.ts"), content: "a  b\n" }),
    );

    expect(verdict).toMatchObject({ kind: "rewrite", updatedInput: { content: "a b\n" } });
  });

  test("a non-looping fixer that exits 1 yields its stderr tail as context", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "fmt": { "on": "**/*.ts", "file": "fmt {file}" } } } }`,
    );

    fakeTool(repo, "fmt", 'echo "a.ts:1:5: unexpected token" >&2; exit 1');

    const verdict = await runPreEdit(
      toolContext(repo, "Write", { file_path: path.join(repo, "a.ts"), content: "let (\n" }),
    );

    expect(verdict).toEqual({ kind: "context", text: "fmt\na.ts:1:5: unexpected token" });
  });

  test("a looping fixer whose binary is missing is allowed with a stderr line", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "lint": { "on": "**/*.ts", "file": "agent-hooks-no-such-tool {file}", "loop": true } } } }`,
    );

    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const verdict = await runPreEdit(
        toolContext(repo, "Write", {
          file_path: path.join(repo, "a.ts"),
          content: "let a = 'x';\n",
        }),
      );

      expect(verdict).toEqual(ALLOW);
      expect(stderr).toHaveBeenCalledWith(
        "agent-hooks: lint: command not found: agent-hooks-no-such-tool",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("a non-looping fixer whose binary is missing is allowed with a stderr line, never a context", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "fmt": { "on": "**/*.ts", "file": "agent-hooks-no-such-tool {file}" } } } }`,
    );

    const stderr = spyOn(console, "error").mockImplementation(() => {});

    try {
      const verdict = await runPreEdit(
        toolContext(repo, "Write", {
          file_path: path.join(repo, "a.ts"),
          content: "let a = 'x';\n",
        }),
      );

      expect(verdict).toEqual(ALLOW);
      expect(stderr).toHaveBeenCalledWith(
        "agent-hooks: fmt: command not found: agent-hooks-no-such-tool",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  describe("a fixer that finds its config from the file's path", () => {
    // Walks up from the file it is given, as oxlint finds a nested config and matches an override by path.
    const NEAREST_CONFIG_FIXER = [
      'dir=$(dirname "$1")',
      'while [ "$dir" != "/" ]; do',
      '  if [ -f "$dir/.fixrc" ]; then sed -i "s/BAD/GOOD/" "$1"; exit 0; fi',
      '  dir=$(dirname "$dir")',
      "done",
    ].join("\n");

    function nestedConfigRepo(): TempRepo {
      const temp = repoWith(
        `{ "pre-edit": { "fixers": { "nearest": { "on": "**/*.ts", "file": "nearest {file}" } } } }`,
        { "src/.fixrc": "on\n" },
      );

      fakeTool(temp.repo, "nearest", NEAREST_CONFIG_FIXER);

      return temp;
    }

    test("sees the config of the file's own directory", async () => {
      const { repo } = nestedConfigRepo();

      const verdict = await runPreEdit(
        toolContext(repo, "Write", { file_path: path.join(repo, "src/a.ts"), content: "BAD\n" }),
      );

      expect(verdict).toMatchObject({ kind: "rewrite", updatedInput: { content: "GOOD\n" } });
      expect(readdirSync(path.join(repo, "src")).toSorted()).toEqual([".fixrc"]);
    });

    test("sees it for a file in a directory that does not exist yet", async () => {
      const { repo } = nestedConfigRepo();

      const verdict = await runPreEdit(
        toolContext(repo, "Write", {
          file_path: path.join(repo, "src/new/deep/a.ts"),
          content: "BAD\n",
        }),
      );

      expect(verdict).toMatchObject({ kind: "rewrite", updatedInput: { content: "GOOD\n" } });
      expect(existsSync(path.join(repo, "src/new"))).toBeFalse();
    });
  });

  test("fixers run with the root as cwd", async () => {
    const { repo } = repoWith(
      `{ "pre-edit": { "fixers": { "where": { "on": "**/*.ts", "file": "where {root}/cwd.txt" } } } }`,
      {
        "pkg/package.json": "{}",
      },
    );

    fakeTool(repo, "where", 'pwd > "$1"');

    await runPreEdit(
      toolContext(repo, "Write", { file_path: path.join(repo, "pkg/a.ts"), content: "x\n" }),
    );

    expect(readFileSync(path.join(repo, "cwd.txt"), "utf8").trim()).toBe(realpathSync(repo));
  });
});

describe("skips", () => {
  test("a path in pre-edit.exclude is allowed and spawns no tool", async () => {
    const temp = repoWith(`{
      "pre-edit": {
        "exclude": ["generated/**"],
        "fixers": { "mark": { "on": "**/*.ts", "file": "mark" } },
      },
    }`);

    const marker = path.join(temp.dir, "spawned");
    fakeTool(temp.repo, "mark", `touch "${marker}"`);

    const verdict = await runPreEdit(
      toolContext(temp.repo, "Write", {
        file_path: path.join(temp.repo, "generated/a.ts"),
        content: "let a = 'x';\n",
      }),
    );

    expect(verdict).toEqual(ALLOW);
    expect(existsSync(marker)).toBeFalse();
  });

  test.each([
    ["a sibling of the root", (temp: TempRepo): string => path.join(temp.dir, "elsewhere.ts")],
    ["the home plans dir", (): string => path.join(homedir(), ".claude/plans/x.md")],
  ])("a file outside the root (%s) is allowed", async (_label, target) => {
    const temp = repoWith(QUOTES_CONFIG);

    const verdict = await runPreEdit(
      toolContext(temp.repo, "Write", { file_path: target(temp), content: "let a = 'x';\n" }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("a tool other than Edit and Write is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG, { "a.ts": "let a = 1;\n" });
    writeRepoFile(repo, "b.ts", "let b = 'x';\n");

    const verdict = await runPreEdit(
      toolContext(repo, "MultiEdit", {
        file_path: path.join(repo, "b.ts"),
        content: "let b = 'y';\n",
      }),
    );

    expect(verdict).toEqual(ALLOW);
  });

  test("a payload without file_path is allowed", async () => {
    const { repo } = repoWith(QUOTES_CONFIG);

    expect(await runPreEdit(toolContext(repo, "Write", { content: "let a = 'x';\n" }))).toEqual(
      ALLOW,
    );
  });
});
