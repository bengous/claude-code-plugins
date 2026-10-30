import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

import type { Clock } from "./ci-wait.ts";
import { type GitHubOverrides, readGitHub, type RunSpec, serveGitHub } from "./land.fixture.ts";
import {
  addedCheckoutPath,
  changedPaths,
  checkoutOf,
  land,
  type Landing,
  movedOn,
  type PullRequest,
  refusalOf,
  samePath,
  type Tiering,
  WAITING,
  type Waiting,
} from "./land.ts";
import { type Comment, record } from "./review-verdict.ts";
import { profileSpec, riskyOf } from "./tier-floor.ts";
import { digestOf, evidenceOf, type Judge, messagesOf, tierOf } from "./tier.ts";

let root = "";

let origin = "";

let work = "";

let other = "";

let bin = "";

let githubFile = "";

let bunLog = "";

let receivedLog = "";

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

function setEnv(name: string, value: string | undefined) {
  if (!saved.has(name)) saved.set(name, process.env[name]);

  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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

/** The GitHub `gh` answers from: the pull request of feature/x, its head the one origin holds, its runs green. */
function serve(overrides: GitHubOverrides = {}) {
  serveGitHub(bin, githubFile, { origin, branch: "feature/x" }, overrides);
}

function github() {
  return readGitHub(githubFile);
}

/** The gh calls that change GitHub, the tier's labels aside, in their order. */
function edits(): readonly string[] {
  return github().calls.filter(
    (call) => (call.startsWith("pr edit") || call.startsWith("run ")) && !call.includes(" tier:"),
  );
}

/** The gh calls that put or take off a tier label, in their order. */
function tierEdits(): readonly string[] {
  return github().calls.filter((call) => call.startsWith("pr edit") && call.includes(" tier:"));
}

/** A judge that finds every change low: past the floor, the branch lands without the human. */
const LOW_JUDGE: Judge = {
  ask: () =>
    Promise.resolve(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: { tier: "low", reason: "the stub judge finds it low" },
        modelUsage: { stub: {} },
      }),
    ),
  system: "stub",
  calibration: { model: "stub", prompt: digestOf("stub"), cases: [] },
};

/** tier.ts's floor on the checkout's change, then a judge that says low. */
const floorThenLow: Tiering = (checkout) =>
  tierOf(
    evidenceOf({
      cwd: checkout,
      diff: ["origin/dev...HEAD"],
      messages: messagesOf(checkout, "origin/dev..HEAD"),
    }),
    riskyOf(checkout, "origin/dev"),
    null,
    LOW_JUDGE,
  );

const NEVER_TIERED: Tiering = () => Promise.reject(new Error("a bot branch was tiered"));

/** An hour from now: a land-ok added after any commit of the fixture. */
function later(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString();
}

/** `overrides`, the pull request carrying a land-ok the human approved after its head. */
function approved(overrides: GitHubOverrides = {}): GitHubOverrides {
  return {
    ...overrides,
    landOkAt: [later()],
    pr: { ...overrides.pr, labels: [...(overrides.pr?.labels ?? []), "land-ok"] },
  };
}

function runListings(): number {
  return github().calls.filter((call) => call.includes("/actions/workflows/ci.yml/runs?")).length;
}

/** A clock that moves only when land sleeps, `during` run at each sleep: what happens while it waits. */
function clockOf(during: () => void): Clock {
  let now = 1_000_000_000;

  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      during();

      return Promise.resolve();
    },
  };
}

function landing(
  branch = "feature/x",
  {
    during = () => {},
    tier = floorThenLow,
    ...waiting
  }: Partial<Waiting> & { during?: () => void; tier?: Tiering } = {},
): Promise<Landing> {
  return land(branch, work, { ...WAITING, clock: clockOf(during), ...waiting }, { tier });
}

function moveDev(): string {
  const moved = commit(other, "c.txt", "elsewhere");

  git(other, "push", "--quiet", "origin", "dev");

  return moved;
}

function why(landed: Landing): string {
  return landed.kind === "refused" ? landed.why : "";
}

function branchHead(): string {
  return git(work, "rev-parse", "HEAD");
}

function pushBranch() {
  git(work, "push", "--quiet", "--force", "origin", "feature/x");
}

