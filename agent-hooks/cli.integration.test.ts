import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import type { Json, TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  fixtureIn,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

const ENTRY = path.join(import.meta.dir, "agent-hooks.ts");

let temp: TempRepo;

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo({ "src/clean.ts": "ok\n" });
});

afterEach(() => {
  removeTempRepo(temp);
});

type Ran = { readonly code: number; readonly stdout: string; readonly stderr: string };

async function cli(args: readonly string[], stdin = "", cwd = temp.repo): Promise<Ran> {
  const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
    cwd,
    env: { ...process.env, AGENT_HOOKS_STATE_DIR: temp.stateDir },
    stdin: new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

function payload(name: string, fields: Readonly<Json> = {}): string {
  return JSON.stringify(fixtureIn(name, temp.repo, fields));
}

describe("agent-hooks <hook>", () => {
  test.each(["session-start", "pre-edit", "stop"])(
    "%s in a checkout without the config exits 0 in silence",
    async (hook) => {
      writeRepoFile(temp.repo, "src/a.ts", "x\n");

      const name =
        hook === "pre-edit" ? "pre-edit-write" : hook === "stop" ? "stop" : "session-start-startup";

      const tool = { tool_input: { file_path: path.join(temp.repo, "src/a.ts"), content: "x\n" } };

      expect(await cli([hook], payload(name, tool))).toEqual({ code: 0, stdout: "", stderr: "" });
    },
  );

  test("a Stop that blocks prints its decision on stdout", async () => {
    fakeTool(temp.repo, "lint", 'grep -Hn bad "$@" && exit 1; exit 0');
    writeConfig(
      temp.repo,
      '{ "lanes": { "lint": { "on": "**/*.ts", "takes": "files", "run": "lint {files}" } } }',
    );
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    const ran = await cli(["stop"], payload("stop"));

    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      decision: "block",
      reason:
        "Stop validation failed:\n\n### lint\nsrc/a.ts:1:bad\n\nFix the errors above before stopping.",
    });
  });

  test("a payload that is no JSON object with a session_id is reported on stderr, exit 0", async () => {
    expect(await cli(["stop"], "not json")).toEqual({
      code: 0,
      stdout: "",
      stderr: "agent-hooks: the payload on stdin is no JSON object with a session_id\n",
    });
  });

  test.each([[["post-edit"]], [["init"]], [["unknown"]], [[]]])(
    "%p is no command: usage, and an exit a harness does not read as a block",
    async (args: readonly string[]) => {
      const ran = await cli(args);

      expect(ran.code).toBe(1);
      expect(ran.stderr).toStartWith("usage:\n  agent-hooks <session-start|pre-edit|stop>");
    },
  );

  test.each([
    [["stop", "--harness", "codex"], "--harness"],
    [["init", "--print"], "--print"],
  ])(
    "%p is no option: usage, and an exit a harness does not read as a block",
    async (args: readonly string[], option: string) => {
      const ran = await cli(args, payload("stop"));

      expect(ran.code).toBe(1);
      expect(ran.stderr).toContain(`agent-hooks: Unknown option '${option}'`);
      expect(ran.stderr).toContain("usage:\n");
    },
  );
});

describe("agent-hooks verify", () => {
  beforeEach(() => {
    fakeTool(temp.repo, "lint", 'echo "linted $@"; grep -Hn bad "$@" && exit 1; exit 0');
    writeConfig(
      temp.repo,
      '{ "lanes": { "lint": { "on": "**/*.ts", "takes": "files", "run": "lint {files}" } } }',
    );
  });

  test("runs the lanes on the files the last session changed", async () => {
    writeRepoFile(temp.repo, "src/before.ts", "bad\n");
    await cli(["session-start"], payload("session-start-startup"));
    writeRepoFile(temp.repo, "src/new.ts", "fine\n");

    expect(await cli(["verify"])).toEqual({
      code: 0,
      stdout: expect.stringMatching(/^scope: src\/new\.ts\nlint: ok \(\d+ ms\)\n$/u),
      stderr: "",
    });
  });

  test("--all takes the whole dirty tree, and a failing lane exits 1", async () => {
    writeRepoFile(temp.repo, "src/before.ts", "bad\n");
    await cli(["session-start"], payload("session-start-startup"));

    const ran = await cli(["verify", "--all"]);

    expect(ran.code).toBe(1);
    expect(ran.stdout).toStartWith(
      "scope: .claude/agent-hooks.jsonc node_modules/.bin/lint src/before.ts\nlint: fail",
    );
    expect(ran.stdout).toContain("  src/before.ts:1:bad");
  });

  test("named files run as named, from the caller's directory", async () => {
    expect((await cli(["verify", "clean.ts"], "", path.join(temp.repo, "src"))).stdout).toMatch(
      /^scope: src\/clean\.ts\nlint: ok \(\d+ ms\)\n$/u,
    );
  });

  test("a named file outside the checkout or on no disk fails", async () => {
    const ran = await cli(["verify", "../outside.ts", "src/typo.ts"]);

    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe(
      `agent-hooks: ${path.join(temp.dir, "outside.ts")} is outside ${temp.repo}\nagent-hooks: no such file: ${path.join(temp.repo, "src/typo.ts")}\n`,
    );
  });

  test("a checkout without the config fails", async () => {
    const ran = await cli(["verify"], "", temp.dir);

    expect(ran.code).toBe(1);
    expect(ran.stderr).toBe(
      `agent-hooks: no .claude/agent-hooks.jsonc at the top of the checkout of ${temp.dir}\n`,
    );
  });
});

describe("agent-hooks doctor", () => {
  test("reads --config and exits 1 on a fixer that fails", async () => {
    fakeTool(temp.repo, "fmt", 'echo "cannot format" >&2; exit 4');
    const elsewhere = path.join(temp.dir, "v2.jsonc");
    await Bun.write(
      elsewhere,
      '{ "fixers": { "fmt": { "on": "**/*.ts", "file": "fmt {file}" } } }',
    );

    const ran = await cli(["doctor", "--config", elsewhere]);

    expect(ran.code).toBe(1);
    expect(ran.stdout).toContain(
      "FAIL    fixer fmt fails on src/clean.ts: cannot format (exit 4)\n",
    );
  });
});
