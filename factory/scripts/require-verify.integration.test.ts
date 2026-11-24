import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAtomicSync } from "../lib/platform/fs.ts";
import { run } from "../lib/platform/process.ts";
import { render } from "./render.ts";
import { readTemplates } from "./templates.ts";

const HOOK = "repo/.claude/hooks/require-verify.sh";

/** What git exports to a hook it runs, which would send these commands to the repository under test's caller. */
const NO_GIT_ENV = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };

const VERIFY = JSON.stringify({ tool_name: "Skill", tool_input: { skill: "verify" } });

let repo = "";

let script = "";

async function git(...args: string[]): Promise<string> {
  const result = await run(["git", ...args], { cwd: repo, env: NO_GIT_ENV });

  if (result.kind !== "exited" || result.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${JSON.stringify(result)}`);
  }

  return result.stdout.trim();
}

interface HookRun {
  readonly code: number;
  readonly stderr: string;
}

async function hook(mode: string, input = "{}", remote: string | null = "true"): Promise<HookRun> {
  const result = await run(["bash", script, mode], {
    cwd: repo,
    env: { ...NO_GIT_ENV, CLAUDE_CODE_REMOTE: remote ?? undefined },
    stdin: input,
  });

  if (result.kind !== "exited") throw new Error(`the hook did not exit: ${JSON.stringify(result)}`);

  return { code: result.code, stderr: result.stderr.trim() };
}

function edit(path: string, content: string): void {
  writeAtomicSync(join(repo, path), content, { mkdir: true });
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "factory-verify-"));

  const rendered = render(
    readTemplates().filter(({ path }) => path === HOOK),
    {},
  );

  if (rendered.kind !== "rendered") throw new Error(rendered.errors.join("; "));

  script = join(repo, "..", `${repo.split("/").at(-1) ?? "hook"}.sh`);
  writeAtomicSync(script, rendered.files[0]?.content ?? "");

  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.email", "test@test.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  edit("src/cli.ts", "export {};\n");
  edit(".gitignore", "dist/\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "base");
  await git("switch", "--quiet", "-c", "work");
  await hook("start");
});

/** Puts the clone back to what it is before a session's SessionStart hook ran. */
function forgetStart(): void {
  rmSync(join(repo, ".git/factory-verify/start"), { force: true });
}

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(script, { force: true });
});

const SENT_BACK = "The working tree changed since the verify skill last ran.";

describe("require-verify.sh stop", () => {
  test("lets a session end that changed nothing since it started", async () => {
    expect(await hook("stop")).toEqual({ code: 0, stderr: "" });

    edit("dist/out.js", "ignored\n");

    expect((await hook("stop")).code).toBe(0);
  });

  test("sends back a session that edited a file and did not verify", async () => {
    edit("src/cli.ts", "export const a = 1;\n");

    const stopped = await hook("stop");

    expect(stopped.code).toBe(2);
    expect(stopped.stderr).toContain(SENT_BACK);
    expect(stopped.stderr).toContain("Checks");
  });

  test("lets it end once verify ran on that tree, a commit of it included", async () => {
    edit("src/cli.ts", "export const a = 1;\n");
    edit("src/new.ts", "export const b = 2;\n");

    expect((await hook("record", VERIFY)).code).toBe(0);
    expect(await hook("stop")).toEqual({ code: 0, stderr: "" });

    await git("add", ".");
    await git("commit", "--quiet", "-m", "change");

    expect(await hook("stop")).toEqual({ code: 0, stderr: "" });
  });

  test("sends it back when it edits again after verify, a committed edit included", async () => {
    edit("src/cli.ts", "export const a = 1;\n");
    await hook("record", VERIFY);
    edit("src/cli.ts", "export const a = 2;\n");

    expect((await hook("stop")).code).toBe(2);

    await git("commit", "--quiet", "--all", "-m", "change");

    expect((await hook("stop")).code).toBe(2);
  });

  test("sends it back twice in a row at most, then lets it end, and counts again after", async () => {
    edit("src/cli.ts", "export const a = 1;\n");

    expect((await hook("stop")).code).toBe(2);
    expect((await hook("stop")).code).toBe(2);
    expect((await hook("stop")).code).toBe(0);
    expect((await hook("stop")).code).toBe(2);
  });

  test("a verify between two stops starts the count again", async () => {
    edit("src/cli.ts", "export const a = 1;\n");

    expect((await hook("stop")).code).toBe(2);

    await hook("record", VERIFY);
    edit("src/cli.ts", "export const a = 2;\n");

    expect((await hook("stop")).code).toBe(2);
    expect((await hook("stop")).code).toBe(2);
    expect((await hook("stop")).code).toBe(0);
  });

  test("lets a session end that started on a branch holding commits and changed nothing", async () => {
    forgetStart();
    edit("src/cli.ts", "export const a = 1;\n");
    await git("commit", "--quiet", "--all", "-m", "another session's change");
    await hook("start");

    expect(await hook("stop")).toEqual({ code: 0, stderr: "" });

    edit("src/cli.ts", "export const a = 2;\n");

    expect((await hook("stop")).code).toBe(2);
  });

  test("keeps the clone's first start: a resume or a compaction after an edit records nothing", async () => {
    edit("src/cli.ts", "export const a = 1;\n");
    await hook("start");

    expect((await hook("stop")).code).toBe(2);
  });

  test("counts the tree as changed where no start was recorded, an untouched tree included", async () => {
    forgetStart();

    expect((await hook("stop")).code).toBe(2);

    await hook("record", VERIFY);

    expect((await hook("stop")).code).toBe(0);
  });

  test("leaves a session outside the cloud alone", async () => {
    edit("src/cli.ts", "export const a = 1;\n");

    expect(await hook("stop", "{}", null)).toEqual({ code: 0, stderr: "" });
    expect(await hook("stop", "{}", "false")).toEqual({ code: 0, stderr: "" });
  });
});

describe("require-verify.sh start", () => {
  test("records nothing outside the cloud", async () => {
    forgetStart();
    await hook("start", "{}", null);

    expect((await hook("stop")).code).toBe(2);
  });

  test("leaves the working tree and the index as they were", async () => {
    forgetStart();
    edit("src/new.ts", "export const b = 2;\n");

    const before = await git("status", "--porcelain");

    await hook("start");

    expect(await git("status", "--porcelain")).toBe(before);
  });
});

describe("require-verify.sh record", () => {
  test("records only when the skill that ran is verify", async () => {
    edit("src/cli.ts", "export const a = 1;\n");

    await hook("record", JSON.stringify({ tool_name: "Skill", tool_input: { skill: "simplify" } }));

    expect((await hook("stop")).code).toBe(2);
  });

  test("records nothing outside the cloud", async () => {
    edit("src/cli.ts", "export const a = 1;\n");

    await hook("record", VERIFY, null);

    expect((await hook("stop")).code).toBe(2);
  });

  test("leaves the working tree and the index as they were", async () => {
    edit("src/cli.ts", "export const a = 1;\n");
    edit("src/new.ts", "export const b = 2;\n");

    const before = await git("status", "--porcelain");

    await hook("record", VERIFY);
    await hook("stop");

    expect(await git("status", "--porcelain")).toBe(before);
  });
});
