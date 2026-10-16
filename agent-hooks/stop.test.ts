/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Runner } from "./exec.ts";
import { run } from "./exec.ts";
import type { Harness } from "./hook.ts";
import { runHook } from "./hook.ts";
import { isRecord, stringField } from "./json.ts";
import { runSessionStart } from "./session-start.ts";
import type { RootRecord, SessionState } from "./state.ts";
import { loadState, rootRecord } from "./state.ts";
import { runStop } from "./stop.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  fixtureIn,
  readRepoFile,
  removeTempRepo,
  scrubGitEnv,
  writeRepoFile,
} from "./test-support.ts";

const SESSION = "s1";

const BAD_CHECKER =
  'status=0; for f in "$@"; do if grep -q BAD "$f"; then echo "$f:1:1: bad"; status=1; fi; done; exit $status';

const LINT_CONFIG = JSON.stringify({
  stop: { lanes: { lint: { on: "**/*.ts", takes: "files", run: "checker {files}" } } },
});

type Counter = { readonly runner: Runner; readonly count: () => number };

function countingRunner(): Counter {
  let calls = 0;

  return {
    runner: (argv, options) => {
      calls += 1;

      return run(argv, options);
    },
    count: () => calls,
  };
}

function parsed(line: string | null): Record<string, unknown> {
  if (line === null) {
    throw new Error("expected a hook output, got none");
  }

  const value: unknown = JSON.parse(line);

  if (!isRecord(value)) {
    throw new Error(`hook output ${line} is not an object`);
  }

  return value;
}

function reasonOf(line: string | null): string {
  const output = parsed(line);

  expect(output["decision"]).toBe("block");

  return stringField(output, "reason") ?? "";
}

function noteOf(line: string | null): string {
  const output = parsed(line);

  expect(output["decision"]).toBeUndefined();

  return stringField(output, "systemMessage") ?? "";
}

