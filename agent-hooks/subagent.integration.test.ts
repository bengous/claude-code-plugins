/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { HookRun } from "./hook.ts";
import { runHook } from "./hook.ts";
import { isRecord, stringField } from "./json.ts";
import { runPreEdit } from "./pre-edit.ts";
import { runSessionStart } from "./session-start.ts";
import { runStop } from "./stop.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  removeTempRepo,
  scrubGitEnv,
  writeRepoFile,
} from "./test-support.ts";

const LINT_CONFIG = JSON.stringify({
  stop: { lanes: { lint: { on: "**/*.ts", takes: "files", run: "checker {files}" } } },
});

const BAD_CHECKER =
  'status=0; for f in "$@"; do if grep -q BAD "$f"; then echo "$f:1:1: bad"; status=1; fi; done; exit $status';

const HOOKS_JSON = path.join(import.meta.dir, "hooks", "hooks.json");

const SESSION_START: HookRun = { hook: "session-start", handler: runSessionStart };

const PRE_EDIT: HookRun = { hook: "pre-edit", handler: runPreEdit };

const STOP: HookRun = { hook: "stop", handler: runStop };

function hook(run: HookRun, payload: Record<string, unknown>): Promise<string | null> {
  return runHook({ ...run, harness: "claude", payload: { session_id: "s1", ...payload } });
}

function decisionOf(line: string | null): string {
  if (line === null) {
    return "allow";
  }

  const value: unknown = JSON.parse(line);

  return isRecord(value) && value["decision"] === "block" ? "block" : "note";
}

describe("a subagent's Stop", () => {
  let temp: TempRepo;
  let errors: Mock<typeof console.error>;

  beforeEach(() => {
    scrubGitEnv();
    errors = spyOn(console, "error").mockImplementation(() => {});
    temp = createTempRepo("agent-hooks-subagent-", {
      ".gitignore": "node_modules/\n",
      [CONFIG_RELATIVE_PATH]: LINT_CONFIG,
    });
    fakeTool(temp.repo, "checker", BAD_CHECKER);
  });

  afterEach(() => {
    errors.mockRestore();
    removeTempRepo(temp);
  });

  /** The Edit or Write of a subagent: its pre-edit, then the write the tool makes. */
  async function edit(agentId: string, name: string, content: string): Promise<void> {
    await hook(PRE_EDIT, {
      agent_id: agentId,
      cwd: temp.repo,
      tool_name: "Write",
      tool_input: { file_path: path.join(temp.repo, name), content },
    });
    writeRepoFile(temp.repo, name, content);
  }

  /** A SubagentStop payload: the stopping subagent is itself listed, running, in background_tasks. */
  function subagentStop(agentId: string): Promise<string | null> {
    return hook(STOP, {
      agent_id: agentId,
      agent_type: "general-purpose",
      hook_event_name: "SubagentStop",
      cwd: temp.repo,
      stop_hook_active: false,
      background_tasks: [
        { id: agentId, type: "subagent", status: "running", description: "the stopping subagent" },
      ],
    });
  }

  test("checks the files the subagent changed, although it lists itself as running", async () => {
    await hook(SESSION_START, { cwd: temp.repo });
    await edit("a1", "src/a.ts", "BAD\n");

    const output = await subagentStop("a1");

    expect(decisionOf(output)).toBe("block");
    expect(output).toContain("src/a.ts:1:1: bad");
  });

  test("two subagents of one session keep their own failing set", async () => {
    await hook(SESSION_START, { cwd: temp.repo });
    await edit("a1", "src/a.ts", "fine\n");
    await edit("a2", "src/b.ts", "fine\n");
    writeRepoFile(temp.repo, "src/a.ts", "BAD\n");

    expect(decisionOf(await subagentStop("a1"))).toBe("block");
    expect(decisionOf(await subagentStop("a2"))).toBe("block");
  });

  test("lets through a subagent that edited nothing, whatever the checkout holds", async () => {
    await hook(SESSION_START, { cwd: temp.repo });
    writeRepoFile(temp.repo, "src/main.ts", "BAD\n");

    expect(await subagentStop("a3")).toBeNull();
  });

  test("leaves the main session's own state to the main session", async () => {
    await hook(SESSION_START, { cwd: temp.repo });
    await edit("a1", "src/a.ts", "BAD\n");
    await subagentStop("a1");

    const main = await hook(STOP, { cwd: temp.repo, prompt_id: "p1" });

    expect(decisionOf(main)).toBe("block");
  });

  test("hooks.json runs the same stop on SubagentStop as on Stop", () => {
    const hooks: unknown = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
    const events = isRecord(hooks) && isRecord(hooks["hooks"]) ? hooks["hooks"] : {};

    const commandOf = (event: string): string | undefined => {
      const entries = events[event];
      const first: unknown = Array.isArray(entries) ? entries[0] : undefined;

      const inner: unknown =
        isRecord(first) && Array.isArray(first["hooks"]) ? first["hooks"][0] : undefined;

      return isRecord(inner) ? stringField(inner, "command") : undefined;
    };

    expect(commandOf("SubagentStop")).toBeString();
    expect(commandOf("SubagentStop")).toBe(commandOf("Stop"));
  });
});
