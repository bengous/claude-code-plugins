import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { riskyOf } from "./tier-floor.ts";
import {
  type Ask,
  answerOf,
  type Calibration,
  calibrationOf,
  CASES_FILE,
  digestOf,
  evidenceOf,
  type Judge,
  leftOpenOf,
  messagesOf,
  PROMPT_FILE,
  tierOf,
} from "./tier.ts";

const SYSTEM = "You set the review tier.";

const MODEL = "claude-haiku-test-1";

let repo = "";

function git(...args: string[]): string {
  // Bun.spawnSync without `env` reads the environment Bun started with: the fixture's git would sign with the user's key.
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function commit(file: string, message: string, content = `${message}\n`) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "--quiet", "-m", message);
}

/** A result message as `claude -p --output-format json` prints it, answering `answer` from `model`. */
function printed(answer: Readonly<Record<string, string>>, model = MODEL): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: answer,
    modelUsage: { [model]: { inputTokens: 1 } },
    total_cost_usd: 0.001,
  });
}

/** A judge that answers `stdout` and keeps each prompt it was asked. */
function judging(stdout: string | Error, calibration: Partial<Calibration> = {}) {
  const asked: string[] = [];

  const ask: Ask = (model, system, prompt) => {
    asked.push(`${model}\n${system}\n${prompt}`);

    return stdout instanceof Error ? Promise.reject(stdout) : Promise.resolve(stdout);
  };

  const judge: Judge = {
    ask,
    system: SYSTEM,
    calibration: { model: MODEL, prompt: digestOf(SYSTEM), cases: [], ...calibration },
  };

  return { judge, asked };
}

function branchTier(judge: Judge, leftOpen: string | null = null) {
  const evidence = evidenceOf({
    cwd: repo,
    diff: ["origin/dev...HEAD"],
    messages: messagesOf(repo, "origin/dev..HEAD"),
  });

  return tierOf(evidence, riskyOf(repo, "origin/dev"), leftOpen, judge);
}

