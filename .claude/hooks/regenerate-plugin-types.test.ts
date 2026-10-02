import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";

import { commit, git } from "./git-fixture.ts";
import {
  headerVersion,
  installedVersion,
  TOOLS_TYPES_PATH,
  TYPES_PATH,
} from "./regenerate-plugin-types.ts";

function setTypes(dir: string, header: string, eol = "\n") {
  const file = join(dir, TYPES_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${header}${eol}// declarations${eol}`);
}

const types = (dir: string) => readFileSync(join(dir, TYPES_PATH), "utf8");

const note = (text: string) => ({
  systemMessage: text,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
});

describe("headerVersion", () => {
  test("reads the version from the generated header", () => {
    expect(headerVersion("// Written by Claude Code 2.1.278.")).toBe("2.1.278");
  });

  test("refuses a first line that is not the header", () => {
    expect(() => headerVersion("// Claude Code function hooks")).toThrow(TYPES_PATH);
  });
});

describe("installedVersion", () => {
  test("reads the version from `claude --version`", () => {
    expect(installedVersion("2.1.278 (Claude Code)\n")).toBe("2.1.278");
  });

  test("refuses an unknown format", () => {
    expect(() => installedVersion("claude 2.1.278")).toThrow("claude --version");
  });
});

describe("hook subprocess", () => {
  const HOOK = join(import.meta.dir, "regenerate-plugin-types.ts");

  // Stands in for `claude` as measured on 2.1.287: a run that loads a mod with
  // --plugin-dir writes the mod's types into its .claude-plugin/types/, and a
  // logged-out one does so before it stops on the login. A logged-in run
  // writes the types and then answers, so the stub writes nothing for it and
  // the test sees the difference. stub-silent makes a run write nothing.
  const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub_dir="$(dirname "$0")"
if [[ $1 == --version ]]; then
  echo "$(cat "$stub_dir/stub-version") (Claude Code)"
  exit 0
fi
echo "$*" >>"$stub_dir/stub-runs"
if [[ -n \${ANTHROPIC_API_KEY:-} || -z \${CLAUDE_CONFIG_DIR:-} || -n "$(ls -A "$CLAUDE_CONFIG_DIR")" ]]; then
  echo "stub: logged in"
  exit 0
fi
if [[ -f $stub_dir/stub-silent ]]; then
  echo "stub: wrote nothing"
  exit 1
fi
mod=""
while [[ $# -gt 0 ]]; do
  if [[ $1 == --plugin-dir ]]; then mod="$2"; fi
  shift
done
types="$mod/.claude-plugin/types"
mkdir -p "$types/claude-code" "$types/claude-code-tools" "$types/claude-code-mcp"
echo "// Written by Claude Code $(cat "$stub_dir/stub-version")." >"$types/claude-code/index.d.ts"
echo "// tools" >"$types/claude-code-tools/index.d.ts"
echo "// mcp" >"$types/claude-code-mcp/index.d.ts"
echo "Not logged in · Please run /login"
exit 1
`;

  let projectDir = "";
  let stubDir = "";
  let tempRoot = "";

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "plugin-types-project-"));
    stubDir = mkdtempSync(join(tmpdir(), "plugin-types-stub-"));
    tempRoot = mkdtempSync(join(tmpdir(), "plugin-types-tmp-"));
    writeFileSync(join(stubDir, "claude"), CLAUDE_STUB);
    chmodSync(join(stubDir, "claude"), 0o755);
    await $`git init -q -b dev`.cwd(projectDir).quiet();
  });

  afterEach(() => {
    for (const dir of [projectDir, stubDir, tempRoot])
      rmSync(dir, { recursive: true, force: true });
  });

  const stubRuns = () =>
    existsSync(join(stubDir, "stub-runs")) ? readFileSync(join(stubDir, "stub-runs"), "utf8") : "";

  async function runHook(installed: string, cwd = projectDir) {
    writeFileSync(join(stubDir, "stub-version"), installed);

    const proc = Bun.spawn([process.execPath, HOOK], {
      stdin: new Blob([
        JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env["PATH"] ?? ""}`,
        CLAUDE_PROJECT_DIR: projectDir,
        ANTHROPIC_API_KEY: "sk-test",
        TMPDIR: tempRoot,
      },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr, firstErrorLine: stderr.split("\n", 1)[0] ?? "" };
  }

  test("leaves the types alone when their header names the installed version", async () => {
    setTypes(projectDir, "// Written by Claude Code 2.1.278.");

    const { exitCode, stdout } = await runHook("2.1.278");

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stubRuns()).toBe("");
  });

  test("reads a header with a CRLF line ending", async () => {
    setTypes(projectDir, "// Written by Claude Code 2.1.278.", "\r\n");

    const { exitCode, stdout } = await runHook("2.1.278");

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("regenerates the types of a checkout on dev logged out, and copies back the core and the tools only", async () => {
    setTypes(projectDir, "// Written by Claude Code 2.1.276.");

    const { exitCode, stdout, stderr } = await runHook("2.1.278");

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(types(projectDir)).toBe("// Written by Claude Code 2.1.278.\n");
    expect(readFileSync(join(projectDir, TOOLS_TYPES_PATH), "utf8")).toBe("// tools\n");
    expect(readdirSync(dirname(join(projectDir, TYPES_PATH))).toSorted()).toEqual([
      "claude-code-tools.d.ts",
      "claude-code.d.ts",
    ]);
    expect(stubRuns()).toStartWith(
      "-p --setting-sources project --no-session-persistence --plugin-dir ",
    );
    expect(JSON.parse(stdout)).toEqual(
      note(`${TYPES_PATH}: regenerated from Claude Code 2.1.276 to 2.1.278, left uncommitted.`),
    );
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  test("reports the drift of a checkout on another branch, and writes nothing", async () => {
    await $`git checkout -q -b feature/x`.cwd(projectDir).quiet();
    setTypes(projectDir, "// Written by Claude Code 2.1.276.");

    const { exitCode, stdout } = await runHook("2.1.278");

    expect(exitCode).toBe(0);
    expect(types(projectDir)).toStartWith("// Written by Claude Code 2.1.276.");
    expect(stubRuns()).toBe("");
    expect(JSON.parse(stdout)).toEqual(
      note(
        `${TYPES_PATH}: written by Claude Code 2.1.276, installed 2.1.278; a session in a checkout on dev regenerates it.`,
      ),
    );
  });

  async function makeWorktree(): Promise<string> {
    await commit(["--allow-empty", "-m", "init"], projectDir);
    await git(["checkout", "-q", "-b", "feature/x"], projectDir);
    const worktree = join(tempRoot, "worktree");
    await git(["worktree", "add", "-q", worktree, "dev"], projectDir);
    setTypes(worktree, "// Written by Claude Code 2.1.276.");
    setTypes(projectDir, "// Written by Claude Code 2.1.276.");

    return worktree;
  }

  test("checks the checkout around the payload's cwd, not the project", async () => {
    const worktree = await makeWorktree();
    mkdirSync(join(worktree, "sub"));

    const { exitCode } = await runHook("2.1.278", join(worktree, "sub"));

    expect(exitCode).toBe(0);
    expect(types(worktree)).toBe("// Written by Claude Code 2.1.278.\n");
    expect(types(projectDir)).toStartWith("// Written by Claude Code 2.1.276.");
  });

  test("climbs out of another repository nested in a worktree to that worktree", async () => {
    const worktree = await makeWorktree();
    const nested = join(worktree, "plans");
    mkdirSync(join(nested, "sub"), { recursive: true });
    await git(["init", "-q"], nested);

    const { exitCode } = await runHook("2.1.278", join(nested, "sub"));

    expect(exitCode).toBe(0);
    expect(types(worktree)).toBe("// Written by Claude Code 2.1.278.\n");
    expect(types(projectDir)).toStartWith("// Written by Claude Code 2.1.276.");
  });

  test("checks the project when the payload's cwd sits in an unrelated repository", async () => {
    await git(["checkout", "-q", "-b", "feature/x"], projectDir);
    setTypes(projectDir, "// Written by Claude Code 2.1.276.");
    const unrelated = join(tempRoot, "dotfiles");
    mkdirSync(unrelated);
    await git(["init", "-q", "-b", "dev"], unrelated);

    const { exitCode, stdout } = await runHook("2.1.278", unrelated);

    expect(exitCode).toBe(0);
    expect(stubRuns()).toBe("");
    expect(JSON.parse(stdout)).toEqual(
      note(
        `${TYPES_PATH}: written by Claude Code 2.1.276, installed 2.1.278; a session in a checkout on dev regenerates it.`,
      ),
    );
  });

  test("does nothing in a checkout without the vellum types", async () => {
    const { exitCode, stdout } = await runHook("2.1.278");

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stubRuns()).toBe("");
  });

  test("fails on one stderr line naming the file when the header is not the generated one", async () => {
    setTypes(projectDir, "// hand-written");

    const { exitCode, firstErrorLine } = await runHook("2.1.278");

    expect(exitCode).toBe(1);
    expect(firstErrorLine).toStartWith(`regenerate-plugin-types: ${TYPES_PATH}: expected`);
    expect(stubRuns()).toBe("");
  });

  test("fails on one stderr line carrying the run's output when the run writes no types", async () => {
    writeFileSync(join(stubDir, "stub-silent"), "");
    setTypes(projectDir, "// Written by Claude Code 2.1.276.");

    const { exitCode, firstErrorLine } = await runHook("2.1.278");

    expect(exitCode).toBe(1);
    expect(firstErrorLine).toStartWith(
      "regenerate-plugin-types: claude -p --plugin-dir exited 1 without writing the mod's types",
    );
    expect(firstErrorLine).toEndWith("stub: wrote nothing");
    expect(types(projectDir)).toStartWith("// Written by Claude Code 2.1.276.");
    expect(readdirSync(tempRoot)).toEqual([]);
  });
});
