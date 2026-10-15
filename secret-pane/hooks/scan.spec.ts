import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addedHits,
  type Host,
  MAX_UNTRACKED,
  needlesOf,
  type RunResult,
  type Scan,
  scanChanges,
  type ScanTarget,
  scanTargets,
} from "./scan.ts";

const HOME = "/u/me";

const PAT = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

const HERE: Extract<ScanTarget, { kind: "place" }> = {
  kind: "place",
  program: "git",
  label: "git commit",
  dir: undefined,
  options: [],
  files: [],
};

const GH: Extract<ScanTarget, { kind: "place" }> = { ...HERE, program: "gh", label: "gh pr" };

const OUTSIDE: RunResult = {
  exitCode: 128,
  stdout: "",
  stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
  isStdoutTruncated: false,
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

/** A clean repository at /work/repo unless an answer says otherwise; `files` are what a read finds, any other path no file. */
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
      if (argv.includes("rev-parse")) return Promise.resolve(answers.root ?? ok("/work/repo\n"));

      if (argv.includes("diff"))
        return Promise.resolve(
          (argv.includes("--cached") ? answers.staged : answers.unstaged) ?? ok(""),
        );

      return Promise.resolve(answers.untracked ?? ok(""));
    },
    read: (path) => {
      reads.push(path);

      return Promise.resolve(files[path] ?? null);
    },
    exists: () => Promise.resolve(true),
  };

  return { host, reads };
}

