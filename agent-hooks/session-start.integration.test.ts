import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { HookOptions } from "./hook.ts";
import { loadState } from "./state.ts";
import type { Json, TempRepo } from "./test-support.ts";
import {
  commitFiles,
  createTempRepo,
  fixtureIn,
  git,
  hookOutput,
  readRepoFile,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

let temp: TempRepo;

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo({ "a.ts": "a\n" });
});

afterEach(() => {
  removeTempRepo(temp);
});

const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);

describe("session-start", () => {
  test("in a checkout without the config it prints nothing and writes no state", async () => {
    expect(
      await hookOutput("session-start", fixtureIn("session-start-startup", temp.repo)),
    ).toBeNull();
    expect(existsSync(temp.stateDir)).toBeFalse();
  });

  test("photographs the checkout around the cwd once: a resume keeps the first photo", async () => {
    writeConfig(temp.repo, "{}");
    writeRepoFile(temp.repo, "a.ts", "dirty before\n");

    expect(
      await hookOutput("session-start", fixtureIn("session-start-startup", temp.repo)),
    ).toBeNull();
    const first = loadState("s1", temp.repo).photo;
    writeRepoFile(temp.repo, "b.ts", "made during the session\n");
    await hookOutput("session-start", fixtureIn("session-start-resume", temp.repo));

    expect(first?.files).toContainKeys(["a.ts", ".claude/agent-hooks.jsonc"]);
    expect(first?.files).not.toContainKey("b.ts");
    expect(loadState("s1", temp.repo).photo).toEqual(first);
  });

  test("photographs from a subdirectory the checkout at its top", async () => {
    writeConfig(temp.repo, "{}");
    writeRepoFile(temp.repo, "pkg/x.ts", "x\n");

    await hookOutput(
      "session-start",
      fixtureIn("session-start-startup", temp.repo, { cwd: path.join(temp.repo, "pkg") }),
    );

    expect(loadState("s1", temp.repo).photo?.files).toContainKey("pkg/x.ts");
  });

  test("removes the scratch directories a killed pre-edit left, and nothing that may still be in use or is the repository's", async () => {
    writeConfig(temp.repo, "{}");
    commitFiles(temp.repo, { "src/.agent-hooks-Tr4ck3/kept.ts": "tracked\n" });

    for (const dir of [
      "src/.agent-hooks-OLD123",
      "src/.agent-hooks-NEW123",
      "src/.agent-hooks-longer-name",
    ]) {
      writeRepoFile(temp.repo, `${dir}/a.ts`, "copy\n");
    }

    for (const dir of [
      "src/.agent-hooks-OLD123",
      "src/.agent-hooks-Tr4ck3",
      "src/.agent-hooks-longer-name",
    ]) {
      utimesSync(path.join(temp.repo, dir), HOUR_AGO, HOUR_AGO);
    }

    writeRepoFile(temp.repo, "src/.agent-hooks-Tr4ck3/new.ts", "untracked\n");
    utimesSync(path.join(temp.repo, "src/.agent-hooks-Tr4ck3"), HOUR_AGO, HOUR_AGO);

    await hookOutput("session-start", fixtureIn("session-start-startup", temp.repo));

    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-OLD123"))).toBeFalse();
    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-NEW123"))).toBeTrue();
    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-Tr4ck3/new.ts"))).toBeTrue();
    expect(existsSync(path.join(temp.repo, "src/.agent-hooks-longer-name"))).toBeTrue();
  });
});

const SETTINGS = ".claude/settings.json";

const LOCAL_SETTINGS = ".claude/settings.local.json";

function declaring(...directories: string[]): string {
  return JSON.stringify({ worktree: { symlinkDirectories: directories } });
}

/**
 * The main checkout as a desktop worktree session finds it: the kit's config and `files` committed, each of
 * `installed` holding a file but untracked, and a worktree created under `.claude/worktrees/` the way Claude Code
 * creates one, without the repository's git hooks. Returns the worktree's top.
 */
