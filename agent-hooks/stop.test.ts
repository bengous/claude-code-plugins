/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Runner } from "./exec.ts";
import { run } from "./exec.ts";
import type { Harness } from "./hook.ts";
import { runHook } from "./hook.ts";
import { isRecord, stringField } from "./json.ts";
import { runSessionStart } from "./session-start.ts";
import type { SessionState } from "./state.ts";
import { loadState } from "./state.ts";
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
    expect(reason).toContain("agent-hooks: no photo for this root, checking the whole dirty tree");
  });

  test("only notes the missing photo when stop_hook_active is set", async () => {
    setUp(LINT_CONFIG, { "src/old.ts": "ok\n" });
    writeRepoFile(temp.repo, "src/old.ts", "BAD\n");

    const output = await stop({ stop_hook_active: true });

    expect(noteOf(output)).toBe(
      "agent-hooks: no photo for this root, checking the whole dirty tree",
    );
    expect(counter.count()).toBe(0);
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
    expect(state().lastRun?.lanes).toEqual({ lint: "fail" });

    const repeated = noteOf(await stop());

    expect(repeated).toContain("same failures as the previous Stop");
    expect(repeated).toContain("### lint");
    expect(repeated).not.toContain("Fix the errors above before stopping.");

    writeRepoFile(temp.repo, "src/new.ts", "good\n");

    expect(await stop()).toBeNull();
    expect(state().lastFailing).toBeNull();
    expect(state().blocksInTurn).toBe(0);
    expect(state().lastRun?.lanes).toEqual({ lint: "ok" });
    expect(state().green["lint@."]).toBeString();

    const spawnsBefore = counter.count();

    expect(await stop()).toBeNull();
    expect(state().lastRun?.lanes).toEqual({ lint: "green" });
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

  test("leaves out a file dirty before the photo and untouched since", async () => {
    setUp(LINT_CONFIG, { "src/old.ts": "ok\n" });
    writeRepoFile(temp.repo, "src/old.ts", "BAD\n");
    await sessionStart();
    writeRepoFile(temp.repo, "notes.md", "changed in the session\n");

    expect(await stop()).toBeNull();
    expect(state().lastRun?.lanes).toEqual({ lint: "skipped" });
    expect(counter.count()).toBe(0);
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
    expect(state().lastRun?.lanes).toEqual({ gone: "missing" });
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
    expect(state().lastRun?.lanes).toEqual({ lint: "fail" });
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
    expect(state().lastRun?.lanes).toEqual({ lint: "ok" });
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
