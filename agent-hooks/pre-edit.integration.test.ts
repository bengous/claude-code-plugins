import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";

import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  fixtureIn,
  git,
  hookOutput,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

let temp: TempRepo;

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo({ "src/old.ts": "const a = 'old';\n" });
  fakeTool(temp.repo, "quotes", `sed -i "s/'/\\"/g" "$1"`);
  fakeTool(temp.repo, "broken", 'echo "broken: cannot parse" >&2; exit 2');
  fakeTool(temp.repo, "upper", "tr a-z A-Z");
});

afterEach(() => {
  removeTempRepo(temp);
});

function fixers(table: string): void {
  writeConfig(temp.repo, `{ "fixers": { ${table} } }`);
}

function write(file: string, content: string) {
  return fixtureIn("pre-edit-write", temp.repo, {
    tool_input: { file_path: path.join(temp.repo, file), content },
  });
}

function edit(file: string, oldString: string, newString: string) {
  return fixtureIn("pre-edit-edit", temp.repo, {
    tool_input: {
      file_path: path.join(temp.repo, file),
      old_string: oldString,
      new_string: newString,
      replace_all: false,
    },
  });
}

const QUOTES = '"quotes": { "on": "**/*.ts", "file": "quotes {file}" }';

describe("pre-edit", () => {
  test("in a checkout without the config it prints nothing and writes no state", async () => {
    expect(await hookOutput("pre-edit", write("src/a.ts", "const a = 'x';\n"))).toBeNull();
    expect(existsSync(temp.stateDir)).toBeFalse();
  });

  test("a config below the top of the checkout, or in a directory outside git, is no config", async () => {
    writeRepoFile(temp.repo, "pkg/.claude/agent-hooks.jsonc", `{ "fixers": { ${QUOTES} } }`);
    writeRepoFile(temp.dir, "loose/.claude/agent-hooks.jsonc", `{ "fixers": { ${QUOTES} } }`);
    fakeTool(path.join(temp.dir, "loose"), "quotes", `sed -i "s/'/\\"/g" "$1"`);

    expect(await hookOutput("pre-edit", write("pkg/a.ts", "const a = 'x';\n"))).toBeNull();
    expect(
      await hookOutput(
        "pre-edit",
        fixtureIn("pre-edit-write", temp.repo, {
          tool_input: { file_path: path.join(temp.dir, "loose/a.ts"), content: "const a = 'x';\n" },
        }),
      ),
    ).toBeNull();
    expect(existsSync(temp.stateDir)).toBeFalse();
  });

  test("a Write gets the fixed content through updatedInput, its scratch directory removed", async () => {
    fixers(QUOTES);

    expect(await hookOutput("pre-edit", write("src/a.ts", "const a = 'x';\n"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { file_path: path.join(temp.repo, "src/a.ts"), content: 'const a = "x";\n' },
      },
      systemMessage: "agent-hooks: fixed and formatted src/a.ts before writing",
    });
    expect(readdirSync(path.join(temp.repo, "src"))).toEqual(["old.ts"]);
  });

  test("the fixer runs on a copy beside the real file, so it finds the files around it", async () => {
    fakeTool(temp.repo, "marker", 'cat "$(dirname "$1")/../.marker" >> "$1"');
    writeRepoFile(temp.repo, "src/.marker", "// marked\n");
    fixers('"marker": { "on": "**/*.ts", "file": "marker {file}" }');

    const output = await hookOutput("pre-edit", write("src/a.ts", "const a = 1;\n"));

    expect(output?.["hookSpecificOutput"]).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: {
        file_path: path.join(temp.repo, "src/a.ts"),
        content: "const a = 1;\n// marked\n",
      },
    });
  });

  test("an Edit becomes one that replaces the whole file with its fixed content", async () => {
    fixers(QUOTES);

    expect(
      (await hookOutput("pre-edit", edit("src/old.ts", "'old'", "'new'")))?.["hookSpecificOutput"],
    ).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: {
        file_path: path.join(temp.repo, "src/old.ts"),
        old_string: "const a = 'old';\n",
        new_string: 'const a = "new";\n',
        replace_all: false,
      },
    });
  });

  test("an Edit whose old_string matches several times is fixed only with replace_all, as the tool would apply it", async () => {
    fixers(QUOTES);
    writeRepoFile(temp.repo, "src/twice.ts", "f('a');\nf('a');\n");
    const twice = edit("src/twice.ts", "'a'", "'b'");

    expect(await hookOutput("pre-edit", twice)).toBeNull();

    const all = fixtureIn("pre-edit-edit", temp.repo, {
      tool_input: {
        file_path: path.join(temp.repo, "src/twice.ts"),
        old_string: "'a'",
        new_string: "'b'",
        replace_all: true,
      },
    });

    expect((await hookOutput("pre-edit", all))?.["hookSpecificOutput"]).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: {
        file_path: path.join(temp.repo, "src/twice.ts"),
        old_string: "f('a');\nf('a');\n",
        new_string: 'f("b");\nf("b");\n',
        replace_all: false,
      },
    });
  });

  test("an empty Write is left alone", async () => {
    fixers('"tag": { "on": "**/*.ts", "file": "tag {file}" }');
    fakeTool(temp.repo, "tag", 'printf x >> "$1"');

    expect(await hookOutput("pre-edit", write("src/a.ts", ""))).toBeNull();
  });

  test("a relative file_path is read from the cwd, a symlinked one through its link", async () => {
    fixers(QUOTES);
    const link = path.join(temp.dir, "link");
    symlinkSync(temp.repo, link);

    const relative = fixtureIn("pre-edit-write", temp.repo, {
      cwd: path.join(temp.repo, "src"),
      tool_input: { file_path: "a.ts", content: "const a = 'x';\n" },
    });

    expect(await hookOutput("pre-edit", relative)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { file_path: "a.ts", content: 'const a = "x";\n' },
      },
      systemMessage: "agent-hooks: fixed and formatted src/a.ts before writing",
    });

    const linked = fixtureIn("pre-edit-write", temp.repo, {
      tool_input: { file_path: path.join(link, "src/b.ts"), content: "const b = 'x';\n" },
    });

    expect((await hookOutput("pre-edit", linked))?.["systemMessage"]).toBe(
      "agent-hooks: fixed and formatted src/b.ts before writing",
    );
  });

  test("a file of a linked worktree nested in the checkout is never rewritten by the parent's config", async () => {
    fixers(QUOTES);
    const worktree = path.join(temp.repo, ".claude/worktrees/agent");
    git(temp.repo, "worktree", "add", "-q", worktree);

    expect(
      await hookOutput("pre-edit", write(".claude/worktrees/agent/src/a.ts", "const a = 'x';\n")),
    ).toBeNull();
    expect(existsSync(path.join(worktree, ".git"))).toBeTrue();
  });

  test("an Edit whose fix would undo it is left alone", async () => {
    fakeTool(temp.repo, "single", `sed -i "s/\\"/'/g" "$1"`);
    fixers('"single": { "on": "**/*.ts", "file": "single {file}" }');

    expect(await hookOutput("pre-edit", edit("src/old.ts", "'old'", '"old"'))).toBeNull();
  });

  test("a fixer that fails or is missing is silent, and the others still apply", async () => {
    fixers(
      `"broken": { "on": "**/*.ts", "file": "broken {file}" },
       "ghost": { "on": "**/*.ts", "file": "no-such-tool-anywhere {file}" },
       ${QUOTES}`,
    );

    expect(await hookOutput("pre-edit", write("src/a.ts", "const a = 'x';\n"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { file_path: path.join(temp.repo, "src/a.ts"), content: 'const a = "x";\n' },
      },
      systemMessage: "agent-hooks: fixed and formatted src/a.ts before writing",
    });
  });

  test("a write whose only fixer fails goes on unchanged, with nothing printed", async () => {
    fixers('"broken": { "on": "**/*.ts", "file": "broken {file}" }');

    expect(await hookOutput("pre-edit", write("src/a.ts", "const a = 'x';\n"))).toBeNull();
  });

  test("a stdin fixer's output is the fixed content", async () => {
    fixers('"upper": { "on": "**/*.md", "stdin": "upper" }');

    expect(
      (await hookOutput("pre-edit", write("notes.md", "hello\n")))?.["hookSpecificOutput"],
    ).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { file_path: path.join(temp.repo, "notes.md"), content: "HELLO\n" },
    });
  });

  test("the loop fixers run first until the content settles, then the others once, whatever the order", async () => {
    fakeTool(temp.repo, "shrink", 'sed -i "s/aa/a/" "$1"');
    fakeTool(temp.repo, "tail-b", 'sed -i "s/a$/b/" "$1"');
    fixers(
      `"tail-b": { "on": "**/*.txt", "file": "tail-b {file}" },
       "shrink": { "on": "**/*.txt", "file": "shrink {file}", "loop": true }`,
    );

    expect(
      (await hookOutput("pre-edit", write("a.txt", "aaaa\n")))?.["hookSpecificOutput"],
    ).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { file_path: path.join(temp.repo, "a.txt"), content: "b\n" },
    });
  });

  test("a loop fixer that never settles runs five passes", async () => {
    const runs = path.join(temp.dir, "runs");
    fakeTool(temp.repo, "grow", `printf x >> "$1"; echo run >> "${runs}"`);
    fixers('"grow": { "on": "**/*.txt", "file": "grow {file}", "loop": true }');

    await hookOutput("pre-edit", write("a.txt", "a"));

    expect(readFileSync(runs, "utf8")).toBe("run\n".repeat(5));
  });

  test("a fixer runs at an edit by default and with `both`, never with `stop`, nor on an excluded file", async () => {
    fakeTool(temp.repo, "tag", 'printf "$2" >> "$1"');
    writeConfig(
      temp.repo,
      `{
        "exclude": ["vendor/**"],
        "fixers": {
          "edit": { "on": "**/*.txt", "file": "tag {file} E" },
          "both": { "on": "**/*.txt", "file": "tag {file} B" },
          "stop": { "on": "**/*.txt", "file": "tag {file} S", "at": "stop" },
          "skip": { "on": "**/*.txt", "exclude": ["skip/**"], "file": "tag {file} X" },
        },
      }`,
    );

    expect((await hookOutput("pre-edit", write("a.txt", "-")))?.["hookSpecificOutput"]).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { file_path: path.join(temp.repo, "a.txt"), content: "-EBX" },
    });
    expect(
      (await hookOutput("pre-edit", write("skip/a.txt", "-")))?.["hookSpecificOutput"],
    ).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { file_path: path.join(temp.repo, "skip/a.txt"), content: "-EB" },
    });
    expect(await hookOutput("pre-edit", write("vendor/a.txt", "-"))).toBeNull();
  });

  test("an invalid config is a note naming the file and the key", async () => {
    writeConfig(temp.repo, '{ "fixers": { "f": { "on": "*", "file": "f", "disabled": true } } }');

    expect(await hookOutput("pre-edit", write("src/a.ts", "x"))).toEqual({
      systemMessage: `agent-hooks: ${path.join(temp.repo, ".claude/agent-hooks.jsonc")}: fixers.f.disabled: unknown key`,
    });
  });

  test("a fixer still running at the deadline is killed and the write goes on as asked", async () => {
    fakeTool(temp.repo, "slow", "sleep 30");
    fixers(`"slow": { "on": "**/*.ts", "file": "slow {file}" }, ${QUOTES}`);
    const started = Date.now();

    expect(
      await hookOutput("pre-edit", write("src/a.ts", "const a = 'x';\n"), { deadlineMs: 3000 }),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(6000);
  });
});
