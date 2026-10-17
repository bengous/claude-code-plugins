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
  type Check,
  checkoutOf,
  land,
  latestChecks,
  movedOn,
  type PullRequest,
  refusalOf,
} from "./land.ts";
import { type Comment, record } from "./review-verdict.ts";

let root = "";

let origin = "";

let work = "";

let other = "";

let prFile = "";

let checksFile = "";

let commentFile = "";

let bunLog = "";

const saved = new Map<string, string | undefined>();

function git(cwd: string, ...args: string[]): string {
  // Bun.spawnSync without `env` reads the environment Bun started with, not process.env's later changes:
  // without it the fixtures' git ignores GIT_CONFIG_GLOBAL and signs every commit with the user's key.
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function setEnv(name: string, value: string) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

function clone(name: string): string {
  const path = join(root, name);

  git(root, "clone", "--quiet", origin, path);
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");

  return path;
}

function commit(cwd: string, file: string, message: string, content = `${message}\n`): string {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", message);

  return git(cwd, "rev-parse", "HEAD");
}

function green(name = "validate (scoped)"): Check {
  return {
    name,
    startedAt: "2026-10-15T10:00:00Z",
    state: "SUCCESS",
    workflow: "CI",
    event: "pull_request",
  };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    state: "OPEN",
    baseRefName: "dev",
    headRefOid: git(work, "rev-parse", "HEAD"),
    checks: [green()],
    comments: [],
    ...overrides,
  };
}

/**
 * What gh prints: the pull request to `gh pr view`, its checks to `gh pr checks`, an error when it has none. The body
 * `gh pr comment` reads is kept in `commentFile`.
 */
function serve(pr: PullRequest) {
  const { checks, ...view } = pr;

  writeFileSync(prFile, JSON.stringify(view));
  rmSync(checksFile, { force: true });

  if (checks.length > 0) writeFileSync(checksFile, JSON.stringify(checks));
}

function moveDev(): string {
  const moved = commit(other, "c.txt", "elsewhere");

  git(other, "push", "--quiet", "origin", "dev");

  return moved;
}

function why(landing: ReturnType<typeof land>): string {
  return landing.kind === "refused" ? landing.why : "";
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "land-"));
  // The fixtures run git as a fresh machine would: no hook manager, signing or push default of the user's.
  setEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  setEnv("GIT_CONFIG_NOSYSTEM", "1");

  origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=dev", "origin.git");

  work = clone("work");
  commit(work, "a.txt", "base");
  git(work, "push", "--quiet", "origin", "dev");
  git(work, "switch", "--quiet", "-c", "feature/x");
  commit(work, "b.txt", "feature");
  git(work, "push", "--quiet", "origin", "feature/x");

  other = clone("other");

  const bin = join(root, "bin");

  prFile = join(root, "pr.json");
  checksFile = join(root, "checks.json");
  commentFile = join(root, "comment.md");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'if [ "$2" = comment ]; then cat > "' + commentFile + '"; exit; fi',
      'if [ "$2" != checks ]; then cat "' + prFile + '"; exit; fi',
      'if [ -f "' + checksFile + '" ]; then cat "' + checksFile + '"; exit; fi',
      "echo \"no checks reported on the 'feature/x' branch\" >&2",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  bunLog = join(root, "bun.log");
  writeFileSync(
    join(bin, "bun"),
    ["#!/bin/sh", `echo "$PWD $*" >> "${bunLog}"`, 'exit "${FAKE_BUN_EXIT:-0}"', ""].join("\n"),
  );
  chmodSync(join(bin, "bun"), 0o755);
  setEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
});

function bunCalls(): string {
  return existsSync(bunLog) ? readFileSync(bunLog, "utf8").trim() : "";
}

function moveDevLockfile(): string {
  const moved = commit(other, "package.json", '{"name":"fixture","devDependencies":{}}');

  git(other, "push", "--quiet", "origin", "dev");

  return moved;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  saved.clear();
  rmSync(root, { recursive: true, force: true });
});

