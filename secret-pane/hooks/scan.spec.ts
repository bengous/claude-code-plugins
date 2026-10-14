import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addedHits,
  type Host,
  MAX_UNTRACKED,
  needlesOf,
  type RunResult,
  scanChanges,
  type ScanTarget,
  scanTargets,
} from "./scan.ts";

const HOME = "/u/me";

const PAT = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

const HERE: Extract<ScanTarget, { kind: "place" }> = {
  kind: "place",
  label: "git commit",
  dir: undefined,
  options: [],
};

const ok = (stdout: string, isStdoutTruncated = false): RunResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  isStdoutTruncated,
});

function diffOf(path: string, ...added: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 0000000..1111111 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

type Fake = { readonly host: Host; readonly reads: string[] };

/** A clean repository at /work/repo unless an answer says otherwise; `files` are what a read finds. */
function fakeHost(
  answers: {
    readonly staged?: RunResult;
    readonly unstaged?: RunResult;
    readonly untracked?: RunResult;
    readonly root?: RunResult;
  } = {},
  files: Readonly<Record<string, string>> = {},
): Fake {
  const reads: string[] = [];

  const host: Host = {
    run: (argv) => {
      const args = argv.slice(argv.indexOf("git") + 1);

      if (args[0] === "rev-parse") return Promise.resolve(answers.root ?? ok("/work/repo\n"));

      if (args[0] === "diff")
        return Promise.resolve(
          (args[1] === "--cached" ? answers.staged : answers.unstaged) ?? ok(""),
        );

      return Promise.resolve(answers.untracked ?? ok(""));
    },
    read: (path) => {
      reads.push(path);

      return Promise.resolve(files[path] ?? "");
    },
  };

  return { host, reads };
}

describe("scanTargets", () => {
  test("a git subcommand outside the local ones, and any gh but gh secret", () => {
    expect(scanTargets("git commit -am x", HOME)).toEqual([HERE]);
    expect(scanTargets("gh pr create --fill", HOME)).toEqual([
      { kind: "place", label: "gh pr", dir: undefined, options: [] },
    ]);
    expect(scanTargets("gh stack add -Am wip b", HOME)).toHaveLength(1);
    expect(scanTargets(`sh -c "git commit -m x"`, HOME)).toEqual([HERE]);
  });

  test("a local git, a git with no subcommand and gh secret give none", () => {
    expect(scanTargets("git status && git log --oneline -3", HOME)).toEqual([]);
    expect(scanTargets("git --version", HOME)).toEqual([]);
    expect(scanTargets("printf '%s' x | gh secret set X", HOME)).toEqual([]);
    expect(scanTargets("printf '%s' x | git credential approve", HOME)).toEqual([]);
    expect(scanTargets("ls -la", HOME)).toEqual([]);
  });

  test("the cd commands before git, composed, and its place options", () => {
    expect(scanTargets("cd /r && git commit -m x", HOME)).toEqual([{ ...HERE, dir: "/r" }]);
    expect(scanTargets("cd a && cd b && git commit", HOME)).toEqual([{ ...HERE, dir: "a/b" }]);
    expect(scanTargets("cd ~/r && git -c x=y -C sub commit", HOME)).toEqual([
      { ...HERE, dir: "/u/me/r", options: ["-C", "sub"] },
    ]);
    expect(scanTargets("git -C ~/r --git-dir=.g --work-tree . commit", HOME)).toEqual([
      { ...HERE, options: ["-C", "/u/me/r", "--git-dir", ".g", "--work-tree", "."] },
    ]);
    expect(scanTargets(`cd "my dir" && git commit`, HOME)).toEqual([{ ...HERE, dir: "my dir" }]);
  });

  test("a subshell's cd stays in it, a nested shell's starts where it stands", () => {
    expect(scanTargets("(cd /a && git status); git commit", HOME)).toEqual([HERE]);
    expect(scanTargets(`cd /a; sh -c "cd b && git commit"`, HOME)).toEqual([
      { ...HERE, dir: "/a/b" },
    ]);
  });

  test("a place the mod cannot read is unknown", () => {
    expect(scanTargets("cd $DIR && git commit", HOME)).toEqual([
      { kind: "unknown", label: "git commit", spelling: "cd $DIR" },
    ]);
    expect(scanTargets("cd ~ && git commit", undefined)).toEqual([
      { kind: "unknown", label: "git commit", spelling: "cd ~" },
    ]);
    expect(scanTargets("cd - && git push", HOME)).toEqual([
      { kind: "unknown", label: "git push", spelling: "cd -" },
    ]);
  });
});

describe("needlesOf", () => {
  test("a value's longest line, at least 8 characters", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";

    expect(needlesOf([PAT])).toEqual([PAT]);
    expect(needlesOf([`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`])).toEqual([
      body,
    ]);
    expect(needlesOf(["abc\r\ndefg\r\nhij"])).toEqual([]);
  });
});

