/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Runner } from "./exec.ts";
import { run } from "./exec.ts";
import type { HookKind, StopHandler } from "./hook.ts";
import { encode, heartbeat, runHook, searchStarts } from "./hook.ts";
import { isRecord, stringField } from "./json.ts";
import type { Input } from "./payload.ts";
import { parseInput } from "./payload.ts";
import { runSessionStart } from "./session-start.ts";
import { beatPath, statePath } from "./state.ts";
import { runStop } from "./stop.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  fixtureNames,
  readFixture,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
} from "./test-support.ts";
import type { Verdict } from "./verdict.ts";
import { ALLOW } from "./verdict.ts";

const INVALID_CONFIG = '{ "stop": { "lanes": { "x": {} } } }';

const VALID_CONFIG =
  '{ "stop": { "lanes": { "lint": { "on": "**/*.ts", "takes": "files", "run": "checker {files}" } } } }';

type StopPayload = {
  readonly session_id: string;
  readonly cwd: string;
  readonly prompt_id: string;
};

type CountingRunner = { readonly runner: Runner; readonly count: () => number };

function countingRunner(): CountingRunner {
  let calls = 0;

  return {
    runner: (argv, options) => {
      calls += 1;

      return run(argv, options);
    },
    count: () => calls,
  };
}

function inputOf(payload: Record<string, unknown>): Input {
  const input = parseInput(payload);

  if (input === null) {
    throw new Error(`payload ${JSON.stringify(payload)} has no session_id`);
  }

  return input;
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

/** Handlers that read no context fit a root hook and the Stop alike. */
const crash = (): Promise<Verdict> => Promise.reject(new Error("boom"));

const allow = (): Promise<Verdict> => Promise.resolve(ALLOW);

const blocking: StopHandler = (context) => {
  for (const state of context.checkouts) {
    state.blocksInTurn = 1;
  }

  return Promise.resolve({ kind: "block", reason: "red" });
};

const slow = async (): Promise<Verdict> => {
  await Bun.sleep(5000);

  return ALLOW;
};

beforeEach(() => {
  scrubGitEnv();
});

describe("parseInput", () => {
  for (const harness of ["claude", "codex"] as const) {
    for (const name of fixtureNames(harness)) {
      test(`reads ${harness}/${name}`, () => {
        const fixture = readFixture(harness, name);
        const input = parseInput(fixture);

        expect(input).not.toBeNull();
        expect(input?.sessionId).toBe(stringField(fixture, "session_id") ?? "");
        expect(input?.cwd).toBe(stringField(fixture, "cwd") ?? "");
        expect(input?.promptId).toEqual(
          stringField(fixture, "prompt_id") ?? stringField(fixture, "turn_id"),
        );
      });
    }
  }

  test("takes the prompt id from turn_id under Codex", () => {
    for (const name of ["stop", "post-edit-apply-patch"]) {
      const fixture = readFixture("codex", name);

      expect(inputOf(fixture).promptId).toBe(stringField(fixture, "turn_id") ?? "");
    }
  });

  test("takes the prompt id from prompt_id at a Claude Stop", () => {
    for (const name of ["stop", "stop-active", "stop-background"]) {
      const fixture = readFixture("claude", name);

      expect(inputOf(fixture).promptId).toBe(stringField(fixture, "prompt_id") ?? "");
    }
  });

  test("reads the running subagent of stop-background", () => {
    const tasks = inputOf(readFixture("claude", "stop-background")).backgroundTasks;

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.type).toBe("subagent");
    expect(tasks[0]?.status).toBe("running");
  });

  test("returns null without a session_id", () => {
    expect(parseInput({ cwd: "/repo" })).toBeNull();
    expect(parseInput({ session_id: "", cwd: "/repo" })).toBeNull();
  });

  test("drops the background tasks that miss a field", () => {
    const input = inputOf({
      session_id: "s1",
      background_tasks: [
        { id: "a", type: "subagent", status: "running", description: "full" },
        { id: "b", type: "subagent", status: "running" },
        { type: "shell", status: "running", description: "no id" },
        "not an object",
      ],
    });

    expect(input.backgroundTasks.map((task) => task.id)).toEqual(["a"]);
  });
});

