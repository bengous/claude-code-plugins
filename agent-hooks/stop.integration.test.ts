import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadState } from "./state.ts";
import type { Json, TempRepo } from "./test-support.ts";
import {
  commitFiles,
  createTempRepo,
  fakeTool,
  fixtureIn,
  git,
  hookOutput,
  readRepoFile,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

let temp: TempRepo;

let runs: string;

const LINT_LANE = '"lint": { "on": "**/*.ts", "takes": "files", "run": "lint {files}" }';

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo({ "src/clean.ts": "ok\n", "README.md": "# r\n" });
  runs = path.join(temp.dir, "runs");
  // Prints each line holding "bad" as `file:line:text` and fails when there is one.
  fakeTool(temp.repo, "lint", `echo "$@" >> "${runs}"; grep -Hn bad "$@" && exit 1; exit 0`);
});

afterEach(() => {
  removeTempRepo(temp);
});

function lanes(table: string, extra = ""): void {
  writeConfig(temp.repo, `{ ${extra} "lanes": { ${table} } }`);
}

function stop(fields: Readonly<Json> = {}, deadlineMs?: number): Promise<Json | null> {
  return hookOutput(
    "stop",
    fixtureIn("stop", temp.repo, fields),
    deadlineMs === undefined ? {} : { deadlineMs },
  );
}

async function sessionStart(): Promise<void> {
  await hookOutput("session-start", fixtureIn("session-start-startup", temp.repo));
}

function lintRuns(): string[] {
  return existsSync(runs) ? readFileSync(runs, "utf8").trimEnd().split("\n") : [];
}

function block(...sections: string[]): Json {
  return {
    decision: "block",
    reason: ["Stop validation failed:", ...sections, "Fix the errors above before stopping."].join(
      "\n\n",
    ),
  };
}

describe("stop: when it runs", () => {
  test("in a checkout without the config it prints nothing and writes no state", async () => {
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    expect(await stop()).toBeNull();
    expect(existsSync(temp.stateDir)).toBeFalse();
  });

  test("plan mode ends the turn in silence", async () => {
    lanes(LINT_LANE);
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    expect(await stop({ permission_mode: "plan" })).toBeNull();
    expect(lintRuns()).toEqual([]);
  });

  test("a main session still waiting on a subagent ends the turn in silence", async () => {
    lanes(LINT_LANE);
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    expect(await hookOutput("stop", fixtureIn("stop-background", temp.repo))).toBeNull();
    expect(lintRuns()).toEqual([]);
  });
});

