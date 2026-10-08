import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stubbedEnv, write } from "./claude-code-types.fixture.ts";
import {
  headerVersion,
  installedVersion,
  needsRun,
  type Outcome,
  promptFor,
  ROLLING_BRANCH,
  runState,
  statePaths,
  TOOLS_TYPES_PATH,
  TYPES_PATH,
} from "./claude-code-types.ts";
import { holdLock } from "./lib/flock.fixture.ts";

const SCRIPT = join(import.meta.dir, "claude-code-types.ts");

describe("headerVersion", () => {
  test("reads the version from the generated header", () => {
    expect(headerVersion("// Written by Claude Code 2.1.278.")).toBe("2.1.278");
  });

  test("refuses a first line that is not the header", () => {
    expect(() => headerVersion("// Claude Code function hooks")).toThrow(TYPES_PATH);
  });
});

describe("installedVersion", () => {
  test("reads the version from `claude --version`", () => {
    expect(installedVersion("2.1.278 (Claude Code)\n")).toBe("2.1.278");
  });

  test("refuses an unknown format", () => {
    expect(() => installedVersion("claude 2.1.278")).toThrow("claude --version");
  });
});

describe("needsRun", () => {
  test("runs for a build newer than the trunk's types when no rolling branch exists", () => {
    expect(needsRun({ installed: "2.1.294", devHeader: "2.1.292", rollingHeader: null })).toBe(
      true,
    );
  });

  test("runs for a build newer than both the trunk's and the rolling branch's types", () => {
    expect(needsRun({ installed: "2.1.294", devHeader: "2.1.290", rollingHeader: "2.1.292" })).toBe(
      true,
    );
  });

  test("leaves a trunk that already carries the installed types", () => {
    expect(needsRun({ installed: "2.1.294", devHeader: "2.1.294", rollingHeader: null })).toBe(
      false,
    );
  });

  test("leaves a rolling branch that already carries the installed types", () => {
    expect(needsRun({ installed: "2.1.294", devHeader: "2.1.292", rollingHeader: "2.1.294" })).toBe(
      false,
    );
  });

  test("never regenerates from an older build", () => {
    expect(needsRun({ installed: "2.1.290", devHeader: "2.1.292", rollingHeader: null })).toBe(
      false,
    );
  });
});

describe("promptFor", () => {
  test("fills each placeholder", () => {
    expect(promptFor("{{from}} → {{to}}", { from: "2.1.292", to: "2.1.294" })).toBe(
      "2.1.292 → 2.1.294",
    );
  });

  test("refuses a placeholder without a value", () => {
    expect(() => promptFor("{{from}} {{form}}", { from: "2.1.292" })).toThrow("{{form}}");
  });
});

let root = "";

let project = "";

let origin = "";

let env: NodeJS.ProcessEnv = {};

const stub = (name: string) => join(root, "stub", name);

const recorded = (name: string) => (existsSync(stub(name)) ? readFileSync(stub(name), "utf8") : "");

const state = (name: string) => join(project, ".git", "claude-code-types", name);

const worktree = () => `${project}.wt/claude-code-types`;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
}

function setHeader(cwd: string, version: string) {
  write(join(cwd, TYPES_PATH), `// Written by Claude Code ${version}.\n// declarations\n`);
}

