import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse, stringify } from "yaml";

import type { Gh, WaitLimits } from "./landing/ci-wait.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";
import {
  type Context,
  describeDryRun,
  describePlan,
  type DryRun,
  dryRunJson,
  folded,
  type MergeStop,
  parseCli,
  plannedTags,
  release,
  reportOf,
  ship,
  type ShipOutcome,
  type View,
} from "./release.ts";
import { type Semver, semverOf } from "./releasing/changelog.ts";
import {
  type CommitId,
  commitAt,
  type MarketplaceName,
  type SourceDir,
} from "./releasing/check-plugin-bumps.ts";
import {
  loadPlan,
  localDate,
  type PlannedBump,
  planDigest,
  planRelease,
  type ReleasePlan,
  sealPlan,
} from "./releasing/release-plan.ts";
import { decideMerge, type PullCheck, type PullView } from "./releasing/release-pull.ts";
import { VERSION_BUMP } from "./reports/sample-review.ts";

let root = "";

let repo: PluginDir;

let origin = "";

let ghLog = "";

let savedPath = "";

let savedClaudeCode: string | undefined;

const DATE = localDate(new Date(2026, 9, 20));

const SLOW = 30_000;

function dir(path: string): PluginDir {
  const checked = pluginDirAt(path);

  if (checked === null) throw new Error(`not a directory: ${path}`);

  return checked;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function catalog(...entries: { name: string; source: string; version?: string }[]) {
  write(".claude-plugin/marketplace.json", JSON.stringify({ name: "test", plugins: entries }));
}

function manifest(source: string, set: string) {
  write(`${source}/.claude-plugin/plugin.json`, JSON.stringify({ name: source, version: set }));
}

function changelog(source: string, ...versions: string[]) {
  write(
    `${source}/CHANGELOG.md`,
    [
      "# Changelog",
      "",
      ...versions.flatMap((v) => [
        `## ${v} - 2026-09-26`,
        "",
        "### Added",
        "",
        `- Change ${v}.`,
        "",
      ]),
    ].join("\n"),
  );
}

function commit(message: string): CommitId {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);

  return commitAt(repo, "HEAD");
}

function pushDev(): CommitId {
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/dev");
  git(repo, "fetch", "--quiet", "origin");

  return commitAt(repo, "origin/dev");
}

function shipped(): CommitId {
  git(repo, "fetch", "--quiet", "origin");

  return commitAt(repo, "origin/main");
}

function tagMessage(tag: string): string {
  return git(repo, "for-each-ref", "--format=%(contents)", `refs/tags/${tag}`);
}

function answer(plugin: string, structured: Record<string, string>) {
  write(
    `../answers/${plugin}.json`,
    JSON.stringify([
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.02,
        structured_output: structured,
      },
    ]),
  );
}

function ciGh(conclusion: "success" | "failure", asked: string[]): Gh {
  return (args) => {
    asked.push(args.join(" "));

    return Promise.resolve(`7\tcompleted\t${conclusion}\thttps://ci.example/runs/7\n`);
  };
}

const MERGE_LIMITS: WaitLimits = { timeoutMs: 1000, pollMs: 10 };

function context(
  gh: Gh,
  say: (line: string) => void = () => {},
  mergeLimits = MERGE_LIMITS,
): Context {
  return { gh, limits: { timeoutMs: 1000, pollMs: 10 }, mergeLimits, say };
}

interface FakePull {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  /** The branch it is from. */
  readonly head: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeCommit: string | null;
  /** Its head commit once merged, or for a pull request seeded with no branch; null reads the branch on origin. */
  pinnedHead: string | null;
  mergeable: string;
  mergeStateStatus: string;
  checks: readonly object[];
}

/**
 * GitHub as the release meets it: its pull requests, what happens on GitHub before each `gh pr view`
 * answers and between a merge's request and its squash commit, and how CI's push runs end.
 */
interface FakeGitHub {
  readonly gh: Gh;
  readonly asked: string[];
  readonly pulls: FakePull[];
  act: (pull: FakePull) => void;
  beforeMerge: () => void;
  /** What `gh pr merge` fails with once GitHub merged. */
  mergeError: Error | null;
  ci: "success" | "failure" | Error;
}

function urlOf(number: number): string {
  return `https://github.example/o/r/pull/${number}`;
}

function flag(args: readonly string[], name: string): string {
  const value = args[args.indexOf(name) + 1];

  if (!args.includes(name) || value === undefined)
    throw new Error(`gh ${args.join(" ")}: no ${name}`);

  return value;
}

function headOf(pull: FakePull): string {
  return pull.pinnedHead ?? git(origin, "rev-parse", `refs/heads/${pull.head}`);
}

function github(act: (pull: FakePull) => void = () => {}): FakeGitHub {
  const fake: FakeGitHub = {
    asked: [],
    pulls: [],
    act,
    beforeMerge: () => {},
    mergeError: null,
    ci: "success",
    gh: (args) => {
      fake.asked.push(args.join(" "));

      const [command, sub, number] = args;

      if (command === "api") {
        return fake.ci instanceof Error
          ? Promise.reject(fake.ci)
          : Promise.resolve(`7\tcompleted\t${fake.ci}\thttps://ci.example/runs/7\n`);
      }

      if (sub === "list") {
        const head = flag(args, "--head");

        return Promise.resolve(
          JSON.stringify(
            fake.pulls
              .filter((pull) => pull.head === head)
              .map((pull) => ({
                number: pull.number,
                state: pull.state,
                title: pull.title,
                body: pull.body,
                url: urlOf(pull.number),
                headRefOid: headOf(pull),
                mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
              })),
          ),
        );
      }

      if (sub === "create") {
        const pull: FakePull = {
          number: fake.pulls.length + 1,
          title: flag(args, "--title"),
          body: flag(args, "--body"),
          head: flag(args, "--head"),
          state: "OPEN",
          mergeCommit: null,
          pinnedHead: null,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BLOCKED",
          checks: [],
        };

        fake.pulls.push(pull);

        return Promise.resolve(`Creating pull request\n${urlOf(pull.number)}\n`);
      }

      const pull = fake.pulls.find((known) => String(known.number) === number);

      if (pull === undefined)
        return Promise.reject(new Error(`gh ${args.join(" ")}: no such pull`));

      if (sub === "merge") {
        if (!args.includes("--squash") || flag(args, "--match-head-commit") !== headOf(pull)) {
          return Promise.reject(new Error("GraphQL: Head branch was modified"));
        }

        if (pull.mergeStateStatus !== "CLEAN") {
          return Promise.reject(new Error("the base branch policy prohibits the merge"));
        }

        fake.beforeMerge();
        githubSquash(pull);

        return fake.mergeError === null ? Promise.resolve("") : Promise.reject(fake.mergeError);
      }

      if (sub !== "view") return Promise.reject(new Error(`gh ${args.join(" ")}: not faked`));

      fake.act(pull);

      return Promise.resolve(
        JSON.stringify({
          state: pull.state,
          headRefOid: headOf(pull),
          mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
          mergeable: pull.mergeable,
          mergeStateStatus: pull.mergeStateStatus,
          statusCheckRollup: pull.checks,
        }),
      );
    },
  };

  return fake;
}

/** A clone standing for GitHub's side of origin, where squash merges and other agents' landings are made. */
function onGitHub(): string {
  const clone = join(root, "github");

  if (existsSync(clone)) {
    git(clone, "fetch", "--quiet", "origin");
  } else {
    git(root, "clone", "--quiet", "--no-checkout", origin, clone);
    git(clone, "config", "user.email", "gh@example.com");
    git(clone, "config", "user.name", "gh");
    git(clone, "config", "commit.gpgsign", "false");
  }

  git(clone, "checkout", "--quiet", "-B", "dev", "origin/dev");

  return clone;
}

