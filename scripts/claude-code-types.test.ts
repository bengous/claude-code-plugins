import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  headerVersion,
  installedVersion,
  needsRun,
  type Outcome,
  promptFor,
  ROLLING_BRANCH,
  RUN_GUARD,
  TOOLS_TYPES_PATH,
  TYPES_PATH,
} from "./claude-code-types.ts";

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

// Stands in for `claude` as measured on 2.1.287: a run that loads a mod with
// --plugin-dir writes the mod's types into its .claude-plugin/types/, then,
// given no prompt, stops on it. The tool types follow the environment and the
// account, so the stub writes other tools for a login variable or a config
// that is not empty. A run given --permission-mode is the agent: it records
// its prompt and writes the body where the prompt says; each control file
// under stub/ adds or changes one move.
const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
version="$(cat "$stub/version")"
if [[ $1 == --version ]]; then
  echo "\${${RUN_GUARD}:-unset}" >>"$stub/version-guards"
  echo "$version (Claude Code)"
  exit 0
fi
if [[ " $* " == *" --plugin-dir "* ]]; then
  echo "$*" >>"$stub/types-runs"
  echo "$PWD" >>"$stub/types-cwds"
  if [[ -f $stub/types-silent ]]; then
    echo "stub: mods off" >&2
    echo "stub: wrote nothing"
    exit 1
  fi
  mod=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --plugin-dir) mod="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  tools="// tools $version"
  if [[ -n \${ANTHROPIC_API_KEY:-}\${CLAUDE_CODE_OAUTH_TOKEN:-} || -z \${CLAUDE_CONFIG_DIR:-} || -n "$(ls -A "$CLAUDE_CONFIG_DIR")" ]]; then
    tools="// tools of this account and environment"
  fi
  types="$mod/.claude-plugin/types"
  mkdir -p "$types/claude-code" "$types/claude-code-tools" "$types/claude-code-mcp"
  echo "// Written by Claude Code $version." >"$types/claude-code/index.d.ts"
  echo "$tools" >"$types/claude-code-tools/index.d.ts"
  echo "// mcp" >"$types/claude-code-mcp/index.d.ts"
  echo "Error: Input must be provided either through stdin or as a prompt argument when using --print" >&2
  exit 1
fi
printf '%s' "\${!#}" >"$stub/agent-prompt"
echo "$PWD \${${RUN_GUARD}:-unset} \${*:1:$#-1}" >>"$stub/agent-runs"
if [[ -f $stub/agent-exit ]]; then exit "$(cat "$stub/agent-exit")"; fi
if [[ -f $stub/agent-commits-types ]]; then
  git -c core.hooksPath=/dev/null commit -qm "chore(vellum): types from Claude Code $version"
fi
if [[ -f $stub/agent-e2e ]]; then
  mkdir -p vellum/src
  echo "export {};" >vellum/src/page.ts
  git add -A
  git commit -qm "feat(vellum): a page"
fi
if [[ -f $stub/agent-dirty ]]; then echo stray >stray.txt; fi
if [[ -f $stub/agent-switches ]]; then git switch -qc elsewhere; fi
body="$(grep -oP 'pull request body to \`\\K[^\`]+' "$stub/agent-prompt")"
echo "the body" >"$body"
`;

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
echo "$*" >>"$stub/gh-calls"
case "$1 $2" in
  "pr list") if [[ -f $stub/gh-open ]]; then cat "$stub/gh-open"; else echo "[]"; fi ;;
  "pr create") echo "https://github.com/o/r/pull/7" ;;
esac
`;

const NOTIFY_STUB = `#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../stub/notify-calls"
`;

// The script runs under the real bun (process.execPath); only the installs it
// starts by name reach this stub.
const BUN_STUB = `#!/usr/bin/env bash
echo "$PWD $*" >>"$(dirname "$0")/../stub/bun-calls"
`;

let root = "";

let project = "";

let origin = "";

let env: NodeJS.ProcessEnv = {};

const stub = (name: string) => join(root, "stub", name);

const recorded = (name: string) => (existsSync(stub(name)) ? readFileSync(stub(name), "utf8") : "");

const state = (name: string) => join(project, ".git", "claude-code-types", name);

const worktree = () => `${project}.wt/claude-code-types`;

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

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

function runScript(action = "run") {
  const result = Bun.spawnSync([process.execPath, SCRIPT, action], {
    cwd: project,
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

  write(
    join(root, "gitconfig"),
    "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = dev\n",
  );

  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("GIT_") && name !== RUN_GUARD,
      ),
    ),
    HOME: root,
    PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };

  for (const [name, content] of [
    ["claude", CLAUDE_STUB],
    ["gh", GH_STUB],
    ["notify-send", NOTIFY_STUB],
    ["bun", BUN_STUB],
  ] as const) {
    write(join(root, "bin", name), content);
    chmodSync(join(root, "bin", name), 0o755);
  }

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
    expect(readFileSync(state("attempted"), "utf8")).toBe("2.1.294");
    expect(existsSync(worktree())).toBe(false);
    expect(existsSync(state("run.lock"))).toBe(false);
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

  test("leaves a live run alone", () => {
    write(state("run.lock"), JSON.stringify({ pid: process.pid, startedAt: "now", boot: null }));

    const { code, stderr } = runScript();

    expect(code).toBe(0);
    expect(stderr).toContain("a live run holds");
    expect(existsSync(state("outcome.json"))).toBe(false);
    expect(recorded("version-guards")).toBe("");
  });

  test("takes over the lock of a dead run", () => {
    const dead = Bun.spawnSync(["true"]).pid;
    write(state("run.lock"), JSON.stringify({ pid: dead, startedAt: "then", boot: null }));

    runScript();

    expect(outcome()).toMatchObject({ kind: "pr" });
    expect(existsSync(state("run.lock"))).toBe(false);
  });

  test("takes over a lock from before a reboot, whose pid a live process has since", () => {
    write(
      state("run.lock"),
      JSON.stringify({ pid: process.pid, startedAt: "then", boot: "an earlier boot" }),
    );

    runScript();

    expect(outcome()).toMatchObject({ kind: "pr" });
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
    expect(existsSync(worktree())).toBe(false);
  });

  test("labels the pull request e2e when the branch reaches the browser suite's paths", () => {
    write(stub("agent-e2e"), "");

    runScript();

    expect(recorded("gh-calls")).toContain("pr edit https://github.com/o/r/pull/7 --add-label e2e");
  });

  test("fails at agent when claude -p fails, keeps the worktree, and records the version as attempted", () => {
    write(stub("agent-exit"), "3");

    runScript();

    expect(outcome()).toEqual({
      kind: "failed",
      to: "2.1.294",
      step: "agent",
      reason: "claude -p exited 3",
      log: state("run.log"),
      worktree: worktree(),
    });
    expect(recorded("notify-calls")).toContain("-u critical");
    expect(recorded("notify-calls")).toContain("rerun by hand");
    expect(readFileSync(state("attempted"), "utf8")).toBe("2.1.294");
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

  test("fails at push when the remote refuses the branch", () => {
    write(join(origin, "hooks/pre-receive"), "#!/usr/bin/env bash\necho refused >&2\nexit 1\n");
    chmodSync(join(origin, "hooks/pre-receive"), 0o755);

    runScript();

    expect(outcome()).toMatchObject({ kind: "failed", step: "push" });
    expect(readFileSync(state("run.log"), "utf8")).toContain("refused");
  });
});
