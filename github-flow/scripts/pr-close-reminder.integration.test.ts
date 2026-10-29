import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { candidateSha } from "./pr-close-reminder.ts";

const SCRIPT = join(import.meta.dir, "pr-close-reminder.ts");

let repo = "";

let integrated = "";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.cwd(cwd).quiet().nothrow();

  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.toString().trim()}`);

  return stdout.toString().trim();
}

async function runHook(payload: string): Promise<string> {
  const { stdout, exitCode } = await $`bun ${SCRIPT} < ${new Response(payload)}`.quiet().nothrow();

  expect(exitCode).toBe(0);

  return stdout.toString().trim();
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "pr-close-reminder-"));
  await git(repo, "init", "--quiet", "--initial-branch=main");
  await git(repo, "config", "user.email", "test@test.com");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await git(repo, "commit", "--quiet", "--allow-empty", "-m", "Integrate the parser (#123)");
  integrated = await git(repo, "log", "-1", "--format=%h");
  await git(repo, "commit", "--quiet", "--allow-empty", "-m", "Unrelated");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("candidateSha", () => {
  test("finds the newest commit naming the pull request, on the first ref that exists", async () => {
    expect(await candidateSha(repo, 123)).toEqual({ ref: "main", sha: integrated });
  });

  test("a number that only prefixes another one is no match", async () => {
    expect(await candidateSha(repo, 12)).toBeNull();
  });

  test("outside a repository there is no candidate", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pr-close-reminder-empty-"));

    try {
      expect(await candidateSha(empty, 123)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("the hook", () => {
  test("a gh pr close gets the reminder with its candidate SHA", async () => {
    const output = await runHook(
      JSON.stringify({ cwd: repo, tool_input: { command: "gh pr close 123" }, tool_response: {} }),
    );

    // SAFETY: the hook prints this one shape; a different one fails the expectations below.
    const parsed = JSON.parse(output) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };

    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      `Candidate: ${integrated}, the newest commit on main whose message names #123.`,
    );
  });

  test("another command, a payload without a command and invalid JSON print nothing", async () => {
    expect(
      await runHook(JSON.stringify({ cwd: repo, tool_input: { command: "git status" } })),
    ).toBe("");
    expect(await runHook(JSON.stringify({ cwd: repo, tool_input: {} }))).toBe("");
    expect(await runHook("{not json")).toBe("");
  });
});