function runScript(action = "run", cwd = project) {
  const result = Bun.spawnSync([process.execPath, SCRIPT, action], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The script run beside the test, for a test that does something while it works. */
async function runScriptAsync() {
  const proc = Bun.spawn([process.execPath, SCRIPT, "run"], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

function outcome(): Outcome {
  // SAFETY: the script writes this file from an Outcome, and every test compares it whole or by kind.
  return JSON.parse(readFileSync(state("outcome.json"), "utf8")) as Outcome;
}

function failureReason(): string {
  const written = outcome();

  if (written.kind !== "failed") throw new Error(`expected a failed run, found ${written.kind}`);

  return written.reason;
}

/** The rolling branch on origin, built from origin/dev with the given types header and commits. */
function pushRolling(version: string, extra: (clone: string) => void) {
  const clone = join(root, "rolling-clone");
  git(root, "clone", "-q", "-b", "dev", origin, clone);
  git(clone, "checkout", "-qb", ROLLING_BRANCH);
  setHeader(clone, version);
  commitAll(clone, `chore(vellum): types from Claude Code ${version}`);
  extra(clone);
  git(clone, "push", "-q", "origin", ROLLING_BRANCH);
  git(project, "fetch", "-q", "origin");
}

/** A commit on origin/dev made from another clone, which the project has not fetched. */
function landOnDev(change: (clone: string) => void) {
  const clone = join(root, "dev-clone");
  git(root, "clone", "-q", "-b", "dev", origin, clone);
  change(clone);
  commitAll(clone, "a change on dev");
  git(clone, "push", "-q", "origin", "dev");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-code-types-"));
  project = join(root, "project");
  origin = join(root, "origin.git");

  env = stubbedEnv(root);
  write(stub("version"), "2.1.294");

  git(root, "init", "-q", "--bare", origin);
  mkdirSync(project);
  git(project, "init", "-q", "-b", "dev");
  git(project, "remote", "add", "origin", origin);
  setHeader(project, "2.1.292");
  write(join(project, TOOLS_TYPES_PATH), "// tools 2.1.292\n");
  write(
    join(project, ".claude-plugin/marketplace.json"),
    JSON.stringify({
      plugins: [{ source: "./vellum" }, { source: "./todos" }, { source: "./git" }],
    }),
  );
  write(join(project, "vellum/hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }));
  write(join(project, "todos/hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }));
  write(join(project, "README.md"), "base\n");
  commitAll(project, "init");
  git(project, "push", "-q", "-u", "origin", "dev");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("regenerate", () => {
  test("rewrites the core and the tools of the checkout from a bare run outside it", () => {
    const { code, stderr } = runScript("regenerate");

    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(readFileSync(join(project, TYPES_PATH), "utf8")).toBe(
      "// Written by Claude Code 2.1.294.\n",
    );
    expect(readFileSync(join(project, TOOLS_TYPES_PATH), "utf8")).toBe("// tools 2.1.294\n");
    expect(recorded("types-runs")).toMatch(
      /^-p --setting-sources project --no-session-persistence --plugin-dir \S+\/mod\n$/u,
    );
    expect(recorded("types-cwds")).not.toContain(project);
  });

  test("fails with the run's output when the run writes no types", () => {
    write(stub("types-silent"), "");

    const { code, stderr } = runScript("regenerate");

    expect(code).toBe(1);
    expect(stderr.split("\n", 1)[0]).toBe(
      "claude-code-types: claude -p --plugin-dir exited 1 without writing the mod's types: stub: mods off | stub: wrote nothing",
    );
    expect(readFileSync(join(project, TYPES_PATH), "utf8")).toStartWith(
      "// Written by Claude Code 2.1.292.",
    );
  });
});

const OPEN_PR = JSON.stringify([
  { number: 5, url: "https://github.com/o/r/pull/5", body: "old body" },
]);

describe("run", () => {
  test("installs, commits the types, opens the pull request of a new rolling branch, then removes its worktree", () => {
    const { code } = runScript();

    expect(code).toBe(0);
    expect(outcome()).toEqual({
      kind: "pr",
      url: "https://github.com/o/r/pull/7",
      from: "2.1.292",
      to: "2.1.294",
      created: true,
    });
    expect(git(project, "log", "-1", "--format=%s", `origin/${ROLLING_BRANCH}`)).toBe(
      "chore(vellum): types from Claude Code 2.1.294",
    );
    expect(git(project, "show", `origin/${ROLLING_BRANCH}:${TYPES_PATH}`)).toStartWith(
      "// Written by Claude Code 2.1.294.",
    );
    expect(recorded("bun-calls")).toBe(
      [
        `${worktree()} install --frozen-lockfile`,
        `${worktree()} install --cwd vellum --frozen-lockfile`,
        "",
      ].join("\n"),
    );
    expect(recorded("gh-calls")).toContain(
      `pr create --base dev --head ${ROLLING_BRANCH} --title chore(vellum): types from Claude Code 2.1.294 --body-file ${state("pr-body.md")}`,
    );
    expect(recorded("gh-calls")).not.toContain("--add-label");
    expect(recorded("agent-runs")).toBe(`${worktree()} 1 -p --model opus --permission-mode auto\n`);
    expect(recorded("agent-prompt")).toContain("hooks modules (vellum, todos)");
    expect(recorded("agent-prompt")).toContain("The script committed them as");
    expect(recorded("agent-prompt")).not.toContain("{{");
    expect(recorded("notify-calls")).toContain("pull request opened");
    expect(readFileSync(state("settled"), "utf8")).toBe("2.1.294");
    expect(existsSync(worktree())).toBe(false);
    expect(runState(statePaths(join(project, ".git")))).toEqual({ kind: "idle" });
    expect(existsSync(state("holder.json"))).toBe(false);
  });

  test("rebases the live rolling branch onto origin/dev, keeps its commits, and updates its open pull request", () => {
    pushRolling("2.1.293", (clone) => {
      write(join(clone, "notes.txt"), "kept\n");
      commitAll(clone, "a commit of the branch");
    });
    landOnDev((clone) => write(join(clone, "README.md"), "dev moved\n"));
    write(stub("gh-open"), OPEN_PR);

    const { code } = runScript();

    expect(code).toBe(0);
    expect(outcome()).toMatchObject({
      kind: "pr",
      url: "https://github.com/o/r/pull/5",
      created: false,
    });
    expect(git(project, "show", `origin/${ROLLING_BRANCH}:notes.txt`)).toBe("kept");
    expect(git(project, "show", `origin/${ROLLING_BRANCH}:README.md`)).toBe("dev moved");
    expect(recorded("gh-calls")).toContain(
      "pr edit 5 --title chore(vellum): types from Claude Code 2.1.294 --body-file",
    );
    expect(recorded("agent-prompt")).toContain("<previous-body>\nold body\n</previous-body>");
  });

  test("starts again from origin/dev when the rolling branch has no open pull request, as after a squash or a closed one", () => {
    pushRolling("2.1.293", (clone) => {
      write(join(clone, "notes.txt"), "landed already\n");
      commitAll(clone, "a commit of the branch");
    });

    runScript();

    expect(outcome()).toMatchObject({ kind: "pr", created: true });
    expect(git(project, "ls-tree", "--name-only", `origin/${ROLLING_BRANCH}`)).not.toContain(
      "notes.txt",
    );
  });

  test("starts again from origin/dev when the live branch does not rebase, and names its commits to the agent", () => {
    pushRolling("2.1.293", (clone) => {
      write(join(clone, "README.md"), "the branch\n");
      commitAll(clone, "the branch edits the README");
    });
    landOnDev((clone) => write(join(clone, "README.md"), "dev\n"));
    write(stub("gh-open"), OPEN_PR);

    runScript();

    expect(recorded("agent-prompt")).toContain("did not rebase onto origin/dev");
    expect(recorded("agent-prompt")).toMatch(/[0-9a-f]+ the branch edits the README/u);
    expect(outcome()).toMatchObject({ kind: "pr", created: false });
    expect(git(project, "show", `origin/${ROLLING_BRANCH}:README.md`)).toBe("dev");
    expect(git(project, "show", `origin/${ROLLING_BRANCH}:${TYPES_PATH}`)).toStartWith(
      "// Written by Claude Code 2.1.294.",
    );
  });

  test("hands a types commit the pre-commit refuses to the agent, with the hook's report", () => {
    write(
      join(project, ".git/hooks/pre-commit"),
      "#!/usr/bin/env bash\necho 'typecheck: ToolSpec has no member isDeferred' >&2\nexit 1\n",
    );
    chmodSync(join(project, ".git/hooks/pre-commit"), 0o755);
    write(stub("agent-commits-types"), "");

    runScript();

    expect(recorded("agent-prompt")).toContain("the pre-commit refused their commit");
    expect(recorded("agent-prompt")).toContain("typecheck: ToolSpec has no member isDeferred");
    expect(outcome()).toMatchObject({ kind: "pr" });
  });

  test("pushes after the rolling branch was deleted on GitHub since the last fetch", () => {
    pushRolling("2.1.293", () => {});
    git(join(root, "rolling-clone"), "push", "-q", "origin", "--delete", ROLLING_BRANCH);

    runScript();

    expect(outcome()).toMatchObject({ kind: "pr", created: true });
  });

  test("refuses a rolling branch checked out in another worktree", () => {
    const other = join(root, "other");
    git(project, "worktree", "add", "-q", "-b", ROLLING_BRANCH, other, "origin/dev");

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "worktree" });
    expect(failureReason()).toContain(other);
    expect(recorded("agent-runs")).toBe("");
  });

  test("leaves alone a run that holds the lock", async () => {
    write(state("run.lock"), "");
    const held = await holdLock(state("run.lock"));

    try {
      const { code, stderr } = await runScriptAsync();

      expect(code).toBe(0);
      expect(stderr).toContain("a live run holds");
      expect(existsSync(state("outcome.json"))).toBe(false);
      expect(recorded("gh-calls")).toBe("");
    } finally {
      await held.release();
    }
  });

  test("takes the lock a dead run left, its holder file with it", () => {
    write(state("run.lock"), "");
    write(state("holder.json"), JSON.stringify({ pid: 1, startedAt: "then", version: "2.1.293" }));

    runScript();

    expect(outcome()).toMatchObject({ kind: "pr" });
    expect(existsSync(state("holder.json"))).toBe(false);
    expect(runState(statePaths(join(project, ".git")))).toEqual({ kind: "idle" });
  });

  test("lets one of two runs started together over a dead run's lock work, and the other leave", async () => {
    write(state("run.lock"), "");
    write(state("holder.json"), JSON.stringify({ pid: 1, startedAt: "then", version: "2.1.293" }));
    write(stub("agent-sleep"), "2");

    const runs = await Promise.all([runScriptAsync(), runScriptAsync()]);

    expect(
      recorded("agent-runs")
        .split("\n")
        .filter((line) => line !== ""),
    ).toHaveLength(1);
    expect(runs.filter((run) => run.stderr.includes("a live run holds"))).toHaveLength(1);
    expect(outcome()).toMatchObject({ kind: "pr" });
  });

  test("names the running holder while it works, from another process", async () => {
    write(stub("agent-sleep"), "2");
    const run = runScriptAsync();

    let seen = runState(statePaths(join(project, ".git")));

    for (let tries = 0; tries < 100 && (seen.kind === "idle" || seen.holder === null); tries++) {
      await Bun.sleep(20);
      seen = runState(statePaths(join(project, ".git")));
    }

    await run;

    expect(seen).toMatchObject({ kind: "running", holder: { version: "2.1.294" } });
  });

  test("skips, without a notification, when the fetch shows origin/dev already carries the installed types", () => {
    landOnDev((clone) => setHeader(clone, "2.1.294"));

    runScript();

    expect(outcome()).toEqual({
      kind: "skipped",
      installed: "2.1.294",
      devHeader: "2.1.294",
      rollingHeader: null,
    });
    expect(recorded("notify-calls")).toBe("");
    expect(recorded("gh-calls")).toBe("");
    expect(existsSync(worktree())).toBe(false);
  });

  test("labels the pull request e2e when the branch reaches the browser suite's paths", () => {
    write(stub("agent-e2e"), "");

    runScript();

    expect(recorded("gh-calls")).toContain("pr edit https://github.com/o/r/pull/7 --add-label e2e");
  });

  test("fails at agent when claude -p fails, keeps the worktree, and settles the version", () => {
    write(stub("agent-exit"), "3");

    runScript();

    expect(outcome()).toEqual({
      kind: "failed",
      to: "2.1.294",
      step: "agent",
      reason: "claude -p exited 3",
      log: state("2.1.294.log"),
      worktree: worktree(),
    });
    expect(recorded("notify-calls")).toContain("-u critical");
    expect(recorded("notify-calls")).toContain("rerun from the main checkout");
    expect(readFileSync(state("settled"), "utf8")).toBe("2.1.294");
  });

  test("fails at verify when the agent leaves a change uncommitted", () => {
    write(stub("agent-dirty"), "");

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "verify" });
    expect(failureReason()).toContain("stray.txt");
    expect(recorded("gh-calls")).not.toContain("pr create");
  });

  test("fails at verify when the agent leaves HEAD off the rolling branch", () => {
    write(stub("agent-switches"), "");

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "verify" });
    expect(failureReason()).toBe("the agent left HEAD on refs/heads/elsewhere");
  });

  test("settles nothing and notifies nobody when it fails before the agent, so the next session retries", () => {
    write(stub("types-silent"), "");

    runScript();

    expect(outcome()).toMatchObject({
      kind: "failed",
      step: "regenerate",
      to: "2.1.294",
      worktree: null,
    });
    expect(existsSync(state("settled"))).toBe(false);
    expect(existsSync(worktree())).toBe(false);
    expect(recorded("notify-calls")).toBe("");
    expect(recorded("agent-runs")).toBe("");
  });

  test("fails at sign, before any worktree, when the key cannot sign without a passphrase", () => {
    write(
      join(root, "bin", "gpg-locked"),
      `#!/usr/bin/env bash\necho "$*" >>"${stub("gpg-calls")}"\necho "gpg: signing failed: No pinentry" >&2\nexit 2\n`,
    );
    chmodSync(join(root, "bin", "gpg-locked"), 0o755);
    git(project, "config", "commit.gpgsign", "true");
    git(project, "config", "gpg.program", join(root, "bin", "gpg-locked"));
    git(project, "config", "user.signingkey", "ABCD1234");

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "sign", worktree: null });
    expect(failureReason()).toContain("gpg: signing failed: No pinentry");
    expect(recorded("gpg-calls")).toBe(
      "--batch --pinentry-mode error --local-user ABCD1234 --sign --output /dev/null\n",
    );
    expect(existsSync(worktree())).toBe(false);
    expect(existsSync(state("settled"))).toBe(false);
  });

  test("fails at regenerate, without the agent, when git cannot sign the types commit", () => {
    write(
      join(project, ".git/hooks/pre-commit"),
      "#!/usr/bin/env bash\necho 'error: gpg failed to sign the data:' >&2\nexit 1\n",
    );
    chmodSync(join(project, ".git/hooks/pre-commit"), 0o755);

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "regenerate", worktree: null });
    expect(failureReason()).toStartWith("git could not sign the types commit");
    expect(recorded("agent-runs")).toBe("");
  });

  test("refuses to recreate a worktree that holds work, and leaves it as it is", () => {
    write(stub("agent-dirty"), "");
    runScript();
    rmSync(stub("agent-dirty"));

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "worktree" });
    expect(failureReason()).toContain("holds uncommitted changes");
    expect(readFileSync(join(worktree(), "stray.txt"), "utf8")).toBe("stray\n");
  });

  test("runs from the main checkout when started inside the worktree it recreates", () => {
    git(project, "worktree", "add", "-q", "-B", ROLLING_BRANCH, worktree(), "origin/dev");

    const { code } = runScript("run", worktree());

    expect(code).toBe(0);
    expect(outcome()).toMatchObject({ kind: "pr", created: true });
  });

  test("stops with its agent on SIGTERM, keeps the worktree and settles the version", async () => {
    write(stub("agent-sleep"), "5");
    const run = runScriptAsync();

    for (let tries = 0; tries < 150 && recorded("agent-pids") === ""; tries++) await Bun.sleep(20);
    const holder = runState(statePaths(join(project, ".git")));

    if (holder.kind !== "running" || holder.holder === null)
      throw new Error("no run holds the lock");
    const asked = Date.now();
    process.kill(holder.holder.pid, "SIGTERM");
    await run;

    // The agent sleeps 5 s: a run that waited for it instead of stopping it would take that long.
    expect(Date.now() - asked).toBeLessThan(3000);

    expect(outcome()).toMatchObject({
      kind: "stopped",
      step: "agent",
      signal: "SIGTERM",
      worktree: worktree(),
    });
    expect(readFileSync(state("settled"), "utf8")).toBe("2.1.294");
    expect(recorded("notify-calls")).toBe("");
    expect(() => process.kill(Number(recorded("agent-pids").trim()), 0)).toThrow();
  });

  test("names the ref whose header is not the generated one", () => {
    landOnDev((clone) => write(join(clone, TYPES_PATH), "// hand-written\n"));

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "fetch" });
    expect(failureReason()).toStartWith(`origin/dev: ${TYPES_PATH}: expected`);
  });

  test("fails at push when the remote refuses the branch", () => {
    write(join(origin, "hooks/pre-receive"), "#!/usr/bin/env bash\necho refused >&2\nexit 1\n");
    chmodSync(join(origin, "hooks/pre-receive"), 0o755);

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "push" });
    expect(readFileSync(state("2.1.294.log"), "utf8")).toContain("refused");
  });
});
