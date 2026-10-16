/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Handler, HookKind } from "./hook.ts";
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

/** A files lane named `tool` that fails on every file holding `word`. */
function laneConfig(tool: string): string {
  return JSON.stringify({
    stop: { lanes: { [tool]: { on: "**/*.ts", takes: "files", run: `${tool} {files}` } } },
  });
}

function checker(word: string): string {
  return `status=0; for f in "$@"; do if grep -q ${word} "$f"; then echo "$f:1:1: ${word}"; status=1; fi; done; exit $status`;
}

function reasonOf(line: string | null): string {
  if (line === null) {
    throw new Error("expected a block, got no output");
  }

  const value: unknown = JSON.parse(line);

  if (!isRecord(value) || value["decision"] !== "block") {
    throw new Error(`expected a block, got ${line}`);
  }

  return stringField(value, "reason") ?? "";
}

/** One state dir for every repo of a case: createTempRepo points the kit at its own. */
function shareStateDir(temp: TempRepo): void {
  process.env["AGENT_HOOKS_STATE_DIR"] = temp.stateDir;
}

function hook(
  kind: HookKind,
  handler: Handler,
  payload: Record<string, unknown>,
): Promise<string | null> {
  return runHook({
    hook: kind,
    harness: "claude",
    payload: { session_id: "s1", ...payload },
    handler,
  });
}

describe("the roots a Stop checks", () => {
  const temps: TempRepo[] = [];
  let errors: Mock<typeof console.error>;

  beforeEach(() => {
    scrubGitEnv();
    errors = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();

    for (const temp of temps.splice(0)) {
      removeTempRepo(temp);
    }
  });

  function repo(files: Readonly<Record<string, string>>): TempRepo {
    const temp = createTempRepo("agent-hooks-roots-", {
      ".gitignore": "node_modules/\n",
      ...files,
    });

    temps.push(temp);

    return temp;
  }

  async function write(cwd: string, file: string, content: string): Promise<void> {
    await hook("pre-edit", runPreEdit, {
      cwd,
      tool_name: "Write",
      tool_input: { file_path: file, content },
    });
    writeRepoFile(path.dirname(file), path.basename(file), content);
  }

  test("a nested root the session edited is checked with its own lanes", async () => {
    const outer = repo({
      [CONFIG_RELATIVE_PATH]: laneConfig("outercheck"),
      [`packages/x/${CONFIG_RELATIVE_PATH}`]: laneConfig("innercheck"),
    });

    fakeTool(outer.repo, "outercheck", checker("OUTERBAD"));
    fakeTool(path.join(outer.repo, "packages/x"), "innercheck", checker("INNERBAD"));
    await hook("session-start", runSessionStart, { cwd: outer.repo });

    await write(outer.repo, path.join(outer.repo, "packages/x/src/a.ts"), "INNERBAD\n");

    expect(reasonOf(await hook("stop", runStop, { cwd: outer.repo, prompt_id: "p1" }))).toContain(
      "### innercheck",
    );
  });

  test("a root the session edited from another root's cwd is checked at Stop", async () => {
    const home = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    const other = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    shareStateDir(home);
    fakeTool(home.repo, "checker", checker("BAD"));
    fakeTool(other.repo, "checker", checker("BAD"));
    await hook("session-start", runSessionStart, { cwd: home.repo });

    await write(home.repo, path.join(other.repo, "src/b.ts"), "BAD\n");

    const reason = reasonOf(await hook("stop", runStop, { cwd: home.repo, prompt_id: "p1" }));

    expect(reason).toContain(`${other.repo}:`);
    expect(reason).toContain("src/b.ts:1:1: BAD");
  });

  test("a Stop from a root the session never photographed checks the roots it did, not that one's whole tree", async () => {
    const home = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    const other = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker"), "src/old.ts": "ok\n" });
    shareStateDir(home);
    fakeTool(home.repo, "checker", checker("BAD"));
    fakeTool(other.repo, "checker", checker("BAD"));
    // Another session's red work, there before this session started.
    writeRepoFile(other.repo, "src/old.ts", "BAD\n");
    await hook("session-start", runSessionStart, { cwd: home.repo });

    expect(await hook("stop", runStop, { cwd: other.repo, prompt_id: "p1" })).toBeNull();
  });
});
