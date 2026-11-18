import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, utimesSync } from "node:fs";
import path from "node:path";

import { loadState } from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import {
  commitFiles,
  createTempRepo,
  fixtureIn,
  hookOutput,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

let temp: TempRepo;

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo({ "a.ts": "a\n" });
});

afterEach(() => {
  removeTempRepo(temp);
});

const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);

describe("session-start", () => {
  test("in a checkout without the config it prints nothing and writes no state", async () => {
    expect(
      await hookOutput("session-start", fixtureIn("session-start-startup", temp.repo)),
    ).toBeNull();
    expect(existsSync(temp.stateDir)).toBeFalse();
  });

  test("photographs the checkout around the cwd once: a resume keeps the first photo", async () => {
    writeConfig(temp.repo, "{}");
    writeRepoFile(temp.repo, "a.ts", "dirty before\n");

    expect(
      await hookOutput("session-start", fixtureIn("session-start-startup", temp.repo)),
    ).toBeNull();
    const first = loadState("s1", temp.repo).photo;
    writeRepoFile(temp.repo, "b.ts", "made during the session\n");
    await hookOutput("session-start", fixtureIn("session-start-resume", temp.repo));

    expect(first?.files).toContainKeys(["a.ts", ".claude/agent-hooks.jsonc"]);
    expect(first?.files).not.toContainKey("b.ts");
    expect(loadState("s1", temp.repo).photo).toEqual(first);
  });

  test("photographs from a subdirectory the checkout at its top", async () => {
    writeConfig(temp.repo, "{}");
    writeRepoFile(temp.repo, "pkg/x.ts", "x\n");

    await hookOutput(
      "session-start",
      fixtureIn("session-start-startup", temp.repo, { cwd: path.join(temp.repo, "pkg") }),
    );

    expect(loadState("s1", temp.repo).photo?.files).toContainKey("pkg/x.ts");
  });

  test("removes the scratch directories a killed pre-edit left, and nothing that may still be in use or is the repository's", async () => {
    writeConfig(temp.repo, "{}");
    commitFiles(temp.repo, { "src/.agent-hooks-Tr4ck3/kept.ts": "tracked\n" });

    for (const dir of [
      "src/.agent-hooks-OLD123",
      "src/.agent-hooks-NEW123",
      "src/.agent-hooks-longer-name",
    ]) {
      writeRepoFile(temp.repo, `${dir}/a.ts`, "copy\n");
    }

    for (const dir of [
      "src/.agent-hooks-OLD123",
      "src/.agent-hooks-Tr4ck3",
      "src/.agent-hooks-longer-name",
    ]) {
      utimesSync(path.join(temp.repo, dir), HOUR_AGO, HOUR_AGO);
    }

    writeRepoFile(temp.repo, "src/.agent-hooks-Tr4ck3/new.ts", "untracked\n");
    utimesSync(path.join(temp.repo, "src/.agent-hooks-Tr4ck3"), HOUR_AGO, HOUR_AGO);

    await hookOutput("session-start", fixtureIn("session-start-startup", temp.repo));

    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-OLD123"))).toBeFalse();
    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-NEW123"))).toBeTrue();
    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-Tr4ck3/new.ts"))).toBeTrue();
    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-longer-name"))).toBeTrue();
  });
});