describe("searchStarts", () => {
  test("starts an edit hook at the directory of an absolute file_path", () => {
    const input = inputOf({
      session_id: "s1",
      cwd: "/repo",
      tool_input: { file_path: "/other/dir/file.ts" },
    });

    expect(searchStarts("pre-edit", input)).toEqual(["/other/dir"]);
    expect(searchStarts("post-edit", input)).toEqual(["/other/dir"]);
  });

  test("resolves a relative file_path against cwd", () => {
    const input = inputOf({
      session_id: "s1",
      cwd: "/repo",
      tool_input: { file_path: "src/file.ts" },
    });

    expect(searchStarts("pre-edit", input)).toEqual(["/repo/src"]);
    expect(searchStarts("post-edit", input)).toEqual(["/repo/src"]);
  });

  test("starts a Stop and a session start at cwd", () => {
    const input = inputOf({
      session_id: "s1",
      cwd: "/repo",
      tool_input: { file_path: "/other/dir/file.ts" },
    });

    expect(searchStarts("stop", input)).toEqual(["/repo"]);
    expect(searchStarts("session-start", input)).toEqual(["/repo"]);
  });

  test("starts a post-edit of an apply_patch at the directory of each patched file, once each", () => {
    const input = inputOf({
      session_id: "s1",
      cwd: "/repo",
      tool_input: {
        command:
          "*** Begin Patch\n*** Update File: /other/src/a.ts\n*** Add File: b.ts\n*** Delete File: c.ts\n*** End Patch",
      },
    });

    expect(searchStarts("post-edit", input)).toEqual(["/other/src", "/repo"]);
  });

  test("starts an edit hook without file_path at cwd", () => {
    expect(
      searchStarts("post-edit", inputOf({ session_id: "s1", cwd: "/repo", tool_input: {} })),
    ).toEqual(["/repo"]);
  });

  test("starts nowhere without cwd", () => {
    expect(searchStarts("stop", inputOf({ session_id: "s1" }))).toEqual([]);
    expect(searchStarts("pre-edit", inputOf({ session_id: "s1", tool_input: {} }))).toEqual([]);
  });
});

describe("encode", () => {
  const text = 'say "hi"\nnext';
  const textJson = JSON.stringify(text);
  const note: Verdict = { kind: "note", text };
  const context: Verdict = { kind: "context", text };
  const block: Verdict = { kind: "block", reason: text };

  const rewrite: Verdict = {
    kind: "rewrite",
    updatedInput: { file_path: "/r/a.ts", content: "x" },
    text,
  };

  const editHooks: readonly HookKind[] = ["session-start", "pre-edit", "post-edit"];

  test("allow", () => {
    for (const hook of [...editHooks, "stop"] as const) {
      expect(encode(ALLOW, "claude", hook)).toBeNull();
    }

    for (const hook of editHooks) {
      expect(encode(ALLOW, "codex", hook)).toBeNull();
    }

    expect(encode(ALLOW, "codex", "stop")).toBe('{"continue":true}');
  });

  test("note", () => {
    for (const hook of [...editHooks, "stop"] as const) {
      expect(encode(note, "claude", hook)).toBe(`{"systemMessage":${textJson}}`);
    }

    for (const hook of editHooks) {
      expect(encode(note, "codex", hook)).toBe(`{"systemMessage":${textJson}}`);
    }

    expect(encode(note, "codex", "stop")).toBe(`{"continue":true,"systemMessage":${textJson}}`);
  });

  test("context", () => {
    for (const harness of ["claude", "codex"] as const) {
      expect(encode(context, harness, "pre-edit")).toBe(
        `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":${textJson}}}`,
      );
      expect(encode(context, harness, "post-edit")).toBe(
        `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":${textJson}}}`,
      );
      expect(encode(context, harness, "session-start")).toBe(
        `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":${textJson}}}`,
      );
    }
  });

  test("block", () => {
    for (const harness of ["claude", "codex"] as const) {
      for (const hook of [...editHooks, "stop"] as const) {
        expect(encode(block, harness, hook)).toBe(`{"decision":"block","reason":${textJson}}`);
      }
    }
  });

  test("rewrite", () => {
    expect(encode(rewrite, "claude", "pre-edit")).toBe(
      `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"file_path":"/r/a.ts","content":"x"}},"systemMessage":${textJson}}`,
    );

    for (const hook of [...editHooks, "stop"] as const) {
      expect(encode(rewrite, "codex", hook)).toBeNull();
    }
  });
});