/** GitHub's squash merge: one commit on dev, titled with the pull request's title and its number. */
function githubSquash(pull: FakePull) {
  const clone = onGitHub();

  pull.pinnedHead = headOf(pull);
  git(clone, "merge", "--quiet", "--squash", `origin/${pull.head}`);
  git(clone, "commit", "--quiet", "-m", `${pull.title} (#${pull.number})`);
  git(clone, "push", "--quiet", "origin", "HEAD:refs/heads/dev");
  pull.state = "MERGED";
  pull.mergeCommit = git(clone, "rev-parse", "HEAD");
}

/** The owner adds `human-approved` and the required checks go green: GitHub calls it mergeable. */
function approve(pull: FakePull) {
  if (pull.state === "OPEN") pull.mergeStateStatus = "CLEAN";
}

function landOnDev(path: string, subject: string): string {
  const clone = onGitHub();

  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), `${subject}\n`);
  git(clone, "add", "-A");
  git(clone, "commit", "--quiet", "-m", subject);
  git(clone, "push", "--quiet", "origin", "HEAD:refs/heads/dev");

  return git(clone, "rev-parse", "HEAD");
}

/** A commit pushed onto the release branch by someone other than the release. */
function pushOnBranch(branch: string): string {
  const clone = onGitHub();

  git(clone, "checkout", "--quiet", "-B", "extra", `origin/${branch}`);
  writeFileSync(join(clone, "extra.md"), "extra\n");
  git(clone, "add", "-A");
  git(clone, "commit", "--quiet", "-m", "docs: a fix after the review");
  git(clone, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);

  return git(clone, "rev-parse", "HEAD");
}

/** A pull request from the release branch of `target`, seeded as another run of release.ts left it. */
function seededPull(target: string, state: "OPEN" | "MERGED", digest: string): FakePull {
  return {
    number: 4,
    title: "chore(release): vellum@0.2.0",
    body: `<!-- release.ts: plan ${digest}, commit ${"f".repeat(40)} -->`,
    head: `release/${target.slice(0, 12)}`,
    state,
    mergeCommit: state === "MERGED" ? "e".repeat(40) : null,
    pinnedHead: "f".repeat(40),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    checks: [],
  };
}

function commands(asked: readonly string[]): readonly string[] {
  return asked.map((line) => line.split(" ").slice(0, 2).join(" "));
}

function refuseOnOrigin(ref: string) {
  const hook = join(origin, "hooks", "pre-receive");

  writeFileSync(
    hook,
    `#!/bin/sh\nwhile read -r old new ref; do\n  if [ "$ref" = '${ref}' ]; then echo "$ref refused" >&2; exit 1; fi\ndone\n`,
  );
  chmodSync(hook, 0o755);
}

