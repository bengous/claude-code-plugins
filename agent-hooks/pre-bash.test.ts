/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { cachePath } from "./github.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import type { TempRepo } from "./test-support.ts";
import { createTempRepo, git, removeTempRepo, scrubGitEnv, writeRepoFile } from "./test-support.ts";

const CLI = path.join(import.meta.dir, "agent-hooks.ts");

const SESSION = "s-pre-bash";

const PROFILE = JSON.stringify({ profile: { landing: { trunk: "dev", release: "main" } } });

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_DIR/calls.log"
case "$1 $2" in
  "repo view") file="$FAKE_GH_DIR/repo.json" ;;
  "pr view") file="$FAKE_GH_DIR/pr.json" ;;
  *) exit 2 ;;
esac
if [ -f "$file" ]; then cat "$file"; else echo "error connecting to api.github.com" >&2; exit 1; fi
`;

const GREEN_PR = {
  number: 7,
  url: "https://github.com/o/n/pull/7",
  baseRefName: "dev",
  mergeable: "MERGEABLE",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "validate",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-01-01T00:00:00Z",
    },
    { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", startedAt: "" },
  ],
};

type Output = {
  readonly code: number;
  readonly stdout: string;
  readonly decision: string | undefined;
  readonly reason: string | undefined;
  readonly note: string | undefined;
};

let temp: TempRepo;

/** A second repository beside `temp.repo`, with its branches and its origin. */
function makeRepo(name: string, files: Readonly<Record<string, string>>, origin: string): string {
  const repo = path.join(temp.dir, name);

  for (const [file, content] of Object.entries({ "README.md": "x\n", ...files })) {
    writeRepoFile(repo, file, content);
  }

  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
  git(repo, "checkout", "-q", "-B", "main");
  git(repo, "branch", "dev");
  git(repo, "remote", "add", "origin", origin);

  return repo;
}

function fakeGh(responses: { readonly repo?: unknown; readonly pr?: unknown }): void {
  const file = path.join(temp.bin, "gh");
  writeFileSync(file, FAKE_GH);
  chmodSync(file, 0o755);

  if (responses.repo !== undefined) {
    writeFileSync(path.join(temp.bin, "repo.json"), JSON.stringify(responses.repo));
  }

  if (responses.pr !== undefined) {
    writeFileSync(path.join(temp.bin, "pr.json"), JSON.stringify(responses.pr));
  }
}

function ghCalls(): string[] {
  const log = path.join(temp.bin, "calls.log");

  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

async function preBash(command: string, cwd: string): Promise<Output> {
  const payload = {
    session_id: SESSION,
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "test" },
  };

  const proc = Bun.spawn([process.execPath, CLI, "pre-bash"], {
    cwd,
    env: {
      ...process.env,
      AGENT_HOOKS_STATE_DIR: temp.stateDir,
      FAKE_GH_DIR: temp.bin,
      PATH: `${temp.bin}:${process.env["PATH"] ?? ""}`,
    },
    stdin: new Response(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const parsed: unknown = stdout.trim() === "" ? {} : JSON.parse(stdout);
  const output = isRecord(parsed) ? parsed : {};
  const specific = recordField(output, "hookSpecificOutput") ?? {};

  return {
    code,
    stdout,
    decision: stringField(specific, "permissionDecision"),
    reason: stringField(specific, "permissionDecisionReason"),
    note: stringField(output, "systemMessage"),
  };
}

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo("agent-hooks-pre-bash-");
  fakeGh({});
});

afterEach(() => {
  removeTempRepo(temp);
});

describe("pre-bash in a repository with profile.landing", () => {
  let repo = "";

  beforeEach(() => {
    repo = makeRepo(
      "profiled",
      { [CONFIG_RELATIVE_PATH]: PROFILE, "scripts/land.ts": "", "scripts/release.ts": "" },
      "git@github.com:o/n.git",
    );
  });

  test("refuses a push to the release with the PreToolUse deny shape", async () => {
    const output = await preBash("git push origin dev:main", repo);

    expect(output.code).toBe(0);
    expect(output.stdout).toBe(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "agent-hooks: a push to 'main' moves the release, and the release is the human's. Commit on 'dev' and push it there, or land with bun ./scripts/land.ts <branch> once its pull request is green.",
        },
      })}\n`,
    );
  });

  test("refuses a force push to the trunk", async () => {
    const output = await preBash("git push --force-with-lease origin dev", repo);

    expect(output.decision).toBe("deny");
    expect(output.reason).toStartWith(
      "agent-hooks: a force push or a deletion never targets 'dev': every clone caches it.",
    );
  });

  test("allows a push to the trunk and to a feature branch, without asking GitHub", async () => {
    expect((await preBash("git push origin dev", repo)).stdout).toBe("");
    expect((await preBash("git push --force-with-lease origin feature/x", repo)).stdout).toBe("");
    expect(ghCalls()).toEqual([]);
  });

  test("refuses a bare push while the release is checked out", async () => {
    expect((await preBash("git push", repo)).decision).toBe("deny");
  });

  test("allows a commit whose message names a push to the release", async () => {
    expect((await preBash("git commit -m 'git push origin main'", repo)).stdout).toBe("");
  });

  test("refuses a force push after a heredoc commit message that holds a quote", async () => {
    const command = `git commit -m "$(cat <<'EOF'\nfix the 5" screen\nEOF\n)" && git push --force origin dev`;

    expect((await preBash(command, repo)).decision).toBe("deny");
  });

  test("refuses a push behind env -C, sudo or xargs", async () => {
    expect((await preBash(`env -C ${repo} git push origin main`, temp.dir)).decision).toBe("deny");
    expect((await preBash("sudo -u me git push origin main", repo)).decision).toBe("deny");
    expect((await preBash("echo x | xargs -n 1 git push origin main", repo)).decision).toBe("deny");
  });

  test("refuses a push to the release hidden in bash -c", async () => {
    expect((await preBash(`echo ok && bash -c "git push origin HEAD:main"`, repo)).decision).toBe(
      "deny",
    );
  });

  test("guards a linked worktree of the repository", async () => {
    const worktree = path.join(temp.dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feature/y", worktree);

    expect((await preBash(`cd ${worktree} && git push origin HEAD:main`, temp.dir)).decision).toBe(
      "deny",
    );
    expect((await preBash("git push origin HEAD", worktree)).stdout).toBe("");
  });

  test("guards the repository a -C names from another directory", async () => {
    expect((await preBash(`git -C ${repo} push origin main`, temp.dir)).decision).toBe("deny");
  });

  test("guards the repository a -C relative to a leading cd names", async () => {
    const command = `cd ${temp.dir} && git -C ${path.basename(repo)} push origin main`;

    expect((await preBash(command, temp.repo)).decision).toBe("deny");
  });

  test("guards the repository chained relative -C options name", async () => {
    const command = `git -C ${temp.dir} -C ${path.basename(repo)} push origin main`;

    expect((await preBash(command, temp.repo)).decision).toBe("deny");
  });

  test("guards the repository a quoted -C names", async () => {
    expect((await preBash(`git -C "${repo}" push origin main`, temp.dir)).decision).toBe("deny");
  });

  test("guards the repository --git-dir names from another directory", async () => {
    expect((await preBash(`git --git-dir=${repo}/.git push origin main`, temp.dir)).decision).toBe(
      "deny",
    );
  });

  test("judges a push aimed at another repository by that repository", async () => {
    const other = makeRepo("other", {}, "/srv/git/other.git");

    expect((await preBash(`git -C ${other} push origin main`, repo)).stdout).toBe("");
    expect((await preBash(`cd ${other} && git push origin main`, repo)).stdout).toBe("");
  });

  test("reads each repository's own profile", async () => {
    const other = makeRepo(
      "gitflow",
      {
        [CONFIG_RELATIVE_PATH]: JSON.stringify({
          profile: { landing: { trunk: "develop", release: "master" } },
        }),
      },
      "/srv/git/gitflow.git",
    );

    const master = await preBash(`cd ${other} && git push origin master`, repo);

    expect(master.reason).toContain("a push to 'master' moves the release");
    expect(master.reason).toContain("push a feature branch and open a pull request");
    expect((await preBash(`cd ${other} && git push origin main`, repo)).stdout).toBe("");
  });

  test("refuses the release script and allows its dry run", async () => {
    expect((await preBash("bun ./scripts/release.ts", repo)).reason).toBe(
      "agent-hooks: ./scripts/release.ts publishes 'main', and the release is the human's. Say the release is ready and leave it to the human.",
    );
    expect((await preBash(`bun ${repo}/scripts/release.ts abc123`, temp.dir)).decision).toBe(
      "deny",
    );
    expect((await preBash("bun ./scripts/release.ts --dry-run", repo)).stdout).toBe("");
  });

  test("refuses gh release create", async () => {
    expect((await preBash("gh release create v1 --notes x", repo)).reason).toContain(
      "gh release create publishes 'main'",
    );
  });

  test("allows gh pr merge of a green, mergeable pull request into the trunk", async () => {
    fakeGh({ pr: GREEN_PR });

    expect((await preBash("gh pr merge 7 --squash", repo)).stdout).toBe("");
    expect(ghCalls()).toEqual([
      "pr view 7 --json number,url,baseRefName,mergeable,statusCheckRollup",
    ]);
  });

  test("refuses gh pr merge into the release, with red checks or not mergeable", async () => {
    fakeGh({ pr: { ...GREEN_PR, baseRefName: "main" } });
    expect((await preBash("gh pr merge 7", repo)).reason).toContain("#7 merges into 'main'");

    const red = GREEN_PR.statusCheckRollup.map((check) => ({ ...check, conclusion: "FAILURE" }));
    fakeGh({ pr: { ...GREEN_PR, statusCheckRollup: red } });
    expect((await preBash("gh pr merge 7", repo)).reason).toContain(
      "checks not green on #7: validate failure",
    );

    fakeGh({ pr: { ...GREEN_PR, mergeable: "CONFLICTING" } });
    expect((await preBash("gh pr merge 7", repo)).reason).toContain("not mergeable (conflicting)");
  });

  test("judges gh pr merge --repo by the default rule: the profile is the cwd's", async () => {
    fakeGh({
      repo: { visibility: "PUBLIC", defaultBranchRef: { name: "main" } },
      pr: { ...GREEN_PR, mergeable: "CONFLICTING" },
    });

    expect((await preBash("gh pr merge --repo=o/n 7", repo)).stdout).toBe("");
  });

  test("lets gh pr merge through with a note when the pull request cannot be read", async () => {
    const output = await preBash("gh pr merge 7", repo);

    expect(output.decision).toBeUndefined();
    expect(output.note).toBe(
      "agent-hooks: could not read the pull request gh pr merge names (error connecting to api.github.com): the merge went unchecked",
    );
  });

  test("an invalid config falls back to the default with a note", async () => {
    writeRepoFile(repo, CONFIG_RELATIVE_PATH, '{ "profile": { "landing": { "trunk": "dev" } } }');
    fakeGh({ repo: { visibility: "PRIVATE", defaultBranchRef: { name: "main" } } });

    const output = await preBash("git push origin main", repo);

    expect(output.decision).toBeUndefined();
    expect(output.note).toContain("profile.landing.release: expected a branch name");
    expect(output.note).toContain("the landing guard applied its default");
  });
});

