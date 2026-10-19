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

import { releaseScriptOf } from "../agent-hooks/landing.ts";
import { type CommitId, commitAt } from "./check-plugin-bumps.ts";
import type { Gh } from "./ci-wait.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";
import { loadPlan, localDate, planRelease, type ReleasePlan, sealPlan } from "./release-plan.ts";
import {
  type Context,
  describePlan,
  parseCli,
  plannedTags,
  release,
  ship,
  type ShipOutcome,
} from "./release.ts";

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

function context(gh: Gh): Context {
  return { gh, limits: { timeoutMs: 1000, pollMs: 10 }, say: () => {} };
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
      "no plugin to bump",
      `vellum-v0.2.1 on ${setThree.slice(0, 7)}, with the sections:`,
      "  0.2.1 - 2026-09-26",
      "  0.2.0 - 2026-09-26",
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
        `main ${shipped().slice(0, 7)} -> ${target.slice(0, 7)}`,
        "vellum 0.1.0 -> 0.2.0, minor (the commit subjects propose patch)",
        "  chore(vellum): 0.2.0, the a module",
        "  why: a user sees the a module",
        "    ## 0.2.0 - 2026-10-20",
        "",
        "    ### Added",
        "",
        "    - The a module.",
        "other 1.0.0 -> 1.0.1, patch (the commit subjects propose minor)",
        "  chore(other): 1.0.1, b fixed",
        "  why: a fix",
        "vellum-v0.2.0 on its bump commit",
      ]);

      const asked: string[] = [];
      const outcome = await ship(repo, plan, context(ciGh("success", asked)));
      const head = git(origin, "rev-parse", "refs/heads/dev");
      const vellumBump = git(origin, "rev-parse", "refs/heads/dev~1");

      expect(git(origin, "log", "--format=%s", `${target}..dev`).split("\n")).toEqual([
        "chore(other): 1.0.1, b fixed",
        "chore(vellum): 0.2.0, the a module",
      ]);
      expect(git(origin, "rev-parse", "refs/heads/dev~2")).toBe(target);
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
      expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.0^{commit}")).toBe(vellumBump);
      expect(tagMessage("vellum-v0.2.0")).toBe(
        "## 0.2.0 - 2026-10-20\n\n### Added\n\n- The a module.",
      );
      expect(git(origin, "show", "--name-only", "--format=", vellumBump).split("\n")).toEqual([
        "vellum/.claude-plugin/plugin.json",
        "vellum/CHANGELOG.md",
      ]);
      expect(git(origin, "show", `${head}:other/.claude-plugin/plugin.json`)).toBe(
        '{"name":"other","version":"1.0.1"}',
      );
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain(`head_sha=${head}&event=push`);
      expect(outcome).toHaveProperty("kind", "released");
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test(
    "rebases the bumps when dev moved by commits the plan needs not cover",
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

      const outcome = await ship(repo, plan, context(ciGh("success", [])));
      const head = git(origin, "rev-parse", "refs/heads/dev");

      expect(outcome).toHaveProperty("kind", "released");
      expect(git(origin, "rev-parse", "refs/heads/dev~1")).toBe(moved);
      expect(git(origin, "log", "-1", "--format=%s", "dev")).toBe(
        "chore(vellum): 0.2.0, the a module",
      );
      expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
      expect(git(origin, "rev-parse", "refs/tags/vellum-v0.2.0^{commit}")).toBe(head);
      expect(worktreeCount()).toBe(1);
    },
    SLOW,
  );

  test.each([
    [
      "a plugin the plan bumps",
      "vellum/c.ts",
      "with changes to a plugin the plan bumps (vellum/c.ts)",
    ],
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

      const outcome = await ship(repo, plan, context(ciGh("success", [])));

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

      const outcome = await ship(repo, await sealedPlan(target), context(ciGh("success", [])));

      expect(outcome).toEqual({
        kind: "refused",
        why: "the commit chore(vellum): 0.2.0, the a module failed:\nno bump",
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

      const outcome: ShipOutcome = await ship(
        repo,
        await sealedPlan(target),
        context(ciGh("failure", [])),
      );

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
        "chore(vellum): 0.2.0, the a module",
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
    [["--dry-run"]],
    [["--dry-run", "abc123"]],
    [["abc123", "--dry-run"]],
    [["--plan", "0123456789ab", "--dry-run"]],
    [["--dry-run", "a", "b"]],
    [["--dry-run=1"]],
    [["--", "--dry-run"]],
    [["--plan", "0123456789ab"]],
    [["--plan"]],
    [["abc123"]],
    [[]],
  ])("reads --dry-run where the landing guard does: %p", (args) => {
    const cli = parseCli(args);
    const guarded = releaseScriptOf(["bun", "./scripts/release.ts", ...args], "/r");

    expect(guarded).not.toBeNull();
    expect(cli.kind === "apply" && guarded?.dryRun === true).toBe(false);
    expect(cli.kind === "dry-run" && guarded?.dryRun === false).toBe(false);
  });

  test("applies only a plan named by its digest", () => {
    expect(parseCli(["--plan", "0123456789ab"])).toEqual({
      kind: "apply",
      digest: "0123456789ab",
    });
    expect(parseCli(["abc123", "--dry-run"])).toEqual({ kind: "dry-run", ref: "abc123" });
    expect(parseCli(["abc123"])).toEqual({ kind: "usage" });
    expect(parseCli([])).toEqual({ kind: "usage" });
  });
});

describe("the commit hooks", () => {
  test(
    "lefthook's sync-versions puts each bump into the catalog and the README, in the bump's commit",
    async () => {
      const scripts = join(import.meta.dir);
      const real = parse(readFileSync(join(scripts, "..", "lefthook.yml"), "utf8"));

      const job = real["pre-commit"].jobs.find(
        ({ name }: { name: string }) => name === "sync-versions",
      );

      write("lefthook.yml", stringify({ "pre-commit": { jobs: [job] } }));
      mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
      copyFileSync(join(scripts, "sync-versions.ts"), join(repo, "scripts", "sync-versions.ts"));
      chmodSync(join(repo, "scripts", "sync-versions.ts"), 0o755);
      copyFileSync(
        join(scripts, "lib", "marketplace-validation.ts"),
        join(repo, "scripts", "lib", "marketplace-validation.ts"),
      );
      catalog(
        { name: "vellum", source: "./vellum", version: "0.1.0" },
        { name: "other", source: "./other", version: "1.0.0" },
      );
      write(
        "README.md",
        "| Plugin | Version | Description |\n|---|---|---|\n| [vellum](vellum/) | 0.1.0 | Plans. |\n| [other](other/) | 1.0.0 | Other. |\n",
      );
      write("vellum/a.ts", "a\n");
      const target = commit("fix(vellum): a, with the hooks");

      const installed = Bun.spawnSync(["lefthook", "install"], {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(installed.stderr.toString()).toBe("");
      pushDev();
      answerVellumMinor();

      expect(
        await ship(repo, await sealedPlan(target), context(ciGh("success", []))),
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
});