/** The real lefthook `sync-versions` job, its script and what it imports, installed in the fixture, with a README table to sync. */
function installSyncVersions() {
  const real = parse(readFileSync(join(import.meta.dir, "..", "lefthook.yml"), "utf8"));

  const job = real["pre-commit"].jobs.find(
    ({ name }: { name: string }) => name === "sync-versions",
  );

  write("lefthook.yml", stringify({ "pre-commit": { jobs: [job] } }));

  for (const file of ["gates/sync-versions.ts", "lib/marketplace-validation.ts"]) {
    mkdirSync(dirname(join(repo, "scripts", file)), { recursive: true });
    copyFileSync(join(import.meta.dir, file), join(repo, "scripts", file));
  }

  chmodSync(join(repo, "scripts", "gates", "sync-versions.ts"), 0o755);
  mkdirSync(join(repo, "tools", "platform"), { recursive: true });

  for (const file of ["pure.ts", "fs.ts", "process.ts", "git.ts"]) {
    copyFileSync(
      join(import.meta.dir, "..", "tools", "platform", file),
      join(repo, "tools", "platform", file),
    );
  }

  catalog(
    { name: "vellum", source: "./vellum", version: "0.1.0" },
    { name: "other", source: "./other", version: "1.0.0" },
  );
  write(
    "README.md",
    "| Plugin | Version | Description |\n|---|---|---|\n| [vellum](vellum/) | 0.1.0 | Plans. |\n| [other](other/) | 1.0.0 | Other. |\n",
  );

  const installed = Bun.spawnSync(["lefthook", "install"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (installed.exitCode !== 0) throw new Error(`lefthook install: ${installed.stderr.toString()}`);
}

async function sealedPlan(target: CommitId): Promise<ReleasePlan> {
  const { plan } = await planRelease(
    repo,
    { shipped: shipped(), target, head: commitAt(repo, "origin/dev") },
    DATE,
    () => {},
  );

  return loadPlan(repo, sealPlan(repo, plan).digest);
}

function worktreeCount(): number {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

function answerVellumMinor() {
  answer("vellum", {
    level: "minor",
    reason: "a user sees the a module",
    summary: "the a module",
    body: "### Added\n\n- The a module.",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-"));
  origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", origin);
  mkdirSync(join(root, "repo"));
  repo = dir(join(root, "repo"));
  git(repo, "init", "-q", "-b", "dev");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "tag.gpgsign", "false");
  git(repo, "remote", "add", "origin", origin);

  const bin = join(root, "bin");
  ghLog = join(root, "gh.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\n`);
  writeFileSync(
    join(bin, "claude"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "\${CLAUDECODE:-unset}" >> '${root}/claude.log'`,
      "name=$(sed -n 's/^Plugin: //p')",
      `cat '${root}/answers/'"$name"'.json'`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${savedPath}`;
  savedClaudeCode = process.env["CLAUDECODE"];
  process.env["CLAUDECODE"] = "1";

  write("package.json", '{ "name": "fixture", "private": true }\n');
  catalog({ name: "vellum", source: "./vellum" }, { name: "other", source: "./other" });
  manifest("vellum", "0.1.0");
  changelog("vellum", "0.1.0");
  manifest("other", "1.0.0");
  commit("first");
  git(repo, "push", "--quiet", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/dev");
});

afterEach(() => {
  process.env.PATH = savedPath;

  if (savedClaudeCode === undefined) {
    delete process.env["CLAUDECODE"];
  } else {
    process.env["CLAUDECODE"] = savedClaudeCode;
  }

  rmSync(root, { recursive: true, force: true });
});

describe("a release", () => {
  test("tags the commit that set the version, with every section since the one main held", () => {
    manifest("vellum", "0.2.0");
    changelog("vellum", "0.2.0", "0.1.0");
    const setTwo = commit("feat(vellum): two, its bump folded in");

    write("vellum/a.ts", "a\n");
    manifest("vellum", "0.2.1");
    changelog("vellum", "0.2.1", "0.2.0", "0.1.0");
    const setThree = commit("fix(vellum): a");

    write("vellum/b.ts", "b\n");
    const head = commit("test(vellum): b");
    const tags = plannedTags(repo, shipped(), head);

    expect(tags.map(({ tag, commit: at }) => [`${tag}`, at])).toEqual([
      ["vellum-v0.2.1", setThree],
    ]);
    expect(
      describePlan({ shipped: shipped(), target: head, bumps: [] }, tags).split("\n").slice(1),
    ).toEqual([
      "",
      "  no plugin to bump",
      "",
      `Tags    vellum-v0.2.1 on ${setThree.slice(0, 7)}, with the sections 0.2.1 - 2026-09-26, 0.2.0 - 2026-09-26`,
    ]);
    expect(release(repo, head, tags)).toEqual({ kind: "released", tags });
    expect(git(repo, "rev-parse", "vellum-v0.2.1^{commit}")).toBe(setThree);
    expect(setTwo).not.toBe(setThree);
    expect(tagMessage("vellum-v0.2.1")).toBe(
      "## 0.2.1 - 2026-09-26\n\n### Added\n\n- Change 0.2.1.\n\n## 0.2.0 - 2026-09-26\n\n### Added\n\n- Change 0.2.0.",
    );
    expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.1^{commit}")).toBe(setThree);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
    expect(readFileSync(ghLog, "utf8")).toBe(
      "release create vellum-v0.2.1 --verify-tag --title vellum 0.2.1 --notes-from-tag\n",
    );
  });

  test("tags the last commit that set a version that was set, reverted and set again", () => {
    manifest("vellum", "0.2.0");
    changelog("vellum", "0.2.0", "0.1.0");
    const reverted = commit("chore(release): vellum@0.2.0 (#1)");

    git(repo, "revert", "--no-edit", reverted);
    manifest("vellum", "0.2.0");
    changelog("vellum", "0.2.0", "0.1.0");
    const again = commit("chore(release): vellum@0.2.0 (#2)");

    expect(
      plannedTags(repo, shipped(), again).map(({ tag, commit: at }) => [`${tag}`, at]),
    ).toEqual([["vellum-v0.2.0", again]]);
  });

  test("tags nothing when no plugin that keeps a changelog changed version", () => {
    manifest("other", "1.1.0");
    const head = commit("feat(other): no changelog kept");
    const tags = plannedTags(repo, shipped(), head);

    expect(tags).toEqual([]);
    expect(release(repo, head, tags)).toEqual({ kind: "released", tags: [] });
    expect(git(repo, "tag", "--list")).toBe("");
  });

  test("tags nothing when the push to main is refused", () => {
    writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho refused >&2\nexit 1\n");
    chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
    manifest("vellum", "0.2.0");
    changelog("vellum", "0.2.0", "0.1.0");
    const head = commit("feat(vellum): two");
    const outcome = release(repo, head, plannedTags(repo, shipped(), head));

    expect(outcome).toHaveProperty("kind", "push-refused");
    expect(git(repo, "tag", "--list")).toBe("");
  });

  test("a plugin new since main takes every section of its changelog", () => {
    catalog(
      { name: "vellum", source: "./vellum" },
      { name: "other", source: "./other" },
      { name: "fresh", source: "./fresh-dir" },
    );
    manifest("fresh-dir", "0.2.0");
    changelog("fresh-dir", "0.2.0", "0.1.0");
    const head = commit("feat(fresh): a new plugin");
    const [tag] = plannedTags(repo, shipped(), head);

    expect(`${tag?.tag}`).toBe("fresh-v0.2.0");
    expect(tag?.notes.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## 0.2.0 - 2026-09-26",
      "## 0.1.0 - 2026-09-26",
    ]);
  });

  test("is refused before the push when the tag exists already", () => {
    manifest("vellum", "0.2.0");
    changelog("vellum", "0.2.0", "0.1.0");
    const head = commit("feat(vellum): two");

    git(repo, "tag", "vellum-v0.2.0", "HEAD~1");

    expect(() => plannedTags(repo, shipped(), head)).toThrow(
      "vellum-v0.2.0 exists already: a tag is never moved",
    );
  });

  test("is refused before the push when the changelog does not parse", () => {
    manifest("vellum", "0.2.0");
    write("vellum/CHANGELOG.md", "# Changelog\n\n## next\n");
    const head = commit("feat(vellum): two");

    expect(() => plannedTags(repo, shipped(), head)).toThrow("vellum/CHANGELOG.md:3");
  });
});

describe("a release with bumps", () => {
  test(
    "commits each bump on dev, waits for its push run, moves main there and tags the bump commit",
    async () => {
      write("vellum/a.ts", "a\n");
      write("other/b.ts", "b\n");
      const target = commit("feat(vellum): a");

      pushDev();
      answerVellumMinor();
      answer("other", { level: "patch", reason: "a fix", summary: "b fixed" });

      const plan = await sealedPlan(target);
      const bumps: readonly object[] = plan.bumps;

      expect(bumps).toEqual([
        {
          name: "vellum",
          source: "vellum",
          from: "0.1.0",
          to: "0.2.0",
          codeLevel: "patch",
          level: "minor",
          reason: "a user sees the a module",
          summary: "the a module",
          section: "## 0.2.0 - 2026-10-20\n\n### Added\n\n- The a module.",
        },
        {
          name: "other",
          source: "other",
          from: "1.0.0",
          to: "1.0.1",
          codeLevel: "minor",
          level: "patch",
          reason: "a fix",
          summary: "b fixed",
          section: null,
        },
      ]);
      expect(readFileSync(join(root, "claude.log"), "utf8")).toBe("unset\nunset\n");
      expect(describePlan(plan, []).split("\n")).toEqual([
        `Release  main ${shipped().slice(0, 7)} → ${target.slice(0, 7)}`,
        "",
        "  vellum  0.1.0 → 0.2.0  minor  ⚠ subjects said patch",
        "  other   1.0.0 → 1.0.1  patch  ⚠ subjects said minor",
        "",
        `── vellum 0.2.0 ${"─".repeat(84)}`,
        "  chore(vellum): 0.2.0, the a module",
        "  why  a user sees the a module",
        "  CHANGELOG.md",
        "  │ ### Added",
        "  │",
        "  │ - The a module.",
        "",
        `── other 1.0.1 ${"─".repeat(85)}`,
        "  chore(other): 1.0.1, b fixed",
        "  why  a fix",
        "",
        "Commit  chore(release): vellum@0.2.0, other@1.0.1",
        "Tags    vellum-v0.2.0 on its bump commit",
      ]);

      const hub = github(approve);
      const said: string[] = [];

      const outcome = await ship(
        repo,
        plan,
        context(hub.gh, (line) => said.push(line)),
      );

      const head = git(origin, "rev-parse", "refs/heads/dev");
      const branch = `release/${target.slice(0, 12)}`;

      const pushed = hub.pulls[0]?.pinnedHead ?? "";

      expect(commands(hub.asked)).toEqual([
        "pr list",
        "pr list",
        "pr create",
        "pr view",
        "pr merge",
        "pr view",
        "api --paginate",
      ]);
      expect(hub.asked).toContain(`pr merge 1 --squash --match-head-commit ${pushed}`);
      expect(hub.asked.filter((line) => line.includes("--auto"))).toEqual([]);
      expect(hub.asked.at(-1)).toContain(`head_sha=${head}&event=push`);
      expect(hub.pulls.map(({ title, head: from }) => [title, from])).toEqual([
        ["chore(release): vellum@0.2.0, other@1.0.1", branch],
      ]);
      expect(git(origin, "rev-parse", `${pushed}~1`)).toBe(target);
      expect(hub.pulls[0]?.body).toContain(
        "- chore(vellum): 0.2.0, the a module\n- chore(other): 1.0.1, b fixed",
      );
      expect(hub.pulls[0]?.body.split("\n").at(-1)).toBe(
        `<!-- release.ts: plan ${planDigest(plan)}, commit ${pushed} -->`,
      );
      expect(said.filter((line) => line.includes("human-approved"))).toEqual([
        expect.stringMatching(
          /^https:\/\/github\.example\/o\/r\/pull\/1: add the label human-approved yourself, your approval, which this script never adds;/u,
        ),
      ]);
      expect(git(origin, "log", "--format=%s", `${target}..dev`)).toBe(
        "chore(release): vellum@0.2.0, other@1.0.1 (#1)",
      );
      expect(VERSION_BUMP.test(git(origin, "log", "-1", "--format=%s", "dev"))).toBe(true);
      expect(git(origin, "rev-parse", "refs/heads/dev~1")).toBe(target);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
      expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.0^{commit}")).toBe(head);
      expect(tagMessage("vellum-v0.2.0")).toBe(
        "## 0.2.0 - 2026-10-20\n\n### Added\n\n- The a module.",
      );
      expect(git(origin, "show", "--name-only", "--format=", head).split("\n")).toEqual([
        "other/.claude-plugin/plugin.json",
        "vellum/.claude-plugin/plugin.json",
        "vellum/CHANGELOG.md",
      ]);
      expect(git(origin, "show", `${head}:other/.claude-plugin/plugin.json`)).toBe(
        '{"name":"other","version":"1.0.1"}',
      );
      expect(said.filter((line) => line.includes("past the plan's"))).toEqual([]);
      expect(outcome).toHaveProperty("kind", "released");
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "tags every plugin the squash commit bumps on that commit",
    async () => {
      changelog("other", "1.0.0");
      commit("docs(other): a changelog");
      write("vellum/a.ts", "a\n");
      write("other/b.ts", "b\n");
      const target = commit("feat(vellum): a");

      pushDev();
      answerVellumMinor();
      answer("other", {
        level: "patch",
        reason: "a fix",
        summary: "b fixed",
        body: "### Fixed\n\n- B.",
      });

      const plan = await sealedPlan(target);
      const outcome = await ship(repo, plan, context(github(approve).gh));
      const head = git(origin, "rev-parse", "refs/heads/dev");

      expect(
        outcome.kind === "released"
          ? outcome.tags.map(({ tag, commit: at }) => [`${tag}`, at])
          : outcome,
      ).toEqual([
        ["vellum-v0.2.0", head],
        ["other-v1.0.1", head],
      ]);
      expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.0^{commit}")).toBe(head);
      expect(git(origin, "rev-parse", "refs/tags/other-v1.0.1^{commit}")).toBe(head);
      expect(tagMessage("other-v1.0.1")).toBe("## 1.0.1 - 2026-10-20\n\n### Fixed\n\n- B.");
    },
    SLOW,
  );

  test(
    "lands the bumps on dev's head when dev moved by commits the plan needs not cover",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);

      write("notes.md", "notes\n");
      write("other/README.md", "docs alone\n");
      const moved = commit("docs: notes");

      pushDev();
      writeFileSync(
        join(repo, ".git", "hooks", "pre-push"),
        `#!/bin/sh\nprintf 'CALL [%s]\\n' "$(cat)" >> '${root}/pre-push.log'\n`,
      );
      chmodSync(join(repo, ".git", "hooks", "pre-push"), 0o755);

      const said: string[] = [];

      const outcome = await ship(
        repo,
        plan,
        context(github(approve).gh, (line) => said.push(line)),
      );

      const head = git(origin, "rev-parse", "refs/heads/dev");
      const branch = `release/${target.slice(0, 12)}`;
      const bumps = git(origin, "rev-parse", `refs/heads/${branch}`);

      expect(outcome).toHaveProperty("kind", "released");
      expect(git(origin, "rev-parse", `${branch}~1`)).toBe(moved);
      expect(git(origin, "rev-parse", "refs/heads/dev~1")).toBe(moved);
      expect(git(origin, "log", "-1", "--format=%s", "dev")).toBe(
        "chore(release): vellum@0.2.0 (#1)",
      );
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
      expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.0^{commit}")).toBe(head);
      expect(said.slice(-2)).toEqual([
        `main ${plan.shipped.slice(0, 7)} → ${head.slice(0, 7)}, past the plan's ${target.slice(0, 7)} by:`,
        `  ${moved.slice(0, 7)} docs: notes`,
      ]);
      expect(readFileSync(join(root, "pre-push.log"), "utf8").split("\n").slice(0, 2)).toEqual([
        `CALL [HEAD ${bumps} refs/heads/${branch} ${"0".repeat(40)}]`,
        `CALL [${head} ${head} refs/heads/main ${plan.shipped}]`,
      ]);
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "is refused, nothing pushed, when dev's head would make a tag the plan did not print",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);

      catalog(
        { name: "vellum", source: "./vellum" },
        { name: "other", source: "./other" },
        { name: "fresh", source: "./fresh" },
      );
      manifest("fresh", "0.1.0");
      changelog("fresh", "0.1.0");
      const moved = commit("feat(fresh): a new plugin");

      pushDev();

      const hub = github(approve);
      const outcome = await ship(repo, plan, context(hub.gh));

      expect(outcome).toHaveProperty("kind", "refused");
      expect(outcome).toHaveProperty(
        "why",
        expect.stringContaining("the release would tag fresh-v0.1.0, which the plan did not print"),
      );
      expect(commands(hub.asked)).toEqual(["pr list"]);
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(moved);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(plan.shipped);
      expect(git(origin, "tag", "--list")).toBe("");
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "is refused, nothing pushed, when dev was rewritten without the plan's target",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);

      git(repo, "reset", "--quiet", "--soft", "HEAD~1");
      write("notes.md", "notes\n");
      const rewritten = commit("fix(vellum): a, and notes");

      git(repo, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/dev");
      git(repo, "fetch", "--quiet", "origin");

      const outcome = await ship(repo, plan, context(github().gh));

      expect(outcome).toHaveProperty(
        "why",
        expect.stringContaining(
          `dev's head ${rewritten.slice(0, 7)} does not hold ${target.slice(0, 7)}`,
        ),
      );
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(rewritten);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(plan.shipped);
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "releases the squash commit GitHub made above what landed on dev while the pull request waited",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);

      const hub = github((pull) => {
        if (pull.mergeStateStatus !== "CLEAN") {
          landOnDev("notes.md", "docs: an agent landed meanwhile");
        }

        approve(pull);
      });

      const outcome = await ship(repo, plan, context(hub.gh));
      const head = git(origin, "rev-parse", "refs/heads/dev");

      expect(outcome).toHaveProperty("kind", "released");
      expect(git(origin, "log", "--format=%s", `${target}..dev`).split("\n")).toEqual([
        "chore(release): vellum@0.2.0 (#1)",
        "docs: an agent landed meanwhile",
      ]);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
      expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.0^{commit}")).toBe(head);
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "is refused with the same plan still good when a pre-push hook refuses the bumps and dev did not move",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();
      writeFileSync(
        join(repo, ".git", "hooks", "pre-push"),
        "#!/bin/sh\necho a gate is red >&2\nexit 1\n",
      );
      chmodSync(join(repo, ".git", "hooks", "pre-push"), 0o755);

      const hub = github(approve);
      const outcome = await ship(repo, await sealedPlan(target), context(hub.gh));

      expect(outcome).toHaveProperty("kind", "refused");
      expect(outcome).toHaveProperty(
        "why",
        expect.stringMatching(
          /^the push of the bumps to release\/[0-9a-f]{12} was refused, nothing moved; once what it names is fixed, the same bun \.\/scripts\/release\.ts --plan <digest> applies again:\na gate is red\n/u,
        ),
      );
      expect(commands(hub.asked)).toEqual(["pr list", "pr list"]);
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(target);
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test.each([
    [
      "a commit under a plugin the plan bumps",
      () => {
        const fix = landOnDev("vellum/c.ts", "fix(vellum): c");

        return `dev moved to ${fix.slice(0, 7)} with commits under a plugin the plan bumps (${fix.slice(0, 7)} fix(vellum): c): run the dry-run again`;
      },
    ],
    [
      "main moving while dev stays put",
      (target: string) => {
        git(onGitHub(), "push", "--quiet", "origin", `${target}:refs/heads/main`);

        return `main moved to ${target.slice(0, 7)} meanwhile: run the dry-run again`;
      },
    ],
  ])(
    "merges nothing, main unmoved, on %s while the pull request is open",
    async (_, meanwhile) => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      let why = "";

      const hub = github((pull) => {
        if (pull.mergeStateStatus !== "CLEAN") why = meanwhile(target);

        approve(pull);
      });

      const dev = () => git(origin, "rev-parse", "refs/heads/dev");
      const outcome = await ship(repo, plan, context(hub.gh));

      expect(outcome).toEqual({
        kind: "not-merged",
        pr: { number: 1, url: urlOf(1) },
        wait: { kind: "drift", why },
      });
      expect(reportOf(outcome).text).toBe(
        `The release pull request #1 (${urlOf(1)}) is mergeable, but nothing merged and main is unmoved: ${why}. Close it (gh pr close 1 --delete-branch --comment "dev moved under the release plan"), then run the dry-run again: its plan judges what dev gained.`,
      );
      expect(commands(hub.asked)).toEqual(["pr list", "pr list", "pr create", "pr view"]);
      expect(git(origin, "log", "-1", "--format=%s", dev())).not.toContain("chore(release)");
      expect(git(origin, "tag", "--list")).toBe("");
    },
    SLOW,
  );

  test(
    "merges nothing when the release branch's head is not the commit it pushed",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      let extra = "";

      const hub = github((pull) => {
        if (extra === "") extra = pushOnBranch(pull.head);

        approve(pull);
      });

      const outcome = await ship(repo, plan, context(hub.gh));
      const pushed = git(origin, "rev-parse", `${extra}~1`);

      expect(outcome).toEqual({
        kind: "not-merged",
        pr: { number: 1, url: urlOf(1) },
        wait: { kind: "foreign-head", head: extra, pushed },
      });
      expect(reportOf(outcome).text).toContain(
        `has the head ${extra.slice(0, 7)}, not ${pushed.slice(0, 7)}, the commit this script pushed; nothing merged, main unmoved.`,
      );
      expect(commands(hub.asked)).not.toContain("pr merge");
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(target);
    },
    SLOW,
  );

  test(
    "says to revert the release commit when dev gained a commit under a bumped plugin between its check and the merge",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      const hub = github(approve);
      let fix = "";

      hub.beforeMerge = () => {
        fix = landOnDev("vellum/c.ts", "fix(vellum): c");
      };

      const outcome = await ship(repo, plan, context(hub.gh));
      const head = git(origin, "rev-parse", "refs/heads/dev");
      const line = `${fix.slice(0, 7)} fix(vellum): c`;

      expect(outcome).toEqual({
        kind: "unplanned",
        head,
        why: `dev moved to ${fix.slice(0, 7)} with commits under a plugin the plan bumps (${line}): run the dry-run again`,
        commits: [line],
      });
      expect(reportOf(outcome).text).toContain(`main is unmoved: dev moved to ${fix.slice(0, 7)}`);
      expect(reportOf(outcome).text).toContain(
        `Revert ${head.slice(0, 7)} on dev through a pull request (git revert ${head}), then run the dry-run again: the revert resets the versions, so the next plan judges everything.`,
      );
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(plan.shipped);
      expect(git(origin, "tag", "--list")).toBe("");
    },
    SLOW,
  );

  test(
    "says the bumps are on dev, main unmoved, when reading the squash commit fails",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      const hub = github(approve);

      hub.beforeMerge = () => {
        git(repo, "tag", "vellum-v0.2.0", target);
      };

      const outcome = await ship(repo, plan, context(hub.gh));
      const head = git(origin, "rev-parse", "refs/heads/dev");

      expect(outcome).toEqual({
        kind: "after-bumps",
        head,
        why: "vellum-v0.2.0 exists already: a tag is never moved",
      });
      expect(reportOf(outcome).text).toBe(
        `The bumps are on dev at ${head.slice(0, 7)}; main is unmoved: vellum-v0.2.0 exists already: a tag is never moved\nNext: the same bun ./scripts/release.ts --plan <digest>; it finds its pull request merged, checks the squash commit again, waits for CI and moves main.`,
      );
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(plan.shipped);
    },
    SLOW,
  );

  test(
    "pushes nothing when another run opened the release pull request while this one made its commit",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      const hub = github(approve);

      const outcome = await ship(
        repo,
        plan,
        context(hub.gh, (line) => {
          if (line.startsWith("committing")) {
            hub.pulls.push(seededPull(target, "OPEN", planDigest(plan)));
          }
        }),
      );

      expect(outcome).toEqual({
        kind: "refused",
        why: `${urlOf(4)}, from release/${target.slice(0, 12)}, opened meanwhile, by another run of this plan; nothing pushed: the same bun ./scripts/release.ts --plan <digest> applies again and resumes it`,
      });
      expect(commands(hub.asked)).toEqual(["pr list", "pr list"]);
      expect(git(origin, "branch", "--list", "release/*")).toBe("");
    },
    SLOW,
  );

  test(
    "pushes nothing over a branch another run pushed before opening its pull request",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      const hub = github(approve);
      const branch = `release/${target.slice(0, 12)}`;
      let theirs = "";

      const outcome = await ship(
        repo,
        plan,
        context(hub.gh, (line) => {
          if (!line.startsWith("committing")) return;

          const clone = onGitHub();

          writeFileSync(join(clone, "theirs.md"), "theirs\n");
          git(clone, "add", "-A");
          git(clone, "commit", "--quiet", "-m", "chore(release): vellum@0.2.0");
          git(clone, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
          theirs = git(clone, "rev-parse", "HEAD");
        }),
      );

      expect(outcome).toEqual({
        kind: "refused",
        why: `${branch} holds ${theirs.slice(0, 7)}, the head of no closed pull request from it: another run of this plan may have pushed it and be opening its pull request; nothing pushed: the same bun ./scripts/release.ts --plan <digest> applies again and resumes that pull request once it is open, or delete the branch (git push origin --delete ${branch}) if nothing uses it`,
      });
      expect(git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(theirs);
      expect(commands(hub.asked)).toEqual(["pr list", "pr list"]);
    },
    SLOW,
  );

  test(
    "says the bumps may be on dev when the merge call fails after GitHub merged, and the same plan carries on",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      const hub = github(approve);

      hub.mergeError = new Error("gh pr merge exited 1: HTTP 502");

      const outcome = await ship(repo, plan, context(hub.gh));
      const head = git(origin, "rev-parse", "refs/heads/dev");

      expect(outcome).toEqual({
        kind: "not-merged",
        pr: { number: 1, url: urlOf(1) },
        wait: { kind: "merge-unsure", why: "gh pr merge exited 1: HTTP 502" },
      });
      expect(reportOf(outcome).text).toBe(
        `The release pull request #1 (${urlOf(1)}) may have merged: gh pr merge exited 1: HTTP 502. The bumps may already be on dev; main is unmoved. The same bun ./scripts/release.ts --plan <digest> finds the pull request merged and carries on from its commit, or resumes the wait if it did not merge.`,
      );
      expect(git(origin, "log", "-1", "--format=%s", head)).toBe(
        "chore(release): vellum@0.2.0 (#1)",
      );

      hub.mergeError = null;

      expect(await ship(repo, plan, context(hub.gh))).toHaveProperty("kind", "released");
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
    },
    SLOW,
  );

  test.each(["OPEN", "MERGED"] as const)(
    "is refused, nothing pushed, when the %s pull request of its branch holds another plan",
    async (state) => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      const hub = github(approve);

      hub.pulls.push(seededPull(target, state, "a".repeat(12)));

      const outcome = await ship(repo, plan, context(hub.gh));

      expect(outcome).toEqual({
        kind: "refused",
        why:
          state === "OPEN"
            ? `${urlOf(4)} holds the bumps of the plan ${"a".repeat(12)}, not of the plan ${planDigest(plan)}: close it (gh pr close 4 --delete-branch --comment "replaced by another release plan"), then the same bun ./scripts/release.ts --plan <digest> applies again; or apply its own plan: bun ./scripts/release.ts --plan ${"a".repeat(12)}`
            : `${urlOf(4)} merged the bumps of the plan ${"a".repeat(12)}, not of the plan ${planDigest(plan)}: carry that release on with bun ./scripts/release.ts --plan ${"a".repeat(12)}, or run the dry-run again`,
      });
      expect(commands(hub.asked)).toEqual(["pr list"]);
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(target);
    },
    SLOW,
  );

  test(
    "says the bumps are on dev when the wait for CI fails, and the same plan carries on from the merged pull request",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      const hub = github(approve);

      hub.ci = new Error("gh api exited 1: HTTP 502");

      const outcome = await ship(repo, plan, context(hub.gh));
      const head = commitAt(repo, "origin/dev");

      expect(outcome).toEqual({
        kind: "after-bumps",
        head,
        why: "waiting for its push run of CI failed: gh api exited 1: HTTP 502",
      });
      expect(reportOf(outcome).text).toBe(
        `The bumps are on dev at ${head.slice(0, 7)}; main is unmoved: waiting for its push run of CI failed: gh api exited 1: HTTP 502\nNext: the same bun ./scripts/release.ts --plan <digest>; it finds its pull request merged, checks the squash commit again, waits for CI and moves main.`,
      );
      expect(git(origin, "log", "-1", "--format=%s", "dev")).toBe(
        "chore(release): vellum@0.2.0 (#1)",
      );
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(shipped());

      hub.ci = "success";
      hub.asked.length = 0;

      expect(await ship(repo, plan, context(hub.gh))).toHaveProperty("kind", "released");
      expect(commands(hub.asked)).toEqual(["pr list", "api --paginate"]);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
      expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.0^{commit}")).toBe(head);
    },
    SLOW,
  );

  test(
    "stops on a closed pull request, dev and main unmoved, and the same plan then opens a new one",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);

      const hub = github((pull) => {
        pull.state = "CLOSED";
      });

      const outcome = await ship(repo, plan, context(hub.gh));

      expect(outcome).toEqual({
        kind: "not-merged",
        pr: { number: 1, url: urlOf(1) },
        wait: { kind: "closed" },
      });
      expect(reportOf(outcome)).toEqual({
        text: `The release pull request #1 (${urlOf(1)}) was closed without merging; dev and main are unmoved: the same bun ./scripts/release.ts --plan <digest> applies again and opens a new one, or run the dry-run again if the plan should change.`,
        exit: 1,
      });
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(target);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(plan.shipped);

      hub.act = approve;

      expect(await ship(repo, plan, context(hub.gh))).toHaveProperty("kind", "released");
      expect(hub.pulls.map(({ number, state }) => [number, state])).toEqual([
        [1, "CLOSED"],
        [2, "MERGED"],
      ]);
      expect(git(origin, "log", "-1", "--format=%s", "dev")).toBe(
        "chore(release): vellum@0.2.0 (#2)",
      );
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "stops when the pull request is not merged in time, and a second run resumes it",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);
      const hub = github();
      const said: string[] = [];

      const outcome = await ship(
        repo,
        plan,
        context(hub.gh, (line) => said.push(line), { timeoutMs: 50, pollMs: 10 }),
      );

      expect(outcome).toEqual({
        kind: "not-merged",
        pr: { number: 1, url: urlOf(1) },
        wait: { kind: "timeout", status: "BLOCKED" },
      });
      expect(reportOf(outcome).text).toBe(
        `The release pull request #1 (${urlOf(1)}) is not mergeable after 60 min (BLOCKED); nothing merged, main unmoved. Once human-approved is on it and its required checks are green, the same bun ./scripts/release.ts --plan <digest> applies again and resumes the wait.`,
      );
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(target);

      const pushed = git(origin, "rev-parse", `refs/heads/release/${target.slice(0, 12)}`);

      hub.act = approve;
      said.length = 0;

      expect(
        await ship(
          repo,
          plan,
          context(hub.gh, (line) => said.push(line)),
        ),
      ).toHaveProperty("kind", "released");
      expect(hub.asked.filter((line) => line.startsWith("pr create"))).toHaveLength(1);
      expect(hub.asked.filter((line) => line.startsWith("pr merge"))).toEqual([
        `pr merge 1 --squash --match-head-commit ${pushed}`,
      ]);
      expect(said[0]).toBe(`resuming the wait for ${urlOf(1)}`);
      expect(git(origin, "rev-parse", `refs/heads/release/${target.slice(0, 12)}`)).toBe(pushed);
      expect(git(origin, "log", "-1", "--format=%s", "dev")).toBe(
        "chore(release): vellum@0.2.0 (#1)",
      );
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(
        git(origin, "rev-parse", "refs/heads/dev"),
      );
    },
    SLOW,
  );

  test.each<readonly [string, (pull: FakePull) => void, MergeStop, string]>([
    [
      "a red check",
      (pull: FakePull) => {
        pull.checks = [
          {
            __typename: "CheckRun",
            name: "test",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://ci.example/runs/9",
          },
          {
            __typename: "CheckRun",
            name: "owner-gate",
            status: "COMPLETED",
            conclusion: "FAILURE",
            detailsUrl: "https://ci.example/runs/10",
          },
        ];
      },
      {
        kind: "red",
        checks: [
          { name: "test", url: "https://ci.example/runs/9", verdict: "red", startedAt: null },
        ],
      },
      `The release pull request #1 (${urlOf(1)}) has test red (https://ci.example/runs/9); nothing merged, main unmoved. Read the failed runs. A flaky job: re-run it (gh run rerun <run-id> --failed), then the same bun ./scripts/release.ts --plan <digest> applies again and resumes the wait. A fix lands on dev on its own, not on this branch, whose head this script refuses unless it pushed it. Close it (gh pr close 1 --delete-branch --comment "a fix lands first"), then run the dry-run again.`,
    ],
    [
      "a red review after a skipped run of it",
      (pull: FakePull) => {
        pull.checks = [
          {
            __typename: "CheckRun",
            name: "review",
            status: "COMPLETED",
            conclusion: "SKIPPED",
            startedAt: EARLIER,
            detailsUrl: "https://ci.example/runs/11",
          },
          {
            __typename: "CheckRun",
            name: "review",
            status: "COMPLETED",
            conclusion: "FAILURE",
            startedAt: LATER,
            detailsUrl: "https://ci.example/runs/12",
          },
        ];
      },
      {
        kind: "red",
        checks: [
          { name: "review", url: "https://ci.example/runs/12", verdict: "red", startedAt: LATER },
        ],
      },
      `The release pull request #1 (${urlOf(1)}) has review red (https://ci.example/runs/12); nothing merged, main unmoved. The review found something: read its comments on the pull request; running it again gives the same verdict. A fix lands on dev on its own, not on this branch, whose head this script refuses unless it pushed it. Close it (gh pr close 1 --delete-branch --comment "a fix lands first"), then run the dry-run again.`,
    ],
    [
      "the agent's check red with the job that runs it, a failure a flaky job explains",
      (pull: FakePull) => {
        pull.checks = [
          {
            __typename: "CheckRun",
            name: "review (read)",
            status: "COMPLETED",
            conclusion: "FAILURE",
            startedAt: EARLIER,
            detailsUrl: "https://ci.example/runs/13",
          },
          {
            __typename: "CheckRun",
            name: "review",
            status: "COMPLETED",
            conclusion: "FAILURE",
            startedAt: LATER,
            detailsUrl: "https://ci.example/runs/13",
          },
        ];
      },
      {
        kind: "red",
        checks: [
          {
            name: "review (read)",
            url: "https://ci.example/runs/13",
            verdict: "red",
            startedAt: EARLIER,
          },
          { name: "review", url: "https://ci.example/runs/13", verdict: "red", startedAt: LATER },
        ],
      },
      `The release pull request #1 (${urlOf(1)}) has review (read) red (https://ci.example/runs/13), review red (https://ci.example/runs/13); nothing merged, main unmoved. Read the failed runs. A flaky job: re-run it (gh run rerun <run-id> --failed), then the same bun ./scripts/release.ts --plan <digest> applies again and resumes the wait. A fix lands on dev on its own, not on this branch, whose head this script refuses unless it pushed it. Close it (gh pr close 1 --delete-branch --comment "a fix lands first"), then run the dry-run again.`,
    ],
    [
      "a conflict with dev",
      (pull: FakePull) => {
        pull.mergeable = "CONFLICTING";
      },
      { kind: "conflict" },
      `The release pull request #1 (${urlOf(1)}) conflicts with dev; nothing merged, main unmoved. Close it (gh pr close 1 --delete-branch --comment "conflicts with dev"), then run the dry-run again: its plan bumps on dev's head.`,
    ],
  ])(
    "stops on %s, dev and main unmoved",
    async (name, act, wait, said) => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const hub = github(act);
      const outcome = await ship(repo, await sealedPlan(target), context(hub.gh));

      expect(outcome).toEqual({ kind: "not-merged", pr: { number: 1, url: urlOf(1) }, wait });
      expect(reportOf(outcome).text).toBe(said);
      expect(hub.asked.filter((line) => line.startsWith("pr view"))).toHaveLength(1);

      if (name.includes("review")) expect(reportOf(outcome).text).not.toMatch(/re-?run/iu);
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(target);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(shipped());
    },
    SLOW,
  );

  test(
    "says the bumps are on dev, and what comes next, when the push to main is refused",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();
      refuseOnOrigin("refs/heads/main");

      const outcome = await ship(repo, await sealedPlan(target), context(github(approve).gh));

      const head = commitAt(repo, "origin/dev");

      expect(outcome).toHaveProperty("kind", "after-bumps");
      expect(outcome).toHaveProperty("head", head);
      expect(reportOf(outcome).text).toContain(
        `The bumps are on dev at ${head.slice(0, 7)}; main is unmoved: the push to main was refused, nothing tagged:`,
      );
      expect(reportOf(outcome).text).toContain("refs/heads/main refused");
      expect(git(origin, "tag", "--list")).toBe("");
    },
    SLOW,
  );

  test.each([
    ["a plugin the plan bumps", "vellum/c.ts", "with commits under a plugin the plan bumps ("],
    ["a plugin that now needs a bump too", "other/c.ts", "and other now need a bump too"],
  ])(
    "is refused, nothing pushed, when dev moved under %s",
    async (_, path, why) => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);

      write(path, "c\n");
      const moved = commit("fix: c");

      pushDev();

      const outcome = await ship(repo, plan, context(github(approve).gh));

      expect(outcome).toHaveProperty("kind", "refused");
      expect(outcome).toHaveProperty("why", expect.stringContaining(why));
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(moved);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(plan.shipped);
      expect(git(origin, "tag", "--list")).toBe("");
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "is refused, nothing pushed, when a commit hook refuses a bump",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();
      writeFileSync(
        join(repo, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\necho no bump >&2\nexit 1\n",
      );
      chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);

      const outcome = await ship(repo, await sealedPlan(target), context(github(approve).gh));

      expect(outcome).toEqual({
        kind: "refused",
        why: "the commit chore(release): vellum@0.2.0 failed:\nno bump",
      });
      expect(git(origin, "rev-parse", "refs/heads/dev")).toBe(target);
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "stops on a red push run with the bumps on dev and main unmoved",
    async () => {
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a");

      pushDev();
      answerVellumMinor();

      const hub = github(approve);

      hub.ci = "failure";

      const outcome: ShipOutcome = await ship(repo, await sealedPlan(target), context(hub.gh));

      expect(outcome).toEqual({
        kind: "ci-not-green",
        head: commitAt(repo, "origin/dev"),
        bumped: true,
        ci: {
          kind: "red",
          red: [
            {
              id: 7,
              status: "completed",
              conclusion: "failure",
              url: "https://ci.example/runs/7",
            },
          ],
        },
      });
      expect(git(origin, "log", "-1", "--format=%s", "dev")).toBe(
        "chore(release): vellum@0.2.0 (#1)",
      );
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(shipped());
      expect(git(origin, "tag", "--list")).toBe("");
    },
    SLOW,
  );

  test("with nothing to bump, waits for the target's push run and releases it", async () => {
    write("vellum/README.md", "docs alone\n");
    const target = commit("docs(vellum): readme");

    pushDev();

    const plan = await sealedPlan(target);
    const asked: string[] = [];

    expect(plan.bumps).toEqual([]);
    expect(await ship(repo, plan, context(ciGh("success", asked)))).toEqual({
      kind: "released",
      tags: [],
    });
    expect(asked[0]).toContain(`head_sha=${target}&event=push`);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(target);
    expect(existsSync(join(root, "claude.log"))).toBe(false);
  });

  test("is refused when main moved since the plan", async () => {
    write("notes.md", "n\n");
    const target = commit("docs: notes");

    pushDev();

    const plan = await sealedPlan(target);

    git(repo, "push", "--quiet", "origin", `${target}:refs/heads/main`);
    git(repo, "fetch", "--quiet", "origin");

    expect(await ship(repo, plan, context(ciGh("success", [])))).toHaveProperty(
      "why",
      expect.stringContaining("not at"),
    );
  });
});

