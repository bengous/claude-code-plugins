/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { cachePath } from "./guard/github.ts";
import { encode, runHook } from "./hook.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import { runPreBash } from "./pre-bash.ts";
import { beatPath } from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  git,
  removeTempRepo,
  scrubGitEnv,
  transcriptRecord as record,
  writeRepoFile,
} from "./test-support.ts";

const CLI = path.join(import.meta.dir, "agent-hooks.ts");

const SESSION = "s-pre-bash";

const PROFILE = JSON.stringify({ profile: { landing: { trunk: "dev", release: "main" } } });

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_DIR/calls.log"
case "$1 $2" in
  "repo view") file="$FAKE_GH_DIR/repo.json" ;;
  "pr view") file="$FAKE_GH_DIR/pr.json" ;;
  "pr checks") file="$FAKE_GH_DIR/checks.json" ;;
  *) exit 2 ;;
esac
if [ -f "$file" ]; then cat "$file"; else echo "error connecting to api.github.com" >&2; exit 1; fi
`;

const GREEN_PR = {
  number: 7,
  url: "https://github.com/o/n/pull/7",
  baseRefName: "dev",
  mergeable: "MERGEABLE",
};

const GREEN_CHECKS = [
  {
    name: "validate",
    state: "SUCCESS",
    workflow: "CI",
    event: "pull_request",
    startedAt: "2026-01-01T00:00:00Z",
  },
  { name: "ci/legacy", state: "SUCCESS", workflow: "", event: "", startedAt: "" },
];

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

function fakeGh(responses: {
  readonly repo?: unknown;
  readonly pr?: unknown;
  readonly checks?: unknown;
}): void {
  const file = path.join(temp.bin, "gh");
  writeFileSync(file, FAKE_GH);
  chmodSync(file, 0o755);

  if (responses.repo !== undefined) {
    writeFileSync(path.join(temp.bin, "repo.json"), JSON.stringify(responses.repo));
  }

  if (responses.pr !== undefined) {
    writeFileSync(path.join(temp.bin, "pr.json"), JSON.stringify(responses.pr));
  }

  if (responses.checks !== undefined) {
    writeFileSync(path.join(temp.bin, "checks.json"), JSON.stringify(responses.checks));
  }
}

function ghCalls(): string[] {
  const log = path.join(temp.bin, "calls.log");

  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

async function preBash(
  command: string,
  cwd: string,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<Output> {
  const payload = {
    session_id: SESSION,
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command, description: "test" },
    ...extra,
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

  test("refuses a bare push that @{push} sends to the release from another branch", async () => {
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "checkout", "-q", "-b", "x");
    git(repo, "branch", "-q", "--set-upstream-to=origin/main");
    git(repo, "config", "push.default", "upstream");

    expect((await preBash("git push", repo)).reason).toContain(
      "a push to 'main' moves the release",
    );
    expect((await preBash("git push origin HEAD", repo)).decision).toBe("deny");
  });

  test("refuses a bare push that remote.origin.push maps to the release", async () => {
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "checkout", "-q", "dev");
    git(repo, "config", "remote.origin.push", "refs/heads/dev:refs/heads/main");

    expect((await preBash("git push", repo)).decision).toBe("deny");
  });

  test("allows a bare push of a feature branch to its own upstream", async () => {
    git(repo, "checkout", "-q", "-b", "feature/x");
    git(repo, "update-ref", "refs/remotes/origin/feature/x", "HEAD");
    git(repo, "branch", "-q", "--set-upstream-to=origin/feature/x");

    expect((await preBash("git push --force-with-lease", repo)).stdout).toBe("");
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

  test("refuses a package.json script that runs the release script, and allows its dry run", async () => {
    writeRepoFile(
      repo,
      "package.json",
      JSON.stringify({
        scripts: {
          release: "bun ./scripts/release.ts",
          plan: "bun ./scripts/release.ts --dry-run",
          ship: "git push origin dev:main",
          loop: "npm run loop",
        },
      }),
    );

    expect((await preBash("bun run release", repo)).reason).toContain(
      "./scripts/release.ts publishes 'main'",
    );
    expect((await preBash("npm run release", repo)).decision).toBe("deny");
    expect((await preBash("pnpm release", repo)).decision).toBe("deny");
    expect((await preBash("bun run ship", repo)).decision).toBe("deny");
    expect((await preBash("bun run plan", repo)).stdout).toBe("");
    expect((await preBash("npm run loop", repo)).stdout).toBe("");
    expect((await preBash("npm run release -- --dry-run", repo)).stdout).toBe("");
    expect((await preBash("bun run --cwd .. release", path.join(repo, "scripts"))).decision).toBe(
      "deny",
    );
  });

  test("refuses the release script behind a runner option, not a use that runs nothing", async () => {
    expect((await preBash(`bun --cwd ${repo} scripts/release.ts`, temp.dir)).decision).toBe("deny");
    expect((await preBash("node --check scripts/release.ts", repo)).stdout).toBe("");
    expect((await preBash("bun build scripts/release.ts", repo)).stdout).toBe("");
  });

  test("reads the profile and the package scripts where the command runs, not where the hook starts", async () => {
    writeRepoFile(
      repo,
      "package.json",
      JSON.stringify({ scripts: { release: "bun ./scripts/release.ts" } }),
    );
    writeRepoFile(repo, "sub/package.json", JSON.stringify({ scripts: { t: "bun test" } }));
    const sub = path.join(repo, "sub");
    const outside = makeRepo("outside", {}, "/srv/git/outside.git");

    expect((await preBash("cd .. && bun run release", sub)).reason).toContain(RELEASE_SCRIPT);
    expect((await preBash("bun --cwd .. run release", sub)).reason).toContain(RELEASE_SCRIPT);
    expect(
      (await preBash(`cd ${repo} && gh release create v1.0.0 --generate-notes`, outside)).reason,
    ).toContain("gh release create publishes 'main'");
    expect((await preBash(`cd ${repo} && bun run release`, outside)).reason).toContain(
      RELEASE_SCRIPT,
    );
    expect((await preBash("bun run t", sub)).stdout).toBe("");
  });

  test("refuses a release command whose directory the guard cannot follow", async () => {
    writeRepoFile(
      repo,
      "package.json",
      JSON.stringify({ scripts: { release: "bun ./scripts/release.ts" } }),
    );

    expect((await preBash('cd "$X" && gh release create v1', repo)).reason).toContain(
      "The release is the human's",
    );
    expect((await preBash('cd "$X" && bun run release', repo)).decision).toBe("deny");
    expect((await preBash('cd "$X" && bun ./scripts/release.ts', repo)).decision).toBe("deny");

    const outside = makeRepo("unprofiled", {}, "/srv/git/unprofiled.git");

    expect((await preBash('cd "$X" && gh release create v1', outside)).decision).toBe("deny");
  });

  test("refuses gh release create", async () => {
    expect((await preBash("gh release create v1 --notes x", repo)).reason).toContain(
      "gh release create publishes 'main'",
    );
  });

  test("allows gh pr merge of a green, mergeable pull request into the trunk", async () => {
    fakeGh({ pr: GREEN_PR, checks: GREEN_CHECKS });

    expect((await preBash("gh pr merge 7 --squash", repo)).stdout).toBe("");
    expect(ghCalls().toSorted()).toEqual([
      "pr checks 7 --json name,state,workflow,event,startedAt",
      "pr view 7 --json number,url,baseRefName,mergeable",
    ]);
  });

  test("refuses gh pr merge when a pull_request run failed beside a newer skipped push run", async () => {
    const failed = { ...GREEN_CHECKS[0], state: "FAILURE" };

    const skippedPush = {
      ...failed,
      state: "SKIPPED",
      event: "push",
      startedAt: "2026-01-02T00:00:00Z",
    };

    fakeGh({ pr: GREEN_PR, checks: [failed, skippedPush] });

    expect((await preBash("gh pr merge 7", repo)).reason).toContain(
      "checks not green on #7: validate failure",
    );
  });

  test("refuses gh pr merge with no check reported yet", async () => {
    fakeGh({ pr: GREEN_PR });
    writeFileSync(
      path.join(temp.bin, "gh"),
      FAKE_GH.replace(
        '"pr checks") file="$FAKE_GH_DIR/checks.json" ;;',
        `"pr checks") echo "no checks reported on the 'feature/x' branch" >&2; exit 1 ;;`,
      ),
    );

    expect((await preBash("gh pr merge 7", repo)).reason).toContain(
      "no check reported on #7's head yet",
    );
  });

  test("refuses gh pr merge into the release, with red checks or not mergeable", async () => {
    fakeGh({ pr: { ...GREEN_PR, baseRefName: "main" }, checks: GREEN_CHECKS });
    expect((await preBash("gh pr merge 7", repo)).reason).toContain("#7 merges into 'main'");

    const red = GREEN_CHECKS.map((check) => ({ ...check, state: "FAILURE" }));
    fakeGh({ pr: GREEN_PR, checks: red });
    expect((await preBash("gh pr merge 7", repo)).reason).toContain(
      "checks not green on #7: validate failure",
    );

    fakeGh({ pr: { ...GREEN_PR, mergeable: "CONFLICTING" }, checks: GREEN_CHECKS });
    expect((await preBash("gh pr merge 7", repo)).reason).toContain("not mergeable (conflicting)");
  });

  test("applies the profile to gh pr merge --repo naming the cwd's own repository", async () => {
    fakeGh({ pr: { ...GREEN_PR, baseRefName: "main" }, checks: GREEN_CHECKS });

    for (const option of ["--repo o/n", "--repo=github.com/o/n", "-R https://github.com/O/N.git"]) {
      expect((await preBash(`gh pr merge 7 ${option}`, repo)).reason).toContain(
        "#7 merges into 'main', the release",
      );
    }

    expect((await preBash("gh release create v1 -R o/n", repo)).decision).toBe("deny");
  });

  test("judges gh pr merge --repo naming another repository by the default rule", async () => {
    fakeGh({
      repo: { visibility: "PUBLIC", defaultBranchRef: { name: "main" } },
      pr: { ...GREEN_PR, mergeable: "CONFLICTING" },
      checks: GREEN_CHECKS,
    });

    expect((await preBash("gh pr merge --repo=other/repo 7", repo)).stdout).toBe("");
    expect((await preBash("gh release create v1 -R other/repo", repo)).stdout).toBe("");
  });

  test("lets gh pr merge through with a note when the pull request cannot be read", async () => {
    const output = await preBash("gh pr merge 7", repo);

    expect(output.decision).toBeUndefined();
    expect(output.note).toBe(
      "agent-hooks: could not read the pull request gh pr merge names (error connecting to api.github.com): the merge went unchecked",
    );
  });

  test("keeps profile.landing when another part of the config is invalid", async () => {
    const landing = '"profile": { "landing": { "trunk": "dev", "release": "main" } }';

    writeRepoFile(
      repo,
      CONFIG_RELATIVE_PATH,
      `{ ${landing}, "stop": { "lanes": { "typo": {} } } }`,
    );
    expect((await preBash("git push origin main", repo)).reason).toContain(
      "a push to 'main' moves the release",
    );

    writeRepoFile(repo, CONFIG_RELATIVE_PATH, `{ ${landing}, "presets": ["no-such-preset"] }`);
    expect((await preBash("git push --force origin dev", repo)).decision).toBe("deny");
    expect((await preBash("git push origin feature/x", repo)).stdout).toBe("");
  });

  test("beats for the session in the checkout around its cwd, a command with no door included", async () => {
    const plain = makeRepo("plain", {}, "git@github.com:o/n.git");

    await preBash("git status", repo);
    await preBash("git status", plain);

    expect(existsSync(beatPath(SESSION, realpathSync(repo)))).toBeTrue();
    expect(existsSync(beatPath(SESSION, realpathSync(plain)))).toBeFalse();
  });

  test("judges the doors from profile.landing alone: another profile key, invalid or unknown, refuses nothing", async () => {
    for (const other of ['"worktree": "each"', '"review": {}', '"later": 1']) {
      writeRepoFile(
        repo,
        CONFIG_RELATIVE_PATH,
        `{ "profile": { "landing": { "trunk": "dev", "release": "main" }, ${other} } }`,
      );

      expect((await preBash("git push origin main", repo)).reason).toContain(
        "a push to 'main' moves the release",
      );
      expect((await preBash("git push origin feature/x", repo)).stdout).toBe("");
    }
  });

  test("an invalid profile refuses every door, naming the error", async () => {
    writeRepoFile(repo, CONFIG_RELATIVE_PATH, '{ "profile": { "landing": { "trunk": "dev" } } }');

    const push = await preBash("git push origin feature/x", repo);

    expect(push.reason).toBe(
      `agent-hooks: ${path.join(repo, CONFIG_RELATIVE_PATH)}: profile.landing.release: expected a branch name. The landing guard cannot read this repository's profile.landing, so it refuses git push until the file is fixed.`,
    );
    expect((await preBash("gh pr merge 7", repo)).reason).toContain("so it refuses gh pr merge");
    expect((await preBash("bun ./scripts/release.ts", repo)).decision).toBe("deny");
    expect((await preBash("git push --dry-run origin main", repo)).stdout).toBe("");
    expect((await preBash("git status", repo)).stdout).toBe("");
  });

  test("a config file that does not parse refuses every door", async () => {
    writeRepoFile(repo, CONFIG_RELATIVE_PATH, "{ not jsonc");

    expect((await preBash("git push origin feature/x", repo)).reason).toContain("invalid JSONC");
  });
});

