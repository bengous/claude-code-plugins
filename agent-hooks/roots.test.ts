/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { Harness, HookRun } from "./hook.ts";
import { runHook } from "./hook.ts";
import { isRecord, stringField } from "./json.ts";
import { runPostEdit, runPreEdit } from "./pre-edit.ts";
import { runSessionStart } from "./session-start.ts";
import { statePath } from "./state.ts";
import { runStop } from "./stop.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  readRepoFile,
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

const SESSION_START: HookRun = { hook: "session-start", handler: runSessionStart };

const PRE_EDIT: HookRun = { hook: "pre-edit", handler: runPreEdit };

const POST_EDIT: HookRun = { hook: "post-edit", handler: runPostEdit };

const STOP: HookRun = { hook: "stop", handler: runStop };

function hook(
  run: HookRun,
  payload: Record<string, unknown>,
  harness: Harness = "claude",
): Promise<string | null> {
  return runHook({ ...run, harness, payload: { session_id: "s1", ...payload } });
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
    await hook(PRE_EDIT, {
      cwd,
      tool_name: "Write",
      tool_input: { file_path: file, content },
    });
    writeRepoFile(path.dirname(file), path.basename(file), content);
  }

  function nestedRepo(): TempRepo {
    const outer = repo({
      [CONFIG_RELATIVE_PATH]: laneConfig("outercheck"),
      [`packages/x/${CONFIG_RELATIVE_PATH}`]: laneConfig("innercheck"),
    });

    fakeTool(outer.repo, "outercheck", checker("OUTERBAD"));
    fakeTool(path.join(outer.repo, "packages/x"), "innercheck", checker("INNERBAD"));

    return outer;
  }

  test("a nested root the session edited is checked with its own lanes, and the outer lanes leave its files alone", async () => {
    const outer = nestedRepo();
    await hook(SESSION_START, { cwd: outer.repo });

    // Content both lanes would refuse: only the owner's may run on it.
    await write(outer.repo, path.join(outer.repo, "packages/x/src/a.ts"), "INNERBAD OUTERBAD\n");

    const reason = reasonOf(await hook(STOP, { cwd: outer.repo, prompt_id: "p1" }));

    expect(reason).toContain("### innercheck");
    expect(reason).not.toContain("### outercheck");
  });

  test("a file Bash wrote in a nested root is checked by that root alone, no photo of its own needed", async () => {
    const outer = nestedRepo();
    await hook(SESSION_START, { cwd: outer.repo });
    writeRepoFile(outer.repo, "packages/x/src/b.ts", "INNERBAD OUTERBAD\n");

    const reason = reasonOf(await hook(STOP, { cwd: outer.repo, prompt_id: "p1" }));

    expect(reason).toContain("### innercheck");
    expect(reason).not.toContain("### outercheck");
  });

  test("a file broken after a first block is checked by the nested root around the cwd", async () => {
    const outer = nestedRepo();
    await hook(SESSION_START, { cwd: outer.repo });
    writeRepoFile(outer.repo, "src/r.ts", "OUTERBAD\n");

    expect(reasonOf(await hook(STOP, { cwd: outer.repo, prompt_id: "p1" }))).toContain(
      "### outercheck",
    );

    // The agent fixes the outer file, then Bash, with the cwd moved into the nested root, writes a bad file there:
    // the second Stop of the turn carries stop_hook_active, which must brake nothing by itself.
    writeRepoFile(outer.repo, "src/r.ts", "fine\n");
    writeRepoFile(outer.repo, "packages/x/src/a.ts", "INNERBAD\n");

    const reason = reasonOf(
      await hook(STOP, {
        cwd: path.join(outer.repo, "packages/x"),
        prompt_id: "p1",
        stop_hook_active: true,
      }),
    );

    expect(reason).toContain("### innercheck");
    expect(reason).toContain("src/a.ts:1:1: INNERBAD");
  });

  test("a dirt the session's photo covers never blocks, wherever the cwd stands at Stop", async () => {
    const outer = nestedRepo();
    writeRepoFile(outer.repo, "packages/x/src/wip.ts", "INNERBAD OUTERBAD\n");
    await hook(SESSION_START, { cwd: outer.repo });
    await write(outer.repo, path.join(outer.repo, "src/r.ts"), "fine\n");

    expect(
      await hook(STOP, { cwd: path.join(outer.repo, "packages/x"), prompt_id: "p1" }),
    ).toBeNull();
  });

  test("with three nested roots, a file is checked by its nearest root alone", async () => {
    const outer = nestedRepo();
    const sub = path.join(outer.repo, "packages/x/sub");
    writeRepoFile(sub, CONFIG_RELATIVE_PATH, laneConfig("subcheck"));
    fakeTool(sub, "subcheck", checker("SUBBAD"));
    await hook(SESSION_START, { cwd: outer.repo });
    await write(outer.repo, path.join(outer.repo, "packages/x/src/a.ts"), "fine\n");

    // Bash writes a file every checker would refuse: only the nearest root's may see it.
    writeRepoFile(outer.repo, "packages/x/sub/src/m.ts", "SUBBAD INNERBAD OUTERBAD\n");

    const reason = reasonOf(await hook(STOP, { cwd: outer.repo, prompt_id: "p1" }));

    expect(reason).toContain("### subcheck");
    expect(reason).toContain("src/m.ts:1:1: SUBBAD");
    expect(reason).not.toContain("### innercheck");
    expect(reason).not.toContain("### outercheck");
  });

  test("the first apply_patch of a checkout photographs it with the patched files as changed", async () => {
    const home = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    const other = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker"), "src/old.ts": "ok\n" });
    shareStateDir(home);
    fakeTool(other.repo, "checker", checker("BAD"));
    writeRepoFile(other.repo, "src/wip.ts", "BAD\n");
    await hook(SESSION_START, { cwd: home.repo }, "codex");

    // Codex's hook runs after the patch: the file already holds its new content when the photo is taken.
    const patched = path.join(other.repo, "src/old.ts");
    writeRepoFile(other.repo, "src/old.ts", "BAD\n");
    await hook(
      POST_EDIT,
      {
        cwd: home.repo,
        tool_name: "apply_patch",
        tool_input: {
          command: `*** Begin Patch\n*** Update File: ${patched}\n@@\n-ok\n+BAD\n*** End Patch`,
        },
      },
      "codex",
    );

    const reason = reasonOf(await hook(STOP, { cwd: home.repo, turn_id: "t1" }, "codex"));

    expect(reason).toContain("src/old.ts:1:1: BAD");
    expect(reason).not.toContain("src/wip.ts");
  });

  test("a root the session edited from another root's cwd is checked at Stop", async () => {
    const home = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    const other = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    shareStateDir(home);
    fakeTool(home.repo, "checker", checker("BAD"));
    fakeTool(other.repo, "checker", checker("BAD"));
    await hook(SESSION_START, { cwd: home.repo });

    await write(home.repo, path.join(other.repo, "src/b.ts"), "BAD\n");

    const reason = reasonOf(await hook(STOP, { cwd: home.repo, prompt_id: "p1" }));

    expect(reason).toContain(`${other.repo}:`);
    expect(reason).toContain("src/b.ts:1:1: BAD");
  });

  test("a Stop checks its cwd's root too, over its whole dirty tree when the session never photographed it", async () => {
    const home = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    const other = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker"), "src/old.ts": "ok\n" });
    shareStateDir(home);
    fakeTool(home.repo, "checker", checker("BAD"));
    fakeTool(other.repo, "checker", checker("BAD"));
    await hook(SESSION_START, { cwd: home.repo });
    // A change no Edit or Write photographed: Bash, or a Codex patch.
    writeRepoFile(other.repo, "src/old.ts", "BAD\n");

    const reason = reasonOf(await hook(STOP, { cwd: other.repo, prompt_id: "p1" }));

    expect(reason).toContain("src/old.ts:1:1: BAD");
    expect(reason).toContain(`no photo of ${other.repo}, checking its whole dirty tree`);
  });

  test("a former cwd checkout without a photo is left alone once the cwd moved away", async () => {
    const home = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    const other = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker"), "src/old.ts": "ok\n" });
    shareStateDir(home);
    fakeTool(home.repo, "checker", checker("BAD"));
    fakeTool(other.repo, "checker", checker("BAD"));
    await hook(SESSION_START, { cwd: home.repo });

    // A Stop from a checkout never photographed saves its state without a photo.
    expect(await hook(STOP, { cwd: other.repo, prompt_id: "p1" })).toContain("no photo of");

    // Another session breaks a file there while this session's cwd is back home: not this agent's change.
    writeRepoFile(other.repo, "src/old.ts", "BAD\n");

    expect(await hook(STOP, { cwd: home.repo, prompt_id: "p1" })).toBeNull();
  });

  test("an apply_patch spanning two checkouts photographs each, the fixers under each file's root", async () => {
    const home = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker"), "src/h.ts": "ok\n" });

    const other = repo({
      [CONFIG_RELATIVE_PATH]: JSON.stringify({
        "pre-edit": { fixers: { mark: { on: "**/*.ts", file: "marker {file}" } } },
        stop: { lanes: { checker: { on: "**/*.ts", takes: "files", run: "checker {files}" } } },
      }),
      "src/o.ts": "ok\n",
    });

    shareStateDir(home);
    fakeTool(home.repo, "checker", checker("BAD"));
    fakeTool(other.repo, "checker", checker("BAD"));
    fakeTool(other.repo, "marker", 'echo "// marked" >> "$1"');
    await hook(SESSION_START, { cwd: home.repo }, "codex");
    writeRepoFile(home.repo, "src/h.ts", "BAD\n");
    writeRepoFile(other.repo, "src/o.ts", "BAD\n");

    const patch = [
      "*** Begin Patch",
      `*** Update File: ${path.join(home.repo, "src/h.ts")}`,
      `*** Update File: ${path.join(other.repo, "src/o.ts")}`,
      "*** End Patch",
    ].join("\n");

    await hook(
      POST_EDIT,
      { cwd: home.repo, tool_name: "apply_patch", tool_input: { command: patch } },
      "codex",
    );

    expect(readRepoFile(other.repo, "src/o.ts")).toBe("BAD\n// marked\n");
    expect(readRepoFile(home.repo, "src/h.ts")).toBe("BAD\n");

    const reason = reasonOf(await hook(STOP, { cwd: home.repo, turn_id: "t1" }, "codex"));

    expect(reason).toContain("src/h.ts:1:1: BAD");
    expect(reason).toContain(`${other.repo}:`);
    expect(reason).toContain("src/o.ts:1:1: BAD");
  });

  test("a path through a symlink names the file git names: a patch through it is checked, the cwd root unlabelled", async () => {
    const home = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker") });
    const other = repo({ [CONFIG_RELATIVE_PATH]: laneConfig("checker"), "src/old.ts": "ok\n" });
    shareStateDir(home);
    fakeTool(other.repo, "checker", checker("BAD"));
    const link = path.join(other.dir, "link");
    symlinkSync(other.repo, link);
    await hook(SESSION_START, { cwd: home.repo }, "codex");
    writeRepoFile(other.repo, "src/old.ts", "BAD\n");

    await hook(
      POST_EDIT,
      {
        cwd: home.repo,
        tool_name: "apply_patch",
        tool_input: {
          command: `*** Begin Patch\n*** Update File: ${path.join(link, "src/old.ts")}\n*** End Patch`,
        },
      },
      "codex",
    );

    const reason = reasonOf(await hook(STOP, { cwd: link, turn_id: "t1" }, "codex"));

    expect(reason).toContain("src/old.ts:1:1: BAD");
    expect(reason).not.toContain(`${other.repo}:`);
  });

  test("with no root around the cwd, SessionStart photographs nothing and a nested root waits for its first edit", async () => {
    const top = repo({ [`packages/x/${CONFIG_RELATIVE_PATH}`]: laneConfig("innercheck") });
    fakeTool(path.join(top.repo, "packages/x"), "innercheck", checker("INNERBAD"));

    expect(await hook(SESSION_START, { cwd: top.repo })).toBeNull();
    expect(existsSync(statePath("s1", top.repo))).toBeFalse();

    // Bash alone under the nested root, with no root around the cwd: the kit's ceiling, unchecked.
    writeRepoFile(top.repo, "packages/x/src/a.ts", "INNERBAD\n");

    expect(await hook(STOP, { cwd: top.repo, prompt_id: "p1" })).toBeNull();

    // The first Edit under the nested root photographs the checkout: what changes from there is checked.
    await write(top.repo, path.join(top.repo, "packages/x/src/b.ts"), "fine\n");
    writeRepoFile(top.repo, "packages/x/src/b.ts", "INNERBAD\n");

    const reason = reasonOf(await hook(STOP, { cwd: top.repo, prompt_id: "p1" }));

    expect(reason).toContain("src/b.ts:1:1: INNERBAD");
    expect(reason).not.toContain("src/a.ts");
  });
});