describe("runStop", () => {
  let temp: TempRepo;
  let counter: Counter;
  let errors: Mock<typeof console.error>;

  /** A repo whose config and `.gitignore` are committed, so only the files a case writes are dirty. */
  function setUp(config: string, files: Readonly<Record<string, string>> = {}): void {
    temp = createTempRepo("agent-hooks-stop-", {
      ".gitignore": "node_modules/\n",
      [CONFIG_RELATIVE_PATH]: config,
      ...files,
    });
    fakeTool(temp.repo, "checker", BAD_CHECKER);
  }

  async function sessionStart(): Promise<void> {
    const payload = fixtureIn("claude", "session-start-startup", temp.repo, SESSION);

    expect(
      await runHook({
        hook: "session-start",
        harness: "claude",
        payload,
        handler: runSessionStart,
      }),
    ).toBeNull();
  }

  function stop(
    overrides: Record<string, unknown> = {},
    harness: Harness = "claude",
  ): Promise<string | null> {
    return runHook({
      hook: "stop",
      harness,
      payload: { ...fixtureIn("claude", "stop", temp.repo, SESSION), ...overrides },
      handler: runStop,
      runner: counter.runner,
    });
  }

  function state(): SessionState {
    return loadState(SESSION, temp.repo);
  }

  /** The repo is its own checkout: what the Stop kept of the root's lanes. */
  function record(): RootRecord {
    return rootRecord(state(), temp.repo);
  }

  beforeEach(() => {
    scrubGitEnv();
    counter = countingRunner();
    errors = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
    removeTempRepo(temp);
  });

  test("allows a plan-mode Stop without running a lane", async () => {
    setUp(LINT_CONFIG);
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    expect(await stop({ permission_mode: "plan" })).toBeNull();
    expect(counter.count()).toBe(0);
  });

  test("skips the lanes while a subagent task runs", async () => {
    setUp(LINT_CONFIG);
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    const output = await stop({
      background_tasks: [{ id: "a1", type: "subagent", status: "running", description: "work" }],
    });

    expect(noteOf(output)).toBe("agent-hooks: a subagent task is still running, lanes skipped");
    expect(counter.count()).toBe(0);
  });

  test("skips the lanes while a teammate task runs", async () => {
    setUp(LINT_CONFIG);
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    const output = await stop({
      background_tasks: [{ id: "t1", type: "teammate", status: "running", description: "work" }],
    });

    expect(noteOf(output)).toBe("agent-hooks: a teammate task is still running, lanes skipped");
    expect(counter.count()).toBe(0);
  });

  test("runs the lanes while only a shell task runs", async () => {
    setUp(LINT_CONFIG);
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    const output = await stop({
      background_tasks: [{ id: "b1", type: "shell", status: "running", description: "dev server" }],
    });

    expect(reasonOf(output)).toContain("src/new.ts");
    expect(counter.count()).toBe(1);
  });

  test("checks the whole dirty tree without a photo", async () => {
    setUp(LINT_CONFIG, { "src/old.ts": "ok\n" });
    writeRepoFile(temp.repo, "src/old.ts", "BAD\n");

    const reason = reasonOf(await stop());

    expect(reason).toContain("src/old.ts");
    expect(reason).toContain(
      `agent-hooks: no photo of ${temp.repo}, checking its whole dirty tree`,
    );
  });

  test("a checkout without a photo blocks once per failing set, whatever stop_hook_active says", async () => {
    setUp(LINT_CONFIG, { "src/old.ts": "ok\n" });
    writeRepoFile(temp.repo, "src/old.ts", "BAD\n");

    expect(reasonOf(await stop({ stop_hook_active: true }))).toContain("src/old.ts");
    expect(noteOf(await stop({ stop_hook_active: true }))).toContain("same failures");

    writeRepoFile(temp.repo, "src/other.ts", "BAD\n");

    expect(reasonOf(await stop({ stop_hook_active: true }))).toContain("src/other.ts");
    expect(noteOf(await stop())).toContain("same failures");
    expect(state().blocksInTurn).toBe(2);
  });

  test("blocks, notes the same failures, allows once fixed, then hits the green cache", async () => {
    setUp(LINT_CONFIG);
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    const reason = reasonOf(await stop());

    expect(reason).toContain("Stop validation failed:");
    expect(reason).toContain("### lint");
    expect(reason).toContain("src/new.ts");
    expect(reason).toContain("Fix the errors above before stopping.");
    expect(state().lastFailing).toEqual({ lint: ["src/new.ts"] });
    expect(state().blocksInTurn).toBe(1);
    expect(record().lastRun?.lanes).toEqual({ lint: "fail" });

    const repeated = noteOf(await stop());

    expect(repeated).toContain("same failures as the previous Stop");
    expect(repeated).toContain("### lint");
    expect(repeated).not.toContain("Fix the errors above before stopping.");

    writeRepoFile(temp.repo, "src/new.ts", "good\n");

    expect(await stop()).toBeNull();
    expect(state().lastFailing).toBeNull();
    expect(state().blocksInTurn).toBe(0);
    expect(record().lastRun?.lanes).toEqual({ lint: "ok" });
    expect(record().green["lint@."]).toBeString();

    const spawnsBefore = counter.count();

    expect(await stop()).toBeNull();
    expect(record().lastRun?.lanes).toEqual({ lint: "green" });
    expect(counter.count()).toBe(spawnsBefore);
  });

  test("a new prompt_id restarts the block counter", async () => {
    setUp(LINT_CONFIG);
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "BAD\n");
    reasonOf(await stop({ prompt_id: "p1" }));

    expect(state().blocksInTurn).toBe(1);

    writeRepoFile(temp.repo, "src/b.ts", "BAD\n");
    reasonOf(await stop({ prompt_id: "p2" }));

    expect(state().blocksInTurn).toBe(1);
    expect(state().promptId).toBe("p2");
  });

  test("a payload without prompt_id keeps the block counter", async () => {
    setUp(LINT_CONFIG);
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "BAD\n");
    reasonOf(await stop({ prompt_id: "p1" }));
    writeRepoFile(temp.repo, "src/b.ts", "BAD\n");
    reasonOf(await stop({ prompt_id: undefined }));

    expect(state().blocksInTurn).toBe(2);
    expect(state().promptId).toBe("p1");
  });

  test("an empty scope allows without a spawn and clears the failures", async () => {
    setUp(LINT_CONFIG);
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");
    reasonOf(await stop());
    rmSync(path.join(temp.repo, "src/new.ts"));
    const spawnsBefore = counter.count();

    expect(await stop()).toBeNull();
    expect(counter.count()).toBe(spawnsBefore);
    expect(state().lastFailing).toBeNull();
    expect(state().blocksInTurn).toBe(0);
  });

  describe("a session whose only change deletes a file", () => {
    const DELETION_CONFIG = JSON.stringify({
      stop: {
        fixers: { touch: { on: "**/*.ts", file: "toucher {file}" } },
        lanes: {
          types: { on: "**/*.ts", takes: "project", run: "typechecker" },
          lint: { on: "**/*.ts", takes: "files", run: "checker {files}" },
        },
      },
    });

    function setUpDeletion(): string {
      setUp(DELETION_CONFIG, { "src/util.ts": "export const util = 1;\n" });
      fakeTool(temp.repo, "typechecker", 'echo "src/main.ts:1:1: cannot find ./util"; exit 1');
      const fixed = path.join(temp.dir, "fixed.log");
      fakeTool(temp.repo, "toucher", `echo "$1" >> "${fixed}"`);

      return fixed;
    }

    test("runs the project lanes, and no files lane or fixer on the deleted file", async () => {
      const fixed = setUpDeletion();
      await sessionStart();
      rmSync(path.join(temp.repo, "src/util.ts"));

      expect(reasonOf(await stop())).toContain("cannot find ./util");
      expect(record().lastRun?.lanes).toEqual({ types: "fail", lint: "skipped" });
      expect(existsSync(fixed)).toBeFalse();
    });

    test("runs the project lanes without a photo too", async () => {
      setUpDeletion();
      rmSync(path.join(temp.repo, "src/util.ts"));

      expect(reasonOf(await stop())).toContain("cannot find ./util");
    });

    test("leaves out a file deleted before the photo", async () => {
      setUpDeletion();
      rmSync(path.join(temp.repo, "src/util.ts"));
      await sessionStart();

      expect(await stop()).toBeNull();
      expect(counter.count()).toBe(0);
    });
  });

  test("leaves out a file dirty before the photo and untouched since", async () => {
    setUp(LINT_CONFIG, { "src/old.ts": "ok\n" });
    writeRepoFile(temp.repo, "src/old.ts", "BAD\n");
    await sessionStart();
    writeRepoFile(temp.repo, "notes.md", "changed in the session\n");

    expect(await stop()).toBeNull();
    expect(record().lastRun?.lanes).toEqual({ lint: "skipped" });
    expect(counter.count()).toBe(0);
  });

  test("a lane that outlives the hook deadline ends as a lane timeout, and the others keep their result", async () => {
    setUp(
      JSON.stringify({
        stop: {
          lanes: {
            slow: { on: "**/*.ts", takes: "project", run: "sleeper", timeout: 60 },
            lint: { on: "**/*.ts", takes: "files", run: "checker {files}" },
          },
        },
      }),
    );
    fakeTool(temp.repo, "sleeper", "sleep 30");
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "fine\n");

    const output = await runHook({
      hook: "stop",
      harness: "claude",
      payload: fixtureIn("claude", "stop", temp.repo, SESSION),
      handler: runStop,
      runner: counter.runner,
      deadlineMs: 4000,
    });

    const reason = reasonOf(output);

    expect(reason).toContain("slow timed out after");
    expect(reason).not.toContain("ran past its");
    expect(record().lastRun?.lanes).toEqual({ slow: "timeout", lint: "ok" });
    expect(record().green["lint@."]).toBeString();
  });

  test("blocks on a lane whose binary is missing", async () => {
    setUp(
      JSON.stringify({
        stop: {
          lanes: { gone: { on: "**/*.ts", takes: "files", run: "no-such-tool-xyz {files}" } },
        },
      }),
    );
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "fine\n");

    expect(reasonOf(await stop())).toContain("command not found");
    expect(record().lastRun?.lanes).toEqual({ gone: "missing" });
  });

  test("a failing note lane passes with its output as a note", async () => {
    setUp(
      JSON.stringify({
        stop: {
          lanes: {
            lint: { on: "**/*.ts", takes: "files", run: "checker {files}", verdict: "note" },
          },
        },
      }),
    );
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    const note = noteOf(await stop());

    expect(note).toStartWith("Stop notes, no block:");
    expect(note).toContain("### lint");
    expect(note).toContain("src/new.ts:1:1: bad");
    expect(note).not.toContain("Fix the errors above before stopping.");
    expect(state().lastFailing).toBeNull();
    expect(record().lastRun?.lanes).toEqual({ lint: "fail" });
  });

  test("names each failing package of a pkg lane", async () => {
    setUp(
      JSON.stringify({
        stop: {
          lanes: { pkgcheck: { on: "**/*.ts", takes: "project", cwd: "pkg", run: "broken" } },
        },
      }),
      { "a/package.json": "{}\n", "b/package.json": "{}\n" },
    );
    fakeTool(temp.repo, "broken", 'echo "broken in $(pwd)"; exit 1');
    await sessionStart();
    writeRepoFile(temp.repo, "a/x.ts", "x\n");
    writeRepoFile(temp.repo, "b/y.ts", "y\n");

    const reason = reasonOf(await stop());

    expect(reason).toContain("### pkgcheck [a]");
    expect(reason).toContain("### pkgcheck [b]");
    expect(reason).toContain(`broken in ${path.join(temp.repo, "a")}`);
    expect(counter.count()).toBe(2);
  });

  test("runs the stop fixers on the real files before the lanes", async () => {
    setUp(
      JSON.stringify({
        stop: {
          fixers: { strip: { on: "**/*.ts", file: "stripper {file}" } },
          lanes: { lint: { on: "**/*.ts", takes: "files", run: "checker {files}" } },
        },
      }),
    );
    fakeTool(temp.repo, "stripper", "sed -i 's/BAD/GOOD/' \"$1\"");
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    expect(await stop()).toBeNull();
    expect(readRepoFile(temp.repo, "src/new.ts")).toBe("GOOD\n");
    expect(record().lastRun?.lanes).toEqual({ lint: "ok" });
  });

  test("leaves a file of pre-edit.exclude alone at Stop, fixers included", async () => {
    setUp(
      JSON.stringify({
        "pre-edit": { exclude: ["vendor/**"] },
        stop: {
          fixers: { strip: { on: "**/*.ts", file: "stripper {file}" } },
          lanes: {
            lint: { on: "**/*.ts", takes: "files", run: "checker {files}", verdict: "note" },
          },
        },
      }),
    );
    fakeTool(temp.repo, "stripper", "sed -i 's/BAD/GOOD/' \"$1\"");
    await sessionStart();
    writeRepoFile(temp.repo, "vendor/lib.ts", "BAD\n");
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    await stop();

    expect(readRepoFile(temp.repo, "vendor/lib.ts")).toBe("BAD\n");
    expect(readRepoFile(temp.repo, "src/new.ts")).toBe("GOOD\n");
  });

  test("keeps a file of pre-edit.exclude from the files lanes, and lets a project lane run on it", async () => {
    setUp(
      JSON.stringify({
        "pre-edit": { exclude: ["dist/**"] },
        stop: {
          lanes: {
            lint: { on: "**/*.js", takes: "files", run: "checker {files}" },
            build: { on: "**/*.js", takes: "project", run: "builder" },
          },
        },
      }),
      { "dist/bundle.js": "ok\n" },
    );
    fakeTool(temp.repo, "builder", "exit 0");
    await sessionStart();
    writeRepoFile(temp.repo, "dist/bundle.js", "BAD\n");

    expect(await stop()).toBeNull();
    expect(record().lastRun?.lanes).toEqual({ lint: "skipped", build: "ok" });
  });

  test("one Stop reads the dirty tree with a single git status", async () => {
    setUp(
      JSON.stringify({
        stop: {
          fixers: { strip: { on: "**/*.ts", file: "stripper {file}" } },
          lanes: { lint: { on: "**/*.ts", takes: "files", run: "checker {files}" } },
        },
      }),
    );
    fakeTool(temp.repo, "stripper", "sed -i 's/BAD/GOOD/' \"$1\"");
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    const realGit = Bun.which("git") ?? "git";
    const log = path.join(temp.dir, "git.log");
    writeRepoFile(temp.bin, "git", `#!/bin/sh\necho "$1" >> "${log}"\nexec "${realGit}" "$@"\n`);
    chmodSync(path.join(temp.bin, "git"), 0o755);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${temp.bin}:${savedPath ?? ""}`;

    try {
      expect(await stop()).toBeNull();
    } finally {
      process.env["PATH"] = savedPath;
    }

    const statuses = readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line === "status");

    expect(statuses).toHaveLength(1);
    expect(record().lastRun?.lanes).toEqual({ lint: "ok" });

    // The digest of the green key is the tree the fixers left: the next Stop on it hits the cache.
    expect(await stop()).toBeNull();
    expect(record().lastRun?.lanes).toEqual({ lint: "green" });
  });

  test("answers Codex with continue and takes turn_id as the prompt id", async () => {
    setUp(LINT_CONFIG);
    const sessionPayload = fixtureIn("codex", "session-start", temp.repo, SESSION);
    await runHook({
      hook: "session-start",
      harness: "codex",
      payload: sessionPayload,
      handler: runSessionStart,
    });
    const payload = fixtureIn("codex", "stop", temp.repo, SESSION);

    const output = await runHook({
      hook: "stop",
      harness: "codex",
      payload,
      handler: runStop,
      runner: counter.runner,
    });

    expect(output).toBe('{"continue":true}');
    expect(state().promptId).toBe(stringField(payload, "turn_id") ?? "");
  });
});