describe("land", () => {
  test("rebases the branch on a dev that moved and pushes it to dev and to its own ref", () => {
    const moved = moveDev();

    serve(pullRequest());

    const landing = land("feature/x", work);
    const head = git(work, "rev-parse", "HEAD");

    expect(landing).toEqual({ kind: "landed", dev: head, pr: 7 });
    expect(git(origin, "rev-parse", "dev")).toBe(head);
    expect(git(origin, "rev-parse", "feature/x")).toBe(head);
    expect(git(work, "rev-parse", "HEAD~1")).toBe(moved);
  });

  test("installs nothing when the rebase brings in no lockfile change", () => {
    moveDev();
    serve(pullRequest());

    expect(land("feature/x", work).kind).toBe("landed");
    expect(bunCalls()).toBe("");
  });

  test("installs the rebased lockfile before the pre-push gates read node_modules", () => {
    moveDevLockfile();
    serve(pullRequest());

    expect(land("feature/x", work).kind).toBe("landed");
    expect(bunCalls()).toBe(`${work} install --frozen-lockfile`);
  });

  test("refuses, back at the reviewed head, when the install fails", () => {
    const reviewed = git(work, "rev-parse", "HEAD");
    const moved = moveDevLockfile();

    serve(pullRequest());
    setEnv("FAKE_BUN_EXIT", "1");

    const landing = land("feature/x", work);

    expect(why(landing)).toContain("bun install --frozen-lockfile failed");
    expect(why(landing)).toContain("node_modules may be half-installed");
    expect(bunCalls().split("\n")).toEqual([
      `${work} install --frozen-lockfile`,
      `${work} install --frozen-lockfile`,
    ]);
    expect(git(work, "rev-parse", "HEAD")).toBe(reviewed);
    expect(git(origin, "rev-parse", "dev")).toBe(moved);
    expect(git(origin, "rev-parse", "feature/x")).toBe(reviewed);
  });

  test("finds the checkout holding the branch from another checkout", () => {
    git(work, "switch", "--quiet", "dev");
    git(work, "worktree", "add", "--quiet", join(root, "wt"), "feature/x");
    serve(pullRequest({ headRefOid: git(join(root, "wt"), "rev-parse", "HEAD") }));

    expect(land("feature/x", work).kind).toBe("landed");
    expect(git(origin, "rev-parse", "dev")).toBe(git(join(root, "wt"), "rev-parse", "HEAD"));
  });

  test("lands with an untracked file in the checkout", () => {
    serve(pullRequest());
    writeFileSync(join(work, "scratch.log"), "notes\n");

    expect(land("feature/x", work).kind).toBe("landed");
  });

  test.each([
    ["a red check", { checks: [{ ...green(), state: "FAILURE" }] }, "not green"],
    ["a check still running", { checks: [{ ...green(), state: "IN_PROGRESS" }] }, "still running"],
    ["no check yet", { checks: [] }, "no check reported"],
    [
      "a failed pull_request run beside a newer skipped push run of the same job",
      {
        checks: [
          { ...green(), state: "FAILURE" },
          { ...green(), state: "SKIPPED", event: "push", startedAt: "2026-10-15T11:00:00Z" },
        ],
      },
      "validate (scoped) failure",
    ],
    ["a base other than dev", { baseRefName: "feature/base" }, "gh stack"],
    ["a closed pull request", { state: "MERGED" }, "not open"],
    ["a head the pull request does not have", { headRefOid: "0".repeat(40) }, "push it"],
  ] as const)("refuses %s and leaves dev unmoved", (_, overrides, reason) => {
    const before = git(origin, "rev-parse", "dev");

    serve(pullRequest(overrides));

    const landing = land("feature/x", work);

    expect(why(landing)).toContain(reason);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });

  test("never overwrites a commit pushed to the branch since the pull request was read", () => {
    serve(pullRequest());

    const reviewed = git(work, "rev-parse", "HEAD");

    git(other, "fetch", "--quiet", "origin");
    git(other, "switch", "--quiet", "feature/x");
    const foreign = commit(other, "d.txt", "fixup from someone else");

    git(other, "push", "--quiet", "origin", "feature/x");
    moveDev();

    const landing = land("feature/x", work);

    expect(why(landing)).toContain("the push of feature/x was refused");
    expect(git(origin, "rev-parse", "feature/x")).toBe(foreign);
    expect(git(work, "rev-parse", "HEAD")).toBe(reviewed);
  });

  test("stops after the branch push when a rebase gives an e2e branch a commit its run never saw", () => {
    commit(work, "vellum/src/page.ts", "touch an e2e path");
    git(work, "push", "--quiet", "origin", "feature/x");
    const moved = moveDev();

    serve(pullRequest());

    const landing = land("feature/x", work);

    expect(why(landing)).toContain("--add-label e2e");
    expect(git(origin, "rev-parse", "feature/x")).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(origin, "rev-parse", "dev")).toBe(moved);
  });

  test("refuses tracked changes in the checkout", () => {
    serve(pullRequest());
    writeFileSync(join(work, "b.txt"), "dirty\n");

    expect(land("feature/x", work)).toEqual({
      kind: "refused",
      why: `${work} has uncommitted changes: commit or drop them, then land`,
    });
  });

  test("refuses output gh did not print as a pull request", () => {
    writeFileSync(prFile, "not json");

    expect(why(land("feature/x", work))).toContain("gh printed no pull request");
  });

  test("refuses a branch outside feature/ and fix/, dev and main included", () => {
    for (const branch of ["dev", "main", "chore/x"]) {
      expect(land(branch, work).kind).toBe("refused");
    }
  });

  test("refuses a branch no checkout holds", () => {
    expect(land("fix/nowhere", work)).toEqual({
      kind: "refused",
      why: "no checkout holds fix/nowhere: check it out, then land",
    });
  });
});