const UNRESOLVED_PUSH =
  "Run the push alone, from the repository, with literal names: git push origin <branch>.";

const UNRESOLVED_MERGE =
  "Run it alone, from the repository, with a literal number: gh pr merge <number>";

const UNRESOLVED_RELEASE =
  "The release is the human's; its plan runs alone, from the repository: bun ./scripts/release.ts --dry-run.";

const RELEASE_PUSH = "a push to 'main' moves the release, and the release is the human's";

const RELEASE_SCRIPT = "publishes 'main', and the release is the human's";

const HEREDOC_COMMIT = `git commit -m "$(cat <<'EOF'\nfix(x): don't (break) it\nEOF\n)"`;

describe("pre-bash refuses every door it cannot resolve, naming the explicit form", () => {
  let repo = "";

  beforeEach(() => {
    repo = makeRepo(
      "probe",
      {
        [CONFIG_RELATIVE_PATH]: PROFILE,
        "scripts/release.ts": "",
        "package.json": JSON.stringify({
          scripts: { release: "bun ./scripts/release.ts", rel2: "npm run release" },
        }),
      },
      "git@github.com:o/n.git",
    );
    git(repo, "checkout", "-q", "dev");
  });

  test.each([
    ["git checkout -q main && git push", UNRESOLVED_PUSH],
    ["git checkout -q main && git push origin HEAD", UNRESOLVED_PUSH],
    ['git push origin "$(git branch --show-current)"', UNRESOLVED_PUSH],
    ['git push -u origin "$(git branch --show-current)"', UNRESOLVED_PUSH],
    ["git push origin $(git rev-parse --abbrev-ref HEAD)", UNRESOLVED_PUSH],
    ['B=main; git push origin "$B"', RELEASE_PUSH],
    [`${HEREDOC_COMMIT} && git push origin main`, RELEASE_PUSH],
    ["stdbuf -oL git push origin main", UNRESOLVED_PUSH],
    ["setsid git push origin main", UNRESOLVED_PUSH],
    ["bash <<'X'\ngit push origin main\nX", UNRESOLVED_PUSH],
    ["bun ./scripts/release", RELEASE_SCRIPT],
    ["bun run release", RELEASE_SCRIPT],
    ["npm run rel2", RELEASE_SCRIPT],
    ["npx tsx scripts/release.ts", UNRESOLVED_RELEASE],
    ["bunx tsx scripts/release.ts", UNRESOLVED_RELEASE],
    ["bun x tsx scripts/release.ts", UNRESOLVED_RELEASE],
    ['gh pr merge "$PR" --squash', UNRESOLVED_MERGE],
    ["git -c alias.p=push p origin main", UNRESOLVED_PUSH],
    ["function f { git push origin main; }; f", UNRESOLVED_PUSH],
    ["command -p git push origin main", RELEASE_PUSH],
    ["env -i PATH=/usr/bin git push origin main", RELEASE_PUSH],
    ["sudo -E -H git push origin main", RELEASE_PUSH],
    ["nice -n5 git push origin main", RELEASE_PUSH],
    ["timeout -k 5 10 git push origin main", RELEASE_PUSH],
    ["time git push origin main", RELEASE_PUSH],
    ["watch -n1 git push origin main", UNRESOLVED_PUSH],
    ["bun -e 'await Bun.$`git push origin main`'", UNRESOLVED_PUSH],
    ["bun -e 'import { $ } from \"bun\"; await $`git push --force origin dev`'", UNRESOLVED_PUSH],
    ["perl -e 'print `git push origin main`'", UNRESOLVED_PUSH],
    ["ruby -e 'system(\"git push origin main\")'", UNRESOLVED_PUSH],
    ["bun - <<'EOF'\nawait Bun.$`git push origin main`;\nEOF", UNRESOLVED_PUSH],
    ["git -c user.name=bot \\\n  push --force origin dev", "never targets 'dev'"],
    ['git -C "$(git rev-parse --show-toplevel)" push origin main', UNRESOLVED_PUSH],
    ['git -c "user.name=$(whoami)" push --force origin dev', UNRESOLVED_PUSH],
    ['gh -R "$(gh repo view --json nameWithOwner -q .nameWithOwner)" pr merge 7', UNRESOLVED_MERGE],
    ["git rebase origin/dev main && git push origin HEAD", UNRESOLVED_PUSH],
    ["cat <<EOF\n$(git push origin main)\nEOF", UNRESOLVED_PUSH],
    ['B=feature/x; for B in main; do git push origin "$B"; done', UNRESOLVED_PUSH],
    ['B=feature/x; read -r B <<< main; git push origin "$B"', UNRESOLVED_PUSH],
    ['B=main; [ -n "$CI" ] && B=feature/x; git push origin "$B"', UNRESOLVED_PUSH],
    ['[ -n "$CI" ] && B=feature/x; git push origin "$B"', UNRESOLVED_PUSH],
    ["git -c remote.origin.push=HEAD:refs/heads/main push", UNRESOLVED_PUSH],
    ["flock /tmp/land.lock -c 'git push origin main'", UNRESOLVED_PUSH],
    ["flock -c 'git push origin main' /tmp/land.lock", UNRESOLVED_PUSH],
    ["echo main | xargs -I{} sh -c 'git push origin {}'", UNRESOLVED_PUSH],
    ["echo dev | xargs -I% bash -c 'git push --force origin %'", UNRESOLVED_PUSH],
    [
      "git branch -r --merged origin/dev | sed 's#origin/##' | xargs -I{} sh -c 'git push origin --delete {}'",
      UNRESOLVED_PUSH,
    ],
    ["cd /nonexistent-dir-xyz 2>/dev/null; git push origin main", UNRESOLVED_PUSH],
    ["git worktree add -q ../wt2 main && cd ../wt2 && git push origin HEAD", UNRESOLVED_PUSH],
  ])("refuses %j", async (command, expected) => {
    const output = await preBash(command, repo);

    expect(output.decision).toBe("deny");
    expect(output.reason).toContain(expected);
  });

  test("joins a line continuation before it looks for a door", async () => {
    expect((await preBash(`git -C ${repo} \\\n  push origin main`, temp.dir)).reason).toContain(
      RELEASE_PUSH,
    );

    fakeGh({ pr: { ...GREEN_PR, baseRefName: "main" }, checks: GREEN_CHECKS });
    expect((await preBash("gh pr \\\n  merge 7 --squash", repo)).reason).toContain(
      "#7 merges into 'main', the release",
    );
  });

  test.each([["gh -R o/n pr merge 7 --squash"], ["gh pr -R o/n merge 7 --squash"]])(
    "refuses %j into the release, -R read wherever it stands",
    async (command) => {
      fakeGh({ pr: { ...GREEN_PR, baseRefName: "main" }, checks: GREEN_CHECKS });

      expect((await preBash(command, repo)).reason).toContain("#7 merges into 'main', the release");
    },
  );

  test("refuses gh pr merge --auto like any merge: gh merges a mergeable pull request at once", async () => {
    const running = GREEN_CHECKS.map((check) => ({ ...check, state: "IN_PROGRESS" }));
    fakeGh({ pr: GREEN_PR, checks: running });
    expect((await preBash("gh pr merge 7 --auto --squash", repo)).reason).toContain(
      "checks not green on #7: validate in_progress, ci/legacy in_progress. Wait for the running ones (gh pr checks 7 --watch)",
    );

    fakeGh({ pr: GREEN_PR });
    writeFileSync(
      path.join(temp.bin, "gh"),
      FAKE_GH.replace(
        '"pr checks") file="$FAKE_GH_DIR/checks.json" ;;',
        `"pr checks") echo "no checks reported on the 'feature/x' branch" >&2; exit 1 ;;`,
      ),
    );
    expect((await preBash("gh pr merge 7 --auto", repo)).reason).toContain(
      "no check reported on #7's head yet: wait for its run (gh pr checks 7 --watch)",
    );
  });
});