describe("a plan", () => {
  test("is refused, and no plan written, when Claude's answer does not read", async () => {
    write("vellum/a.ts", "a\n");
    const target = commit("fix(vellum): a");

    pushDev();
    answer("vellum", { level: "huge", reason: "r", summary: "s", body: "b" });

    await expect(sealedPlan(target)).rejects.toThrow(
      'vellum: Claude\'s level "huge" is not one of',
    );
    expect(existsSync(join(repo, ".git", "release-plan"))).toBe(false);
  });

  test("is refused when Claude's changelog section would not parse", async () => {
    write("vellum/a.ts", "a\n");
    const target = commit("fix(vellum): a");

    pushDev();
    answer("vellum", { level: "patch", reason: "r", summary: "s", body: "## Fixed\n\n- A." });

    await expect(sealedPlan(target)).rejects.toThrow("holds a heading of level 1 or 2");
  });

  test("is refused for an older SHA that needs a bump", async () => {
    write("vellum/a.ts", "a\n");
    const older = commit("fix(vellum): a");

    write("notes.md", "n\n");
    commit("docs: notes");
    pushDev();

    await expect(sealedPlan(older)).rejects.toThrow(
      "vellum need a bump, and a bump needs dev's head",
    );
  });
});

describe("the command line", () => {
  test.each([
    [["--dry-run"], "dry-run"],
    [["--dry-run", "abc123"], "dry-run"],
    [["abc123", "--dry-run"], "dry-run"],
    [["--plan", "0123456789ab", "--dry-run"], "usage"],
    [["--dry-run", "a", "b"], "usage"],
    [["--", "--dry-run"], "usage"],
    [["--dry-run=1"], "usage"],
    [["--dry-run", "--json"], "dry-run"],
    [["--json", "abc123", "--dry-run"], "dry-run"],
    [["--json"], "usage"],
    [["--plan", "0123456789ab", "--json"], "usage"],
    [["--plan", "0123456789ab"], "apply"],
    [["--plan"], "usage"],
    [["abc123"], "usage"],
    [[], "usage"],
  ])("reads %p as %s", (args, kind) => {
    expect<string>(parseCli(args).kind).toBe(kind);
  });

  test("applies only a plan named by its digest", () => {
    expect(parseCli(["--plan", "0123456789ab"])).toEqual({
      kind: "apply",
      digest: "0123456789ab",
    });
    expect(parseCli(["abc123", "--dry-run"])).toEqual({
      kind: "dry-run",
      ref: "abc123",
      json: false,
    });
    expect(parseCli(["--dry-run", "--json"])).toEqual({ kind: "dry-run", ref: null, json: true });
  });
});