/** Ten numbered lines, the one at `changed` replaced by `text`. */
function lines(changed: number, text: string): string {
  return Array.from({ length: 10 }, (_, index) => (index === changed ? text : `line ${index}`))
    .join("\n")
    .concat("\n");
}

describe("land, a branch that touches a risky path", () => {
  const RECORD = "bun ./scripts/review-verdict.ts record feature/x";

  /** The comment `review-verdict.ts record` posted, as the owner's. */
  function posted(): Comment {
    return { body: readFileSync(commentFile, "utf8"), authorAssociation: "OWNER" };
  }

  function recordVerdict(): Comment {
    serve(pullRequest());
    expect(record("feature/x", work).kind).toBe("recorded");

    return posted();
  }

  function pushBranch() {
    git(work, "push", "--quiet", "--force", "origin", "feature/x");
  }

  beforeEach(() => {
    commit(
      other,
      ".claude/agent-hooks.jsonc",
      "review profile",
      '{ "profile": { "review": { "risky": ["risky/**"] } } }\n',
    );
    git(other, "push", "--quiet", "origin", "dev");
    git(work, "fetch", "--quiet", "origin");
    git(work, "rebase", "--quiet", "origin/dev");
    commit(work, "risky/a.ts", "risky");
    pushBranch();
  });

  test("refuses without a review verdict, naming the paths and the command that records one", () => {
    const reviewed = git(work, "rev-parse", "HEAD");
    const before = git(origin, "rev-parse", "dev");

    serve(pullRequest());

    const landing = land("feature/x", work);

    expect(why(landing)).toContain("risky/a.ts");
    expect(why(landing)).toContain(RECORD);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
    expect(git(origin, "rev-parse", "feature/x")).toBe(reviewed);
    expect(git(work, "rev-parse", "HEAD")).toBe(reviewed);
  });

  test("records the patch-id that git diff piped to git patch-id --stable gives", () => {
    serve(pullRequest());

    const recording = record("feature/x", work);
    const mergeBase = git(work, "merge-base", "origin/dev", "HEAD");

    const pipe = Bun.spawnSync(
      ["sh", "-c", `git diff ${mergeBase}..HEAD | git patch-id --stable`],
      { cwd: work, stdout: "pipe" },
    );

    const [patchId = ""] = pipe.stdout.toString().split(" ");

    expect(patchId).toMatch(/^[0-9a-f]{40}$/u);
    expect(recording).toEqual({ kind: "recorded", pr: 7, patchId });
    expect(posted().body.split("\n")[0]).toBe(`<!-- review: clean patch-id=${patchId} -->`);
  });

  test("lands with the verdict review-verdict.ts records", () => {
    const verdict = recordVerdict();

    serve(pullRequest({ comments: [verdict] }));

    expect(land("feature/x", work).kind).toBe("landed");
    expect(git(origin, "rev-parse", "dev")).toBe(git(work, "rev-parse", "HEAD"));
  });

  test("keeps the verdict through a rebase that leaves the patch as it was", () => {
    const verdict = recordVerdict();
    const moved = moveDev();

    serve(pullRequest({ comments: [verdict] }));

    expect(land("feature/x", work).kind).toBe("landed");
    expect(git(work, "rev-parse", "HEAD~2")).toBe(moved);
  });

  test("refuses a verdict recorded before the code changed", () => {
    const verdict = recordVerdict();

    commit(work, "risky/a.ts", "changed after the review");
    pushBranch();
    serve(pullRequest({ comments: [verdict] }));

    const landing = land("feature/x", work);

    expect(why(landing)).toContain("no clean review verdict");
    expect(why(landing)).toContain(RECORD);
  });

  test("refuses a verdict a rebase broke by changing the patch's context, naming the rebase", () => {
    commit(other, "risky/b.ts", "ten lines", lines(-1, ""));
    git(other, "push", "--quiet", "origin", "dev");
    git(work, "fetch", "--quiet", "origin");
    git(work, "rebase", "--quiet", "origin/dev");
    commit(work, "risky/b.ts", "change line 6", lines(6, "reviewed"));
    pushBranch();

    const verdict = recordVerdict();
    const reviewed = git(work, "rev-parse", "HEAD");

    commit(other, "risky/b.ts", "change line 3 on dev", lines(3, "context"));
    git(other, "push", "--quiet", "origin", "dev");
    serve(pullRequest({ comments: [verdict] }));

    const landing = land("feature/x", work);

    expect(why(landing)).toContain("the rebase on origin/dev changed");
    expect(why(landing)).toContain(RECORD);
    expect(git(work, "rev-parse", "HEAD")).toBe(reviewed);
  });

  test("counts no verdict posted by someone without write access", () => {
    const verdict = recordVerdict();

    serve(pullRequest({ comments: [{ ...verdict, authorAssociation: "NONE" }] }));

    expect(why(land("feature/x", work))).toContain("no clean review verdict");
  });

  test("lets a branch that touches no risky path land without a verdict", () => {
    git(work, "reset", "--quiet", "--hard", "HEAD~1");
    pushBranch();
    serve(pullRequest());

    expect(land("feature/x", work).kind).toBe("landed");
  });

  test("refuses a profile on dev that does not parse, naming it", () => {
    commit(other, ".claude/agent-hooks.jsonc", "broken profile", "{\n");
    git(other, "push", "--quiet", "origin", "dev");
    serve(pullRequest());

    expect(why(land("feature/x", work))).toContain("origin/dev:.claude/agent-hooks.jsonc");
  });
});