describe("stop: the scope", () => {
  test("checks only the files changed since the session's photo", async () => {
    lanes(LINT_LANE);
    writeRepoFile(temp.repo, "src/before.ts", "bad from before\n");
    await sessionStart();
    writeRepoFile(temp.repo, "src/new.ts", "bad\n");

    expect(await stop()).toEqual(block("### lint\nsrc/new.ts:1:bad"));
    expect(lintRuns()).toEqual(["src/new.ts"]);
  });

  test("without a photo it checks the whole dirty tree, and says nothing of it", async () => {
    lanes(LINT_LANE);
    writeRepoFile(temp.repo, "src/a.ts", "fine\n");

    expect(await stop()).toBeNull();
    expect(lintRuns()).toEqual(["src/a.ts"]);

    writeRepoFile(temp.repo, "src/b.ts", "bad\n");

    expect(await stop()).toEqual(block("### lint\nsrc/b.ts:1:bad"));
  });

  test("a `files` lane is never handed an excluded file, a `project` lane still runs on its change and on a deletion", async () => {
    fakeTool(temp.repo, "proj", `echo project >> "${runs}"`);
    lanes(
      `${LINT_LANE}, "proj": { "on": "**", "takes": "project", "run": "proj" }`,
      '"exclude": ["gen/**"],',
    );
    commitFiles(temp.repo, {
      ".claude/agent-hooks.jsonc": readRepoFile(temp.repo, ".claude/agent-hooks.jsonc"),
    });
    await sessionStart();
    writeRepoFile(temp.repo, "gen/out.ts", "bad\n");

    expect(await stop()).toBeNull();
    expect(lintRuns()).toEqual(["project"]);

    rmSync(path.join(temp.repo, "gen/out.ts"));
    rmSync(path.join(temp.repo, "src/clean.ts"));

    expect(await stop()).toBeNull();
    expect(lintRuns()).toEqual(["project", "project"]);
  });

  test("a `pkg` lane runs once per package, from it, on paths relative to it", async () => {
    lanes('"lint": { "on": "**/*.ts", "takes": "files", "cwd": "pkg", "run": "lint {files}" }');
    commitFiles(temp.repo, { "packages/a/package.json": "{}", "packages/b/package.json": "{}" });
    await sessionStart();
    writeRepoFile(temp.repo, "packages/a/x.ts", "bad\n");
    writeRepoFile(temp.repo, "packages/b/y.ts", "bad\n");

    expect(await stop()).toEqual(
      block("### lint [packages/a]\nx.ts:1:bad", "### lint [packages/b]\ny.ts:1:bad"),
    );
    expect(lintRuns().toSorted()).toEqual(["x.ts", "y.ts"]);
  });

  test("a session that edits in another worktree is measured there too, its report named by it", async () => {
    lanes(LINT_LANE);
    commitFiles(temp.repo, {
      ".claude/agent-hooks.jsonc": readRepoFile(temp.repo, ".claude/agent-hooks.jsonc"),
    });
    const worktree = path.join(temp.dir, "wt");
    git(temp.repo, "worktree", "add", "-q", worktree);
    fakeTool(worktree, "lint", `echo "$@" >> "${runs}"; grep -Hn bad "$@" && exit 1; exit 0`);
    await sessionStart();
    const file = path.join(worktree, "src/w.ts");

    await hookOutput(
      "pre-edit",
      fixtureIn("pre-edit-write", temp.repo, { tool_input: { file_path: file, content: "bad\n" } }),
    );
    writeRepoFile(worktree, "src/w.ts", "bad\n");

    expect(await stop()).toEqual({
      decision: "block",
      reason: `${worktree}:\nStop validation failed:\n\n### lint\nsrc/w.ts:1:bad\n\nFix the errors above before stopping.`,
    });
  });
});

describe("stop: the Stop fixers", () => {
  test("run on the session's files with `at` stop or both, a failing one in silence", async () => {
    fakeTool(temp.repo, "tag", 'printf "$2" >> "$1"');
    fakeTool(temp.repo, "broken", "echo broken >&2; exit 3");
    writeConfig(
      temp.repo,
      `{
        "fixers": {
          "edit": { "on": "**/*.ts", "file": "tag {file} E" },
          "broken": { "on": "**/*.ts", "file": "broken {file}", "at": "stop" },
          "stop": { "on": "**/*.ts", "file": "tag {file} S", "at": "stop" },
          "both": { "on": "**/*.ts", "file": "tag {file} B", "at": "both" },
        },
      }`,
    );
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "-");

    expect(await stop()).toBeNull();
    expect(readRepoFile(temp.repo, "src/a.ts")).toBe("-SB");
    expect(readRepoFile(temp.repo, "src/clean.ts")).toBe("ok\n");
  });

  test("a stdin fixer leaves a file that changed while it ran as it found it", async () => {
    fakeTool(temp.repo, "racer", "printf 'raced\\n' > \"$1\"; tr a-z A-Z");
    writeConfig(
      temp.repo,
      '{ "fixers": { "racer": { "on": "**/*.md", "stdin": "racer {root}/{path}", "at": "stop" } } }',
    );
    await sessionStart();
    writeRepoFile(temp.repo, "README.md", "hello\n");

    expect(await stop()).toBeNull();
    expect(readRepoFile(temp.repo, "README.md")).toBe("raced\n");
  });
});

describe("stop: the green cache", () => {
  test("a lane green for this HEAD and dirty tree is not run again; a change runs it", async () => {
    lanes(LINT_LANE);
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "fine\n");

    expect(await stop()).toBeNull();
    expect(await stop()).toBeNull();
    expect(lintRuns()).toEqual(["src/a.ts"]);

    writeRepoFile(temp.repo, "src/a.ts", "still fine\n");

    expect(await stop()).toBeNull();
    expect(lintRuns()).toEqual(["src/a.ts", "src/a.ts"]);
  });
});