function semver(text: string): Semver {
  const checked = semverOf(text);

  if (checked === null) throw new Error(`not x.y.z: ${text}`);

  return checked;
}

function drafted(bumps: readonly PlannedBump[]): DryRun {
  // SAFETY: the brand states a commit id; this one is a literal of the test.
  const target = "b".repeat(40) as CommitId;

  return {
    // SAFETY: as above.
    plan: { shipped: "a".repeat(40) as CommitId, target, bumps },
    tags: [],
    costUsd: 0.034,
    sealed: {
      path: join(repo, ".git", "release-plan", `${target}.json`),
      digest: "0123456789ab",
    },
  };
}

describe("the dry-run's output", () => {
  const bump: PlannedBump = {
    // SAFETY: the brand states a catalog name; this one is a literal of the test.
    name: "vellum" as MarketplaceName,
    // SAFETY: the brand states a directory below the root; this one is a literal of the test.
    source: "vellum" as SourceDir,
    from: semver("0.17.9"),
    to: semver("0.18.0"),
    codeLevel: "patch",
    level: "minor",
    reason: "breaking under 0.x",
    summary: "only the human starts it",
    section: "## 0.18.0 - 2026-10-20\n\n### Changed\n\n- Only you start it.",
  };

  test("shows Claude's reason only when its level departs from the subjects'", () => {
    const agreed = describePlan(drafted([{ ...bump, codeLevel: "minor" }]).plan, []);
    const departed = describePlan(drafted([bump]).plan, []);

    expect(agreed).not.toContain("why");
    expect(agreed).not.toContain("⚠");
    expect(departed).toContain("  why  breaking under 0.x");
    expect(departed).toContain("⚠ subjects said patch");
  });

  test("ends on the digest line release-plugins reads, uncoloured whatever the view paints", () => {
    const painted: View = { paint: (_format, text) => `<${text}>`, width: 100 };
    const lines = describeDryRun(repo, drafted([bump]), painted).split("\n");

    expect(lines.at(-1)).toBe("digest: 0123456789ab");
    expect(lines.at(-2)).toBe(`<Plan    >.git/release-plan/${"b".repeat(40)}.json`);
    expect(lines.at(-3)).toBe("<Cost    >$0.03 (opus × 1)");
  });

  test("names a plan sealed outside the repository, as a worktree's is, by its absolute path", () => {
    const sealed = { path: "/elsewhere/release-plan/b.json", digest: "0123456789ab" };

    expect(
      describeDryRun(repo, { ...drafted([bump]), sealed })
        .split("\n")
        .at(-2),
    ).toBe("Plan    /elsewhere/release-plan/b.json");
  });

  test("gives an agent the plan, each bump's subject and tag, and the digest, as JSON", () => {
    const run = drafted([bump]);

    expect(JSON.parse(dryRunJson(run))).toEqual({
      shipped: run.plan.shipped,
      target: run.plan.target,
      digest: "0123456789ab",
      plan: run.sealed.path,
      model: "opus",
      costUsd: 0.034,
      title: "chore(release): vellum@0.18.0",
      bumps: [
        {
          ...bump,
          subject: "chore(vellum): 0.18.0, only the human starts it",
          tag: "vellum-v0.18.0",
        },
      ],
      tags: [],
    });
  });

  test("folds a long line on spaces, a list item's continuation under its text", () => {
    expect(folded("- one two three four", 10)).toEqual(["- one two", "  three", "  four"]);
    expect(folded("aaaa bbbb\n\ncccc", 4)).toEqual(["aaaa", "bbbb", "", "cccc"]);
    expect(folded("unbreakable-token-longer-than-width", 5)).toEqual([
      "unbreakable-token-longer-than-width",
    ]);
  });

  test("keeps the text the plan commits: a line that fits, its spacing, and a fenced block as they are", () => {
    expect(folded("Run `bun  ./x.ts   --flag` now", 100)).toEqual([
      "Run `bun  ./x.ts   --flag` now",
    ]);
    expect(folded("| a  | b  |", 100)).toEqual(["| a  | b  |"]);
    expect(folded("aa  bb  cc", 7)).toEqual(["aa  bb", "cc"]);
    expect(
      folded("```sh\nbun ./scripts/a-long-command.ts --with many flags\n```\nafter it", 10),
    ).toEqual(["```sh", "bun ./scripts/a-long-command.ts --with many flags", "```", "after it"]);
  });
});