describe("scanTargets", () => {
  test("a git subcommand outside the local ones, and any gh but gh secret", () => {
    expect(scanTargets("git commit -am x", HOME)).toEqual([HERE]);
    expect(scanTargets("gh pr create --fill", HOME)).toEqual([GH]);
    expect(scanTargets("gh stack add -Am wip b", HOME)).toHaveLength(1);
    expect(scanTargets(`sh -c "git commit -m x"`, HOME)).toEqual([HERE]);
  });

  test("a local git, a git with no subcommand and gh secret give none", () => {
    expect(scanTargets("git status && git log --oneline -3", HOME)).toEqual([]);
    expect(scanTargets("git --version", HOME)).toEqual([]);
    expect(scanTargets("printf '%s' x | gh secret set X", HOME)).toEqual([]);
    expect(scanTargets("printf '%s' x | git credential approve", HOME)).toEqual([]);
    expect(scanTargets("ls -la", HOME)).toEqual([]);
    expect(scanTargets("which gh && gh --version", HOME)).toEqual([]);
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

  test("a cd after a keyword or a brace, and a pushd, count too", () => {
    expect(scanTargets("if cd B; then git add -A && git commit -qm x; fi", HOME)).toEqual([
      { ...HERE, dir: "B" },
    ]);
    expect(scanTargets("{ cd B && git commit -qm x; } 2>&1", HOME)).toEqual([
      { ...HERE, dir: "B" },
    ]);
    expect(scanTargets("pushd B >/dev/null && git commit -am x", HOME)).toEqual([
      { ...HERE, dir: "B" },
    ]);
    expect(scanTargets("pushd B && popd && git commit", HOME)).toEqual([
      { kind: "unknown", label: "git commit", spelling: "cd -" },
    ]);
  });

  test("the file a git command reads its message from", () => {
    expect(scanTargets("git commit -F /tmp/msg", HOME)).toEqual([{ ...HERE, files: ["/tmp/msg"] }]);
    expect(scanTargets("cd /r && git tag -a v1 --file=notes.txt", HOME)).toEqual([
      { ...HERE, label: "git tag", dir: "/r", files: ["/r/notes.txt"] },
    ]);
    expect(scanTargets("git commit -F - <<'EOF'\nmsg\nEOF", HOME)).toEqual([HERE]);
  });

  test("a command run over ssh runs on another machine, and the first command names its place", () => {
    expect(scanTargets(`ssh vps "cd /srv/app && git stash && git pull"`, HOME)).toEqual([]);
    expect(scanTargets(`git commit -m "fix: git resolves aliases"`, HOME)).toEqual([HERE]);
  });

  test("the place git's variables name in front of it", () => {
    expect(scanTargets("GIT_DIR=/g GIT_WORK_TREE=~/w git commit -m x", HOME)).toEqual([
      { ...HERE, options: ["--git-dir", "/g", "--work-tree", "/u/me/w"] },
    ]);
  });

  test("a here-string is no heredoc: the lines after it are still read", () => {
    expect(
      scanTargets(
        `version=$(jq -r .version <<<'{"version":"1.2.3"}')\ncd B && git add -A && git commit -qm "v$version"`,
        HOME,
      ),
    ).toEqual([{ ...HERE, dir: "B" }]);
  });

  test("a heredoc ssh runs is read as remote, and `git add .` runs no heredoc", () => {
    expect(scanTargets(`ssh vps <<'EOF'\ncd /srv/app && git stash\nEOF`, HOME)).toEqual([]);
    expect(scanTargets("ssh vps git push", HOME)).toEqual([]);
    expect(
      scanTargets(
        `git add . && git commit -m "$(cat <<'EOF'\nfix: git -C --hard. x\nEOF\n)"`,
        HOME,
      ),
    ).toEqual([HERE]);
    expect(scanTargets(`sudo bash <<'EOF'\ngit commit -am x\nEOF`, HOME)).toEqual([HERE]);
    expect(scanTargets(`sudo -u deploy bash <<'EOF'\ngit commit -am x\nEOF`, HOME)).toEqual([HERE]);
    expect(
      scanTargets(
        `sudo git add . && git commit -m "$(cat <<'EOF'\nrun \`cd ~/p && git push\`\nEOF\n)"`,
        HOME,
      ),
    ).toEqual([HERE]);
    expect(scanTargets(`timeout 60 bash <<'EOF'\ngit commit -am x\nEOF`, HOME)).toEqual([HERE]);
    expect(scanTargets(`bash <<'EOF' # deploy\ncd /b && git commit -am x\nEOF`, HOME)).toEqual([
      { ...HERE, dir: "/b" },
    ]);
    expect(scanTargets(`ssh vps <<'EOF' && git push\ncd /srv/app && git stash\nEOF`, HOME)).toEqual(
      [{ ...HERE, label: "git push" }],
    );
  });

  test("the files a command's standard input reads", () => {
    expect(scanTargets("gh gist create < .env", HOME)).toEqual([
      { ...GH, label: "gh gist", files: [".env"] },
    ]);
    expect(scanTargets("cat .env | gh gist create -", HOME)).toEqual([
      { ...GH, label: "gh gist", files: [".env"] },
    ]);
    expect(scanTargets("git commit --allow-empty -F - < msg 2>/dev/null", HOME)).toEqual([
      { ...HERE, files: ["msg"] },
    ]);
  });

  test("git reads its message file from where -C puts it", () => {
    expect(scanTargets("git -C /r commit -F msg.txt", HOME)).toEqual([
      { ...HERE, options: ["-C", "/r"], files: ["/r/msg.txt"] },
    ]);
  });

  test("a redirection between git and its subcommand hides nothing", () => {
    expect(scanTargets("git >/dev/null commit --allow-empty -m x", HOME)).toEqual([HERE]);
    expect(scanTargets("git </dev/null commit -m x 2>&1", HOME)).toEqual([HERE]);
    expect(scanTargets("git &>/dev/null commit -am x", HOME)).toEqual([HERE]);
  });

  test("the files a gh command is handed, where it stands", () => {
    expect(scanTargets("gh gist create .env", HOME)).toEqual([
      { ...GH, label: "gh gist", files: [".env"] },
    ]);
    expect(scanTargets("cd /r && gh release upload v1 a.env", HOME)).toEqual([
      { ...GH, label: "gh release", dir: "/r", files: ["/r/v1", "/r/a.env"] },
    ]);
    expect(scanTargets("gh issue create --body-file=/tmp/log -t x", HOME)).toEqual([
      { ...GH, label: "gh issue", files: ["/tmp/log", "x"] },
    ]);
    expect(scanTargets("gh api repos/o/r -F body=@notes.md", HOME)).toEqual([
      { ...GH, label: "gh api", files: ["notes.md"] },
    ]);
  });

  test("a subshell's or a substitution's cd stays in it, a nested shell's starts where it stands", () => {
    expect(scanTargets("(cd /a && git status); git commit", HOME)).toEqual([HERE]);
    expect(scanTargets("echo `cd /x; pwd` && git commit -am x", HOME)).toEqual([HERE]);
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

test("addedHits names a file as it is, git's quotes and trailing tab undone", () => {
  const added = (header: string) =>
    ["diff --git a/x b/x", header, "@@ -0,0 +1 @@", `+${PAT}`, ""].join("\n");

  expect(addedHits(added("+++ b/my file.txt\t"), [PAT])).toEqual(["my file.txt"]);
  expect(addedHits(added(String.raw`+++ "b/\303\251t\303\251 \"q\".txt"`), [PAT])).toEqual([
    `été "q".txt`,
  ]);
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
        { path: "config.ts", where: "tracked" },
        { path: ".env", where: "untracked" },
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

  test("gh outside any repository carries no change, git there fails the scan", async () => {
    const { host } = fakeHost({ root: OUTSIDE });

    expect(await scanChanges(host, GH, [PAT])).toEqual({ kind: "clean" });
    expect(await scanChanges(host, HERE, [PAT])).toMatchObject({ kind: "failed" });
  });

  test("a file gh is handed holds the value, inside a repository or out of one", async () => {
    const files = { "/tmp/.env": `TOKEN=${PAT}\n` };
    const target = { ...GH, label: "gh gist", files: ["create", "/tmp/.env"] };
    const found: Scan = { kind: "found", files: [{ path: "/tmp/.env", where: "handed" }] };

    expect(await scanChanges(fakeHost({}, files).host, target, [PAT])).toEqual(found);
    expect(await scanChanges(fakeHost({ root: OUTSIDE }, files).host, target, [PAT])).toEqual(
      found,
    );
  });

  test("a handed file that is there but cannot be read fails the scan", async () => {
    const denied: Host = {
      ...fakeHost().host,
      read: () => Promise.reject(new Error("denied by a hook")),
    };

    expect(await scanChanges(denied, { ...GH, files: [".env"] }, [PAT])).toEqual({
      kind: "failed",
      why: ".env could not be read: denied by a hook",
    });
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

/** A host on the real machine, git out of reach of its configuration. */
function realHost(repo: string): Host {
  return {
    run: (argv, cwd) => git(cwd ?? repo, ...argv.slice(1)),
    read: (path) => Bun.file(path).text(),
    exists: (path) => Promise.resolve(existsSync(path)),
  };
}

describe("scanChanges on a real repository", () => {
  test("from a subdirectory, whatever the repository's diff and color settings", async () => {
    const repo = await mkdtemp(join(tmpdir(), "secret-pane-scan-"));

    try {
      await git(repo, "init", "-q");
      await git(repo, "config", "user.email", "t@example.com");
      await git(repo, "config", "user.name", "t");
      await git(repo, "config", "diff.relative", "true");
      await git(repo, "config", "color.ui", "always");
      await mkdir(join(repo, "sub"));
      await writeFile(join(repo, "README.md"), "hello\n");
      await writeFile(join(repo, "sub", "a.txt"), "a\n");
      await git(repo, "add", "-A");
      await git(repo, "commit", "-qm", "init");
      await writeFile(join(repo, ".env"), `TOKEN=${PAT}\n`);
      await writeFile(join(repo, "README.md"), `hello\ntoken ${PAT}\n`);

      expect(await scanChanges(realHost(repo), { ...HERE, dir: join(repo, "sub") }, [PAT])).toEqual(
        {
          kind: "found",
          files: [
            { path: "README.md", where: "tracked" },
            { path: ".env", where: "untracked" },
          ],
        },
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a value committed before is no change, a value about to be committed is", async () => {
    const repo = await mkdtemp(join(tmpdir(), "secret-pane-scan-"));

    try {
      const host = realHost(repo);

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
        files: [{ path: ".env", where: "untracked" }],
      });

      await git(repo, "add", ".env");
      expect(await scanChanges(host, HERE, [PAT])).toEqual({
        kind: "found",
        files: [{ path: ".env", where: "tracked" }],
      });

      await git(repo, "rm", "-q", "--cached", ".env");
      await writeFile(join(repo, ".gitignore"), ".env\n");
      expect(await scanChanges(host, HERE, [PAT])).toEqual({ kind: "clean" });

      await git(repo, "add", ".gitignore");
      await git(repo, "commit", "-qm", "ignore");
      await writeFile(join(repo, ".gitignore"), `.env\n# ${PAT}\n`);
      expect(await scanChanges(host, HERE, [PAT])).toEqual({
        kind: "found",
        files: [{ path: ".gitignore", where: "tracked" }],
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