describe("pre-bash judges the doors gh api opens", () => {
  let repo = "";

  beforeEach(() => {
    repo = makeRepo("api", { [CONFIG_RELATIVE_PATH]: PROFILE }, "git@github.com:o/n.git");
  });

  test("judges the merge endpoint like gh pr merge", async () => {
    fakeGh({ pr: GREEN_PR, checks: GREEN_CHECKS });
    expect(
      (await preBash("gh api -X PUT repos/o/n/pulls/7/merge -f merge_method=squash", repo)).stdout,
    ).toBe("");

    fakeGh({ pr: { ...GREEN_PR, baseRefName: "main" }, checks: GREEN_CHECKS });
    expect((await preBash("gh api -X PUT repos/o/n/pulls/7/merge", repo)).reason).toContain(
      "#7 merges into 'main', the release",
    );
    expect(
      (await preBash("gh api --method PUT repos/{owner}/{repo}/pulls/7/merge", repo)).reason,
    ).toContain("#7 merges into 'main', the release");
    expect((await preBash("gh api repos/o/n/pulls/7/merge", repo)).stdout).toBe("");
  });

  test("judges a ref update, a deletion or a merge of branches like the push it is", async () => {
    expect(
      (
        await preBash(
          "gh api -X PATCH repos/o/n/git/refs/heads/main -f sha=abc -F force=true",
          repo,
        )
      ).reason,
    ).toContain(RELEASE_PUSH);
    expect((await preBash("gh api -X DELETE repos/o/n/git/refs/heads/dev", repo)).reason).toContain(
      "never targets 'dev'",
    );
    expect(
      (await preBash("gh api -X PATCH repos/o/n/git/refs/heads/dev -f sha=abc", repo)).stdout,
    ).toBe("");
    expect(
      (await preBash("gh api repos/o/n/merges -f base=main -f head=dev", repo)).reason,
    ).toContain(RELEASE_PUSH);
    expect((await preBash("gh api repos/o/n/git/refs/heads/main", repo)).stdout).toBe("");
  });

  test("refuses a GraphQL mutation that merges or moves a ref, and an endpoint known at run time", async () => {
    const merge = await preBash(
      "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_x\"}) { clientMutationId } }'",
      repo,
    );

    expect(merge.reason).toContain(UNRESOLVED_MERGE);
    expect(
      (
        await preBash(
          "gh api graphql -f query='mutation { mergeBranch(input: {}) { clientMutationId } }'",
          repo,
        )
      ).decision,
    ).toBe("deny");
    expect(
      (
        await preBash(
          "gh api graphql -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
          repo,
        )
      ).reason,
    ).toContain(UNRESOLVED_PUSH);
    expect((await preBash('gh api -X PUT "repos/o/n/pulls/$N/merge"', repo)).reason).toContain(
      UNRESOLVED_MERGE,
    );
    expect(
      (
        await preBash(
          'gh api graphql -f query=\'query { repository(owner: "o", name: "n") { mergeCommitAllowed } }\'',
          repo,
        )
      ).stdout,
    ).toBe("");
  });
});