describe("stop: the loop guard", () => {
  test("the same failures as the previous Stop let the turn end and say so", async () => {
    lanes(LINT_LANE);
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    expect(await stop()).toEqual(block("### lint\nsrc/a.ts:1:bad"));
    expect(await stop()).toEqual({
      systemMessage:
        "agent-hooks: same failures as the previous Stop, letting the turn end\nStop validation failed:\n\n### lint\nsrc/a.ts:1:bad",
    });
  });

  test("progress blocks at most `cap` times in a row; a new prompt starts the count again", async () => {
    lanes(LINT_LANE, '"cap": 2,');
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "bad\nbad\nbad\n");

    expect((await stop())?.["decision"]).toBe("block");

    writeRepoFile(temp.repo, "src/a.ts", "bad\nbad\n");

    expect((await stop())?.["decision"]).toBe("block");

    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    expect(await stop()).toEqual({
      systemMessage:
        "agent-hooks: 2 blocks in a row, letting the turn end\nStop validation failed:\n\n### lint\nsrc/a.ts:1:bad",
    });

    writeRepoFile(temp.repo, "src/b.ts", "bad\n");

    expect((await stop({ prompt_id: "next-prompt" }))?.["decision"]).toBe("block");
  });

  test("a green Stop clears the failing set", async () => {
    lanes(LINT_LANE);
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");
    await stop();
    writeRepoFile(temp.repo, "src/a.ts", "fine\n");

    expect(await stop()).toBeNull();
    expect(loadState("s1", temp.repo).lastFailing).toBeNull();
  });
});

