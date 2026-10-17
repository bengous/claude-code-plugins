import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, utimesSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { DEADLINES_MS, runHook } from "./hook.ts";
import { runSessionEnd, runSessionStart } from "./session-start.ts";
import { beat, beatPath, freshState, loadState, saveState } from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  readRepoFile,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
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

const MINUTE_MS = 60_000;

/** The heartbeat of agent `key` in `dir`, last refreshed `ageMs` ago. */
function beatAgo(key: string, dir: string, ageMs: number): void {
  beat(key, dir);
  const at = new Date(Date.now() - ageMs);
  utimesSync(beatPath(key, dir), at, at);
}

function worktreeNote(dir: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `agent-hooks: another session ran a hook in ${dir} in the last 15 minutes, and this repository takes one worktree per task: do this task in a worktree of its own (EnterWorktree, or git worktree add), not in this checkout.`,
    },
  });
}

describe("runSessionStart under profile.worktree", () => {
  let temp: TempRepo;
  let checkout: string;

  beforeEach(() => {
    scrubGitEnv();
    temp = createTempRepo("agent-hooks-worktree-", {
      [CONFIG_RELATIVE_PATH]: `{ "profile": { "worktree": "per-task" } }`,
    });
    checkout = realpathSync(temp.repo);
  });

  afterEach(() => {
    removeTempRepo(temp);
  });

  function sessionStart(source = "startup", sessionId = "s1"): Promise<string | null> {
    return runHook({
      hook: "session-start",
      harness: "claude",
      payload: { session_id: sessionId, cwd: temp.repo, source },
      handler: runSessionStart,
    });
  }

  test("per-task, another session beat in the checkout within the window: a note naming the checkout", async () => {
    beatAgo("s2", checkout, 14 * MINUTE_MS);

    expect(await sessionStart()).toBe(worktreeNote(checkout));
  });

  test("another session's subagent counts as another session", async () => {
    beatAgo("s2.a1", checkout, MINUTE_MS);

    expect(await sessionStart()).toBe(worktreeNote(checkout));
  });

  test("a beat past the window is a session gone: no note", async () => {
    beatAgo("s2", checkout, 16 * MINUTE_MS);

    expect(await sessionStart()).toBeNull();
  });

  test("a state file without a beat is no live session", async () => {
    saveState(freshState("s2", checkout));

    expect(await sessionStart()).toBeNull();
  });

  test("only a session that starts, from scratch or after /clear, is told: never one resumed, compacted or forked mid-task", async () => {
    beatAgo("s2", checkout, MINUTE_MS);

    expect(await sessionStart("clear")).toBe(worktreeNote(checkout));

    for (const source of ["resume", "compact", "fork"]) {
      expect(await sessionStart(source)).toBeNull();
    }
  });

  test("the session's own beats and its own subagents' never count", async () => {
    beatAgo("s1", checkout, MINUTE_MS);
    beatAgo("s1.a1", checkout, MINUTE_MS);

    expect(await sessionStart()).toBeNull();
  });

  test("a session that ended took its beats along: the one /clear starts after it is not told", async () => {
    await sessionStart("startup", "s2");
    runSessionEnd({ session_id: "s2", cwd: temp.repo, reason: "clear" });

    expect(await sessionStart("clear", "s3")).toBeNull();
  });

  test("another session's beat in another checkout: no note", async () => {
    beatAgo("s2", path.join(temp.dir, "other"), MINUTE_MS);

    expect(await sessionStart()).toBeNull();
  });

  test("a shared checkout, declared or by default, takes no note", async () => {
    beatAgo("s2", checkout, MINUTE_MS);

    for (const config of [`{ "profile": { "worktree": "shared" } }`, "{}"]) {
      writeConfig(temp.repo, config);

      expect(await sessionStart()).toBeNull();
    }
  });

  test("an invalid worktree value is a note to the user at SessionStart, naming the key", async () => {
    writeConfig(temp.repo, `{ "profile": { "worktree": "each" } }`);

    expect(await sessionStart()).toBe(
      JSON.stringify({
        systemMessage: `agent-hooks: ${path.join(checkout, CONFIG_RELATIVE_PATH)}: profile.worktree: expected per-task|shared`,
      }),
    );
  });

  test("the photo is taken as without the note", async () => {
    beatAgo("s2", checkout, MINUTE_MS);
    writeRepoFile(temp.repo, "dirty.ts", "x\n");

    await sessionStart();

    expect(Object.keys(loadState("s1", checkout).photo?.files ?? {})).toEqual(["dirty.ts"]);
  });
});