describe("runHook", () => {
  let temp: TempRepo;
  let errors: Mock<typeof console.error>;

  beforeEach(() => {
    temp = createTempRepo("agent-hooks-hook-");
    errors = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
    removeTempRepo(temp);
  });

  const payload = (): StopPayload => ({ session_id: "s1", cwd: temp.repo, prompt_id: "p1" });

  test("returns null and reports an empty payload", async () => {
    expect(
      await runHook({ hook: "stop", harness: "claude", payload: null, handler: allow }),
    ).toBeNull();
    expect(errors).toHaveBeenCalled();
  });

  test("returns null for a payload without session_id", async () => {
    const output = await runHook({
      hook: "stop",
      harness: "claude",
      payload: { cwd: temp.repo },
      handler: allow,
    });

    expect(output).toBeNull();
    expect(errors).toHaveBeenCalled();
  });

  test("does nothing in a root without a config", async () => {
    const counter = countingRunner();

    const output = await runHook({
      hook: "stop",
      harness: "claude",
      payload: payload(),
      handler: runStop,
      runner: counter.runner,
    });

    expect(output).toBeNull();
    expect(counter.count()).toBe(0);
    expect(existsSync(statePath("s1", temp.repo))).toBe(false);
  });

  test("blocks a Stop on an invalid config, then lets the same failure through", async () => {
    writeConfig(temp.repo, INVALID_CONFIG);

    const first = parsed(
      await runHook({ hook: "stop", harness: "claude", payload: payload(), handler: runStop }),
    );

    expect(first["decision"]).toBe("block");
    expect(stringField(first, "reason")).toContain('missing "on"');

    const second = parsed(
      await runHook({ hook: "stop", harness: "claude", payload: payload(), handler: runStop }),
    );

    expect(second["decision"]).toBeUndefined();
    expect(stringField(second, "systemMessage")).toContain('missing "on"');
  });

  test("every hook beats for its agent in the checkout around its cwd, in a root only", async () => {
    writeConfig(temp.repo, VALID_CONFIG);

    for (const hook of ["session-start", "pre-edit", "post-edit"] as const) {
      const key = `s-${hook}`;
      await runHook({
        hook,
        harness: "claude",
        payload: { ...payload(), session_id: key },
        handler: allow,
      });

      expect(existsSync(beatPath(key, temp.repo))).toBeTrue();
    }

    await runHook({
      hook: "stop",
      harness: "claude",
      payload: { ...payload(), agent_id: "a1" },
      handler: allow,
    });

    expect(existsSync(beatPath("s1.a1", temp.repo))).toBeTrue();

    fs.rmSync(path.join(temp.repo, CONFIG_RELATIVE_PATH));
    await runHook({
      hook: "pre-edit",
      harness: "claude",
      payload: { ...payload(), session_id: "s-none" },
      handler: allow,
    });

    expect(existsSync(beatPath("s-none", temp.repo))).toBeFalse();
  });

  test("a heartbeat that cannot find its checkout reports it and throws nothing", () => {
    writeConfig(temp.repo, VALID_CONFIG);
    const input = parseInput(payload());

    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error('Executable not found in $PATH: "git"');
    });

    try {
      expect(input).not.toBeNull();
      expect(() => input !== null && heartbeat(input)).not.toThrow();
    } finally {
      spawn.mockRestore();
    }

    expect(errors.mock.calls.flat().join("\n")).toContain("agent-hooks: heartbeat not saved: ");
    expect(existsSync(beatPath("s1", temp.repo))).toBeFalse();
  });

  test("notes an invalid config at session start", async () => {
    writeConfig(temp.repo, INVALID_CONFIG);

    const output = parsed(
      await runHook({
        hook: "session-start",
        harness: "claude",
        payload: payload(),
        handler: allow,
      }),
    );

    expect(Object.keys(output)).toEqual(["systemMessage"]);
    expect(stringField(output, "systemMessage")).toContain('missing "on"');
  });

  test("notes an invalid config at pre-edit", async () => {
    writeConfig(temp.repo, INVALID_CONFIG);

    const output = parsed(
      await runHook({ hook: "pre-edit", harness: "claude", payload: payload(), handler: allow }),
    );

    expect(Object.keys(output)).toEqual(["systemMessage"]);
    expect(stringField(output, "systemMessage")).toContain('missing "on"');
    expect(stringField(output, "systemMessage")).toContain(CONFIG_RELATIVE_PATH);
  });

  test("blocks a Stop when the handler crashes", async () => {
    writeConfig(temp.repo, VALID_CONFIG);

    const output = parsed(
      await runHook({ hook: "stop", harness: "claude", payload: payload(), handler: crash }),
    );

    expect(output["decision"]).toBe("block");
    expect(stringField(output, "reason")?.startsWith("agent-hooks crashed:")).toBe(true);
  });

  test.each(["pre-edit", "post-edit"] as const)(
    "allows %s when the handler crashes and reports it on stderr",
    async (hook) => {
      writeConfig(temp.repo, VALID_CONFIG);

      expect(
        await runHook({ hook, harness: "claude", payload: payload(), handler: crash }),
      ).toBeNull();
      expect(errors).toHaveBeenCalledWith("agent-hooks crashed: boom");
    },
  );

  test("a handler that runs past the deadline yields the failure verdict before the harness timeout", async () => {
    writeConfig(temp.repo, VALID_CONFIG);
    const started = Date.now();

    const output = parsed(
      await runHook({
        hook: "stop",
        harness: "claude",
        payload: payload(),
        handler: slow,
        deadlineMs: 300,
      }),
    );

    expect(Date.now() - started).toBeLessThan(2000);
    expect(output["decision"]).toBe("block");
    expect(stringField(output, "reason")).toContain("stop ran past its 300 ms deadline");
  });

  test("allows a session start when the handler crashes", async () => {
    writeConfig(temp.repo, VALID_CONFIG);

    expect(
      await runHook({
        hook: "session-start",
        harness: "claude",
        payload: payload(),
        handler: crash,
      }),
    ).toBeNull();
  });

  test("returns the verdict and reports the failure when the state cannot be saved", async () => {
    writeConfig(temp.repo, VALID_CONFIG);
    const notADirectory = path.join(temp.dir, "not-a-directory");
    writeFileSync(notADirectory, "");
    process.env["AGENT_HOOKS_STATE_DIR"] = path.join(notADirectory, "state");

    expect(
      await runHook({ hook: "stop", harness: "claude", payload: payload(), handler: blocking }),
    ).toBe('{"decision":"block","reason":"red"}');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("agent-hooks: state not saved:"));
  });

  test("a Stop reads each state file once", async () => {
    writeConfig(temp.repo, VALID_CONFIG);
    await runHook({
      hook: "session-start",
      harness: "claude",
      payload: payload(),
      handler: runSessionStart,
    });
    const reads = spyOn(fs, "readFileSync");

    try {
      await runHook({ hook: "stop", harness: "claude", payload: payload(), handler: allow });

      expect(reads.mock.calls.filter(([file]) => file === statePath("s1", temp.repo))).toHaveLength(
        1,
      );
    } finally {
      reads.mockRestore();
    }
  });

  test("an edit hook serializes no state it does not save", async () => {
    writeConfig(temp.repo, VALID_CONFIG);
    await runHook({
      hook: "session-start",
      harness: "claude",
      payload: payload(),
      handler: runSessionStart,
    });
    const serialized = spyOn(JSON, "stringify");

    try {
      await runHook({ hook: "pre-edit", harness: "claude", payload: payload(), handler: allow });

      expect(
        serialized.mock.calls.filter(([value]) => isRecord(value) && "photo" in value),
      ).toEqual([]);
    } finally {
      serialized.mockRestore();
    }
  });

  test("an edit hook that changes nothing writes no state", async () => {
    writeConfig(temp.repo, VALID_CONFIG);

    expect(
      await runHook({ hook: "pre-edit", harness: "claude", payload: payload(), handler: allow }),
    ).toBeNull();
    expect(existsSync(statePath("s1", temp.repo))).toBe(false);
  });

  test("saves the state of the session", async () => {
    writeConfig(temp.repo, VALID_CONFIG);
    fakeTool(temp.repo, "checker", "exit 0");

    expect(
      await runHook({ hook: "stop", harness: "claude", payload: payload(), handler: allow }),
    ).toBeNull();

    const file = statePath("s1", temp.repo);

    expect(existsSync(file)).toBe(true);

    const state: unknown = JSON.parse(readFileSync(file, "utf8"));

    expect(isRecord(state) ? state["sessionId"] : undefined).toBe("s1");
  });
});