const EARLIER = "2026-11-23T10:00:00Z";

const LATER = "2026-11-23T10:05:00Z";

function check(
  name: string,
  verdict: PullCheck["verdict"],
  startedAt: string | null = null,
): PullCheck {
  return { name, url: `https://ci.example/${name}`, verdict, startedAt };
}

describe("the wait for the release pull request", () => {
  const pushed = "b".repeat(40);

  const open: Extract<PullView, { state: "OPEN" }> = {
    state: "OPEN",
    headRefOid: pushed,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    checks: [],
  };

  function decided(view: PullView, elapsedMs = 0) {
    return decideMerge(view, pushed, elapsedMs, 1000);
  }

  test("waits while owner-gate alone is red: it is red until the owner's label", () => {
    expect(
      decided({ ...open, checks: [check("owner-gate", "red"), check("test", "green")] }),
    ).toEqual({ kind: "wait" });
  });

  test("judges each check by its latest run, ordered by startedAt, not by its place in the list", () => {
    expect(
      decided({ ...open, checks: [check("test", "red", LATER), check("test", "green", EARLIER)] }),
    ).toEqual({ kind: "red", checks: [check("test", "red", LATER)] });
    expect(
      decided({ ...open, checks: [check("test", "green", LATER), check("test", "red", EARLIER)] }),
    ).toEqual({ kind: "wait" });
  });

  test("stops at once on a red run after a green or skipped one", () => {
    expect(
      decided({
        ...open,
        checks: [check("review", "green", EARLIER), check("review", "red", LATER)],
      }),
    ).toEqual({ kind: "red", checks: [check("review", "red", LATER)] });
  });

  test("waits on a red check whose re-run is queued, not started yet", () => {
    expect(
      decided({ ...open, checks: [check("test", "red", EARLIER), check("test", "pending", null)] }),
    ).toEqual({ kind: "wait" });
  });

  test("is mergeable once GitHub's merge state is CLEAN, and on no other state", () => {
    expect(decided({ ...open, mergeStateStatus: "CLEAN" })).toEqual({ kind: "mergeable" });

    for (const status of ["BLOCKED", "BEHIND", "UNSTABLE", "UNKNOWN", "DRAFT"]) {
      expect(decided({ ...open, mergeStateStatus: status })).toEqual({ kind: "wait" });
    }
  });

  test("ends on a head it did not push, before anything else", () => {
    expect(decided({ ...open, headRefOid: "c".repeat(40), mergeStateStatus: "CLEAN" })).toEqual({
      kind: "foreign-head",
      head: "c".repeat(40),
      pushed,
    });
  });

  test("ends on a conflict, a close, a merge, and the timeout", () => {
    expect(decided({ ...open, mergeable: "CONFLICTING" })).toEqual({ kind: "conflict" });
    expect(decided({ state: "CLOSED" })).toEqual({ kind: "closed" });
    expect(decided({ state: "MERGED", mergeCommit: "c".repeat(40), headRefOid: pushed })).toEqual({
      kind: "merged",
      commit: "c".repeat(40),
      head: pushed,
    });
    expect(decided(open, 1000)).toEqual({ kind: "timeout", status: "BLOCKED" });
  });
});