describe("addedHits", () => {
  test("the files whose added lines hold a needle, named by their +++ line", () => {
    const diff = `${diffOf("README.md", "nothing here")}${diffOf(".env", `TOKEN=${PAT}`)}`;

    expect(addedHits(diff, [PAT])).toEqual([".env"]);
  });

  test("a removed line is no hit, and an added line that reads like a header names no file", () => {
    const removed = [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +0,0 @@",
      `-TOKEN=${PAT}`,
      "",
    ].join("\n");

    expect(addedHits(removed, [PAT])).toEqual([]);
    expect(addedHits(diffOf("notes.md", "++ b/elsewhere", `key ${PAT}`), [PAT])).toEqual([
      "notes.md",
    ]);
  });
});

describe("scanChanges", () => {
  test("a value in a staged line, an unstaged line or an untracked file", async () => {
    const { host, reads } = fakeHost(
      {
        staged: ok(diffOf("config.ts", `const token = "${PAT}";`)),
        unstaged: ok(diffOf("src/a.ts", "nothing")),
        untracked: ok(".env\0notes.txt\0"),
      },
      { "/work/repo/.env": `TOKEN=${PAT}\n` },
    );

    expect(await scanChanges(host, HERE, [PAT])).toEqual({
      kind: "found",
      files: [
        { path: "config.ts", isTracked: true },
        { path: ".env", isTracked: false },
      ],
    });
    expect(reads).toEqual(["/work/repo/.env", "/work/repo/notes.txt"]);
  });

  test("a multi-line value is found by its longest line", async () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
    const value = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    const { host } = fakeHost({ staged: ok(diffOf("key.pem", ...value.split("\n"))) });

    expect(await scanChanges(host, HERE, needlesOf([value]))).toMatchObject({ kind: "found" });

    const header = fakeHost({ staged: ok(diffOf("doc.md", "-----BEGIN PRIVATE KEY-----")) });

    expect(await scanChanges(header.host, HERE, needlesOf([value]))).toEqual({ kind: "clean" });
  });

  test("no repository, a truncated diff or too many untracked files fail the scan", async () => {
    const outside = fakeHost({
      root: {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        isStdoutTruncated: false,
      },
    });

    expect(await scanChanges(outside.host, { ...HERE, dir: "/tmp" }, [PAT])).toEqual({
      kind: "failed",
      why: "git rev-parse --show-toplevel exited 128 in /tmp: fatal: not a git repository (or any of the parent directories): .git",
    });

    const truncated = fakeHost({ unstaged: ok("diff --git", true) });

    expect(await scanChanges(truncated.host, HERE, [PAT])).toMatchObject({
      kind: "failed",
      why: expect.stringContaining("more than the 4 MiB"),
    });

    const many = Array.from({ length: MAX_UNTRACKED + 1 }, (_, at) => `f${at}`).join("\0");
    const crowded = fakeHost({ untracked: ok(many) });

    expect(await scanChanges(crowded.host, HERE, [PAT])).toMatchObject({
      kind: "failed",
      why: expect.stringContaining(`${MAX_UNTRACKED + 1} untracked files`),
    });
    expect(crowded.reads).toEqual([]);
  });

  test("a file a read cannot take whole is skipped, a read that fails fails the scan", async () => {
    const big: Host = {
      ...fakeHost({ untracked: ok("big.bin\0") }).host,
      read: () => Promise.resolve(null),
    };

    expect(await scanChanges(big, HERE, [PAT])).toEqual({ kind: "clean" });

    const denied: Host = {
      ...fakeHost({ untracked: ok("secret.txt\0") }).host,
      read: () => Promise.reject(new Error("EACCES")),
    };

    expect(await scanChanges(denied, HERE, [PAT])).toEqual({
      kind: "failed",
      why: "secret.txt could not be read: EACCES",
    });
  });
});

/** git in a temporary repository, out of reach of the machine's own configuration. */
async function git(cwd: string, ...args: string[]): Promise<RunResult> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    isStdoutTruncated: false,
  };
}

describe("scanChanges on a real repository", () => {
  test("a value committed before is no change, a value about to be committed is", async () => {
    const repo = await mkdtemp(join(tmpdir(), "secret-pane-scan-"));

    try {
      const host: Host = {
        run: (argv, cwd) => git(cwd ?? repo, ...argv.slice(1)),
        read: (path) => Bun.file(path).text(),
      };

      await git(repo, "init", "-q");
      await git(repo, "config", "user.email", "t@example.com");
      await git(repo, "config", "user.name", "t");
      await writeFile(join(repo, "config.txt"), `token ${PAT}\n`);
      await git(repo, "add", "config.txt");
      await git(repo, "commit", "-qm", "init");

      expect(await scanChanges(host, HERE, [PAT])).toEqual({ kind: "clean" });

      await writeFile(join(repo, ".env"), `TOKEN=${PAT}\n`);
      expect(await scanChanges(host, { ...HERE, options: ["-C", repo] }, [PAT])).toEqual({
        kind: "found",
        files: [{ path: ".env", isTracked: false }],
      });

      await git(repo, "add", ".env");
      expect(await scanChanges(host, HERE, [PAT])).toEqual({
        kind: "found",
        files: [{ path: ".env", isTracked: true }],
      });

      await git(repo, "rm", "-q", "--cached", ".env");
      await writeFile(join(repo, ".gitignore"), ".env\n");
      expect(await scanChanges(host, HERE, [PAT])).toEqual({ kind: "clean" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
