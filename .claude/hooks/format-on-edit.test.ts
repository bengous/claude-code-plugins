import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";

import { diffHunks, parseHookInput, rewritersFor, toRepoRelative } from "./format-on-edit.ts";
import type { Rewriter } from "./format-on-edit.ts";

describe("parseHookInput", () => {
  test("returns null on invalid JSON", () => {
    expect(parseHookInput("not json")).toBeNull();
  });
});

describe("toRepoRelative", () => {
  test("strips the repo root", () => {
    expect(toRepoRelative("/repo/scripts/a.ts", "/repo/")).toBe("scripts/a.ts");
  });

  test("returns null for a file outside the repo", () => {
    expect(toRepoRelative("/elsewhere/a.ts", "/repo")).toBeNull();
  });
});

describe("rewritersFor", () => {
  test("sends the four script extensions through oxfmt, oxlint --fix, oxfmt, which skip what their config ignores", () => {
    for (const path of ["a.ts", "a.js", "a.mjs", "a.cjs", "archive/plugin/a.ts"]) {
      const oxfmt: Rewriter = {
        tool: "oxfmt",
        argv: ["bun", "x", "oxfmt", "--no-error-on-unmatched-pattern", path],
      };

      expect(rewritersFor(path)).toEqual([
        oxfmt,
        {
          tool: "oxlint --fix",
          argv: [
            "bun",
            "x",
            "oxlint",
            "--fix",
            "--silent",
            "--format=agent",
            "--no-error-on-unmatched-pattern",
            path,
          ],
        },
        oxfmt,
      ]);
    }
  });

  test("sends shell scripts to shfmt with the lint-shell flags", () => {
    expect(rewritersFor("scripts/a.sh")).toEqual([
      { tool: "shfmt", argv: ["shfmt", "-i", "2", "-ci", "-w", "scripts/a.sh"] },
    ]);
  });

  test("has none for other files", () => {
    for (const path of ["a.md", "a.json", "a"]) {
      expect(rewritersFor(path)).toEqual([]);
    }
  });

  test("skips shell scripts under archive/, as lint-shell does", () => {
    expect(rewritersFor("archive/plugin/a.sh")).toEqual([]);
  });

  test("skips every file under a node_modules directory", () => {
    for (const path of [
      "node_modules/pkg/a.js",
      "plugin/node_modules/pkg/a.ts",
      "node_modules/a.sh",
    ]) {
      expect(rewritersFor(path)).toEqual([]);
    }
  });

  test("rewrites repo source, dot directories included", () => {
    expect(rewritersFor(".claude/hooks/guard-destructive.ts")).toHaveLength(3);
  });
});

describe("diffHunks", () => {
  test("drops the header lines and keeps every hunk", () => {
    const hunks = [
      "@@ -1,2 +1,2 @@",
      '-import { $ } from "bun";',
      '+import { join } from "node:path";',
      "@@ -9 +9 @@ function main() {",
      "-  return  1;",
      "+  return 1;",
    ];

    const diff = [
      "diff --git 1/tmp/format-on-edit-x/a.ts 2/scripts/a.ts",
      "old mode 100644",
      "new mode 100755",
      "index c3f6b27..5612c88",
      "--- 1/tmp/format-on-edit-x/a.ts",
      "+++ 2/scripts/a.ts",
      ...hunks,
      "",
    ].join("\n");

    expect(diffHunks(diff)).toBe(hunks.join("\n"));
  });

  test("is empty when the diff holds no hunk", () => {
    expect(diffHunks("diff --git a/x b/y\nold mode 100644\nnew mode 100755\n")).toBe("");
  });
});

function fixedContext(name: string) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `\`oxfmt\` and \`oxlint --fix\` rewrote \`${name}\`; it now reads as this diff:\n` +
        "@@ -1,5 +1,7 @@\n export function f(a: number): number {\n   if (a > 1) return 1;\n" +
        "-  if (a > 2)   return 2;\n+\n+  if (a > 2) return 2;\n+\n   return 0;\n }",
    },
  };
}