function touchE2e() {
  commit(work, "vellum/src/page.ts", "touch an e2e path");
  pushBranch();
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

  receivedLog = join(root, "received.log");
  writeFileSync(join(origin, "hooks", "post-receive"), `#!/bin/sh\ncat >> "${receivedLog}"\n`);
  chmodSync(join(origin, "hooks", "post-receive"), 0o755);

  other = clone("other");

  bin = join(root, "bin");
  githubFile = join(root, "github.json");
  mkdirSync(bin);
  bunLog = join(root, "bun.log");
  writeFileSync(
    join(bin, "bun"),
    [
      "#!/bin/sh",
      `echo "$PWD $*" >> "${bunLog}"`,
      'if [ -n "$FAKE_BUN_DOES" ]; then sh -c "$FAKE_BUN_DOES"; fi',
      'exit "${FAKE_BUN_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "bun"), 0o755);
  setEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
});

function bunCalls(): string {
  return existsSync(bunLog) ? readFileSync(bunLog, "utf8").trim() : "";
}

/** The ref updates origin took since the fixture was set up, each `<ref> <new oid>`, a deletion's oid all zeros. */
function received(): readonly string[] {
  if (!existsSync(receivedLog)) return [];

  return readFileSync(receivedLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [, next, ref] = line.split(" ");

      return `${ref} ${next}`;
    });
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

const RED_E2E: RunSpec = { validate: "success", e2e: "failure", polls: 1 };

describe("land", () => {
  test("rebases the branch on a dev that moved and pushes it to dev and to its own ref", async () => {
    const moved = moveDev();

    serve();

    const landed = await landing();
    const head = branchHead();

    expect(landed).toEqual({ kind: "landed", dev: head, pr: 7, remote: { kind: "deleted" } });
    expect(git(origin, "rev-parse", "dev")).toBe(head);
    expect(received()).toContain(`refs/heads/feature/x ${head}`);
    expect(git(work, "rev-parse", "HEAD~1")).toBe(moved);
  });

  test("installs nothing when the rebase brings in no lockfile change", async () => {
    moveDev();
    serve();

    expect((await landing()).kind).toBe("landed");
    expect(bunCalls()).toBe("");
  });

  test("installs the rebased lockfile before the pre-push gates read node_modules", async () => {
    moveDevLockfile();
    serve();

    expect((await landing()).kind).toBe("landed");
    expect(bunCalls()).toBe(`${work} install --frozen-lockfile`);
  });

  test("refuses, back at the reviewed head, when the install fails", async () => {
    const reviewed = branchHead();
    const moved = moveDevLockfile();

    serve();
    setEnv("FAKE_BUN_EXIT", "1");

    const landed = await landing();

    expect(why(landed)).toContain("bun install --frozen-lockfile failed");
    expect(why(landed)).toContain("node_modules may be half-installed");
    expect(bunCalls().split("\n")).toEqual([
      `${work} install --frozen-lockfile`,
      `${work} install --frozen-lockfile`,
    ]);
    expect(branchHead()).toBe(reviewed);
    expect(git(origin, "rev-parse", "dev")).toBe(moved);
    expect(git(origin, "rev-parse", "feature/x")).toBe(reviewed);
  });

  test("finds the checkout holding the branch from another checkout", async () => {
    git(work, "switch", "--quiet", "dev");
    git(work, "worktree", "add", "--quiet", join(root, "wt"), "feature/x");
    serve();

    expect((await landing()).kind).toBe("landed");
    expect(git(origin, "rev-parse", "dev")).toBe(git(join(root, "wt"), "rev-parse", "HEAD"));
  });

  test("lands with an untracked file in the checkout", async () => {
    serve();
    writeFileSync(join(work, "scratch.log"), "notes\n");

    expect((await landing()).kind).toBe("landed");
  });

  test("waits for the run still going on the head, then lands", async () => {
    serve({ pushRun: { validate: "success", e2e: "skipped", polls: 3 } });

    expect((await landing()).kind).toBe("landed");
    expect(runListings()).toBe(4);
  });

  test.each([
    ["a red run", { pushRun: { validate: "failure", e2e: "skipped", polls: 0 } }, "CI is red on"],
    ["no run on its head", { pushRun: null }, "no ci.yml run showed"],
    ["a base other than dev", { pr: { baseRefName: "feature/base" } }, "gh stack"],
    ["a closed pull request", { pr: { state: "MERGED" } }, "not open"],
    ["a head the pull request does not have", { pinnedHead: "0".repeat(40) }, "push it"],
  ] satisfies [string, GitHubOverrides, string][])(
    "refuses %s and leaves dev unmoved",
    async (_, overrides, reason) => {
      const before = git(origin, "rev-parse", "dev");

      serve(overrides);

      const landed = await landing();

      expect(why(landed)).toContain(reason);
      expect(git(origin, "rev-parse", "dev")).toBe(before);
      expect(edits()).toEqual([]);
    },
  );

  test("never overwrites a commit pushed to the branch since the pull request was read", async () => {
    const reviewed = branchHead();

    git(other, "fetch", "--quiet", "origin");
    git(other, "switch", "--quiet", "feature/x");
    const foreign = commit(other, "d.txt", "fixup from someone else");

    git(other, "push", "--quiet", "origin", "feature/x");
    moveDev();
    serve({ pinnedHead: reviewed });

    const landed = await landing();

    expect(why(landed)).toContain("the push of feature/x was refused");
    expect(git(origin, "rev-parse", "feature/x")).toBe(foreign);
    expect(branchHead()).toBe(reviewed);
  });

  test.each([
    ["a commit", () => commit(work, "b.txt", "made while land waited")],
    ["an edit", () => writeFileSync(join(work, "b.txt"), "edited while land waited\n")],
  ])("refuses %s made in the checkout while CI runs, and leaves it there", async (_, made) => {
    const reviewed = branchHead();
    const before = git(origin, "rev-parse", "dev");
    let once = false;

    serve({ pushRun: { validate: "success", e2e: "skipped", polls: 1 } });

    const landed = await landing("feature/x", {
      during: () => {
        if (!once) made();

        once = true;
      },
    });

    expect(why(landed)).toMatch(/moved from .* while land ran|has uncommitted changes/u);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
    expect(git(origin, "rev-parse", "feature/x")).toBe(reviewed);
    expect(readFileSync(join(work, "b.txt"), "utf8")).toContain("while land waited");
  });

  test("refuses a commit made while the rebased lockfile installs, pushing nothing", async () => {
    const reviewed = branchHead();
    const moved = moveDevLockfile();

    serve();
    setEnv("FAKE_BUN_DOES", "echo sneaky >> b.txt && git commit -qam sneaky");

    const landed = await landing();

    expect(why(landed)).toContain("while land ran");
    expect(git(origin, "rev-parse", "feature/x")).toBe(reviewed);
    expect(git(origin, "rev-parse", "dev")).toBe(moved);
  });

  test("refuses a commit made while the branch push's hook runs, keeping it off dev", async () => {
    const moved = moveDev();
    const hook = join(work, ".git", "hooks", "pre-push");

    serve();
    writeFileSync(
      hook,
      "#!/bin/sh\nif [ ! -f .hooked ]; then touch .hooked; echo sneaky >> b.txt; git add b.txt; git commit -q -m sneaky; fi\nexit 0\n",
    );
    chmodSync(hook, 0o755);

    const landed = await landing();

    expect(why(landed)).toContain("while land ran");
    expect(git(origin, "rev-parse", "dev")).toBe(moved);
    expect(git(work, "log", "-1", "--format=%s")).toBe("sneaky");
  });

  test("resets nothing when an edit lands in the checkout while a refused push's hook runs", async () => {
    const moved = moveDev();
    const hook = join(work, ".git", "hooks", "pre-push");

    serve();
    writeFileSync(hook, '#!/bin/sh\necho "edited during the push" >> b.txt\nexit 1\n');
    chmodSync(hook, 0o755);

    const landed = await landing();

    expect(why(landed)).toContain("the push of feature/x was refused, and");
    expect(why(landed)).toContain("has uncommitted changes");
    expect(readFileSync(join(work, "b.txt"), "utf8")).toContain("edited during the push");
    expect(git(work, "rev-parse", "HEAD~1")).toBe(moved);
  });

  test("gives up on a run still going once the landing has waited an hour", async () => {
    serve({ pushRun: { validate: "success", e2e: "skipped", polls: 1_000_000 } });

    const landed = await landing("feature/x", { pollMs: 10 * 60_000 });

    expect(why(landed)).toContain("CI still runs on");
    expect(why(landed)).toContain("after the 60 min land waits at most");
    expect(why(landed)).toContain("https://github.com/o/r/actions/runs/100");
  });

  test("refuses tracked changes in the checkout", async () => {
    serve();
    writeFileSync(join(work, "b.txt"), "dirty\n");

    expect(await landing()).toEqual({
      kind: "refused",
      why: `${work} has uncommitted changes: commit or drop them, then land`,
    });
  });

  test("refuses output gh did not print as a pull request", async () => {
    serve({ garbage: "not json" });

    expect(why(await landing())).toContain("gh printed no pull request");
  });

  test("refuses a branch outside the landable names, dev and main included", async () => {
    for (const branch of ["dev", "main", "chore/x", "chore/claude-code-types-2", "renovate"]) {
      // oxlint-disable-next-line no-await-in-loop -- one branch name at a time keeps the failure on its name.
      expect(await landing(branch)).toEqual({
        kind: "refused",
        why: `${branch} is not a feature/, fix/ or renovate/ branch, or chore/claude-code-types: only those land on dev`,
      });
    }
  });

  test.each(["renovate/react-monorepo", "chore/claude-code-types"])(
    "lands the bot branch %s untiered, its own guards holding it",
    async (branch) => {
      git(work, "branch", "--quiet", "-m", branch);
      git(work, "push", "--quiet", "origin", branch);
      serveGitHub(bin, githubFile, { origin, branch });

      expect((await landing(branch, { tier: NEVER_TIERED })).kind).toBe("landed");
      expect(git(origin, "rev-parse", "dev")).toBe(branchHead());
      expect(tierEdits()).toEqual([]);
    },
  );

  test("refuses a branch neither a checkout nor origin holds", async () => {
    expect(await landing("fix/nowhere")).toEqual({
      kind: "refused",
      why: "no checkout holds fix/nowhere, and origin has no fix/nowhere: push it, then land",
    });
  });

  test("adds a checkout for a branch none holds, installs its lockfile, lands, then removes it", async () => {
    commit(work, "bun.lock", "lock the dependencies");
    pushBranch();
    git(work, "switch", "--quiet", "dev");
    serve();

    const added = join(work, ".claude", "worktrees", "land-feature-x");
    const head = git(origin, "rev-parse", "feature/x");

    expect(await landing()).toEqual({
      kind: "landed",
      dev: head,
      pr: 7,
      remote: { kind: "deleted" },
    });
    expect(bunCalls()).toBe(`${added} install --frozen-lockfile`);
    expect(existsSync(added)).toBe(false);
    expect(checkoutOf(git(work, "worktree", "list", "--porcelain"), "feature/x")).toBeNull();
  });

  test("adds the checkout from origin's branch when no local branch has its name", async () => {
    git(work, "switch", "--quiet", "dev");
    git(work, "branch", "--quiet", "-D", "feature/x");
    serve();

    const head = git(origin, "rev-parse", "feature/x");

    expect(await landing()).toEqual({
      kind: "landed",
      dev: head,
      pr: 7,
      remote: { kind: "deleted" },
    });
  });

  test("fast-forwards a clean checkout behind its pull request's head, then lands that head", async () => {
    git(other, "fetch", "--quiet", "origin");
    git(other, "switch", "--quiet", "feature/x");

    const fixed = commit(other, "d.txt", "fixed by another worker");

    git(other, "push", "--quiet", "origin", "feature/x");
    serve();

    expect(await landing()).toEqual({
      kind: "landed",
      dev: fixed,
      pr: 7,
      remote: { kind: "deleted" },
    });
    expect(branchHead()).toBe(fixed);
  });

  test("resets a clean checkout whose head a push to GitHub replaced, then lands the new head", async () => {
    const replaced = branchHead();

    git(other, "fetch", "--quiet", "origin");
    git(other, "switch", "--quiet", "feature/x");
    writeFileSync(join(other, "b.txt"), "rewritten by a fix worker's rebase\n");
    git(other, "commit", "--quiet", "--all", "--amend", "--no-edit");
    git(other, "push", "--quiet", "--force", "origin", "feature/x");

    const rewritten = git(other, "rev-parse", "HEAD");

    serve({ pushes: [{ at: "2000-01-01T00:00:00Z", before: replaced, sha: rewritten }] });

    expect(await landing()).toEqual({
      kind: "landed",
      dev: rewritten,
      pr: 7,
      remote: { kind: "deleted" },
    });
    expect(branchHead()).toBe(rewritten);
  });

  test("keeps a checkout apart from its pull request's head that GitHub never held, and refuses", async () => {
    const local = commit(work, "e.txt", "never pushed");

    git(other, "fetch", "--quiet", "origin");
    git(other, "switch", "--quiet", "feature/x");
    commit(other, "d.txt", "pushed by someone else");
    git(other, "push", "--quiet", "origin", "feature/x");
    serve();

    expect(why(await landing())).toContain("push it, then land again");
    expect(branchHead()).toBe(local);
  });

  test("refuses the types branch held where the types run recreates its worktree", async () => {
    git(
      work,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "chore/claude-code-types",
      `${work}.wt/claude-code-types`,
    );

    expect(why(await landing("chore/claude-code-types"))).toContain(
      "is where the types run recreates its worktree, under a landing: move that checkout elsewhere (git worktree move ",
    );
  });
});

describe("land, a branch that touches the e2e paths", () => {
  beforeEach(touchE2e);

  test("asks for an e2e run with the label, waits for it, then lands", async () => {
    serve(approved());

    expect((await landing()).kind).toBe("landed");
    expect(edits()).toEqual(["pr edit feature/x --add-label e2e"]);
    expect(git(origin, "rev-parse", "dev")).toBe(branchHead());
  });

  test("takes the label off first when it is on, since adding it again starts no run", async () => {
    serve(approved({ pr: { labels: ["e2e"] } }));

    expect((await landing()).kind).toBe("landed");
    expect(edits()).toEqual([
      "pr edit feature/x --remove-label e2e",
      "pr edit feature/x --add-label e2e",
    ]);
  });

  test("waits for the label's run, a second run on the head, though the first is green", async () => {
    serve(approved({ labelRun: { validate: "success", e2e: "success", polls: 1, hidden: 2 } }));

    expect((await landing()).kind).toBe("landed");
    expect(github().runs.map((run) => run.sha)).toEqual([branchHead(), branchHead()]);
  });

  test("asks for no run when the head has a green e2e already", async () => {
    serve(approved({ pushRun: { validate: "success", e2e: "success", polls: 0 } }));

    expect((await landing()).kind).toBe("landed");
    expect(edits()).toEqual([]);
  });

  test("asks for e2e on a head behind dev only once rebased, when the pull request shows that commit", async () => {
    const reviewed = branchHead();
    const moved = moveDev();

    serve(approved({ lag: 2 }));

    const landed = await landing();
    const head = branchHead();

    expect(landed).toEqual({ kind: "landed", dev: head, pr: 7, remote: { kind: "deleted" } });
    expect(head).not.toBe(reviewed);
    expect(git(work, "rev-parse", "HEAD~2")).toBe(moved);
    expect(edits()).toEqual(["pr edit feature/x --add-label e2e"]);

    const e2eRuns = github()
      .runs.filter((run) => run.outcome.e2e === "success")
      .map((run) => run.sha);

    expect(e2eRuns).toEqual([head]);
  });

  test("gives up once the waits add up to an hour", async () => {
    serve(
      approved({
        pushRun: { validate: "success", e2e: "skipped", polls: 5 },
        labelRun: { validate: "success", e2e: "success", polls: 3 },
      }),
    );

    const landed = await landing("feature/x", { pollMs: 10 * 60_000 });

    expect(why(landed)).toContain("after the 60 min land waits at most");
  });

  test("re-runs once a run red in its e2e jobs alone, then lands", async () => {
    serve(approved({ labelRun: RED_E2E }));

    expect((await landing()).kind).toBe("landed");
    expect(edits()).toEqual(["pr edit feature/x --add-label e2e", "run rerun 101 --failed"]);
  });

  test("refuses a run still red after its one re-run, naming it, and leaves dev unmoved", async () => {
    const before = git(origin, "rev-parse", "dev");

    serve(approved({ labelRun: RED_E2E, rerun: RED_E2E }));

    const landed = await landing();

    expect(why(landed)).toContain(
      "https://github.com/o/r/actions/runs/101, red again after the re-run land made",
    );
    expect(why(landed)).toContain("gh run rerun <run-id> --failed");
    expect(edits()).toEqual(["pr edit feature/x --add-label e2e", "run rerun 101 --failed"]);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });

  test("re-runs a red e2e found on the head instead of adding the label again", async () => {
    serve(approved({ pushRun: { ...RED_E2E, polls: 0 } }));

    expect((await landing()).kind).toBe("landed");
    expect(edits()).toEqual(["run rerun 100 --failed"]);
  });

  test("refuses a red run whose red is not the e2e's, with no re-run", async () => {
    serve(approved({ labelRun: { validate: "failure", e2e: "failure", polls: 1 } }));

    expect(why(await landing())).toContain("CI is red on");
    expect(edits()).toEqual(["pr edit feature/x --add-label e2e"]);
  });
});

const NULL_OID = "0".repeat(40);

function remoteBranch(): string {
  return git(origin, "branch", "--list", "feature/x");
}

function stateReads(): number {
  return github().calls.filter((call) => call === "pr view 7 --json state").length;
}

/** Lands feature/x on dev, its remote branch kept for a reason holding `reason`. */
async function landedKeeping(reason: string) {
  const landed = await landing();

  expect(landed).toEqual({
    kind: "landed",
    dev: branchHead(),
    pr: 7,
    remote: { kind: "kept", why: expect.stringContaining(reason) },
  });
  expect(git(origin, "rev-parse", "dev")).toBe(branchHead());
}

describe("land, the remote branch once landed", () => {
  test("deletes it after the push to dev, once GitHub reads the pull request merged", async () => {
    moveDev();
    serve({ mergeLag: 2 });

    const landed = await landing();
    const head = branchHead();

    expect(landed).toEqual({ kind: "landed", dev: head, pr: 7, remote: { kind: "deleted" } });
    expect(received().slice(-3)).toEqual([
      `refs/heads/feature/x ${head}`,
      `refs/heads/dev ${head}`,
      `refs/heads/feature/x ${NULL_OID}`,
    ]);
    expect(stateReads()).toBe(3);
  });

  test("keeps it while GitHub still reads the pull request open a minute after the push", async () => {
    serve({ mergeLag: 1_000_000 });

    await landedKeeping(
      "#7 reads open on GitHub, not merged: deleting feature/x now would close it unmerged",
    );
    expect(remoteBranch()).not.toBe("");
    expect(stateReads()).toBe(5);
  });

  test("keeps it while a pull request based on it is open", async () => {
    serve({ stacked: [9, 12] });

    await landedKeeping("#9, #12 open on feature/x would close with it");
    expect(remoteBranch()).not.toBe("");
  });

  test("keeps it, the landing landed, when origin refuses the delete", async () => {
    git(origin, "config", "receive.denyDeletes", "true");
    serve();

    await landedKeeping("the delete was refused:");
    expect(remoteBranch()).not.toBe("");
  });

  test("keeps it, the landing landed, when gh fails once dev took the branch", async () => {
    serve({ failing: ["pr list"] });

    await landedKeeping("gh pr list --base exited 1");
    expect(remoteBranch()).not.toBe("");
  });

  test("keeps a commit pushed to it once it landed", async () => {
    const reviewed = branchHead();
    let foreign = "";

    serve({ pinnedHead: reviewed, mergeLag: 1 });

    const landed = await landing("feature/x", {
      during: () => {
        if (foreign !== "" || git(origin, "rev-parse", "dev") !== reviewed) return;

        git(other, "fetch", "--quiet", "origin");
        git(other, "switch", "--quiet", "feature/x");
        foreign = commit(other, "d.txt", "pushed once it landed");
        git(other, "push", "--quiet", "origin", "feature/x");
      },
    });

    expect(landed).toEqual({
      kind: "landed",
      dev: reviewed,
      pr: 7,
      remote: { kind: "kept", why: expect.stringContaining("stale info") },
    });
    expect(git(origin, "rev-parse", "feature/x")).toBe(foreign);
  });

  test("leaves the local branch and the checkout holding it as they are", async () => {
    const tree = join(root, "wt");

    git(work, "switch", "--quiet", "dev");
    git(work, "worktree", "add", "--quiet", tree, "feature/x");
    serve();

    const landed = await landing();
    const head = git(tree, "rev-parse", "HEAD");

    expect(landed).toEqual({ kind: "landed", dev: head, pr: 7, remote: { kind: "deleted" } });
    expect(remoteBranch()).toBe("");
    expect(git(tree, "symbolic-ref", "HEAD")).toBe("refs/heads/feature/x");
    expect(git(work, "rev-parse", "refs/heads/feature/x")).toBe(head);
    expect(checkoutOf(git(work, "worktree", "list", "--porcelain"), "feature/x")).not.toBeNull();
  });

  test("names what it did with the remote branch on the verdict line", () => {
    // A skill added: tier.ts's floor says human, so no model is asked, and the human's land-ok lands it.
    commit(work, "skills/x/SKILL.md", "feat: a skill");
    pushBranch();
    serve(approved({ stacked: [9] }));
    setEnv("LAND_DEV_COPY", "1");

    const cli = Bun.spawnSync([process.execPath, join(import.meta.dir, "land.ts"), "feature/x"], {
      cwd: work,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(cli.stdout.toString()).toBe(
      `landed feature/x on dev at ${branchHead().slice(0, 8)} (#7); remote branch kept: #9 open on feature/x would close with it; its run on dev: gh run list --branch dev --event push --limit 1\n`,
    );
    expect(cli.exitCode).toBe(0);
  });
});

/** Ten numbered lines, the one at `changed` replaced by `text`. */
function lines(changed: number, text: string): string {
  return Array.from({ length: 10 }, (_, index) => (index === changed ? text : `line ${index}`))
    .join("\n")
    .concat("\n");
}

const RISKY_PROFILE = '{ "profile": { "review": { "risky": ["risky/**", "scripts/**"] } } }\n';

/** The comment `review-verdict.ts record` posted, as the owner's. */
function posted(): Comment {
  return { body: github().comment ?? "", authorAssociation: "OWNER" };
}

function recordVerdict(): Comment {
  serve();
  expect(record("feature/x", branchHead(), work).kind).toBe("recorded");

  return posted();
}

/** Commits `content` at `file` on dev, then rebases the branch on it. */
function onDev(file: string, message: string, content: string) {
  commit(other, file, message, content);
  git(other, "push", "--quiet", "origin", "dev");
  git(work, "fetch", "--quiet", "origin");
  git(work, "rebase", "--quiet", "origin/dev");
}

describe("land, a branch that touches a risky path", () => {
  const RECORD = "bun ./scripts/review-verdict.ts record feature/x --sha";

  beforeEach(() => {
    onDev(".claude/agent-hooks.jsonc", "review profile", RISKY_PROFILE);
    commit(work, "risky/a.ts", "risky");
    pushBranch();
  });

  test("refuses without a review verdict, naming the paths and the command that records one", async () => {
    const reviewed = branchHead();
    const before = git(origin, "rev-parse", "dev");

    serve(approved());

    const landed = await landing();

    expect(why(landed)).toContain("risky/a.ts");
    expect(why(landed)).toContain(`${RECORD} ${reviewed}`);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
    expect(git(origin, "rev-parse", "feature/x")).toBe(reviewed);
    expect(branchHead()).toBe(reviewed);
  });

  test("records the patch-id that git diff piped to git patch-id --verbatim gives", () => {
    serve(approved());

    const recording = record("feature/x", branchHead(), work);
    const mergeBase = git(work, "merge-base", "origin/dev", "HEAD");

    const pipe = Bun.spawnSync(
      ["sh", "-c", `git diff ${mergeBase}..HEAD | git patch-id --verbatim`],
      { cwd: work, stdout: "pipe" },
    );

    const [patchId = ""] = pipe.stdout.toString().split(" ");

    expect(patchId).toMatch(/^[0-9a-f]{40}$/u);
    expect(recording).toEqual({ kind: "recorded", pr: 7, patchId });
    expect(posted().body.split("\n")[0]).toBe(`<!-- review: clean patch-id=${patchId} -->`);
  });

  test("lands with the verdict review-verdict.ts records", async () => {
    const verdict = recordVerdict();

    serve(approved({ pr: { comments: [verdict] } }));

    expect((await landing()).kind).toBe("landed");
    expect(git(origin, "rev-parse", "dev")).toBe(branchHead());
  });

  test("lands with a verdict posted while it waited for CI", async () => {
    const verdict = recordVerdict();

    serve(approved({ pushRun: { validate: "success", e2e: "skipped", polls: 1 } }));

    const landed = await landing("feature/x", {
      during: () => {
        const posting = github();

        writeFileSync(
          githubFile,
          JSON.stringify({ ...posting, pr: { ...posting.pr, comments: [verdict] } }),
        );
      },
    });

    expect(landed.kind).toBe("landed");
  });

  test("keeps the verdict through a rebase that leaves the patch as it was", async () => {
    const verdict = recordVerdict();
    const moved = moveDev();

    serve(approved({ pr: { comments: [verdict] } }));

    expect((await landing()).kind).toBe("landed");
    expect(git(work, "rev-parse", "HEAD~2")).toBe(moved);
  });

  test("refuses a verdict recorded before the code changed", async () => {
    const verdict = recordVerdict();

    commit(work, "risky/a.ts", "changed after the review");
    pushBranch();
    serve(approved({ pr: { comments: [verdict] } }));

    const landed = await landing();

    expect(why(landed)).toContain("no clean review verdict");
    expect(why(landed)).toContain(`${RECORD} ${branchHead()}`);
  });

  test("refuses a verdict recorded before a change of whitespace alone", async () => {
    const verdict = recordVerdict();

    commit(work, "risky/a.ts", "indent after the review", "  risky\n");
    pushBranch();
    serve(approved({ pr: { comments: [verdict] } }));

    expect(why(await landing())).toContain("no clean review verdict");
  });

  test("refuses a verdict a rebase broke by changing the patch's context, naming the rebase", async () => {
    onDev("risky/b.ts", "ten lines", lines(-1, ""));
    commit(work, "risky/b.ts", "change line 6", lines(6, "reviewed"));
    pushBranch();

    const verdict = recordVerdict();
    const reviewed = branchHead();

    commit(other, "risky/b.ts", "change line 3 on dev", lines(3, "context"));
    git(other, "push", "--quiet", "origin", "dev");
    serve(approved({ pr: { comments: [verdict] } }));

    const landed = await landing();

    expect(why(landed)).toContain("the rebase on origin/dev changed");
    expect(why(landed)).toContain(RECORD);
    expect(branchHead()).toBe(reviewed);
  });

  test("counts no verdict posted by someone without write access", async () => {
    const verdict = recordVerdict();

    serve(approved({ pr: { comments: [{ ...verdict, authorAssociation: "NONE" }] } }));

    expect(why(await landing())).toContain("no clean review verdict");
  });

  test("lets a branch that touches no risky path land without a verdict", async () => {
    git(work, "reset", "--quiet", "--hard", "HEAD~1");
    pushBranch();
    serve(approved());

    expect((await landing()).kind).toBe("landed");
  });

  test("counts every changed path as risky while dev's profile does not parse, and says so", async () => {
    onDev(".claude/agent-hooks.jsonc", "broken profile", "{\n");
    git(work, "reset", "--quiet", "--hard", "HEAD~1");
    pushBranch();
    serve(approved());

    const landed = await landing();

    expect(why(landed)).toContain("origin/dev:.claude/agent-hooks.jsonc");
    expect(why(landed)).toContain("every path counts as risky");
    expect(why(landed)).toContain("b.txt");
  });

  test("counts every changed path as risky while dev's profile holds a misspelled key", async () => {
    onDev(
      ".claude/agent-hooks.jsonc",
      "misspelled profile",
      '{ "profile": { "reveiw": { "risky": ["risky/**"] } } }\n',
    );
    git(work, "reset", "--quiet", "--hard", "HEAD~1");
    pushBranch();
    serve(approved());

    const landed = await landing();

    expect(why(landed)).toContain("profile.reveiw");
    expect(why(landed)).toContain("every path counts as risky");
    expect(why(landed)).toContain("b.txt");
  });

  test("lands the branch that fixes dev's unreadable profile once it has a verdict", async () => {
    onDev(".claude/agent-hooks.jsonc", "broken profile", "{\n");
    commit(work, ".claude/agent-hooks.jsonc", "fix the profile", RISKY_PROFILE);
    pushBranch();

    const verdict = recordVerdict();

    serve(approved({ pr: { comments: [verdict] } }));

    expect((await landing()).kind).toBe("landed");
  });

  test("runs origin/dev's copy of the gate, so a branch whose land.ts skips it is still refused", () => {
    for (const dir of ["scripts", "agent-hooks"]) {
      cpSync(join(import.meta.dir, "..", dir), join(other, dir), { recursive: true });
    }

    git(other, "add", "scripts", "agent-hooks");
    git(other, "commit", "--quiet", "-m", "the scripts");
    git(other, "push", "--quiet", "origin", "dev");
    git(work, "fetch", "--quiet", "origin");
    git(work, "rebase", "--quiet", "origin/dev");

    const script = join(work, "scripts", "land.ts");
    const gated = readFileSync(script, "utf8");

    const skipped = gated.replace(
      "const review = reviewRefusal(",
      "const review = null && reviewRefusal(",
    );

    expect(skipped).not.toBe(gated);
    commit(work, "scripts/land.ts", "skip the gate", skipped);
    pushBranch();
    serve(approved());

    const before = git(origin, "rev-parse", "dev");

    // A landing's pre-push runs this suite with LAND_DEV_COPY set: inherited, it would skip the dev copy under test.
    setEnv("LAND_DEV_COPY", undefined);

    const cli = Bun.spawnSync([process.execPath, script, "feature/x"], {
      cwd: work,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(cli.stderr.toString()).toContain("no clean review verdict");
    expect(cli.exitCode).toBe(1);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });
});

const HUMAN_STUB: Tiering = () => Promise.resolve({ tier: "human", reason: "a hook matches more" });

/** A skill added on the branch: the floor sends it to the human. */
function addSkill() {
  commit(work, "skills/x/SKILL.md", "feat: a skill");
  pushBranch();
}

describe("land, the tier", () => {
  test("refuses a human branch without the human's land-ok before any wait, labelled tier:human", async () => {
    addSkill();
    serve();

    const before = git(origin, "rev-parse", "dev");

    expect(await landing()).toEqual({
      kind: "refused",
      why: "#7 is tier:human (adds, removes or renames a plugin component: skills/x/SKILL.md), with no land-ok label: it lands once the human types « land #7 » in a session; stop",
    });
    expect(runListings()).toBe(0);
    expect(tierEdits()).toEqual(["pr edit feature/x --add-label tier:human"]);
    expect(github().calls).toContain(
      "label create tier:human --force --color D93F0B --description Waits for the human's land #N",
    );
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });

  test("lands a human branch with a land-ok added after its head", async () => {
    addSkill();
    serve(approved());

    expect((await landing()).kind).toBe("landed");
    expect(git(origin, "rev-parse", "dev")).toBe(branchHead());
  });

  test("refuses a land-ok the human gave to an earlier head, whatever its commit's date", async () => {
    const earlier = branchHead();

    addSkill();
    serve({
      landOkAt: ["2050-01-01T00:00:00Z"],
      pushes: [
        { at: "2000-01-01T00:00:00Z", sha: earlier },
        { at: "2100-01-01T00:00:00Z", sha: branchHead() },
      ],
      pr: { labels: ["land-ok"] },
    });

    expect(why(await landing())).toContain(
      `with a land-ok added at 2050-01-01T00:00:00Z for ${earlier.slice(0, 8)}, whose change is not that of its head`,
    );
  });

  test("refuses a land-ok added before any push of the branch", async () => {
    addSkill();
    serve({ landOkAt: ["1990-01-01T00:00:00Z"], pr: { labels: ["land-ok"] } });

    expect(why(await landing())).toContain("before any push of feature/x GitHub lists");
  });

  test("keeps the human's land-ok through a rebase that leaves the change as it was", async () => {
    addSkill();

    const okHead = branchHead();

    moveDev();
    git(work, "fetch", "--quiet", "origin");
    git(work, "rebase", "--quiet", "origin/dev");
    pushBranch();
    serve({
      landOkAt: ["2050-01-01T00:00:00Z"],
      pushes: [
        { at: "2000-01-01T00:00:00Z", sha: okHead },
        { at: "2100-01-01T00:00:00Z", sha: branchHead() },
      ],
      pr: { labels: ["land-ok"] },
    });

    expect(branchHead()).not.toBe(okHead);
    expect((await landing()).kind).toBe("landed");
  });

  test("refuses a land-ok taken off while CI ran", async () => {
    addSkill();
    serve(approved({ pushRun: { validate: "success", e2e: "skipped", polls: 1 } }));

    const landed = await landing("feature/x", {
      during: () => {
        const read = github();

        writeFileSync(
          githubFile,
          JSON.stringify({ ...read, pr: { ...read.pr, labels: ["tier:human"] } }),
        );
      },
    });

    expect(why(landed)).toContain("#7 is tier:human");
    expect(runListings()).toBeGreaterThan(0);
  });

  test("labels a low branch tier:low and lands it unattended", async () => {
    serve();

    expect((await landing()).kind).toBe("landed");
    expect(tierEdits()).toEqual(["pr edit feature/x --add-label tier:low"]);
  });

  test("keeps a branch human once a pass labelled it so, whatever the judge says now", async () => {
    serve({ pr: { labels: ["tier:human"] } });

    expect(why(await landing())).toBe(
      "#7 is tier:human (its tier:human label, left by an earlier pass; tier.ts now says low: the stub judge finds it low), with no land-ok label: it lands once the human types « land #7 » in a session; stop",
    );
    expect(tierEdits()).toEqual([]);
  });

  test("raises a branch labelled tier:low to tier:human, taking the low label off", async () => {
    serve({ pr: { labels: ["tier:low"] } });

    expect(why(await landing("feature/x", { tier: HUMAN_STUB }))).toContain(
      "#7 is tier:human (a hook matches more)",
    );
    expect(tierEdits()).toEqual([
      "pr edit feature/x --remove-label tier:low",
      "pr edit feature/x --add-label tier:human",
    ]);
  });

  test("refuses a low branch while a red-dev issue is open", async () => {
    serve({ redDev: [41] });

    expect(await landing()).toEqual({
      kind: "refused",
      why: "dev is red (#41): no unattended landing until it is green",
    });
  });

  test("lands a low branch with the human's land-ok while dev is red: it fixes the red", async () => {
    serve(approved({ redDev: [41] }));

    expect((await landing()).kind).toBe("landed");
  });

  test("reads the tier once per landing", async () => {
    let asked = 0;

    const tier: Tiering = () => {
      asked += 1;

      return Promise.resolve({ tier: "low", reason: "counted" });
    };

    serve();

    expect((await landing("feature/x", { tier })).kind).toBe("landed");
    expect(asked).toBe(1);
  });
});

describe("addedCheckoutPath", () => {
  test("puts the checkout under the main worktree's .claude/worktrees", () => {
    const porcelain =
      "worktree /repo\nHEAD 1111\nbranch refs/heads/dev\n\nworktree /repo/wt\nHEAD 2";

    expect(addedCheckoutPath(porcelain, "fix/12-a")).toBe(
      join("/repo", ".claude", "worktrees", "land-fix-12-a"),
    );
  });
});

describe("record", () => {
  test("refuses a pull request whose head adds nothing to origin/dev", () => {
    const base = git(work, "rev-parse", "origin/dev");

    serve({ pinnedHead: base });

    expect(record("feature/x", base, work)).toEqual({
      kind: "refused",
      why: expect.stringContaining("changes nothing"),
    });
    expect(github().comment).toBeNull();
  });

  test("refuses a reviewed sha that is not the pull request's head, posting nothing", () => {
    const reviewed = branchHead();

    commit(work, "b.txt", "pushed after the review");
    pushBranch();
    serve();

    expect(record("feature/x", reviewed, work)).toEqual({
      kind: "refused",
      why: expect.stringContaining(`not ${reviewed.slice(0, 8)}`),
    });
    expect(github().comment).toBeNull();
  });
});

describe("riskyOf", () => {
  test("reads no risky path from a revision without the profile file", () => {
    expect(riskyOf(work, "origin/dev")).toEqual({ kind: "read", risky: [] });
  });

  test("reads a revision it cannot resolve as unreadable, never as no profile", () => {
    expect(riskyOf(work, "origin/nowhere").kind).toBe("unreadable");
  });

  test("names the profile file as git does, with forward slashes", () => {
    expect(profileSpec("origin/dev")).toBe("origin/dev:.claude/agent-hooks.jsonc");
  });
});

describe("changedPaths", () => {
  test("fails on a diff git cannot compute, never reads it as no change", () => {
    expect(changedPaths(work, "origin/nowhere").kind).toBe("failed");
    expect(changedPaths(work, "origin/dev")).toEqual({ kind: "read", paths: ["b.txt"] });
  });

  test("reads the branch's own paths, not those dev took since it forked", () => {
    moveDev();
    git(work, "fetch", "--quiet", "origin");

    expect(changedPaths(work, "origin/dev")).toEqual({ kind: "read", paths: ["b.txt"] });
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

describe("samePath", () => {
  test("holds a path git spells with other separators or a redundant segment as the same", () => {
    const types = "C:/Users/me/repo.wt/claude-code-types";

    expect(samePath(types, "C:\\Users\\me\\repo.wt/claude-code-types", win32.resolve)).toBe(true);
    expect(samePath(types, "C:\\Users\\me\\repo.wt\\other", win32.resolve)).toBe(false);
    expect(
      samePath("/repo.wt/claude-code-types", "/repo.wt/./claude-code-types", posix.resolve),
    ).toBe(true);
  });
});

describe("refusalOf", () => {
  const open: PullRequest = {
    number: 1,
    state: "OPEN",
    baseRefName: "dev",
    headRefOid: "abc",
    labels: [],
    comments: [],
  };

  test("lets an open pull request against dev through", () => {
    expect(refusalOf(open)).toBeNull();
  });

  test("names a pull request closed or stacked on another branch", () => {
    expect(refusalOf({ ...open, state: "CLOSED" })).toBe("#1 is closed, not open");
    expect(refusalOf({ ...open, baseRefName: "feature/base" })).toContain("gh stack");
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
