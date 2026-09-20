import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import {
  type PluginDir,
  type PluginName,
  pluginDirAt,
  pluginNameIn,
  pluginNamesIn,
  readPlugins,
  readSources,
  worktreePathFor,
} from "./plugin-sources.ts";

let scratch = "";

function dirAt(path: string): PluginDir {
  const dir = pluginDirAt(path);

  if (dir === null) throw new Error(`not a directory: ${path}`);

  return dir;
}

function nameIn(root: PluginDir, name: string): PluginName {
  const plugin = pluginNameIn(root, name);

  if (plugin === null) throw new Error(`not a plugin: ${name}`);

  return plugin;
}

function unbranded(value: string | null): string | null {
  return value;
}

function writePlugin(root: string, name: string, version: string, declared = name): void {
  mkdirSync(join(root, name, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, name, ".claude-plugin", "plugin.json"),
    `{"name":"${declared}","version":"${version}"}\n`,
  );
}

/**
 * A scratch repo every git command can write in: a CI runner carries no identity, and
 * `commit.gpgsign` and `tag.gpgsign` are on globally here, so a suite must reach for no real key.
 * Repo config rather than flags per call, so a command added later carries neither.
 */
async function initRepo(repo: string): Promise<void> {
  mkdirSync(repo);
  await $`git -C ${repo} init -q -b dev`.quiet();
  await $`git -C ${repo} config user.email t@t`.quiet();
  await $`git -C ${repo} config user.name t`.quiet();
  await $`git -C ${repo} config commit.gpgsign false`.quiet();
  await $`git -C ${repo} config tag.gpgsign false`.quiet();
}