const GATED = JSON.stringify({
  profile: {
    landing: { trunk: "dev", release: "main", by: "action" },
    approvals: {
      workflows: { "release.yml": ["on publie", "publie", "release"] },
      labels: { "ok-humain": ["ok #{pr}", "ok pour la #{pr}"] },
    },
  },
});

function typed(text: string): Record<string, unknown> {
  return record("typed", [["Fix the date parser.", text]]);
}

const GATED_COMMANDS = [
  "gh workflow run release.yml --ref dev",
  "gh api -X POST repos/o/n/actions/workflows/release.yml/dispatches -f ref=dev",
  "gh pr edit 12 --add-label ok-humain",
  "gh api -X POST repos/o/n/issues/12/labels -f 'labels[]=ok-humain'",
];

describe("pre-bash where the landing action moves the trunk and the human's words open the gated doors", () => {
  let repo = "";
  let transcript = "";

  /** The session's transcript, these records in it, each stamped one second after the one before. */
  function session(...items: Record<string, unknown>[]): void {
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(
      transcript,
      items
        .map((item, index) =>
          JSON.stringify({ ...item, timestamp: new Date(Date.now() + index * 1000).toISOString() }),
        )
        .join("\n") + "\n",
    );
  }

  function run(command: string, extra: Record<string, unknown> = {}): Promise<Output> {
    return preBash(command, repo, {
      transcript_path: transcript,
      prompt_id: "p-fixture",
      ...extra,
    });
  }

  beforeEach(() => {
    repo = makeRepo(
      "gated",
      {
        [CONFIG_RELATIVE_PATH]: GATED,
        ".github/workflows/release.yml": "name: Release\non: workflow_dispatch\n",
      },
      "git@github.com:o/n.git",
    );
    transcript = path.join(temp.dir, "projects", `${SESSION}.jsonl`);
  });

  test("refuses a push to the trunk, plain or through gh api, and lets a task branch through", async () => {
    expect((await run("git push origin dev")).reason).toBe(
      "agent-hooks: 'dev' moves only through the landing action, never by an agent's push. Push your task branch and open a pull request to 'dev': the landing action fast-forwards 'dev' to its head once its run is green.",
    );
    expect((await run("gh api -X PATCH repos/o/n/git/refs/heads/dev -f sha=abc")).reason).toContain(
      "moves only through the landing action",
    );
    expect((await run("git push -u origin fix/x")).stdout).toBe("");
  });

  test("refuses gh pr merge into the trunk: the action lands it", async () => {
    fakeGh({ pr: GREEN_PR, checks: GREEN_CHECKS });

    expect((await run("gh pr merge 7 --rebase")).reason).toContain(
      "#7 lands on 'dev' through the landing action alone",
    );
  });

  test("refuses each gated door while the human's latest message does not ask for it", async () => {
    session(typed("Fix the date parser."));

    const reasons = await Promise.all(
      GATED_COMMANDS.map(async (command) => (await run(command)).reason),
    );

    expect(reasons).toEqual([
      `agent-hooks: dispatching release.yml is the human's decision, and the human's latest message does not say so (it would hold one of "on publie", "publie", "release"). Ask the human whether to run it, and dispatch it once their own message says so.`,
      expect.stringContaining("dispatching release.yml is the human's decision"),
      `agent-hooks: the label ok-humain on #12 is the human's ok on that pull request, and the human's latest message does not say so (it would open a line with one of "ok #12", "ok pour la #12"). Ask the human for their ok on #12, and add the label once their own message gives it.`,
      expect.stringContaining("the label ok-humain on #12 is the human's ok"),
    ]);
  });

  test("lets the dispatch through when the human's latest message asks for a release, in each form", async () => {
    session(typed("Fix the date parser."), typed("C'est bon, on publie."));

    for (const command of [
      ...GATED_COMMANDS.slice(0, 2),
      "gh workflow run Release",
      "gh workflow run .github/workflows/release.yml",
    ]) {
      expect((await run(command)).stdout).toBe("");
    }

    expect((await run(GATED_COMMANDS[2] ?? "")).decision).toBe("deny");
  });

  test("lets the label through for the pull request the human's latest message approves, and no other", async () => {
    session(typed("ok pour la #12"));

    expect((await run("gh pr edit 12 --add-label ok-humain")).stdout).toBe("");
    expect((await run("gh issue edit 12 --add-label bug,ok-humain")).stdout).toBe("");
    expect((await run(GATED_COMMANDS[3] ?? "")).stdout).toBe("");
    expect((await run("gh pr edit 13 --add-label ok-humain")).reason).toContain(
      "the label ok-humain on #13",
    );
    expect((await run("gh pr edit --add-label ok-humain")).reason).toContain(
      "this command does not name each it labels by its number",
    );
    expect((await run("gh pr create --base dev --label ok-humain")).reason).toContain(
      "this command does not name each it labels by its number",
    );
  });

  test("an older approval does not count once the human wrote since", async () => {
    session(typed("on publie"), typed("ok #12"), typed("attends, pas encore"));

    expect((await run(GATED_COMMANDS[0] ?? "")).decision).toBe("deny");
    expect((await run(GATED_COMMANDS[2] ?? "")).decision).toBe("deny");
  });

  test("a message from a tool, a task, a peer session, a teammate or an approved plan is no approval", async () => {
    const words = "on publie, ok #12";

    session(
      typed("Fix the date parser."),
      record("notified-user", [["3 findings.", words]]),
      record("peer", [["Done.", words]]),
      record("lead", [["Go for step 2.", words]]),
      record("approved-plan", [["# Fix the date parser", words]]),
      record("skill-review-forked", [["running in the background", words]]),
      record("say", [["The parser is fixed; committing.", words]]),
    );

    for (const command of GATED_COMMANDS) {
      expect((await run(command)).decision).toBe("deny");
    }
  });

  test("a subagent reads the human's messages in its session's transcript", async () => {
    session(typed("on publie"));

    expect((await run(GATED_COMMANDS[0] ?? "", { agent_id: "a1" })).stdout).toBe("");
  });

  test("refuses when the transcript cannot tell the human's latest message", async () => {
    expect((await preBash(GATED_COMMANDS[0] ?? "", repo)).reason).toContain(
      "the guard cannot read the human's latest message (the hook received no transcript_path)",
    );

    session(typed("on publie"));

    expect((await run(GATED_COMMANDS[0] ?? "", { prompt_id: "p-later" })).reason).toContain(
      "the transcript does not hold this turn's prompt yet",
    );
  });

  test("leaves another workflow, another label, another repository and the reads alone", async () => {
    for (const command of [
      "gh workflow run ci.yml --ref fix/x",
      "gh pr edit 12 --add-label bug",
      "gh workflow run release.yml --repo other/repo",
      "gh pr edit 12 --add-label ok-humain -R other/repo",
      "gh workflow view release.yml && gh pr view 12 --json labels",
      "gh api repos/o/n/issues/12/labels",
    ]) {
      expect((await run(command)).stdout).toBe("");
    }
  });

  test("a review's bypasses stay refused: --repo from outside, several numbers, other label mutations, unread endpoints, a commented name", async () => {
    session(typed("ok #12"));
    writeRepoFile(
      repo,
      ".github/workflows/release.yml",
      "name: Release # the release\non: workflow_dispatch\n",
    );

    for (const command of [
      "cd /tmp && gh workflow run release.yml --repo o/n",
      "cd /tmp && gh pr edit 13 --add-label ok-humain -R o/n",
      "gh issue edit 12 13 --add-label ok-humain",
      "gh issue edit 12 https://github.com/o/n/pull/13 --add-label ok-humain",
      `gh api graphql -f query='mutation{updatePullRequest(input:{pullRequestId:"P",labelIds:["L"]}){clientMutationId}}'`,
      "gh api -X POST repos/o/n/actions/workflows/.github%2Fworkflows%2Frelease.yml/dispatches -f ref=dev",
      "gh api -X POST repositories/1/actions/workflows/release.yml/dispatches -f ref=dev",
      "gh api -X POST repositories/1/issues/12/labels -f 'labels[]=ok-humain'",
      "gh workflow run Release",
      "gh api -X POST 'repos/o/n/actions/workflows/release.yml/dispatches#x' -f ref=dev",
      "gh api -X POST 'repos/o/n/issues/13/labels#x' -f 'labels[]=ok-humain'",
      "gh api -X PATCH 'repos/o/n/git/refs/heads/dev#x' -f sha=abc",
    ]) {
      expect({ command, decision: (await run(command)).decision }).toStrictEqual({
        command,
        decision: "deny",
      });
    }

    expect((await run("cd /tmp && gh pr edit 12 --add-label ok-humain -R o/n")).stdout).toBe("");
    expect((await run("gh api -X POST repos/o/n/labels -f name=bug")).stdout).toBe("");
  });

  test("refuses a workflow named by an id it cannot match to a file", async () => {
    expect((await run("gh workflow run 4242")).reason).toContain(
      "the guard cannot tell which workflow the id 4242 names",
    );
  });

  test("an invalid profile.approvals refuses the gated doors, naming the error", async () => {
    writeRepoFile(
      repo,
      CONFIG_RELATIVE_PATH,
      JSON.stringify({ profile: { approvals: { labels: { "ok-humain": ["ok"] } } } }),
    );

    expect((await run(GATED_COMMANDS[2] ?? "")).reason).toContain(
      "The landing guard cannot read this repository's profile.approvals, so it refuses a label",
    );
  });
});