// shfmt drives these runs, save the oxlint ones: oxlint and oxfmt need the
// repo's node_modules linked into the temp project.
describe("hook subprocess", () => {
  const HOOK = join(import.meta.dir, "format-on-edit.ts");
  const SESSION_ID = "format-on-edit-test";
  const MIS_INDENTED = "if true; then\necho hi\nfi\n";
  const FORMATTED = "if true; then\n  echo hi\nfi\n";

  let projectDir = "";
  let tempRoot = "";

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "format-on-edit-project-"));
    tempRoot = mkdtempSync(join(tmpdir(), "format-on-edit-tmp-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function runHook(
    filePath: string,
    env: Record<string, string> = {},
    payload: { agent_id?: string } = {},
  ) {
    const proc = Bun.spawn([process.execPath, HOOK], {
      stdin: new Blob([
        JSON.stringify({ session_id: SESSION_ID, ...payload, tool_input: { file_path: filePath } }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        TMPDIR: tempRoot,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        // oxlint picks its default output format from these, and CI sets
        // none: emptied, a run under Claude Code sees what CI sees.
        AI_AGENT: "",
        CLAUDECODE: "",
        CLAUDE_CODE: "",
        ...env,
      },
    });

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    return { exitCode, stdout };
  }

  const markerFile = (id: string = SESSION_ID) => join(tempRoot, "claude-code-plugins-stop", id);

  test("marks the editing subagent, not the parent session its payload names", async () => {
    const agentId = "ae64aaf2fc71fc3bd";
    const script = join(projectDir, "a.sh");
    writeFileSync(script, FORMATTED);

    const { exitCode } = await runHook(script, {}, { agent_id: agentId });

    expect(exitCode).toBe(0);
    expect(existsSync(markerFile(agentId))).toBe(true);
    expect(existsSync(markerFile())).toBe(false);
  });

  test("returns a reformat as its unified diff, even under an external diff tool", async () => {
    const script = join(projectDir, "a.sh");
    const externalDiff = join(tempRoot, "external-diff.sh");
    writeFileSync(script, MIS_INDENTED);
    writeFileSync(externalDiff, "#!/bin/sh\necho EXTERNAL\n");
    chmodSync(externalDiff, 0o755);

    const { exitCode, stdout } = await runHook(script, { GIT_EXTERNAL_DIFF: externalDiff });

    expect(exitCode).toBe(0);

    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "`shfmt` rewrote `a.sh`; it now reads as this diff:\n" +
          "@@ -1,3 +1,3 @@\n if true; then\n-echo hi\n+  echo hi\n fi",
      },
    });

    expect(readFileSync(script, "utf8")).toBe(FORMATTED);
    expect(readFileSync(markerFile(), "utf8")).toBe("");
  });

  test("stays silent on a formatted executable file and still marks the session", async () => {
    const script = join(projectDir, "a.sh");
    writeFileSync(script, FORMATTED);
    chmodSync(script, 0o755);

    const { exitCode, stdout } = await runHook(script);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(markerFile())).toBe(true);
  });

  // shfmt and Bun's shell reword these errors between releases. The hook owns
  // the prefix and passing a non-empty message through, never its wording.
  test("returns a formatter failure as context", async () => {
    const script = join(projectDir, "broken.sh");
    writeFileSync(script, "if true; then\n");

    const { exitCode, stdout } = await runHook(script);

    expect(exitCode).toBe(0);

    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringMatching(/^`shfmt` failed on `broken\.sh`:\n\S/u),
      },
    });
  });

  test("returns a formatter missing from PATH as context, not as a crash", async () => {
    const script = join(projectDir, "a.sh");
    writeFileSync(script, MIS_INDENTED);

    const { exitCode, stdout } = await runHook(script, { PATH: tempRoot });

    expect(exitCode).toBe(0);

    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringMatching(/^`shfmt` failed on `a\.sh`:\n\S/u),
      },
    });
  });

  test("ignores a file outside the project", async () => {
    const { exitCode, stdout } = await runHook("/elsewhere/a.sh");

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(markerFile())).toBe(false);
  });

  test("ignores a file gone before the hook runs", async () => {
    const { exitCode, stdout } = await runHook(join(projectDir, "gone.sh"));

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  // The project and its agent worktree each register the anti-slop plugin
  // from their own file, as the repo and a worktree copy of it do: oxlint run
  // from the project on a worktree file fails on the second registration.
  describe.each([
    ["the project", ""],
    ["an agent worktree", ".claude/worktrees/agent"],
  ])("oxlint --fix in %s", (_, checkout) => {
    const REPO_ROOT = join(import.meta.dir, "..", "..");

    // An agent worktree has no node_modules of its own: Bun resolves the
    // tools from the checkout around it.
    const NODE_MODULES = dirname(dirname(Bun.resolveSync("oxlint/package.json", REPO_ROOT)));

    const CONSECUTIVE_IFS =
      "export function f(a: number): number {\n  if (a > 1) return 1;\n  if (a > 2)   return 2;\n  return 0;\n}\n";

    const FIXED =
      "export function f(a: number): number {\n  if (a > 1) return 1;\n\n  if (a > 2) return 2;\n\n  return 0;\n}\n";

    const NO_FIXER =
      "const code = (path: string): number => path.length;\n\nexport const lengths = (paths: string[]): number[] => paths.map(code);\n";

    const OXLINT_CONFIG = {
      jsPlugins: [{ name: "anti-slop", specifier: "./anti-slop.ts" }],
      rules: {
        "anti-slop/require-readable-spacing": "error",
        "unicorn/no-array-callback-reference": "error",
      },
    };

    let root = "";

    beforeEach(async () => {
      symlinkSync(NODE_MODULES, join(projectDir, "node_modules"));
      const plugin = join(REPO_ROOT, "tools", "oxlint", "anti-slop", "index.ts");

      for (const dir of [projectDir, join(projectDir, ".claude", "worktrees", "agent")]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "anti-slop.ts"),
          `export { default } from ${JSON.stringify(plugin)};\n`,
        );
        writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(OXLINT_CONFIG));
        await $`git init -q`.cwd(dir).quiet();
      }

      root = join(projectDir, checkout);
    });

    test("applies a safe fix, formats the file and returns the diff", async () => {
      const file = join(root, "a.ts");
      writeFileSync(file, CONSECUTIVE_IFS);

      const { exitCode, stdout } = await runHook(file);

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual(fixedContext(join(checkout, "a.ts")));
      expect(readFileSync(file, "utf8")).toBe(FIXED);
    });

    test("follows a symlinked project dir to the checkout", async () => {
      const link = join(tempRoot, "project-link");
      symlinkSync(projectDir, link);
      const file = join(link, checkout, "a.ts");
      writeFileSync(file, CONSECUTIVE_IFS);

      const { exitCode, stdout } = await runHook(file, { CLAUDE_PROJECT_DIR: link });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual(fixedContext(join(checkout, "a.ts")));
      expect(readFileSync(file, "utf8")).toBe(FIXED);
    });

    test.if(checkout === "")(
      "keeps a file a symlink takes outside any checkout with the project",
      async () => {
        const outside = join(tempRoot, "outside");
        mkdirSync(outside);
        symlinkSync(outside, join(projectDir, "shared"));
        const file = join(projectDir, "shared", "s.ts");
        writeFileSync(file, CONSECUTIVE_IFS);

        const { exitCode, stdout } = await runHook(file);

        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout)).toEqual(fixedContext("shared/s.ts"));
        expect(readFileSync(file, "utf8")).toBe(FIXED);
      },
    );

    test("fixes the finding a line wrapped by oxfmt creates", async () => {
      const file = join(root, "c.ts");
      const value = JSON.stringify("x".repeat(90));
      const head = "export function f(): number {\n";
      const tail = "  const short = 1;\n\n  return long.length + short;\n}\n";
      writeFileSync(file, `${head}  const long = ${value};\n${tail}`);

      const { exitCode } = await runHook(file);

      expect(exitCode).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(`${head}  const long =\n    ${value};\n\n${tail}`);
    });

    test("leaves a finding without a fixer as written, and silent", async () => {
      const file = join(root, "b.ts");
      writeFileSync(file, NO_FIXER);

      const { exitCode, stdout } = await runHook(file);

      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(readFileSync(file, "utf8")).toBe(NO_FIXER);

      const lint = await $`bun x oxlint b.ts`.cwd(root).nothrow().quiet();

      expect(lint.exitCode).toBe(1);
      expect(lint.stdout.toString()).toContain("no-array-callback-reference");
    });

    test("returns an oxlint failure as context, ahead of the formatting before it", async () => {
      const file = join(root, "a.ts");
      const name = join(checkout, "a.ts");
      writeFileSync(file, CONSECUTIVE_IFS);
      writeFileSync(join(root, ".oxlintrc.json"), "{");

      const { exitCode, stdout } = await runHook(file);
      const output: { hookSpecificOutput: { additionalContext: string } } = JSON.parse(stdout);
      const context = output.hookSpecificOutput.additionalContext;

      expect(exitCode).toBe(0);
      expect(context).toStartWith(`\`oxlint --fix\` failed on \`${name}\`:\n`);
      expect(context).toContain("configuration file");

      expect(context).toEndWith(
        `\n\n\`oxfmt\` rewrote \`${name}\`; it now reads as this diff:\n` +
          "@@ -1,5 +1,5 @@\n export function f(a: number): number {\n   if (a > 1) return 1;\n" +
          "-  if (a > 2)   return 2;\n+  if (a > 2) return 2;\n   return 0;\n }",
      );
    });
  });
});