function desktopWorktree(files: Readonly<Record<string, string>>, installed: readonly string[]) {
  commitFiles(temp.repo, {
    ".gitignore": "node_modules\n/.claude/worktrees/\n",
    ".claude/agent-hooks.jsonc": "{}\n",
    "pkg/package.json": "{}\n",
    ...files,
  });

  for (const directory of installed) {
    writeRepoFile(temp.repo, `${directory}/installed.txt`, "dependency\n");
  }

  const worktree = path.join(temp.repo, ".claude/worktrees/desk");
  git(temp.repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-q", "-b", "desk", worktree);

  return worktree;
}

/** SessionStart as the Code tab runs it: in the main checkout, `CLAUDE_PROJECT_DIR` on it, the session's cwd in the payload. */
function desktopSessionStart(
  cwd: string,
  options: Partial<HookOptions> = {},
): Promise<Json | null> {
  process.chdir(temp.repo);
  process.env["CLAUDE_PROJECT_DIR"] = temp.repo;

  return hookOutput(
    "session-start",
    fixtureIn("session-start-startup", temp.repo, { cwd }),
    options,
  );
}

/** Where the link at `relative` under `top` points, or null when no link stands there. */
function linkAt(top: string, relative: string): string | null {
  const target = path.join(top, relative);
  const stats = lstatSync(target, { throwIfNoEntry: false });

  return stats?.isSymbolicLink() === true ? readlinkSync(target) : null;
}

describe("session-start in a worktree the desktop app created", () => {
  const processCwd = process.cwd();
  const projectDir = process.env["CLAUDE_PROJECT_DIR"];

  afterEach(() => {
    process.chdir(processCwd);

    if (projectDir === undefined) {
      delete process.env["CLAUDE_PROJECT_DIR"];
    } else {
      process.env["CLAUDE_PROJECT_DIR"] = projectDir;
    }
  });

  test("links each declared directory the main checkout holds, at the root and nested, from both settings files", async () => {
    const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules") }, [
      "node_modules",
      "pkg/node_modules",
    ]);

    writeRepoFile(temp.repo, LOCAL_SETTINGS, declaring("pkg/node_modules", "node_modules/"));

    expect(await desktopSessionStart(worktree)).toBeNull();

    expect(linkAt(worktree, "node_modules")).toBe(path.join(temp.repo, "node_modules"));
    expect(linkAt(worktree, "pkg/node_modules")).toBe(path.join(temp.repo, "pkg/node_modules"));
    expect(readRepoFile(worktree, "pkg/node_modules/installed.txt")).toBe("dependency\n");
    expect(git(worktree, "status", "--porcelain")).toBe("");
  });

  test("a cwd in a subdirectory of the worktree links at the worktree's top", async () => {
    const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules") }, ["node_modules"]);

    await desktopSessionStart(path.join(worktree, "pkg"));

    expect(linkAt(worktree, "node_modules")).toBe(path.join(temp.repo, "node_modules"));
    expect(existsSync(path.join(worktree, "pkg/node_modules"))).toBeFalse();
  });

  test("keeps what the worktree already holds at a declared path", async () => {
    const worktree = desktopWorktree(
      { [SETTINGS]: declaring("node_modules", "pkg/node_modules") },
      ["node_modules", "pkg/node_modules"],
    );

    writeRepoFile(worktree, "node_modules/own.txt", "installed here\n");

    await desktopSessionStart(worktree);

    expect(linkAt(worktree, "node_modules")).toBeNull();
    expect(readRepoFile(worktree, "node_modules/own.txt")).toBe("installed here\n");
    expect(linkAt(worktree, "pkg/node_modules")).toBe(path.join(temp.repo, "pkg/node_modules"));
  });

  test("a session in the main checkout links nothing", async () => {
    const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules") }, ["node_modules"]);

    expect(await desktopSessionStart(temp.repo)).toBeNull();

    expect(lstatSync(path.join(temp.repo, "node_modules")).isDirectory()).toBeTrue();
    expect(existsSync(path.join(worktree, "node_modules"))).toBeFalse();
  });

  test("without the setting, links nothing", async () => {
    const worktree = desktopWorktree(
      { [SETTINGS]: JSON.stringify({ worktree: { baseRef: "head" } }) },
      ["node_modules"],
    );

    expect(await desktopSessionStart(worktree)).toBeNull();

    expect(existsSync(path.join(worktree, "node_modules"))).toBeFalse();
  });

  test("a checkout without .claude/agent-hooks.jsonc is untouched", async () => {
    const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules") }, ["node_modules"]);
    git(worktree, "rm", "-q", ".claude/agent-hooks.jsonc");

    expect(await desktopSessionStart(worktree)).toBeNull();

    expect(existsSync(path.join(worktree, "node_modules"))).toBeFalse();
    expect(existsSync(temp.stateDir)).toBeFalse();
  });

  test("leaves out a directory the main checkout lacks, and one whose parent the worktree lacks", async () => {
    const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules", "gen/cache") }, [
      "gen/cache",
    ]);

    expect(await desktopSessionStart(worktree)).toBeNull();

    expect(existsSync(path.join(worktree, "node_modules"))).toBeFalse();
    expect(existsSync(path.join(worktree, "gen"))).toBeFalse();
  });

  test("a directory git would not ignore as a link is not linked, and the user is told the pattern for each path", async () => {
    const worktree = desktopWorktree(
      {
        ".gitignore": "node_modules/\n.venv/\n/.claude/worktrees/\n",
        [SETTINGS]: declaring("node_modules", "pkg/node_modules", ".venv"),
      },
      ["node_modules", "pkg/node_modules", ".venv"],
    );

    expect(await desktopSessionStart(worktree)).toEqual({
      systemMessage: `agent-hooks: not linked into ${worktree}: node_modules, pkg/node_modules, .venv. git would list each link as untracked: ignore it with a pattern without a trailing slash (/node_modules, /pkg/node_modules, /.venv), since to git a link is a file and a pattern with the slash matches only a directory.`,
    });

    for (const declared of ["node_modules", "pkg/node_modules", ".venv"]) {
      expect(existsSync(path.join(worktree, declared))).toBeFalse();
    }
  });

  test("a declared path outside the repository links nothing and names the file", async () => {
    const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules", "../shared") }, [
      "node_modules",
    ]);

    expect(await desktopSessionStart(worktree)).toEqual({
      systemMessage: `agent-hooks: declared directories not all linked into ${worktree}: ${path.join(temp.repo, SETTINGS)}: worktree.symlinkDirectories: "../shared" is not a directory path inside the repository`,
    });
    expect(existsSync(path.join(worktree, "node_modules"))).toBeFalse();
  });

  test("a photo that runs out of time still leaves the worktree linked", async () => {
    const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules") }, ["node_modules"]);

    // A 1000 ms hook deadline leaves the photo no time once the settle margin is taken: its git calls time out
    // without starting, while the link step keeps its own budget.
    const output = await desktopSessionStart(worktree, { deadlineMs: 1000 });

    expect(output).toBeNull();
    expect(linkAt(worktree, "node_modules")).toBe(path.join(temp.repo, "node_modules"));
    expect(loadState("s1", worktree).photo).toBeNull();
  });

  test("a slow photo does not hold the link step back: the links are made first", async () => {
    const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules") }, ["node_modules"]);
    const realGit = Bun.which("git");

    if (realGit === null) {
      throw new Error("git is not on the PATH");
    }

    // A git first on the PATH whose `status`, the photo's call, takes longer than the link step's budget.
    const bin = path.join(temp.dir, "slow-git");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = status ] && sleep 1.5; done\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(path.join(bin, "git"), 0o755);
    const pathBefore = process.env["PATH"];
    process.env["PATH"] = `${bin}${path.delimiter}${pathBefore ?? ""}`;

    try {
      expect(await desktopSessionStart(worktree)).toBeNull();
    } finally {
      process.env["PATH"] = pathBefore;
    }

    expect(linkAt(worktree, "node_modules")).toBe(path.join(temp.repo, "node_modules"));
  });

  test.each([
    { settings: "[]", error: "expected an object" },
    { settings: `{ "worktree": "head" }`, error: "worktree: expected an object" },
    {
      settings: `{ "worktree": { "symlinkDirectories": "node_modules" } }`,
      error: "worktree.symlinkDirectories: expected an array of directory paths",
    },
    { settings: `{ "worktree": `, error: "invalid JSON: " },
  ])(
    "a local settings file shaped $settings links nothing, from either file, and names the error",
    async ({ settings, error }) => {
      const worktree = desktopWorktree({ [SETTINGS]: declaring("node_modules") }, ["node_modules"]);
      writeRepoFile(temp.repo, LOCAL_SETTINGS, settings);

      const output = await desktopSessionStart(worktree);

      expect(output?.["systemMessage"]).toStartWith(
        `agent-hooks: declared directories not all linked into ${worktree}: ${path.join(temp.repo, LOCAL_SETTINGS)}: ${error}`,
      );
      expect(existsSync(path.join(worktree, "node_modules"))).toBeFalse();
    },
  );
});