describe("record", () => {
  test("refuses a pull request whose head adds nothing to origin/dev", () => {
    serve(pullRequest({ headRefOid: git(work, "rev-parse", "origin/dev") }));

    expect(record("feature/x", work)).toEqual({
      kind: "refused",
      why: expect.stringContaining("changes nothing"),
    });
    expect(existsSync(commentFile)).toBe(false);
  });
});

describe("checkoutOf", () => {
  test("reads the path of the worktree whose branch matches", () => {
    const porcelain = [
      "worktree /repo\nHEAD 1111\nbranch refs/heads/dev",
      "worktree /repo/.claude/worktrees/a\nHEAD 2222\nbranch refs/heads/feature/x",
      "worktree /repo/.claude/worktrees/b\nHEAD 3333\ndetached",
    ].join("\n\n");

    expect(checkoutOf(porcelain, "feature/x")).toBe("/repo/.claude/worktrees/a");
    expect(checkoutOf(porcelain, "feature")).toBeNull();
  });
});

describe("latestChecks", () => {
  test("keeps the newest attempt of each check", () => {
    const failed = { ...green("e2e"), state: "FAILURE" };
    const rerun = { ...green("e2e"), startedAt: "2026-10-15T11:00:00Z" };

    expect(latestChecks([rerun, failed, green()])).toEqual([rerun, green()]);
  });

  test("keeps a run of each workflow and event, as gh pr checks does", () => {
    const failed = { ...green("e2e"), state: "FAILURE" };

    const skippedPush = {
      ...failed,
      state: "SKIPPED",
      event: "push",
      startedAt: "2026-10-15T11:00:00Z",
    };

    const otherWorkflow = {
      ...green("e2e"),
      workflow: "Nightly",
      startedAt: "2026-10-15T12:00:00Z",
    };

    expect(latestChecks([failed, skippedPush, otherWorkflow])).toEqual([
      failed,
      skippedPush,
      otherWorkflow,
    ]);
  });
});

describe("refusalOf", () => {
  const open: PullRequest = {
    number: 1,
    state: "OPEN",
    baseRefName: "dev",
    headRefOid: "abc",
    checks: [green(), { ...green("e2e"), state: "SKIPPED" }],
    comments: [],
  };

  test("lets a green, open pull request against dev through", () => {
    expect(refusalOf("feature/x", open, "abc")).toBeNull();
  });

  test("names every red check", () => {
    const red = {
      ...open,
      checks: [
        { ...green(), state: "FAILURE" },
        { ...green("win32 (scoped)"), state: "CANCELLED" },
      ],
    };

    expect(refusalOf("feature/x", red, "abc")).toBe(
      "checks not green on #1: validate (scoped) failure, win32 (scoped) cancelled",
    );
  });
});

describe("movedOn", () => {
  test("tells a dev that moved from a hook or a rule that refused", () => {
    expect(movedOn(" ! [rejected]        feature/x -> dev (fetch first)")).toBe(true);
    expect(movedOn(" ! [rejected]        feature/x -> dev (non-fast-forward)")).toBe(true);
    expect(movedOn("error: failed to push some refs\npre-push hook exited with code 1")).toBe(
      false,
    );
    expect(
      movedOn(
        " ! [remote rejected] feature/x -> dev (push declined due to repository rule violations)",
      ),
    ).toBe(false);
  });
});