async function commit(repo: string, message: string, date: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -q -m ${message} --date=${date}`
    .env({ ...process.env, GIT_COMMITTER_DATE: date })
    .quiet();
}

/**
 * A repo shaped like the real one: two plugins on `dev`, a branch ahead on one
 * of them, another ahead on no plugin at all, and the two ref spaces
 * `--no-merged dev` picks up when nobody names refs/heads and refs/remotes.
 */
async function buildRepo(): Promise<string> {
  const repo = join(scratch, "repo");

  await initRepo(repo);
  writePlugin(repo, "alpha", "1.0.0");
  writePlugin(repo, "beta", "2.0.0");
  writeFileSync(join(repo, "README.md"), "root\n");
  await commit(repo, "init", "2026-01-01T00:00:00Z");

  await $`git -C ${repo} switch -q -c work`.quiet();
  writePlugin(repo, "alpha", "1.1.0");
  await commit(repo, "work on alpha", "2026-02-01T00:00:00Z");

  await $`git -C ${repo} switch -q -c parked dev`.quiet();
  writeFileSync(join(repo, "README.md"), "parked\n");
  await commit(repo, "root file only", "2026-03-01T00:00:00Z");

  await $`git -C ${repo} switch -q dev`.quiet();

  const ahead = (await $`git -C ${repo} rev-parse work`.quiet().text()).trim();

  await $`git -C ${repo} update-ref refs/original/refs/heads/main ${ahead}`.quiet();
  await $`git -C ${repo} tag -m backup backup/before-rebase ${ahead}`.quiet();

  return repo;
}

describe("plugin-sources", () => {
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "plugin-sources-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("pluginDirAt takes an existing directory and nothing else", () => {
    writeFileSync(join(scratch, "file"), "");

    expect(unbranded(pluginDirAt(scratch))).toBe(scratch);
    expect(pluginDirAt(join(scratch, "file"))).toBeNull();
    expect(pluginDirAt(join(scratch, "missing"))).toBeNull();
  });

  test("pluginNameIn takes a directory carrying a manifest", () => {
    writePlugin(scratch, "alpha", "1.0.0");
    mkdirSync(join(scratch, "docs"));

    const root = dirAt(scratch);

    expect(unbranded(pluginNameIn(root, "alpha"))).toBe("alpha");
    expect(pluginNameIn(root, "docs")).toBeNull();
    expect(pluginNamesIn(root).map((name) => unbranded(name))).toEqual(["alpha"]);
  });

  test("worktreePathFor sits beside the main checkout, under its ref", () => {
    expect(worktreePathFor(dirAt(scratch), "fix/x")).toBe(`${scratch}.wt/fix/x`);
  });

  test("a ref is a source when it carries commits on that plugin dev lacks", async () => {
    const root = dirAt(await buildRepo());
    const sources = await readSources(root, nameIn(root, "alpha"));

    expect(sources.map((source) => source.ref)).toEqual(["work", "dev"]);
    expect(sources[0]).toEqual({
      ref: "work",
      version: "1.1.0",
      lastCommit: "2026-02-01",
      ahead: 1,
      kind: "branch",
      hasLocalBranch: true,
    });
    expect(sources[1]).toEqual({
      ref: "dev",
      version: "1.0.0",
      lastCommit: "2026-01-01",
      ahead: 0,
      kind: "checkout",
      dir: root,
    });
  });

  test("a ref ahead on another path is not a source", async () => {
    const root = dirAt(await buildRepo());
    const sources = await readSources(root, nameIn(root, "beta"));

    expect(sources.map((source) => source.ref)).toEqual(["dev"]);
  });

  test("refs outside refs/heads and refs/remotes stay out", async () => {
    const root = dirAt(await buildRepo());
    const refs = (await readSources(root, nameIn(root, "alpha"))).map((source) => source.ref);

    expect(refs).not.toContain("backup/before-rebase");
    expect(refs).not.toContain("refs/original/refs/heads/main");
  });

  test("a worktree is a checkout, read on the branch field and not on its path", async () => {
    const repo = await buildRepo();
    const root = dirAt(repo);
    const lying = join(scratch, "named-after-nothing");

    await $`git -C ${repo} worktree add -q ${lying} work`.quiet();

    const sources = await readSources(root, nameIn(root, "alpha"));
    const work = sources.find((source) => source.ref === "work");

    expect(work).toEqual({
      ref: "work",
      version: "1.1.0",
      lastCommit: "2026-02-01",
      ahead: 1,
      kind: "checkout",
      dir: dirAt(lying),
    });
  });

  test("a worktree on dev's commit is its own source, with what its disk holds", async () => {
    const repo = await buildRepo();
    const root = dirAt(repo);
    const wip = join(scratch, "wip");

    await $`git -C ${repo} worktree add -q ${wip} -b wip dev`.quiet();
    writePlugin(wip, "alpha", "9.9.9-wip");

    const sources = await readSources(root, nameIn(root, "alpha"));

    expect(sources.map((source) => [source.ref, source.version])).toEqual([
      ["work", "1.1.0"],
      ["dev", "1.0.0"],
      ["wip", "9.9.9-wip"],
    ]);
  });

  test("two refs on one commit are one source, the local branch winning", async () => {
    const repo = await buildRepo();
    const root = dirAt(repo);
    const ahead = (await $`git -C ${repo} rev-parse work`.quiet().text()).trim();

    await $`git -C ${repo} update-ref refs/remotes/origin/work ${ahead}`.quiet();

    const refs = (await readSources(root, nameIn(root, "alpha"))).map((source) => source.ref);

    expect(refs).toEqual(["work", "dev"]);
  });

  test("a detached worktree is the checkout of the ref whose tip it holds", async () => {
    const repo = await buildRepo();
    const root = dirAt(repo);
    const ahead = (await $`git -C ${repo} rev-parse work`.quiet().text()).trim();
    const det = join(scratch, "det");

    await $`git -C ${repo} update-ref refs/remotes/origin/only ${ahead}`.quiet();
    await $`git -C ${repo} branch -q -D work`.quiet();
    await $`git -C ${repo} worktree add -q --detach ${det} refs/remotes/origin/only`.quiet();

    const sources = await readSources(root, nameIn(root, "alpha"));

    expect(sources[0]).toEqual({
      ref: "origin/only",
      version: "1.1.0",
      lastCommit: "2026-02-01",
      ahead: 1,
      kind: "checkout",
      dir: dirAt(det),
    });
  });

  test("a remote ref alone materializes on a detached HEAD", async () => {
    const repo = await buildRepo();
    const root = dirAt(repo);
    const ahead = (await $`git -C ${repo} rev-parse work`.quiet().text()).trim();

    await $`git -C ${repo} update-ref refs/remotes/origin/only ${ahead}`.quiet();
    await $`git -C ${repo} branch -q -D work`.quiet();

    const sources = await readSources(root, nameIn(root, "alpha"));

    expect(sources[0]).toEqual({
      ref: "origin/only",
      version: "1.1.0",
      lastCommit: "2026-02-01",
      ahead: 1,
      kind: "branch",
      hasLocalBranch: false,
    });
  });

  test("readPlugins reads dev's versions and marks the plugins with work elsewhere", async () => {
    const repo = await buildRepo();
    const root = dirAt(repo);
    const config = join(scratch, "config");

    mkdirSync(join(config, "plugins"), { recursive: true });
    writeFileSync(
      join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "alpha@market": [{ scope: "user", version: "0.9.0" }],
          "beta@market": [{ scope: "local", version: "2.0.0" }],
        },
      }),
    );
    process.env["CLAUDE_CONFIG_DIR"] = config;

    try {
      expect(await readPlugins(root)).toEqual([
        {
          name: nameIn(root, "alpha"),
          devVersion: "1.0.0",
          installedVersion: "0.9.0",
          outsideDev: true,
        },
        {
          name: nameIn(root, "beta"),
          devVersion: "2.0.0",
          installedVersion: null,
          outsideDev: false,
        },
      ]);
    } finally {
      delete process.env["CLAUDE_CONFIG_DIR"];
    }
  });

  test("the installed version is read under the declared name, not the directory", async () => {
    const repo = join(scratch, "declaring");
    const config = join(scratch, "config");

    await initRepo(repo);
    writePlugin(repo, "orchestration", "2.8.1", "claude-orchestration");
    await commit(repo, "init", "2026-01-01T00:00:00Z");

    mkdirSync(join(config, "plugins"), { recursive: true });
    writeFileSync(
      join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "claude-orchestration@market": [{ scope: "user", version: "2.7.0" }] },
      }),
    );
    process.env["CLAUDE_CONFIG_DIR"] = config;

    try {
      const rows = await readPlugins(dirAt(repo));

      expect(rows[0]?.installedVersion).toBe("2.7.0");
    } finally {
      delete process.env["CLAUDE_CONFIG_DIR"];
    }
  });
});