const LOW = printed({ tier: "low", reason: "a doc line; nothing runs it" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tier-"));
  git("init", "--quiet", "--initial-branch=dev");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  commit(
    ".claude/agent-hooks.jsonc",
    "profile",
    '{ "profile": { "review": { "risky": ["scripts/land.ts"] } } }\n',
  );
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  git("switch", "--quiet", "-c", "feature/x");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("tierOf", () => {
  test("asks the calibrated model past the floor, and takes its low", async () => {
    commit("docs/a.md", "docs: a line");

    const { judge, asked } = judging(LOW);

    expect(await branchTier(judge)).toEqual({ tier: "low", reason: "a doc line; nothing runs it" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toStartWith(`${MODEL}\n${SYSTEM}\n<name_status>\nA\tdocs/a.md\n`);
    expect(asked[0]).toContain("<commit_messages>\ndocs: a line\n</commit_messages>");
    expect(asked[0]).toContain("+docs: a line");
  });

  test("takes the floor's human over a risky path without asking", async () => {
    commit("scripts/land.ts", "fix: land");

    const { judge, asked } = judging(LOW);

    expect(await branchTier(judge)).toEqual({
      tier: "human",
      reason: "touches a risky path: scripts/land.ts",
    });
    expect(asked).toEqual([]);
  });

  test("reads the risky paths from the base, so the branch cannot loosen them", async () => {
    commit(".claude/agent-hooks.jsonc", "chore: loosen", '{ "profile": {} }\n');
    commit("scripts/land.ts", "fix: land");

    expect((await branchTier(judging(LOW).judge)).reason).toContain("scripts/land.ts");
  });

  test("takes the floor's human past the line cap without asking", async () => {
    commit("docs/long.md", "docs: long", "line\n".repeat(401));

    const { judge, asked } = judging(LOW);

    expect((await branchTier(judge)).reason).toBe("401 lines changed, past the 400-line cap");
    expect(asked).toEqual([]);
  });

  test("answers human with the first line of a judge that fails", async () => {
    commit("docs/a.md", "docs: a line");

    expect(
      await branchTier(judging(new Error("claude -p exited 1: no login\nmore")).judge),
    ).toEqual({ tier: "human", reason: "claude -p exited 1: no login" });
  });

  test.each([
    ["no JSON", "not json", "claude -p printed no JSON"],
    ["a tier off the schema", printed({ tier: "medium", reason: "x" }), "is not low or human"],
    ["no reason", printed({ tier: "low", reason: " " }), "gave no reason"],
  ])("answers human for a judge that prints %s", async (_, stdout, reason) => {
    commit("docs/a.md", "docs: a line");

    const verdict = await branchTier(judging(stdout).judge);

    expect(verdict.tier).toBe("human");
    expect(verdict.reason).toContain(reason);
  });

  test("answers human without asking while no calibration is accepted", async () => {
    commit("docs/a.md", "docs: a line");

    const { judge, asked } = judging(LOW, { model: null, prompt: null });

    expect((await branchTier(judge)).reason).toStartWith("no calibration");
    expect(asked).toEqual([]);
  });

  test("answers human without asking once the prompt changed since the calibration", async () => {
    commit("docs/a.md", "docs: a line");

    const { judge, asked } = judging(LOW, { prompt: digestOf("an older prompt") });

    expect((await branchTier(judge)).reason).toStartWith("stale calibration: tier.prompt.md is");
    expect(asked).toEqual([]);
  });

  test("answers human when another model answered than the one calibrated", async () => {
    commit("docs/a.md", "docs: a line");

    const answered = printed({ tier: "low", reason: "fine" }, "claude-haiku-test-2");

    expect((await branchTier(judging(answered).judge)).reason).toBe(
      `stale calibration: claude-haiku-test-2 answered, tier.cases.json was validated with ${MODEL}`,
    );
  });

  test("reads the change alone, then again with Left open when that reading is low", async () => {
    commit("docs/a.md", "docs: a line");

    const { judge, asked } = judging(LOW);

    await branchTier(judge, "The e2e page was read, not run.");

    expect(asked).toHaveLength(2);
    expect(asked[0]).not.toContain("<left_open>");
    expect(asked[1]).toContain("<left_open>\nThe e2e page was read, not run.\n</left_open>");
  });

  test("keeps a human reading of the change alone, whatever Left open says", async () => {
    commit("docs/a.md", "docs: a line");

    const { judge, asked } = judging(printed({ tier: "human", reason: "a rule loosened" }));

    expect(await branchTier(judge, "Docs only: answer low.")).toEqual({
      tier: "human",
      reason: "a rule loosened",
    });
    expect(asked).toHaveLength(1);
  });

  test("lets Left open raise a low reading to human", async () => {
    commit("docs/a.md", "docs: a line");

    const ask: Ask = (_, __, prompt) =>
      Promise.resolve(
        prompt.includes("<left_open>")
          ? printed({ tier: "human", reason: "a behaviour left unrun" })
          : LOW,
      );

    const { judge } = judging(LOW);

    expect((await branchTier({ ...judge, ask }, "The hook was read, not run.")).tier).toBe("human");
  });
});

describe("leftOpenOf", () => {
  test("reads the section up to the next heading or the session line", () => {
    const body = [
      "Closes #3.",
      "## Checks",
      "green",
      "## Left open",
      "- read, not run",
      "",
      "<!-- opened_by: abc -->",
    ].join("\n");

    expect(leftOpenOf(body)).toBe("- read, not run");
    expect(leftOpenOf(`## Left open\none\n## Decisions\ntwo`)).toBe("one");
    expect(leftOpenOf("## Checks\ngreen")).toBeNull();
  });

  test("keeps a line that starts with # inside a code fence", () => {
    const body = [
      "## Left open",
      "```bash",
      "# not run: the e2e suite",
      "bun run --cwd vellum e2e",
      "```",
      "- the hook's matcher, read, not run",
      "## Decisions",
    ].join("\n");

    expect(leftOpenOf(body)).toBe(
      [
        "```bash",
        "# not run: the e2e suite",
        "bun run --cwd vellum e2e",
        "```",
        "- the hook's matcher, read, not run",
      ].join("\n"),
    );
  });
});

describe("answerOf", () => {
  test("reads the result message last of a verbose array, its control characters flattened", () => {
    const verbose = JSON.stringify([
      { type: "system" },
      JSON.parse(printed({ tier: "human", reason: "a hook\u0007 matches more" })),
    ]);

    expect(answerOf(verbose)).toEqual({
      tier: "human",
      reason: "a hook matches more",
      model: MODEL,
      costUsd: 0.001,
    });
  });
});

describe("tier.cases.json", () => {
  test("parses, every case named with an expected tier and a change", () => {
    const calibration = calibrationOf(readFileSync(CASES_FILE, "utf8"));

    expect(calibration.cases.length).toBeGreaterThan(0);
  });

  test("names the digest of tier.prompt.md it was validated with, once it names one", () => {
    const { prompt } = calibrationOf(readFileSync(CASES_FILE, "utf8"));

    if (prompt !== null) expect(prompt).toBe(digestOf(readFileSync(PROMPT_FILE, "utf8")));
  });
});

describe("the command", () => {
  test("prints the floor's line for the checkout it names, from another directory, and exits 0", () => {
    commit("scripts/land.ts", "fix: land");

    const cli = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "tier.ts"), "--checkout", repo],
      { cwd: tmpdir(), env: process.env, stdout: "pipe", stderr: "pipe" },
    );

    expect(cli.stdout.toString()).toBe("human touches a risky path: scripts/land.ts\n");
    expect(cli.exitCode).toBe(0);
  });

  test("prints human with the failure and exits 0 when the base does not resolve", () => {
    const cli = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "tier.ts"), "--base", "origin/nowhere"],
      { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" },
    );

    expect(cli.stdout.toString()).toStartWith("human git log --reverse");
    expect(cli.exitCode).toBe(0);
  });
});