describe("stop: verdicts", () => {
  test("a `note` lane that fails tells the user and lets the turn end", async () => {
    lanes(
      '"lint": { "on": "**/*.ts", "takes": "files", "run": "lint {files}", "verdict": "note" }',
    );
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    expect(await stop()).toEqual({
      systemMessage: "Stop notes, no block:\n\n### lint\nsrc/a.ts:1:bad",
    });
  });

  test("a lane still running near the deadline is killed and its timeout reported", async () => {
    fakeTool(temp.repo, "slow", "sleep 30");
    lanes('"slow": { "on": "**", "takes": "project", "run": "slow" }');
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "x\n");

    const output = await stop({}, 4000);

    expect(output?.["decision"]).toBe("block");
    expect(String(output?.["reason"])).toMatch(/### slow\nslow timed out after \d+ ms/u);
  });

  test("an invalid config blocks, naming the file and the key", async () => {
    writeConfig(temp.repo, '{ "stop": {} }');

    expect(await stop()).toEqual({
      decision: "block",
      reason: `agent-hooks: ${path.join(temp.repo, ".claude/agent-hooks.jsonc")}: stop: unknown key\n\nFix the errors above before stopping.`,
    });
  });

  test("a block whose state cannot be saved lets the turn end and tells the user, report and reason", async () => {
    lanes(LINT_LANE);
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");
    const notADirectory = path.join(temp.dir, "state-file");
    writeFileSync(notADirectory, "");
    process.env["AGENT_HOOKS_STATE_DIR"] = notADirectory;

    for (let stopIndex = 0; stopIndex < 2; stopIndex += 1) {
      const output = await stop();

      expect(output?.["decision"]).toBeUndefined();
      expect(String(output?.["systemMessage"])).toMatch(
        /^agent-hooks: the state could not be saved \(.+\), so the loop guard cannot count this block: letting the turn end\nStop validation failed:\n\n### lint\nsrc\/a\.ts:1:bad\n\nFix the errors above before stopping\.$/u,
      );
    }
  });

  test("a Stop past its deadline answers under the checkout's cap, and lets the same failure through", async () => {
    lanes(LINT_LANE, '"cap": 1,');
    await sessionStart();
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    expect((await stop())?.["decision"]).toBe("block");

    const hanging = { deadlineMs: 2000, runner: () => new Promise<never>(() => {}) };

    writeRepoFile(temp.repo, "src/a.ts", "bad again\n");

    expect(await hookOutput("stop", fixtureIn("stop", temp.repo), hanging)).toEqual({
      systemMessage:
        "agent-hooks: 1 blocks in a row, letting the turn end\nagent-hooks: stop ran past its 2000 ms deadline",
    });
    expect(
      await hookOutput("stop", fixtureIn("stop", temp.repo, { prompt_id: "p2" }), hanging),
    ).toEqual({
      systemMessage:
        "agent-hooks: same failures as the previous Stop, letting the turn end\nagent-hooks: stop ran past its 2000 ms deadline",
    });
  });

  test("the brake is one per checkout: a red checkout blocks while the session's other checkout stays green", async () => {
    lanes(LINT_LANE);
    commitFiles(temp.repo, {
      ".claude/agent-hooks.jsonc": readRepoFile(temp.repo, ".claude/agent-hooks.jsonc"),
    });
    const worktree = path.join(temp.dir, "wt");
    git(temp.repo, "worktree", "add", "-q", worktree);
    fakeTool(worktree, "lint", 'grep -Hn bad "$@" && exit 1; exit 0');
    await sessionStart();
    await hookOutput(
      "pre-edit",
      fixtureIn("pre-edit-write", temp.repo, {
        tool_input: { file_path: path.join(worktree, "src/w.ts"), content: "fine\n" },
      }),
    );
    writeRepoFile(worktree, "src/w.ts", "fine\n");
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");

    expect(await stop()).toEqual(block("### lint\nsrc/a.ts:1:bad"));
    expect(loadState("s1", temp.repo).lastFailing).toEqual({ lint: ["src/a.ts"] });
    expect(loadState("s1", worktree).lastFailing).toBeNull();
    expect(loadState("s1", worktree).lastRun?.lanes).toEqual({ lint: "ok" });
  });

  test("a nested repository's files are never the parent's to measure", async () => {
    fakeTool(temp.repo, "proj", `echo project >> "${runs}"`);
    lanes(`${LINT_LANE}, "proj": { "on": "**", "takes": "project", "run": "proj" }`);
    await sessionStart();
    const nested = path.join(temp.repo, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q");
    writeRepoFile(nested, "a.ts", "bad\n");

    expect(await stop()).toBeNull();
    expect(lintRuns()).toEqual([]);
  });

  test("the kit's git reads the checkout it found, whatever GIT_DIR the session exports", async () => {
    lanes(LINT_LANE);
    writeRepoFile(temp.repo, "src/a.ts", "bad\n");
    const other = path.join(temp.dir, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    process.env["GIT_DIR"] = path.join(other, ".git");
    process.env["GIT_WORK_TREE"] = other;

    try {
      expect(await stop()).toEqual(block("### lint\nsrc/a.ts:1:bad"));
    } finally {
      delete process.env["GIT_DIR"];
      delete process.env["GIT_WORK_TREE"];
    }
  });

  test("a git that times out is a failure of its own, never an empty scope", async () => {
    lanes(LINT_LANE);
    writeRepoFile(temp.repo, "src/a.ts", "fine\n");
    const bin = path.join(temp.dir, "slow-git");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(path.join(bin, "git"), 0o755);
    const pathBefore = process.env["PATH"];
    process.env["PATH"] = `${bin}:${pathBefore ?? ""}`;

    try {
      const output = await stop({}, 4000);

      expect(output?.["decision"]).toBe("block");
      expect(String(output?.["reason"])).toStartWith(
        "agent-hooks: git status --porcelain=v1 -z -uall timed out after",
      );

      // The timeout's remaining time differs at each Stop: the same failure must still read as no progress.
      expect(String((await stop({}, 3500))?.["systemMessage"])).toStartWith(
        "agent-hooks: same failures as the previous Stop, letting the turn end\nagent-hooks: git status --porcelain=v1 -z -uall timed out after",
      );
    } finally {
      process.env["PATH"] = pathBefore;
    }
  });
});
