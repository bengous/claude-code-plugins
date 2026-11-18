import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { loadState } from "./state.ts";
import type { Json, TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  fixtureIn,
  hookOutput,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

let temp: TempRepo;

const AGENT = { agent_id: "a1", agent_type: "general-purpose", hook_event_name: "SubagentStop" };

const ITSELF_RUNNING = {
  background_tasks: [
    { id: "a1", type: "subagent", status: "running", description: "the stopping subagent" },
  ],
};

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo({ "src/clean.ts": "ok\n" });
  fakeTool(temp.repo, "lint", 'grep -Hn bad "$@" && exit 1; exit 0');
  writeConfig(
    temp.repo,
    '{ "lanes": { "lint": { "on": "**/*.ts", "takes": "files", "run": "lint {files}" } } }',
  );
});

afterEach(() => {
  removeTempRepo(temp);
});

function subagentStop(): Promise<Json | null> {
  return hookOutput("stop", fixtureIn("stop", temp.repo, { ...AGENT, ...ITSELF_RUNNING }));
}

async function subagentWrite(file: string, content: string): Promise<void> {
  await hookOutput(
    "pre-edit",
    fixtureIn("pre-edit-write", temp.repo, {
      agent_id: "a1",
      tool_input: { file_path: path.join(temp.repo, file), content },
    }),
  );
  writeRepoFile(temp.repo, file, content);
}

describe("SubagentStop", () => {
  test("a subagent that photographed nothing is let through, its parent's dirty tree unmeasured", async () => {
    writeRepoFile(temp.repo, "src/parent.ts", "bad\n");

    expect(await subagentStop()).toBeNull();
  });

  test("measures only what the subagent changed since its own photo, under its own state", async () => {
    await hookOutput("session-start", fixtureIn("session-start-startup", temp.repo));
    writeRepoFile(temp.repo, "src/parent.ts", "bad\n");
    await subagentWrite("src/mine.ts", "bad\n");

    expect(await subagentStop()).toEqual({
      decision: "block",
      reason:
        "Stop validation failed:\n\n### lint\nsrc/mine.ts:1:bad\n\nFix the errors above before stopping.",
    });
    expect(loadState("s1.a1", temp.repo).lastFailing).toEqual({ lint: ["src/mine.ts"] });
    expect(loadState("s1", temp.repo).lastFailing).toBeNull();
  });
});
