import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runDoctor } from "./doctor.ts";
import type { TempRepo } from "./test-support.ts";
import {
  commitFiles,
  createTempRepo,
  fakeTool,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

let temp: TempRepo;

let home: string;

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo({
    "README.md": "# r\n",
    "docs/guide.md": "# g\n",
    "package.json": "{}\n",
    "plans/p.md": "# p\n",
  });
  home = path.join(temp.dir, "home");
  mkdirSync(home);
});

afterEach(() => {
  removeTempRepo(temp);
});

async function doctor(configFile?: string): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];

  const print = (line: string): void => {
    lines.push(line);
  };

  const code = await runDoctor(
    configFile === undefined
      ? { cwd: temp.repo, home, print }
      : { cwd: temp.repo, home, print, configFile },
  );

  return { code, lines };
}

describe("doctor", () => {
  test("checks each program, tries each fixer, and prints the wiring, the photo and the last Stop, no config dump", async () => {
    fakeTool(temp.repo, "fmt", "exit 0");
    fakeTool(temp.repo, "check", "exit 0");
    writeConfig(
      temp.repo,
      `{
        "fixers": { "fmt": { "on": "**/*.{md,json}", "file": "fmt {file}" } },
        "lanes": { "check": { "on": "**", "takes": "project", "run": "check" } },
      }`,
    );

    const { code, lines } = await doctor();

    expect(code).toBe(0);
    expect(lines.slice(0, 5)).toEqual([
      `checkout: ${temp.repo}`,
      `ok      config: ${path.join(temp.repo, ".claude/agent-hooks.jsonc")}`,
      `ok      fixer fmt: ${path.join(temp.repo, "node_modules/.bin/fmt")}`,
      `ok      lane check: ${path.join(temp.repo, "node_modules/.bin/check")}`,
      "ok      fixer fmt runs on README.md, package.json",
    ]);
    expect(lines[5]).toBe("WARN    claude wiring: the agent-hooks plugin is not enabled");
    expect(lines[6]).toMatch(/^photo: \d+ dirty files in \d+ ms$/u);
    expect(lines[7]).toBe("last stop: none");
    expect(lines).toHaveLength(8);
  });

  test("names a fixer that fails on a tracked file, one file per extension, and exits 1", async () => {
    const tried = path.join(temp.dir, "tried");
    fakeTool(
      temp.repo,
      "fmt",
      `echo "$1" >> "${tried}"; case "$1" in *.md) echo "error: no parser for this file" >&2; exit 2;; esac`,
    );
    writeConfig(
      temp.repo,
      '{ "fixers": { "fmt": { "on": "**/*.{md,json}", "file": "fmt {file}" } } }',
    );

    const { code, lines } = await doctor();

    expect(code).toBe(1);
    expect(lines).toContain(
      "FAIL    fixer fmt fails on README.md: error: no parser for this file (exit 2)",
    );
    expect(lines.filter((line) => line.startsWith("FAIL"))).toHaveLength(1);
    expect(
      readFileSync(tried, "utf8")
        .trimEnd()
        .split("\n")
        .map((file) => path.basename(file)),
    ).toEqual(["README.md", "package.json"]);
  });

  test("a `loop` fixer that exits non-zero is a linter leaving a finding: a WARN, and exit 0", async () => {
    fakeTool(temp.repo, "lint", 'echo "x.md:1:1: a finding it cannot fix" >&2; exit 1');
    writeConfig(
      temp.repo,
      '{ "fixers": { "lint": { "on": "**/*.md", "file": "lint --fix {file}", "loop": true } } }',
    );

    const { code, lines } = await doctor();

    expect(lines).toContain(
      "WARN    fixer lint leaves a finding or fails on README.md: x.md:1:1: a finding it cannot fix (exit 1)",
    );
    expect(code).toBe(0);
  });

  test("a `loop` fixer that runs out of time is a FAIL: it would stall every edit", async () => {
    writeConfig(
      temp.repo,
      '{ "fixers": { "lint": { "on": "**/*.md", "file": "lint --fix {file}", "loop": true } } }',
    );
    fakeTool(temp.repo, "lint", "exit 0");

    const lines: string[] = [];

    const code = await runDoctor({
      cwd: temp.repo,
      print: (line) => lines.push(line),
      runner: () => Promise.resolve({ kind: "timedOut", stdout: "", stderr: "", timeoutMs: 1 }),
    });

    expect(lines.some((line) => line.startsWith("FAIL    fixer lint fails on README.md"))).toBe(
      true,
    );
    expect(code).toBe(1);
  });

  test("tries the fixer on a copy beside the real file, so its ignore file applies, and leaves no copy", async () => {
    fakeTool(
      temp.repo,
      "fmt",
      'grep -qx "$(basename "$1")" "$(dirname "$1")/../.fmtignore" && { echo "ignored: $1" >&2; exit 2; }; exit 0',
    );
    commitFiles(temp.repo, { "docs/.fmtignore": "guide.md\n" });
    writeConfig(temp.repo, '{ "fixers": { "fmt": { "on": "docs/*.md", "file": "fmt {file}" } } }');

    const { lines } = await doctor();

    expect(lines.find((line) => line.startsWith("FAIL"))).toMatch(
      /^FAIL {4}fixer fmt fails on docs\/guide\.md: ignored: .*\/docs\/\.agent-hooks-\w{6}\/guide\.md \(exit 2\)$/u,
    );
    expect(readdirSync(path.join(temp.repo, "docs")).toSorted()).toEqual([
      ".fmtignore",
      "guide.md",
    ]);
  });

  test("skips the line `bun run` echoes for its script: the failure's own line is named", async () => {
    fakeTool(
      temp.repo,
      "fmt",
      'echo "\\$ fmt --write $1" >&2; echo "Expected at least one target file." >&2; exit 2',
    );
    writeConfig(temp.repo, '{ "fixers": { "fmt": { "on": "README.md", "file": "fmt {file}" } } }');

    expect((await doctor()).lines).toContain(
      "FAIL    fixer fmt fails on README.md: Expected at least one target file. (exit 2)",
    );
  });

  test("tries no file the config or the fixer excludes", async () => {
    fakeTool(temp.repo, "fmt", "exit 0");
    writeConfig(
      temp.repo,
      `{
        "exclude": ["README.md"],
        "fixers": { "fmt": { "on": "**/*.md", "exclude": ["docs/**"], "file": "fmt {file}" } },
      }`,
    );

    expect((await doctor()).lines).toContain("ok      fixer fmt runs on plans/p.md");
  });

  test("a missing program is MISSING and exits 1, and its fixer is not tried", async () => {
    writeConfig(
      temp.repo,
      `{
        "fixers": { "ghost": { "on": "**/*.md", "file": "no-such-fixer {file}" } },
        "lanes": { "tests": { "on": "**", "takes": "project", "run": "bun run tests" } },
      }`,
    );

    const { code, lines } = await doctor();

    expect(code).toBe(1);
    expect(lines).toContain("MISSING fixer ghost: no-such-fixer");
    expect(lines).toContain(
      `MISSING lane tests: no "tests" script in ${path.join(temp.repo, "package.json")}`,
    );
    expect(lines.some((line) => line.includes("fixer ghost runs on"))).toBeFalse();
  });

  test("--config checks a file from elsewhere against the checkout around the cwd", async () => {
    fakeTool(temp.repo, "fmt", "exit 0");
    const elsewhere = path.join(temp.dir, "elsewhere.jsonc");
    writeFileSync(
      elsewhere,
      '{ "fixers": { "fmt": { "on": "**/*.json", "file": "fmt {file}" } } }',
    );

    const { code, lines } = await doctor(elsewhere);

    expect(code).toBe(0);
    expect(lines).toContain(`ok      config: ${elsewhere}`);
    expect(lines).toContain("ok      fixer fmt runs on package.json");
    expect(existsSync(path.join(temp.repo, ".claude/agent-hooks.jsonc"))).toBeFalse();
  });

  test("an invalid config is named with its key path and exits 1", async () => {
    writeConfig(temp.repo, '{ "presets": ["ts"] }');

    expect(await doctor()).toEqual({
      code: 1,
      lines: [
        `checkout: ${temp.repo}`,
        `agent-hooks: ${path.join(temp.repo, ".claude/agent-hooks.jsonc")}: presets: unknown key`,
      ],
    });
  });

  test("a checkout without the config says so and exits 1", async () => {
    expect(await doctor()).toEqual({
      code: 1,
      lines: [
        `checkout: ${temp.repo}`,
        `MISSING config: ${path.join(temp.repo, ".claude/agent-hooks.jsonc")}, so every hook of the kit exits at once here`,
      ],
    });
  });

  test("the plugin enabled and a settings file declaring a kit hook run each hook twice", async () => {
    writeConfig(temp.repo, "{}");
    writeRepoFile(
      home,
      ".claude/settings.json",
      '{ "enabledPlugins": { "agent-hooks@market": true } }',
    );
    writeRepoFile(
      temp.repo,
      ".claude/settings.json",
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /x/agent-hooks.ts stop" }] }] },
      }),
    );

    expect((await doctor()).lines).toContain(
      `WARN    claude wiring: plugin agent-hooks@market and a hook in ${path.join(temp.repo, ".claude/settings.json")} both run the kit, so each hook runs twice: remove the one in ${path.join(temp.repo, ".claude/settings.json")}`,
    );
  });

  test("resolves a fixer's program from the package of the file it fixes, as the hooks do", async () => {
    commitFiles(temp.repo, { "packages/a/package.json": "{}\n", "packages/a/x.md": "# x\n" });
    fakeTool(path.join(temp.repo, "packages/a"), "pkgfmt", "exit 0");
    writeConfig(
      temp.repo,
      '{ "fixers": { "pkgfmt": { "on": "packages/a/**/*.md", "file": "pkgfmt {file}" } } }',
    );

    const { code, lines } = await doctor();

    expect(lines).toContain(
      `ok      fixer pkgfmt: ${path.join(temp.repo, "packages/a/node_modules/.bin/pkgfmt")}`,
    );
    expect(lines).toContain("ok      fixer pkgfmt runs on packages/a/x.md");
    expect(code).toBe(0);
  });

  test("a fixer's `bun run` script is read where the fixer runs, the top: one a sub-package alone holds is MISSING", async () => {
    commitFiles(temp.repo, {
      "packages/a/package.json": '{ "scripts": { "fmt": "true" } }\n',
      "packages/a/x.md": "# x\n",
    });
    writeConfig(
      temp.repo,
      '{ "fixers": { "fmt": { "on": "packages/a/**/*.md", "file": "bun run fmt {file}" } } }',
    );

    const { code, lines } = await doctor();

    expect(lines).toContain(
      `MISSING fixer fmt: no "fmt" script in ${path.join(temp.repo, "package.json")}`,
    );
    expect(code).toBe(1);
  });

  test("a failure of the kit itself ends as one line and exit 1", async () => {
    const broken = path.join(temp.dir, "broken");
    writeRepoFile(broken, ".git", "gitdir: /nowhere/at/all\n");
    writeConfig(broken, '{ "fixers": { "f": { "on": "**", "file": "true {file}" } } }');
    const lines: string[] = [];

    const code = await runDoctor({ cwd: broken, home, print: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines.at(-1)).toStartWith("agent-hooks: git ls-files -z failed (exit 128): fatal:");
  });

  test("the probes share one budget: the fixers it leaves are named, not tried", async () => {
    fakeTool(temp.repo, "slow", "sleep 2");
    fakeTool(temp.repo, "fast", "exit 0");
    writeConfig(
      temp.repo,
      `{
        "fixers": {
          "slow": { "on": "README.md", "file": "slow {file}" },
          "fast": { "on": "README.md", "file": "fast {file}" },
        },
      }`,
    );
    const lines: string[] = [];

    await runDoctor({
      cwd: temp.repo,
      home,
      print: (line) => lines.push(line),
      probeBudgetMs: 300,
    });

    expect(lines).toContain(
      "WARN    fixers not tried, the 300 ms the probes may take ran out: fast",
    );
    expect(
      lines.some((line) => line.startsWith("FAIL    fixer slow fails on README.md")),
    ).toBeTrue();
  });

  test("the plugin enabled alone is the wiring", async () => {
    writeConfig(temp.repo, "{}");
    writeRepoFile(
      home,
      ".claude/settings.json",
      '{ "enabledPlugins": { "agent-hooks@market": true } }',
    );

    expect((await doctor()).lines).toContain("ok      claude wiring: plugin agent-hooks@market");
  });
});