describe("pre-bash in a repository without a profile", () => {
  let repo = "";

  beforeEach(() => {
    repo = makeRepo("plain", {}, "https://github.com/o/n.git");
  });

  test("refuses a push to the default branch of a public repository", async () => {
    fakeGh({ repo: { visibility: "PUBLIC", defaultBranchRef: { name: "main" } } });

    const output = await preBash("git push origin main", repo);

    expect(output.reason).toBe(
      "agent-hooks: 'main' is the default branch of the public repository github.com/o/n, and moving it is the human's. Push a feature branch and open a pull request instead. A repository whose agents land on their own declares profile.landing in .claude/agent-hooks.jsonc.",
    );
  });

  test("reads the visibility once per repository for the session", async () => {
    fakeGh({ repo: { visibility: "PUBLIC", defaultBranchRef: { name: "main" } } });

    expect((await preBash("git push origin feature/x", repo)).stdout).toBe("");
    expect((await preBash("git push", repo)).decision).toBe("deny");
    expect(ghCalls()).toEqual(["repo view github.com/o/n --json visibility,defaultBranchRef"]);
    expect(cachePath(SESSION)).toStartWith(temp.stateDir);
    expect(existsSync(cachePath(SESSION))).toBe(true);
  });

  test("allows a push to the default branch of a private repository", async () => {
    fakeGh({ repo: { visibility: "PRIVATE", defaultBranchRef: { name: "main" } } });

    expect((await preBash("git push origin main", repo)).stdout).toBe("");
  });

  test("reads the default branch, master included", async () => {
    fakeGh({ repo: { visibility: "PUBLIC", defaultBranchRef: { name: "master" } } });

    expect((await preBash("git push origin main", repo)).stdout).toBe("");
    expect((await preBash("git push origin HEAD:master", repo)).decision).toBe("deny");
  });

  test("reads the remote the push names", async () => {
    fakeGh({ repo: { visibility: "PUBLIC", defaultBranchRef: { name: "main" } } });
    git(repo, "remote", "add", "fork", "git@github.com:me/fork.git");

    await preBash("git push fork main", repo);

    expect(ghCalls()).toEqual(["repo view github.com/me/fork --json visibility,defaultBranchRef"]);
  });

  test("lets the push through with a note when the visibility cannot be read", async () => {
    const output = await preBash("git push origin main", repo);

    expect(output.decision).toBeUndefined();
    expect(output.note).toBe(
      "agent-hooks: could not read whether github.com/o/n is public (error connecting to api.github.com): the push went unchecked",
    );
  });

  test("allows a push to a remote that is no hosted repository, without asking GitHub", async () => {
    const local = makeRepo("local", {}, "/srv/git/local.git");

    expect((await preBash("git push origin main", local)).stdout).toBe("");
    expect(ghCalls()).toEqual([]);
  });

  test("refuses gh pr merge into the default branch of a public repository", async () => {
    fakeGh({
      repo: { visibility: "PUBLIC", defaultBranchRef: { name: "main" } },
      pr: { ...GREEN_PR, baseRefName: "main" },
    });

    expect((await preBash("gh pr merge 7", repo)).reason).toContain(
      "#7 merges into 'main', the default branch of the public repository github.com/o/n",
    );
  });

  test("allows the release commands", async () => {
    writeRepoFile(repo, "scripts/release.ts", "");

    expect((await preBash("gh release create v1", repo)).stdout).toBe("");
    expect((await preBash("bun ./scripts/release.ts", repo)).stdout).toBe("");
  });
});

describe("pre-bash outside the doors", () => {
  test("allows a push outside any repository", async () => {
    expect((await preBash("git push origin main", temp.dir)).stdout).toBe("");
  });

  test("allows every other command without a lookup", async () => {
    expect((await preBash("ls -la && bun test", temp.repo)).stdout).toBe("");
    expect(ghCalls()).toEqual([]);
  });

  test("exits 0 without output on an invalid payload", async () => {
    const proc = Bun.spawn([process.execPath, CLI, "pre-bash"], {
      stdin: new Response("not json"),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
  });
});