describe("pre-bash without the opt-in keys keeps the trunk and the gated doors open", () => {
  test("with profile.landing alone, or no profile at all", async () => {
    const profiled = makeRepo(
      "landing-only",
      { [CONFIG_RELATIVE_PATH]: PROFILE },
      "git@github.com:o/n.git",
    );

    const plain = makeRepo("no-profile", {}, "git@github.com:o/private.git");
    fakeGh({ repo: { visibility: "PRIVATE", defaultBranchRef: { name: "main" } } });

    for (const repo of [profiled, plain]) {
      for (const command of [
        ...GATED_COMMANDS,
        "git push origin dev",
        "gh pr create --label ok-humain",
      ]) {
        expect((await preBash(command, repo)).stdout).toBe("");
      }
    }
  });
});

describe("pre-bash lets the forms an agent ordinarily writes through", () => {
  let repo = "";

  beforeEach(() => {
    repo = makeRepo(
      "everyday",
      { [CONFIG_RELATIVE_PATH]: PROFILE, "scripts/release.ts": "" },
      "git@github.com:o/n.git",
    );
    git(repo, "checkout", "-q", "-b", "feature/x");
    git(repo, "update-ref", "refs/remotes/origin/feature/x", "HEAD");
    git(repo, "branch", "-q", "--set-upstream-to=origin/feature/x");
  });

  test.each([
    "git push origin feature/x",
    "git push",
    "git push -u origin HEAD",
    "git push origin dev",
    "git fetch origin && git rebase origin/dev && git push --force-with-lease origin feature/x",
    `git add -A && ${HEREDOC_COMMIT} && git push -u origin feature/x`,
    "git checkout -b feature/y && git push -u origin feature/y",
    "git log --grep=push --oneline && git stash push -m wip",
    'rg -n "git push" . ; echo "then git push"',
    "cat scripts/release.ts && bun x oxlint scripts/release.ts && bun ./scripts/release.ts --dry-run",
    "python3 - <<'EOF'\nprint(open('x').read().replace('git push', 'git push -u'))\nEOF",
    "systemd-run --user --scope -q -p MemoryMax=8G -- git push origin feature/x",
    "flock /tmp/agent-hooks-lock sh -c 'git push origin feature/x'",
    'GIT_SSH_COMMAND="ssh -v" git push origin feature/x',
    "node -e 'console.log(`git push ${1}`)' && python3 -c \"print('git push')\"",
    "git config push.default && git worktree remove ../gone; git push origin feature/x",
    "gh pr view 7 --json mergeable,mergeStateStatus",
  ])("allows %j", async (command) => {
    expect((await preBash(command, repo)).stdout).toBe("");
  });

  test("follows a variable assigned once, unconditionally or along an && chain", async () => {
    expect((await preBash('S=feature/x && git push origin "$S"', repo)).stdout).toBe("");
    expect(
      (await preBash(`cd ${repo} && B=feature/x && git push origin "$B"`, temp.dir)).stdout,
    ).toBe("");
  });

  test("allows a push from another directory through cd, -C or a variable the line assigns", async () => {
    expect((await preBash(`cd ${repo} && git push origin feature/x`, temp.dir)).stdout).toBe("");
    expect(
      (await preBash(`wt=${repo} && git -C "$wt" push origin feature/x`, temp.dir)).stdout,
    ).toBe("");
    expect((await preBash(`S=${repo}; cd $S; git push origin feature/x`, temp.dir)).stdout).toBe(
      "",
    );
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
      checks: GREEN_CHECKS,
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

describe("pre-bash under its deadline", () => {
  let repo = "";

  beforeEach(() => {
    repo = makeRepo("plain", {}, "https://github.com/o/n.git");
  });

  test("judges the commands of one call at once", async () => {
    // Each pr view waits until the other one has started: run one after the other, both time out.
    const gh = `#!/bin/sh
case "$1 $2 $3" in
  "pr view 7"|"pr view 8")
    touch "$FAKE_GH_DIR/started-$3"
    other=$([ "$3" = 7 ] && echo 8 || echo 7)
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      [ -f "$FAKE_GH_DIR/started-$other" ] && { cat "$FAKE_GH_DIR/pr.json"; exit 0; }
      sleep 0.1
    done
    echo "the other pr view never started" >&2; exit 1 ;;
  "pr checks"*) cat "$FAKE_GH_DIR/checks.json" ;;
  "repo view"*) cat "$FAKE_GH_DIR/repo.json" ;;
esac
`;

    fakeGh({
      repo: { visibility: "PUBLIC", defaultBranchRef: { name: "main" } },
      pr: GREEN_PR,
      checks: GREEN_CHECKS,
    });
    writeFileSync(path.join(temp.bin, "gh"), gh);

    expect((await preBash("gh pr merge 7; gh pr merge 8", repo)).stdout).toBe("");
  });

  test("lets the command through with a note when its payload cannot be read", async () => {
    const resolve = spyOn(fs.realpathSync, "native").mockImplementation(() => {
      throw new Error("EACCES");
    });

    try {
      const payload = {
        session_id: SESSION,
        cwd: repo,
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
      };

      expect(
        await runHook({ hook: "pre-bash", handler: runPreBash, harness: "claude", payload }),
      ).toBe(
        JSON.stringify({
          systemMessage: "agent-hooks: pre-bash crashed (EACCES): the command went unchecked",
        }),
      );
    } finally {
      resolve.mockRestore();
    }
  });

  test("lets the command through with a note past its deadline", async () => {
    writeFileSync(path.join(temp.bin, "gh"), "#!/bin/sh\nsleep 5\n");
    chmodSync(path.join(temp.bin, "gh"), 0o755);
    const saved = process.env["PATH"];
    process.env["PATH"] = `${temp.bin}:${saved ?? ""}`;

    try {
      const started = Date.now();

      const payload = {
        session_id: SESSION,
        cwd: repo,
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
      };

      expect(
        await runHook({
          hook: "pre-bash",
          handler: runPreBash,
          harness: "claude",
          payload,
          deadlineMs: 300,
        }),
      ).toBe(
        JSON.stringify({
          systemMessage:
            "agent-hooks: pre-bash ran past its 300 ms deadline: the command went unchecked",
        }),
      );
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      process.env["PATH"] = saved;
    }
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

/**
 * Haiku's stand-in: finds a process passage in a message that names a "review of", none otherwise; keeps what it
 * read and counts its calls; exits 1 while `claude.fail` exists.
 */
const FAKE_CLAUDE = `#!/bin/sh
input=$(cat; echo .)
input=\${input%.}
printf '%s' "$input" > "$FAKE_GH_DIR/claude.input"
echo call >> "$FAKE_GH_DIR/claude.calls"
[ -f "$FAKE_GH_DIR/claude.fail" ] && exit 1
case "$input" in
  *"review of"*) cat <<'EOF'
{"type":"result","result":"{\\"passages\\": [{\\"quote\\": \\"review of #1\\", \\"kind\\": \\"process\\"}, {\\"quote\\": \\"#1\\", \\"kind\\": \\"fact\\"}]}"}
EOF
  ;;
  *) cat <<'EOF'
{"type":"result","result":"{\\"passages\\": []}"}
EOF
  ;;
esac
`;

const JUDGED = JSON.stringify({ profile: { commitMessages: "judged" } });

const REFUSAL = [
  "agent-hooks: this commit message tells how the change came about or how it was checked, which goes in the pull request, not in the history:",
  '- "review of #1" (how the change came about)',
  "A commit message says what the code does and why, the reason in words. Rewrite these passages, or rerun exactly the same command if the message is right.",
].join("\n");

/** What the fake judge read last, or null when it never ran. */
function judgeInput(): string | null {
  const file = path.join(temp.bin, "claude.input");

  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function judgeCalls(): number {
  const file = path.join(temp.bin, "claude.calls");

  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
}

describe("pre-bash has Haiku judge an agent's commit message", () => {
  let repo = "";

  beforeEach(() => {
    repo = makeRepo("judged", { [CONFIG_RELATIVE_PATH]: JUDGED }, "git@github.com:o/n.git");
    const file = path.join(temp.bin, "claude");
    writeFileSync(file, FAKE_CLAUDE);
    chmodSync(file, 0o755);
  });

  test("refuses a message that tells how the change came about, quoting it, and lets a message of facts through in silence", async () => {
    const refused = await preBash("git commit -qm 'fix: a, from the review of #1'", repo);

    expect(refused.decision).toBe("deny");
    expect(refused.reason).toBe(REFUSAL);
    expect((await preBash("git commit -qm 'fix: read partial dates'", repo)).stdout).toBe("");
  });

  test("gives the judge the message, then the files the commit takes: the index, or every tracked change for -a", async () => {
    writeRepoFile(repo, "src/parse.ts", "x\n");
    git(repo, "add", "src/parse.ts");
    writeRepoFile(repo, "README.md", "y\n");

    await preBash("git commit -qm 'fix: a' -m 'Partial dates parse.'", repo);

    expect(judgeInput()).toBe("Message:\nfix: a\n\nPartial dates parse.\n\nFiles:\nsrc/parse.ts");

    await preBash("git commit -aqm 'fix: b'", repo);

    expect(judgeInput()).toBe("Message:\nfix: b\n\nFiles:\nREADME.md\nsrc/parse.ts");
  });

  test("lists no file on a branch with no commit yet", async () => {
    const fresh = path.join(temp.dir, "fresh");
    writeRepoFile(fresh, CONFIG_RELATIVE_PATH, JUDGED);
    git(fresh, "init", "-q");

    await preBash("git commit -qm 'fix: a'", fresh);

    expect(judgeInput()).toBe("Message:\nfix: a\n\nFiles:\n");
  });

  test("a message refused once passes unjudged on every rerun; a rewritten message is judged again", async () => {
    const command = "git commit -qm 'fix: a, from the review of #1'";

    expect((await preBash(command, repo)).decision).toBe("deny");
    expect((await preBash(command, repo)).stdout).toBe("");
    expect((await preBash(command, repo)).stdout).toBe("");
    expect(judgeCalls()).toBe(1);

    expect((await preBash("git commit -qm 'fix: a, after the review of #1'", repo)).decision).toBe(
      "deny",
    );
    expect((await preBash("git commit -qm 'fix: a'", repo)).stdout).toBe("");
    expect((await preBash(command, repo)).stdout).toBe("");
    expect(judgeCalls()).toBe(3);
  });

  test("a line whose commits were refused one after the other gets through on its rerun", async () => {
    const first = "git commit -qm 'fix: a, review of #1'";
    const both = `${first} && git commit -qm 'fix: b, review of #1'`;

    expect((await preBash(first, repo)).decision).toBe("deny");
    expect((await preBash(both, repo)).decision).toBe("deny");
    expect((await preBash(both, repo)).stdout).toBe("");
  });

  test("a refusal holds for the agent it was given to", async () => {
    const command = "git commit -qm 'fix: a, from the review of #1'";

    expect((await preBash(command, repo, { agent_id: "a2" })).decision).toBe("deny");
    expect((await preBash(command, repo)).decision).toBe("deny");
    expect((await preBash(command, repo, { agent_id: "a2" })).stdout).toBe("");
  });

  test("judges each commit of a line, and names each refused one by its subject", async () => {
    const output = await preBash(
      "git commit -qm 'fix: a, review of #1' && git commit -qm 'fix: b' && git commit -qm 'fix: c, review of #1'",
      repo,
    );

    expect(judgeCalls()).toBe(3);
    expect(output.reason).toStartWith("agent-hooks: these commit messages tell");
    expect(output.reason).toContain('In "fix: a, review of #1":');
    expect(output.reason).toContain('In "fix: c, review of #1":');
    expect(output.reason).not.toContain('In "fix: b":');
  });

  test("reads the message where git reads it: a heredoc, a file, a file under -C", async () => {
    await preBash("git commit -F - <<'EOF'\nfix: from stdin\nEOF", repo);

    expect(judgeInput()).toStartWith("Message:\nfix: from stdin\n\n");

    writeRepoFile(repo, "sub/msg.txt", "fix: from a file\n");
    await preBash("git -C sub commit -F msg.txt", repo);

    expect(judgeInput()).toStartWith("Message:\nfix: from a file\n\n");

    writeRepoFile(repo, "msgs/m", "fix: a short name\n");
    await preBash("cd msgs && git commit -F m", repo);

    expect(judgeInput()).toStartWith("Message:\nfix: a short name\n\n");
    expect(
      (await preBash("git commit -F sub/msg.txt --trailer 'Note: the review of #1'", repo)).reason,
    ).toStartWith("agent-hooks: this commit message tells");
    expect(judgeInput()).toStartWith("Message:\nfix: from a file\n\nNote: the review of #1\n\n");
  });

  test("leaves unjudged, in silence, a commit that keeps its message or makes none", async () => {
    for (const command of [
      "git commit --amend --no-edit",
      "git commit --no-edit",
      "git commit -C HEAD",
      "git commit --dry-run -m 'review of #1'",
      "bash -c 'git commit -m x'",
      "ls -la",
    ]) {
      expect((await preBash(command, repo)).stdout).toBe("");
    }

    expect(judgeInput()).toBeNull();
  });

  test("judges nothing in a repository whose profile does not ask for it", async () => {
    const plain = makeRepo("plain", {}, "git@github.com:o/n.git");

    expect((await preBash("git commit -m 'review of #1'", plain)).stdout).toBe("");
    expect(judgeInput()).toBeNull();
  });

  test("a refusal of the landing guard wins, and the judge's refusal it hid is not remembered", async () => {
    writeRepoFile(
      repo,
      CONFIG_RELATIVE_PATH,
      JSON.stringify({
        profile: { landing: { trunk: "dev", release: "main" }, commitMessages: "judged" },
      }),
    );

    const refused = await preBash(
      "git commit -qm 'review of #1' && git push origin dev:main",
      repo,
    );

    expect(refused.reason).toStartWith("agent-hooks: a push to 'main' moves the release");
    expect(existsSync(path.join(temp.stateDir, `${SESSION}.refused`))).toBe(false);
    expect(
      (await preBash("git commit -qm 'review of #1' && git push origin dev", repo)).reason,
    ).toBe(REFUSAL);
  });

  test("a judge that gives no answer lets the commit through with a note", async () => {
    writeFileSync(path.join(temp.bin, "claude.fail"), "");

    const output = await preBash("git commit -qm 'review of #1'", repo);

    expect(output.decision).toBeUndefined();
    expect(output.note).toBe(
      "agent-hooks: the commit judge gave no answer (claude -p exited 1 with no readable answer): the commit passed",
    );
  });

  test("a refusal it cannot save lets the commit through with a note, so no rerun is refused forever", async () => {
    mkdirSync(path.join(temp.stateDir, `${SESSION}.refused`), { recursive: true });

    const output = await preBash("git commit -qm 'review of #1'", repo);

    expect(output.decision).toBeUndefined();
    expect(output.note).toStartWith(
      "agent-hooks: the commit judge refused a message but could not save the refusal (",
    );
  });

  test("a message only the line's run gives goes unjudged, with a note", async () => {
    writeRepoFile(repo, "msg.txt", "fix: an older message\n");

    for (const command of [
      'git commit -m "$(cat msg.txt)"',
      'git commit -m "$MSG"',
      "git commit -m `cat msg.txt`",
      "printf 'review of #1' | git commit -F -",
      "git commit -F - <<EOF\nreview of $PR\nEOF",
      "printf 'review of #1' > msg.txt && git commit -F msg.txt",
      "printf 'review of #1' > msg.txt && git commit -F ./msg.txt",
    ]) {
      expect((await preBash(command, repo)).note).toBe(
        "agent-hooks: a commit went unjudged: part of its message is known only once the line runs",
      );
    }

    expect(judgeInput()).toBeNull();
  });

  test("a refusal keeps the landing guard's note", async () => {
    const output = await preBash("git commit -qm 'review of #1' && git push origin main", repo);

    expect(output.reason).toBe(
      `${REFUSAL}\nagent-hooks: could not read whether github.com/o/n is public (error connecting to api.github.com): the push went unchecked`,
    );
  });

  test("a refusal keeps the notes of the line's other commits", async () => {
    const output = await preBash(
      "git commit -qm 'fix: a, review of #1' && git commit -m \"$MSG\"",
      repo,
    );

    expect(output.reason).toBe(
      `${REFUSAL}\nagent-hooks: a commit went unjudged: part of its message is known only once the line runs`,
    );
  });

  test("hands a message past the argument size limit through", async () => {
    const long = `fix: a\n\n${"Partial dates parse. ".repeat(10_000)}`;

    expect((await preBash(`git commit -F - <<'EOF'\n${long}\nEOF`, repo)).stdout).toBe("");
    expect(judgeInput()).toStartWith("Message:\nfix: a\n\nPartial dates parse.");
  });

  test("a commit whose cd the walk cannot follow says so, in a repository with the key", async () => {
    expect((await preBash('cd "$NOWHERE" && git commit -m a', repo)).note).toBe(
      "agent-hooks: a commit went unjudged: an earlier cd $NOWHERE leaves its directory unknown",
    );
  });
});

describe("encode under pre-bash", () => {
  const text = 'say "hi"\nnext';

  test("an allow prints nothing, a note its systemMessage, a refusal the deny shape", () => {
    expect(encode({ kind: "allow" }, "claude", "pre-bash")).toBeNull();
    expect(encode({ kind: "note", text }, "claude", "pre-bash")).toBe(
      `{"systemMessage":${JSON.stringify(text)}}`,
    );
    expect(encode({ kind: "deny", reason: text }, "claude", "pre-bash")).toBe(
      `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":${JSON.stringify(text)}}}`,
    );
  });
});
