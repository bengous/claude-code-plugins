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

import { headerVersion, installedVersion, TYPES_PATH } from "./regenerate-plugin-types.ts";

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

  // Stands in for `claude` as measured on 2.1.278: print mode appends a piped
  // stdin to the prompt, and `/plugin-types` exists only under
  // CLAUDE_CODE_ENABLE_FUNCTION_HOOKS; both paths exit 0. stub-silent makes a
  // registered run write nothing.
  const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub_dir="$(dirname "$0")"
if [[ $1 == --version ]]; then
  echo "$(cat "$stub_dir/stub-version") (Claude Code)"
  exit 0
fi
echo "$*" >>"$stub_dir/stub-runs"
if [[ \${CLAUDE_CODE_ENABLE_FUNCTION_HOOKS:-} != 1 ]]; then
  echo "/plugin-types isn't installed in this session"
  exit 0
fi
if [[ -f $stub_dir/stub-silent ]]; then
  echo "stub: wrote nothing"
  exit 0
fi
prompt="\${!#}"
piped="$(cat)"
if [[ -n $piped ]]; then prompt+=$'\\n'"$piped"; fi
out="\${prompt#/plugin-types }"
mkdir -p "$out/claude-code-plugins"
echo "// Written by Claude Code $(cat "$stub_dir/stub-version")." >"$out/claude-code.d.ts"
echo "// mcp" >"$out/claude-code-mcp.d.ts"
echo "// plugins" >"$out/claude-code-plugins.d.ts"
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
        CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: "",
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

  test("regenerates the types of a checkout on dev, and copies back claude-code.d.ts only", async () => {
    setTypes(projectDir, "// Written by Claude Code 2.1.276.");

    const { exitCode, stdout, stderr } = await runHook("2.1.278");

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(types(projectDir)).toBe("// Written by Claude Code 2.1.278.\n");
    expect(readdirSync(dirname(join(projectDir, TYPES_PATH)))).toEqual(["claude-code.d.ts"]);
    expect(stubRuns()).toStartWith(
      '-p --setting-sources project --settings {"disableAllHooks":true} --no-session-persistence /plugin-types ',
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

  test("checks the checkout around the payload's cwd, not the project", async () => {
    const git = (args: string[]) =>
      $`git ${args}`
        .cwd(projectDir)
        .env({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })
        .quiet();

    await git([
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    await git(["checkout", "-q", "-b", "feature/x"]);
    const worktree = join(tempRoot, "worktree");
    await git(["worktree", "add", "-q", worktree, "dev"]);
    mkdirSync(join(worktree, "sub"));
    setTypes(worktree, "// Written by Claude Code 2.1.276.");
    setTypes(projectDir, "// Written by Claude Code 2.1.276.");

    const { exitCode } = await runHook("2.1.278", join(worktree, "sub"));

    expect(exitCode).toBe(0);
    expect(types(worktree)).toBe("// Written by Claude Code 2.1.278.\n");
    expect(types(projectDir)).toStartWith("// Written by Claude Code 2.1.276.");
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

  test("fails on one stderr line carrying the run's output when /plugin-types writes nothing", async () => {
    writeFileSync(join(stubDir, "stub-silent"), "");
    setTypes(projectDir, "// Written by Claude Code 2.1.276.");

    const { exitCode, firstErrorLine } = await runHook("2.1.278");

    expect(exitCode).toBe(1);
    expect(firstErrorLine).toStartWith("regenerate-plugin-types: /plugin-types exited 0");
    expect(firstErrorLine).toEndWith("stub: wrote nothing");
    expect(types(projectDir)).toStartWith("// Written by Claude Code 2.1.276.");
    expect(readdirSync(tempRoot)).toEqual([]);
  });
});
