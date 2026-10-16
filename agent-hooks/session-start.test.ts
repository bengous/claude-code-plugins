import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, utimesSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { DEADLINES_MS, runHook } from "./hook.ts";
import { runSessionStart } from "./session-start.ts";
import { loadState } from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import { createTempRepo, removeTempRepo, scrubGitEnv, writeRepoFile } from "./test-support.ts";

describe("runSessionStart", () => {
  let temp: TempRepo;

  beforeEach(() => {
    scrubGitEnv();
    temp = createTempRepo("agent-hooks-session-start-", { [CONFIG_RELATIVE_PATH]: "{}" });
  });

  afterEach(() => {
    removeTempRepo(temp);
  });

  /** A scratch dir a pre-edit made `ageMs` ago, with its copy inside. */
  function scratch(name: string, ageMs: number): string {
    writeRepoFile(temp.repo, `src/${name}/a.ts`, "copy\n");
    const dir = path.join(temp.repo, "src", name);
    const at = new Date(Date.now() - ageMs);
    utimesSync(dir, at, at);

    return dir;
  }

  test("removes the scratch dirs older than the pre-edit deadline, keeps a live one, photographs neither", async () => {
    const stale = scratch(".agent-hooks-old123", DEADLINES_MS["pre-edit"] + 60_000);
    const live = scratch(".agent-hooks-new456", 0);

    await runHook({
      hook: "session-start",
      harness: "claude",
      payload: { session_id: "s1", cwd: temp.repo },
      handler: runSessionStart,
    });

    expect(existsSync(stale)).toBeFalse();
    expect(existsSync(live)).toBeTrue();
    expect(loadState("s1", temp.repo).photo?.files).toEqual({});
  });
});
