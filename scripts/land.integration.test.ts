import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

import { tryLock } from "./headless/flock.ts";
import {
  type GitHubOverrides,
  type LayerSpec,
  readGitHub,
  type RunSpec,
  serveGitHub,
} from "./land.fixture.ts";
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
  tierScript,
  WAITING,
  type Waiting,
} from "./land.ts";
import type { Clock } from "./landing/ci-wait.ts";
import { lockPaths } from "./landing/landing-lock.ts";
import { type Comment, record } from "./landing/review-verdict.ts";
import { profileSpec, riskyOf } from "./landing/tier-floor.ts";
import { digestOf, evidenceOf, type Judge, messagesOf, tierOf } from "./landing/tier.ts";

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

/** tier.ts's floor on the change from the base to the head it is given, then a judge that says low. */
const floorThenLow: Tiering = (checkout, _, base, head) =>
  tierOf(
    evidenceOf({
      cwd: checkout,
      diff: [`${base}...${head}`],
      messages: messagesOf(checkout, `${base}..${head}`),
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
  setEnv("LANDING_LOCK_DIR", join(root, "locks"));
  // A real landing's pre-push runs this suite with its own pid set here.
  setEnv("LANDING_LOCK_HOLDER", undefined);

  origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=dev", "origin.git");

  work = clone("work");
  commit(work, "a.txt", "base");
  git(work, "push", "--quiet", "origin", "dev");
  git(work, "switch", "--quiet", "-c", "feature/x");
  commit(work, "b.txt", "feature");
  git(work, "push", "--quiet", "origin", "feature/x");

  receivedLog = join(root, "received.log");
  writeFileSync(
    join(origin, "hooks", "post-receive"),
    `#!/bin/sh\n{ echo ---; cat; } >> "${receivedLog}"\n`,
  );
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

/** The pushes origin took since the fixture was set up, each its ref updates `<ref> <new oid>`, a deletion's all zeros. */
function receives(): readonly (readonly string[])[] {
  if (!existsSync(receivedLog)) return [];

  return readFileSync(receivedLog, "utf8")
    .split("---\n")
    .filter((push) => push.trim() !== "")
    .map((push) =>
      push
        .trim()
        .split("\n")
        .map((line) => {
          const [, next, ref] = line.split(" ");

          return `${ref} ${next}`;
        }),
    );
}

/** The ref updates origin took since the fixture was set up, every push's in their order. */
function received(): readonly string[] {
  return receives().flat();
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
    [
      "a base no open pull request heads",
      { pr: { baseRefName: "feature/base" } },
      "#7 is based on feature/base, which has no open pull request: gh pr edit 7 --base dev once feature/base is on dev, or open one",
    ],
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

/** The fixture's landing lock taken by another landing, its holder file naming it: the descriptor that holds it. */
function holdLock(): number {
  const paths = lockPaths(origin);

  mkdirSync(dirname(paths.lock), { recursive: true });

  const fd = openSync(paths.lock, "a");

  expect(tryLock(fd, "exclusive")).toBe(true);
  writeFileSync(
    paths.holder,
    JSON.stringify({ pid: 4242, branch: "feature/other", since: "2026-11-02T10:00:00.000Z" }),
  );

  return fd;
}

function lockFree(): boolean {
  const fd = openSync(lockPaths(origin).lock, "a");

  try {
    return tryLock(fd, "exclusive");
  } finally {
    closeSync(fd);
  }
}

/** A pre-push hook in `cwd` that runs the landing lock's check on git's remote URL, as lefthook's does. */
function lockChecked(cwd: string) {
  const hook = join(cwd, ".git", "hooks", "pre-push");
  const check = join(import.meta.dir, "landing", "lock-check.ts");

  writeFileSync(hook, `#!/bin/sh\nexec '${process.execPath}' '${check}' "$2"\n`);
  chmodSync(hook, 0o755);
}

describe("land, the landing lock", () => {
  test("waits for the landing that holds it, listing no run before it is free", async () => {
    const held = holdLock();
    let sleeps = 0;
    let listedWhileHeld = -1;

    serve();

    const landed = await landing("feature/x", {
      during: () => {
        sleeps += 1;

        if (sleeps !== 2) return;

        listedWhileHeld = runListings();
        closeSync(held);
      },
    });

    expect(landed.kind).toBe("landed");
    expect(listedWhileHeld).toBe(0);
    expect(runListings()).toBeGreaterThan(0);
  });

  test("reads the tier again once it holds the lock, which a land-ok can outlast", async () => {
    addSkill();

    const held = holdLock();
    let sleeps = 0;

    serve(approved());

    const landed = await landing("feature/x", {
      during: () => {
        sleeps += 1;

        if (sleeps !== 1) {
          if (sleeps === 2) closeSync(held);

          return;
        }

        const read = github();

        writeFileSync(
          githubFile,
          JSON.stringify({ ...read, pr: { ...read.pr, labels: ["tier:human"] } }),
        );
      },
    });

    expect(why(landed)).toContain("#7 is tier:human");
    expect(why(landed)).toContain("with no land-ok label");
    expect(runListings()).toBe(0);
  });

  test("refuses once the holder keeps it past the wait, naming it, and leaves dev unmoved", async () => {
    const held = holdLock();
    const before = git(origin, "rev-parse", "dev");

    serve();

    expect(await landing("feature/x", { timeoutMs: 12_000 })).toEqual({
      kind: "refused",
      why: "dev is being landed by pid 4242 (feature/other) since 2026-11-02T10:00:00.000Z: land again",
    });
    expect(git(origin, "rev-parse", "dev")).toBe(before);
    expect(runListings()).toBe(0);
    closeSync(held);
  });

  test("releases it once the landing ends, refused or landed", async () => {
    serve({ pushRun: { validate: "failure", e2e: "skipped", polls: 0 } });

    expect(why(await landing())).toContain("CI is red on");
    expect(lockFree()).toBe(true);
    expect(existsSync(lockPaths(origin).holder)).toBe(false);

    serve();

    expect((await landing()).kind).toBe("landed");
    expect(lockFree()).toBe(true);
  });

  test("names its pid to the pre-push check of its own push to dev, which lets it through", async () => {
    lockChecked(work);
    moveDev();
    serve();

    expect((await landing()).kind).toBe("landed");
    expect(git(origin, "rev-parse", "dev")).toBe(branchHead());
  });

  test("has the pre-push check refuse another push to dev while it holds the lock", () => {
    const held = holdLock();

    lockChecked(other);
    commit(other, "c.txt", "inline");

    const pushed = Bun.spawnSync(["git", "-C", other, "push", "--quiet", "origin", "dev"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(pushed.stderr.toString()).toContain(
      "pre-push: a landing holds dev (pid 4242 (feature/other) since 2026-11-02T10:00:00.000Z)",
    );
    expect(pushed.exitCode).not.toBe(0);
    closeSync(held);
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
  const RECORD = "bun ./scripts/landing/review-verdict.ts record feature/x --sha";

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

  test("tiers through tier.ts the change from the base it is given to the head it is given", async () => {
    serve();

    const dev = git(work, "rev-parse", "origin/dev");

    expect(await tierScript(work, 7, "origin/dev", branchHead())).toEqual({
      tier: "human",
      reason: "touches a risky path: risky/a.ts",
    });
    expect(await tierScript(work, 7, branchHead(), branchHead())).toEqual({
      tier: "human",
      reason: "the change touches no file",
    });
    expect(await tierScript(work, 7, "origin/dev", dev)).toEqual({
      tier: "human",
      reason: "the change touches no file",
    });
  });

  test("refuses without a verdict before it lists any run or takes the lock", async () => {
    serve(approved());

    expect(why(await landing())).toContain("no clean review verdict");
    expect(runListings()).toBe(0);
    expect(existsSync(lockPaths(origin).lock)).toBe(false);
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
    for (const dir of ["scripts", "agent-hooks", "tools"]) {
      cpSync(join(import.meta.dir, "..", dir), join(other, dir), { recursive: true });
    }

    // dev's copy imports a module outside those three directories: it runs only from dev's whole tree.
    const devLand = join(other, "scripts", "land.ts");

    writeFileSync(join(other, "docs.ts"), "export const ON_DEV = true;\n");
    writeFileSync(devLand, `${readFileSync(devLand, "utf8")}\nimport "../docs.ts";\n`);
    git(other, "add", "scripts", "agent-hooks", "tools", "docs.ts");
    git(other, "commit", "--quiet", "-m", "the scripts");
    git(other, "push", "--quiet", "origin", "dev");
    git(work, "fetch", "--quiet", "origin");
    git(work, "rebase", "--quiet", "origin/dev");

    const script = join(work, "scripts", "land.ts");
    const gated = readFileSync(script, "utf8");

    // Both reads of the verdict skipped, the one before the wait and the one after the rebase: run, this copy would land.
    const skipped = gated
      .replace("const review = reviewRefusal(", "const review = null && reviewRefusal(")
      .replace("const verdict = reviewRefusal(", "const verdict = null && reviewRefusal(");

    expect(skipped.match(/null && reviewRefusal\(/gu)).toHaveLength(2);
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
    expect(github().calls).toContain(
      "label create land-ok --force --color 5319E7 --description The human typed land #N in a session",
    );
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });

  test("lands a human branch with a land-ok added after its head", async () => {
    addSkill();
    serve(approved());

    expect((await landing()).kind).toBe("landed");
    expect(git(origin, "rev-parse", "dev")).toBe(branchHead());
  });

  test("takes off a land-ok the human gave to an earlier head, whatever its commit's date, and names the commits since", async () => {
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

    const compare = `https://github.com/o/r/compare/${earlier}...${branchHead()}`;

    expect(why(await landing())).toContain(
      `with a land-ok given to ${earlier.slice(0, 8)}, whose change is not that of its head ${branchHead().slice(0, 8)}: the label is off; 1 commit since, to read at ${compare}`,
    );
    expect(edits()).toEqual(["pr edit feature/x --remove-label land-ok"]);
    expect(github().pr.labels).not.toContain("land-ok");
    expect(github().calls.filter((call) => call.startsWith("pr comment"))).toHaveLength(1);
    expect(github().comment).toBe(
      [
        `<!-- land-ok: void approved=${earlier} head=${branchHead()} -->`,
        `The human's \`land-ok\` covered ${earlier.slice(0, 8)}; 1 commit since changed the patch, so the label is off. To read before the next « land #7 »: ${compare}`,
        `- ${branchHead().slice(0, 8)} feat: a skill (https://github.com/o/r/commit/${branchHead()})`,
      ].join("\n"),
    );
  });

  test("keeps a land-ok whose head origin no longer serves, refusing without a write", async () => {
    addSkill();
    serve({
      landOkAt: ["2050-01-01T00:00:00Z"],
      pushes: [
        { at: "2000-01-01T00:00:00Z", sha: "deadbeef".repeat(5) },
        { at: "2100-01-01T00:00:00Z", sha: branchHead() },
      ],
      pr: { labels: ["land-ok"] },
    });

    expect(why(await landing())).toContain(
      "with a land-ok given to deadbeef, which origin no longer serves",
    );
    expect(edits()).toEqual([]);
    expect(github().pr.labels).toContain("land-ok");
    expect(github().comment).toBeNull();
  });

  test("keeps the label on when the comment that names what to read cannot be posted", async () => {
    const earlier = branchHead();

    addSkill();
    serve({
      landOkAt: ["2050-01-01T00:00:00Z"],
      pushes: [
        { at: "2000-01-01T00:00:00Z", sha: earlier },
        { at: "2100-01-01T00:00:00Z", sha: branchHead() },
      ],
      pr: { labels: ["land-ok"] },
      failing: ["pr comment"],
    });

    expect(why(await landing())).toContain("gh pr comment feature/x exited 1");
    expect(edits()).toEqual([]);
    expect(github().pr.labels).toContain("land-ok");
  });

  test("names a change amended or reset with no new commit, whose patch the ok no longer covers", async () => {
    addSkill();

    const okHead = branchHead();

    writeFileSync(join(work, "skills/x/SKILL.md"), "feat: a skill \n");
    git(work, "add", "skills/x/SKILL.md");
    git(work, "commit", "--quiet", "--amend", "--no-edit");
    pushBranch();
    serve({
      landOkAt: ["2050-01-01T00:00:00Z"],
      pushes: [
        { at: "2000-01-01T00:00:00Z", sha: okHead },
        { at: "2100-01-01T00:00:00Z", sha: branchHead() },
      ],
      pr: { labels: ["land-ok"] },
    });

    expect(why(await landing())).toContain(
      `the label is off; no new commit, the patch amended or reset, to read at https://github.com/o/r/compare/${okHead}..${branchHead()}`,
    );
    expect(github().comment).toContain(
      `the patch changed with no new commit, amended or reset, so the label is off. To read before the next « land #7 »: the two heads' own diff, https://github.com/o/r/compare/${okHead}..${branchHead()}`,
    );
    expect(github().comment).not.toContain("\n- ");
  });

  test("takes a voided land-ok off a low branch too while dev is red, and says so", async () => {
    const earlier = branchHead();

    commit(work, "docs/x.md", "docs: a page");
    pushBranch();
    serve({
      redDev: [41],
      landOkAt: ["2050-01-01T00:00:00Z"],
      pushes: [
        { at: "2000-01-01T00:00:00Z", sha: earlier },
        { at: "2100-01-01T00:00:00Z", sha: branchHead() },
      ],
      pr: { labels: ["land-ok"] },
    });

    const refusal = why(await landing());

    expect(refusal).toContain(
      "dev is red (#41): no unattended landing until it is green; #7, with a land-ok given to",
    );
    expect(refusal).toContain("the label is off; 1 commit since");
    expect(github().pr.labels).not.toContain("land-ok");
  });

  test("lists as the commits since only those whose patch the ok did not cover, a rebase aside", async () => {
    addSkill();

    const okHead = branchHead();

    moveDev();
    git(work, "fetch", "--quiet", "origin");
    git(work, "rebase", "--quiet", "origin/dev");
    commit(work, "skills/x/more.md", "docs: one more line");
    pushBranch();
    serve({
      landOkAt: ["2050-01-01T00:00:00Z"],
      pushes: [
        { at: "2000-01-01T00:00:00Z", sha: okHead },
        { at: "2100-01-01T00:00:00Z", sha: branchHead() },
      ],
      pr: { labels: ["land-ok"] },
    });

    expect(why(await landing())).toContain(
      "1 commit since, to read at the commits its comment links",
    );
    expect(github().comment).toContain(
      `- ${branchHead().slice(0, 8)} docs: one more line (https://github.com/o/r/commit/${branchHead()})`,
    );
    expect(github().comment).toContain("would show the rebase too");
    expect(github().comment).not.toContain("feat: a skill");
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
    expect(github().pr.labels).toContain("land-ok");
    expect(github().comment).toBeNull();
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

const STACK_BRANCHES = ["feature/s-1", "feature/s-2", "feature/s-3"];

/** Layers on dev, each branch cut from the one under it, pushed; the checkout holds the top. Their heads, bottom first. */
function buildStack(
  files: readonly string[] = ["s-1.txt", "s-2.txt", "s-3.txt"],
  branches: readonly string[] = STACK_BRANCHES,
): string[] {
  return branches.map((branch, index) => {
    git(work, "switch", "--quiet", "-c", branch, ...(index === 0 ? ["origin/dev"] : []));
    commit(work, files[index] ?? `${index}.txt`, `layer ${index + 1}`);
    git(work, "push", "--quiet", "origin", branch);

    return branchHead();
  });
}

/** The GitHub of a stack #470 of the layers #467, #468, #469 on `branches`, each with `perLayer`'s fields. */
function serveStack(
  perLayer: readonly Partial<LayerSpec>[] = [],
  overrides: GitHubOverrides = {},
  branches: readonly string[] = STACK_BRANCHES,
) {
  serve({
    stacks: [{ number: 470, layers: branches.map((_, index) => 467 + index) }],
    ...overrides,
    layers: branches.map((branch, index) => ({
      number: 467 + index,
      branch,
      baseRefName: branches[index - 1] ?? "dev",
      ...perLayer[index],
    })),
  });
}

const APPROVED_LAYER: Partial<LayerSpec> = { labels: ["land-ok"], landOkAt: [later()] };

function dispatches(): number {
  return github().calls.filter((call) => call.includes("/dispatches")).length;
}

function originBranches(): string {
  return git(origin, "branch", "--list", "feature/s-*");
}

/** A dispatch run 50 on `sha` already there, its jobs ended as `outcome` says. */
function dispatchRunOn(
  sha: string,
  outcome: { readonly validate: "success" | "failure"; readonly e2e: "success" | "failure" },
) {
  return {
    id: 50,
    sha,
    event: "workflow_dispatch",
    past: [],
    outcome,
    polls: 0,
    hidden: 0,
    stale: 0,
    unlabels: false,
  };
}

describe("land, a stack", () => {
  test("lands three layers in one pass: one dispatch run, one atomic push, every pull request merged", async () => {
    const heads = buildStack();
    const top = heads[2] ?? "";

    serveStack();

    expect(await landing("470")).toEqual({
      kind: "landedStack",
      dev: top,
      stack: 470,
      layers: STACK_BRANCHES.map((branch, index) => ({
        number: 467 + index,
        branch,
        remote: { kind: "deleted" },
      })),
    });
    expect(git(origin, "rev-parse", "dev")).toBe(top);
    expect(receives()).toContainEqual([
      `refs/heads/dev ${top}`,
      `refs/heads/feature/s-1 ${top}`,
      `refs/heads/feature/s-2 ${top}`,
    ]);
    expect(github().runs.map(({ event, sha }) => `${event} ${sha}`)).toEqual([
      `workflow_dispatch ${top}`,
    ]);
    expect(github().layers.map((layer) => layer.state)).toEqual(["MERGED", "MERGED", "MERGED"]);
    expect(originBranches()).toBe("");
  });

  test("reuses a green workflow_dispatch run already on the top's head", async () => {
    const top = buildStack()[2] ?? "";

    serveStack([], { runs: [dispatchRunOn(top, { validate: "success", e2e: "success" })] });

    expect((await landing("470")).kind).toBe("landedStack");
    expect(dispatches()).toBe(0);
  });

  test("re-runs once a dispatch run on the top's head red in its e2e jobs alone, dispatching none", async () => {
    const top = buildStack()[2] ?? "";

    serveStack([], { runs: [dispatchRunOn(top, { validate: "success", e2e: "failure" })] });

    expect((await landing("470")).kind).toBe("landedStack");
    expect(dispatches()).toBe(0);
    expect(edits()).toContain("run rerun 50 --failed");
    expect(git(origin, "rev-parse", "dev")).toBe(top);
  });

  test("refuses a dispatch run on the top's head red beyond its e2e jobs, naming it", async () => {
    const top = buildStack()[2] ?? "";
    const before = git(origin, "rev-parse", "dev");

    serveStack([], { runs: [dispatchRunOn(top, { validate: "failure", e2e: "failure" })] });

    const refusal = why(await landing("470"));

    expect(refusal).toContain(`CI is red on ${top.slice(0, 8)}, the head of #469`);
    expect(refusal).toContain("https://github.com/o/r/actions/runs/50");
    expect(dispatches()).toBe(0);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });

  test("refuses a layer the human has not approved, naming it, before any run is listed", async () => {
    buildStack(["s-1.txt", "skills/x/SKILL.md", "s-3.txt"]);
    serveStack();

    const before = git(origin, "rev-parse", "dev");
    const refusal = why(await landing("470"));

    expect(refusal).toStartWith(
      "layer 2 of 3, #468 (feature/s-2): #468 is tier:human (adds, removes or renames a plugin component: skills/x/SKILL.md), with no land-ok label",
    );
    expect(runListings()).toBe(0);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });

  test("refuses a layer that touches a risky path with no review verdict, before any run is listed", async () => {
    onDev(".claude/agent-hooks.jsonc", "review profile", RISKY_PROFILE);
    buildStack(["risky/a.ts", "s-2.txt", "s-3.txt"]);
    serveStack([APPROVED_LAYER]);

    const refusal = why(await landing("470"));

    expect(refusal).toStartWith(
      "layer 1 of 3, #467 (feature/s-1): feature/s-1 touches risky paths",
    );
    expect(refusal).toContain("no clean review verdict");
    expect(runListings()).toBe(0);
  });

  test("refuses a stack whose top does not hold dev, naming the gh stack commands", async () => {
    const top = buildStack()[2] ?? "";

    moveDev();
    serveStack();

    expect(why(await landing("470"))).toBe(
      `the stack's top ${top.slice(0, 8)} does not hold origin/dev: gh stack rebase, then gh stack push (github-flow:stacked-prs), then land again`,
    );
    expect(runListings()).toBe(0);
  });

  test("keeps the land-ok of a layer through a cascade that keeps every layer's patch", async () => {
    const before = buildStack(["s-1.txt", "skills/x/SKILL.md", "s-3.txt"]);

    moveDev();
    git(work, "fetch", "--quiet", "origin");

    for (const [index, branch] of STACK_BRANCHES.entries()) {
      git(work, "switch", "--quiet", branch);
      git(work, "rebase", "--quiet", STACK_BRANCHES[index - 1] ?? "origin/dev");
    }

    git(work, "push", "--quiet", "--force", "origin", ...STACK_BRANCHES);

    const after = STACK_BRANCHES.map((branch) => git(work, "rev-parse", branch));

    serveStack([{}, { labels: ["land-ok"], landOkAt: ["2050-01-01T00:00:00Z"] }], {
      branchPushes: Object.fromEntries(
        STACK_BRANCHES.map((branch, index) => [
          branch,
          [
            { at: "2000-01-01T00:00:00Z", sha: before[index] ?? "" },
            { at: "2100-01-01T00:00:00Z", sha: after[index] ?? "" },
          ],
        ]),
      ),
    });

    expect((await landing("470")).kind).toBe("landedStack");
    expect(github().comment).toBeNull();
  });

  test("moves nothing when origin refuses one ref of the atomic push", async () => {
    const heads = buildStack();
    const before = git(origin, "rev-parse", "dev");
    const hook = join(origin, "hooks", "update");

    writeFileSync(hook, '#!/bin/sh\n[ "$1" = refs/heads/feature/s-2 ] && exit 1\nexit 0\n');
    chmodSync(hook, 0o755);
    serveStack();

    const refusal = why(await landing("470"));

    expect(refusal).toContain("the atomic push of");
    expect(refusal).toContain("nothing moved");
    expect(git(origin, "rev-parse", "dev")).toBe(before);
    expect(git(origin, "rev-parse", "feature/s-1")).toBe(heads[0] ?? "");
    expect(git(origin, "rev-parse", "feature/s-2")).toBe(heads[1] ?? "");
  });

  test("names a pull request GitHub never reads merged, and deletes no branch", async () => {
    const top = buildStack()[2] ?? "";

    serveStack([{}, { mergeLag: 1_000_000 }]);

    expect(why(await landing("470"))).toBe(
      `pushed ${top.slice(0, 8)} to dev and the layers, but GitHub reads #468 not merged a minute later: no remote branch deleted; delete them once GitHub reads them merged`,
    );
    expect(git(origin, "rev-parse", "dev")).toBe(top);
    expect(originBranches()).toContain("feature/s-1");
  });

  test("lands a layer of a stack with the one under it, keeping its branch for the layer above", async () => {
    const heads = buildStack();

    serveStack();

    expect(await landing("468")).toEqual({
      kind: "landedStack",
      dev: heads[1] ?? "",
      stack: null,
      layers: [
        { number: 467, branch: "feature/s-1", remote: { kind: "deleted" } },
        {
          number: 468,
          branch: "feature/s-2",
          remote: { kind: "kept", why: "#469 open on feature/s-2 would close with it" },
        },
      ],
    });
    expect(github().layers.map((layer) => layer.state)).toEqual(["MERGED", "MERGED", "OPEN"]);
    expect(git(origin, "rev-parse", "feature/s-3")).toBe(heads[2] ?? "");
  });

  test("refuses, pushing nothing, once dev moved during the wait", async () => {
    const heads = buildStack();
    let moved = "";

    serveStack();

    const refusal = why(
      await landing("470", {
        during: () => {
          if (moved === "") moved = moveDev();
        },
      }),
    );

    expect(refusal).toContain("dev moved while the stack waited");
    expect(git(origin, "rev-parse", "dev")).toBe(moved);
    expect(git(origin, "rev-parse", "feature/s-1")).toBe(heads[0] ?? "");
  });

  test("refuses a lower layer the layer above does not hold, before its commit could be dropped", async () => {
    const heads = buildStack();

    git(work, "switch", "--quiet", "feature/s-1");

    const fix = commit(work, "fix.txt", "a fix on layer 1, not cascaded");

    git(work, "push", "--quiet", "origin", "feature/s-1");
    git(work, "switch", "--quiet", "feature/s-3");
    serveStack();

    expect(why(await landing("470"))).toBe(
      `#467 (feature/s-1) at ${fix.slice(0, 8)} is not in #468 (feature/s-2) at ${(heads[1] ?? "").slice(0, 8)} above it: gh stack rebase, then gh stack push (github-flow:stacked-prs), then land again`,
    );
    expect(runListings()).toBe(0);
    expect(git(origin, "rev-parse", "feature/s-1")).toBe(fix);
  });

  test("takes off a layer's land-ok when its head stayed but its base was rewound under it", async () => {
    const branches = ["feature/s-1", "feature/s-2"];

    git(work, "switch", "--quiet", "-c", "feature/s-1", "origin/dev");

    const kept = commit(work, "s-1.txt", "layer 1");
    const dropped = commit(work, "extra.txt", "an extra commit on layer 1");

    git(work, "push", "--quiet", "origin", "feature/s-1");
    git(work, "switch", "--quiet", "-c", "feature/s-2");

    const top = commit(work, "s-2.txt", "layer 2");

    git(work, "push", "--quiet", "origin", "feature/s-2");
    git(work, "push", "--quiet", "--force", "origin", `${kept}:refs/heads/feature/s-1`);

    const before = git(origin, "rev-parse", "dev");

    serveStack(
      [
        { labels: ["land-ok"], landOkAt: ["2002-01-01T00:00:00Z"] },
        { labels: ["land-ok"], landOkAt: ["2000-06-01T00:00:00Z"] },
      ],
      {
        branchPushes: {
          "feature/s-1": [
            { at: "2000-01-01T00:00:00Z", sha: dropped },
            { at: "2001-01-01T00:00:00Z", sha: kept },
          ],
          "feature/s-2": [{ at: "2000-01-01T00:00:00Z", sha: top }],
        },
      },
      branches,
    );

    const refusal = why(await landing("470", { tier: HUMAN_STUB }));

    expect(refusal).toStartWith(
      `layer 2 of 2, #468 (feature/s-2): #468 is tier:human (a hook matches more), with a land-ok given to ${top.slice(0, 8)}, whose change is not that of its head`,
    );
    expect(github().layers[1]?.labels).not.toContain("land-ok");
    expect(github().comment).toContain(
      `To read before the next « land #468 »: the commits below\n- ${dropped.slice(0, 8)} an extra commit on layer 1 (https://github.com/o/r/commit/${dropped})`,
    );
    expect(github().comment).not.toContain(`compare/${top}`);
    expect(git(origin, "rev-parse", "dev")).toBe(before);
  });

  test("reads the pull requests merged after its push though the wait used up the landing's hour", async () => {
    const top = buildStack()[2] ?? "";

    serveStack([{}, { mergeLag: 1 }]);

    expect((await landing("470", { pollMs: 10_000, timeoutMs: 10_000 })).kind).toBe("landedStack");
    expect(git(origin, "rev-parse", "dev")).toBe(top);
    expect(originBranches()).toBe("");
  });

  test("refuses a layer on a branch outside the landable names", async () => {
    const branches = ["chore/s-1", "feature/s-2", "feature/s-3"];

    buildStack(undefined, branches);
    serveStack([], {}, branches);

    expect(why(await landing("470"))).toBe(
      "#467's branch chore/s-1 is not a feature/, fix/ or renovate/ branch, or chore/claude-code-types: only those land on dev",
    );
  });
});

describe("land, a number", () => {
  test("lands the pull request a number names, based on dev, as its branch lands", async () => {
    serve();

    expect(await landing("#7")).toEqual({
      kind: "landed",
      dev: branchHead(),
      pr: 7,
      remote: { kind: "deleted" },
    });
  });

  test("refuses a number that is neither a pull request nor a stack", async () => {
    serve();

    expect(why(await landing("999"))).toBe(
      "#999 is neither an open pull request nor a stack with open pull requests",
    );
  });

  test("refuses a number that is both a pull request and a stack", async () => {
    buildStack();
    serveStack([], { stacks: [{ number: 7, layers: [467, 468, 469] }] });

    expect(why(await landing("7"))).toBe("#7 is both a pull request and a stack");
  });

  test("refuses a base that two open pull requests head", async () => {
    buildStack();
    serve({
      layers: [
        { number: 467, branch: "feature/s-1", baseRefName: "dev" },
        { number: 468, branch: "feature/s-2", baseRefName: "feature/s-1" },
        { number: 471, branch: "feature/s-1", baseRefName: "main" },
      ],
    });

    expect(why(await landing("468"))).toBe(
      "feature/s-1, the base of #468, heads 2 open pull requests (#467, #471): close the extra ones, then land again",
    );
  });
});

/** The landing of `target` as `--dry-run` runs it, the judge never asked. */
function dryRun(target: string): Promise<Landing> {
  return land(target, work, { ...WAITING, clock: clockOf(() => {}) }, { tier: NEVER_TIERED }, true);
}

const LOW_LABELLED: Partial<LayerSpec> = { labels: ["tier:low"] };

/** `land.ts 470 --dry-run` run from the checkout, as an agent runs it. */
function dryRunCli() {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "land.ts"), "470", "--dry-run"], {
    cwd: work,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** The gh calls that would have changed GitHub. */
function writesToGitHub(): readonly string[] {
  return github().calls.filter(
    (call) =>
      /^(?:pr (?:edit|comment)|label create|run rerun)\b/u.test(call) || call.includes("POST"),
  );
}

describe("land --dry-run", () => {
  test("prints a stack's plan, writing nothing, taking no lock, pushing nothing", async () => {
    const [, second = "", top = ""] = buildStack();

    serveStack([LOW_LABELLED, LOW_LABELLED, LOW_LABELLED]);

    const pushed = received();
    const planned = await dryRun("470");

    expect(planned.kind).toBe("planned");

    const plan = planned.kind === "planned" ? planned.lines : [];

    expect(plan[0]).toBe(
      "stack #470: #467 feature/s-1, #468 feature/s-2, #469 feature/s-3, bottom first",
    );
    expect(plan).toContain(
      `layer 2 of 3: #468 feature/s-2 at ${second.slice(0, 8)}, based on feature/s-1: tier low (its tier:low label); no risky path`,
    );
    expect(plan).toContain(`the top ${top.slice(0, 8)} holds origin/dev`);
    expect(plan).toContain("its workflow_dispatch runs of ci.yml: none");
    expect(writesToGitHub()).toEqual([]);
    expect(received()).toEqual(pushed);
    expect(existsSync(lockPaths(origin).lock)).toBe(false);
  });

  test("reads #470 as 470", async () => {
    buildStack();
    serveStack([LOW_LABELLED, LOW_LABELLED, LOW_LABELLED]);

    expect(await dryRun("#470")).toEqual(await dryRun("470"));
  });

  test("refuses as the landing would, writing nothing, when a layer has neither tier label nor land-ok", async () => {
    buildStack();
    serveStack([LOW_LABELLED, {}, LOW_LABELLED]);

    expect(why(await dryRun("470"))).toStartWith(
      "layer 2 of 3, #468 (feature/s-2): #468 is tier:human (no tier label, not judged in a dry run), with no land-ok label",
    );
    expect(writesToGitHub()).toEqual([]);
  });

  test("prints a branch's plan with its runs, writing nothing", async () => {
    serve({ pr: { labels: ["tier:low"] } });

    const planned = await dryRun("feature/x");

    expect(planned).toEqual({
      kind: "planned",
      lines: [
        `#7 feature/x at ${branchHead().slice(0, 8)}, based on dev: tier low (its tier:low label); no risky path`,
        "its head holds origin/dev",
        "its pull_request runs of ci.yml: green",
        "land.ts would take the landing lock, wait for CI, rebase on origin/dev, push feature/x, push it to dev and delete the remote branch",
      ],
    });
    expect(writesToGitHub()).toEqual([]);
  });

  test("exits 0 on a plan and 1 on a refusal, from the command line", () => {
    buildStack();
    serveStack([LOW_LABELLED, LOW_LABELLED, LOW_LABELLED]);
    setEnv("LAND_DEV_COPY", "1");

    const planned = dryRunCli();

    expect(planned.stdout.toString()).toStartWith("stack #470: ");
    expect(planned.exitCode).toBe(0);

    serveStack([LOW_LABELLED, {}, LOW_LABELLED]);

    const refused = dryRunCli();

    expect(refused.stderr.toString()).toStartWith("land: layer 2 of 3, #468 (feature/s-2): ");
    expect(refused.exitCode).toBe(1);
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

  test("records the patch against the pull request's own base, the layer under it", () => {
    const patchAgainst = (base: string) => {
      const pipe = Bun.spawnSync(
        ["sh", "-c", `git diff $(git merge-base ${base} HEAD)..HEAD | git patch-id --verbatim`],
        { cwd: work, env: process.env, stdout: "pipe" },
      );

      return pipe.stdout.toString().split(" ")[0] ?? "";
    };

    git(work, "switch", "--quiet", "-c", "feature/base", "dev");
    commit(work, "base.txt", "the layer under");
    git(work, "push", "--quiet", "origin", "feature/base");
    git(work, "switch", "--quiet", "feature/x");
    git(work, "rebase", "--quiet", "feature/base");
    pushBranch();
    serve({ pr: { baseRefName: "feature/base" } });

    const recording = record("feature/x", branchHead(), work);

    expect(recording).toEqual({
      kind: "recorded",
      pr: 7,
      patchId: patchAgainst("origin/feature/base"),
    });
    expect(patchAgainst("origin/dev")).not.toBe(patchAgainst("origin/feature/base"));
    expect(posted().body).toContain("its patch against `origin/feature/base` stays the same");
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
    url: "https://github.com/o/r/pull/1",
    labels: [],
    comments: [],
  };

  test("lets an open pull request against the base it must have through", () => {
    expect(refusalOf(open, "dev")).toBeNull();
    expect(refusalOf({ ...open, baseRefName: "feature/base" }, "feature/base")).toBeNull();
  });

  test("names a pull request closed, or open against another base than its own", () => {
    expect(refusalOf({ ...open, state: "CLOSED" }, "dev")).toBe("#1 is closed, not open");
    expect(refusalOf({ ...open, baseRefName: "feature/base" }, "dev")).toBe(
      "#1 targets feature/base, not dev: land it by its number, bun ./scripts/land.ts 1, which lands the pull requests under it too",
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