describe("the commit hooks", () => {
  test(
    "lefthook's sync-versions puts each bump into the catalog and the README, in the bump's commit",
    async () => {
      installSyncVersions();
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a, with the hooks");

      pushDev();
      answerVellumMinor();

      expect(
        await ship(repo, await sealedPlan(target), context(github(approve).gh)),
      ).toHaveProperty("kind", "released");

      const head = git(origin, "rev-parse", "refs/heads/dev");

      expect(git(origin, "show", "--name-only", "--format=", head).split("\n")).toEqual([
        ".claude-plugin/marketplace.json",
        "README.md",
        "vellum/.claude-plugin/plugin.json",
        "vellum/CHANGELOG.md",
      ]);
      expect(
        JSON.parse(git(origin, "show", `${head}:.claude-plugin/marketplace.json`)).plugins[0],
      ).toEqual({
        name: "vellum",
        source: "./vellum",
        version: "0.2.0",
      });
      expect(git(origin, "show", `${head}:README.md`)).toContain(
        "| [vellum](vellum/) | 0.2.0 | Plans. |",
      );
    },
    SLOW,
  );

  test(
    "the bumps' commit is made on dev's head, so the README row dev changed since the plan keeps its text",
    async () => {
      installSyncVersions();
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a, with the hooks");

      pushDev();
      answerVellumMinor();

      const plan = await sealedPlan(target);

      write(
        "README.md",
        readFileSync(join(repo, "README.md"), "utf8").replace("Plans.", "Plans, read in a page."),
      );
      const moved = commit("docs: vellum's row says more");

      pushDev();

      const outcome = await ship(repo, plan, context(github(approve).gh));
      const head = git(origin, "rev-parse", "refs/heads/dev");

      expect(outcome).toHaveProperty("kind", "released");
      expect(git(origin, "rev-parse", "refs/heads/dev~1")).toBe(moved);
      expect(git(origin, "show", `${head}:README.md`)).toContain(
        "| [vellum](vellum/) | 0.2.0 | Plans, read in a page. |",
      );
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );
});
