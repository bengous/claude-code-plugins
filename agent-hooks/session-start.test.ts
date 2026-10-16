import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, utimesSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { DEADLINES_MS, runHook } from "./hook.ts";
import { runSessionStart } from "./session-start.ts";
import { loadState } from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  readRepoFile,
  removeTempRepo,
  scrubGitEnv,
  writeRepoFile,
} from "./test-support.ts";

const STALE_MS = DEADLINES_MS["pre-edit"] + 60_000;

describe("runSessionStart", () => {
  let temp: TempRepo;

  beforeEach(() => {
    scrubGitEnv();
    temp = createTempRepo("agent-hooks-session-start-", {
      [CONFIG_RELATIVE_PATH]: "{}",
      ".agent-hooks-data/keep.ts": "v1\n",
      "src/.agent-hooks-abcdef/tracked.ts": "tracked\n",
    });
  });

  afterEach(() => {
    removeTempRepo(temp);
  });

  /** Sets the last change of `relativePath` to `ageMs` ago. */
  function age(relativePath: string, ageMs: number): string {
    const target = path.join(temp.repo, relativePath);
    const at = new Date(Date.now() - ageMs);
    utimesSync(target, at, at);

    return target;
  }

  /** A scratch dir a pre-edit made `ageMs` ago, with its copy inside. */
  function scratch(name: string, ageMs: number): string {
    writeRepoFile(temp.repo, `src/${name}/a.ts`, "copy\n");

    return age(`src/${name}`, ageMs);
  }

  function sessionStart(): Promise<string | null> {
    return runHook({
      hook: "session-start",
      harness: "claude",
      payload: { session_id: "s1", cwd: temp.repo },
      handler: runSessionStart,
    });
  }

  test("removes the scratch dirs older than the pre-edit deadline, keeps a live one, photographs neither", async () => {
    const stale = scratch(".agent-hooks-old123", STALE_MS);
    const live = scratch(".agent-hooks-new456", 0);

    await sessionStart();

    expect(existsSync(stale)).toBeFalse();
    expect(existsSync(live)).toBeTrue();
    expect(loadState("s1", temp.repo).photo?.files).toEqual({});
  });

  test("removes only an untracked directory named as a pre-edit scratch dir", async () => {
    writeRepoFile(temp.repo, ".agent-hooks-data/keep.ts", "v2\n");
    age(".agent-hooks-data", STALE_MS);
    writeRepoFile(temp.repo, ".claude/.agent-hooks-backup.jsonc", "{}\n");
    age(".claude/.agent-hooks-backup.jsonc", STALE_MS);
    const shortSuffix = scratch(".agent-hooks-x1", STALE_MS);
    writeRepoFile(temp.repo, "src/.agent-hooks-abcdef/untracked.ts", "u\n");
    age("src/.agent-hooks-abcdef", STALE_MS);
    const stale = scratch(".agent-hooks-abc123", STALE_MS);

    await sessionStart();

    expect(readRepoFile(temp.repo, ".agent-hooks-data/keep.ts")).toBe("v2\n");
    expect(existsSync(path.join(temp.repo, ".claude/.agent-hooks-backup.jsonc"))).toBeTrue();
    expect(existsSync(shortSuffix)).toBeTrue();
    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-abcdef/tracked.ts"))).toBeTrue();
    expect(existsSync(stale)).toBeFalse();
  });
});
