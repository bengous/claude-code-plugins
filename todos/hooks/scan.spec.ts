import { describe, expect, test } from "bun:test";

import { type Host, repoRoot, type RunResult, scanRepo } from "./scan.ts";

const ROOT = "/work/repo";

const NOW = Date.UTC(2026, 9, 2);

const DAY = 86_400_000;

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });

const failed = (exitCode: number, stderr: string): RunResult => ({ exitCode, stdout: "", stderr });

function porcelain(
  line: number,
  authoredAt: number,
  sha = "9b6920bb8d4e6b85dc8012b168a827d4219fd016",
): string {
  return [
    `${sha} ${line} ${line} 1`,
    "author-mail <me@example.com>",
    `author-time ${authoredAt / 1000}`,
    "\tline",
    "",
  ].join("\n");
}

type Fake = { readonly host: Host; readonly calls: (readonly string[])[] };

function fakeHost(answers: {
  grep: RunResult;
  blame?: Record<string, RunResult>;
  list?: string;
  email?: RunResult;
  remote?: RunResult;
}): Fake {
  const calls: (readonly string[])[] = [];

  const host: Host = {
    run: (argv) => {
      calls.push(argv);

      if (argv[1] === "rev-parse") return Promise.resolve(ok(`${ROOT}\n`));

      if (argv[1] === "grep") return Promise.resolve(answers.grep);

      if (argv[1] === "config") return Promise.resolve(answers.email ?? failed(1, ""));

      if (argv[1] === "remote")
        return Promise.resolve(answers.remote ?? failed(2, "error: No such remote 'origin'"));

      return Promise.resolve(
        answers.blame?.[argv.at(-1) ?? ""] ?? failed(128, "fatal: unexpected blame"),
      );
    },
    exists: () => Promise.resolve(answers.list !== undefined),
    read: () => Promise.resolve(answers.list ?? ""),
  };

  return { host, calls };
}

describe("scanRepo", () => {
  test("merges TODO.md items and code comments, newest first", async () => {
    const { host } = fakeHost({
      grep: ok(
        "src/a.ts\u000010\u0000// TODO: recent comment\nsrc/b.sh\u00003\u0000# FIXME: old comment\n",
      ),
      blame: {
        "src/a.ts": ok(porcelain(10, NOW - 2 * DAY)),
        "src/b.sh": ok(porcelain(3, NOW - 400 * DAY)),
        "TODO.md": ok(porcelain(1, NOW - 30 * DAY)),
      },
      list: "- list item\n",
    });

    const scan = await scanRepo(host, ROOT, ["TODO", "FIXME"], NOW);
    expect(scan.failures).toEqual([]);
    expect(scan.scannedAt).toBe(NOW);
    expect(scan.todos.map((item) => [item.source, item.text, item.commit])).toEqual([
      ["comment", "recent comment", "9b6920bb"],
      ["list", "list item", "9b6920bb"],
      ["comment", "old comment", "9b6920bb"],
    ]);
  });

  test("dates an untracked file's comments to the scan", async () => {
    const { host } = fakeHost({
      grep: ok("new.ts\u00001\u0000// TODO: brand new\n"),
      blame: { "new.ts": failed(128, "fatal: no such path 'new.ts' in HEAD") },
    });

    const scan = await scanRepo(host, ROOT, ["TODO"], NOW);
    expect(scan.failures).toEqual([]);
    expect(scan.todos).toEqual([
      {
        source: "comment",
        path: "new.ts",
        line: 1,
        marker: "TODO",
        tag: null,
        text: "brand new",
        commit: null,
        authoredAt: NOW,
        authorEmail: null,
      },
    ]);
  });

  test("reports a blame that fails for another reason", async () => {
    const { host } = fakeHost({
      grep: ok("a.ts\u00001\u0000// TODO: x\n"),
      blame: { "a.ts": failed(128, "fatal: bad revision") },
    });

    const scan = await scanRepo(host, ROOT, ["TODO"], NOW);
    expect(scan.failures).toEqual(["git blame a.ts: fatal: bad revision"]);
    expect(scan.todos).toHaveLength(1);
  });

  test("finds nothing when git grep matches nothing and there is no TODO.md", async () => {
    const { host, calls } = fakeHost({ grep: failed(1, "") });
    const scan = await scanRepo(host, ROOT, ["TODO"], NOW);
    expect(scan.todos).toEqual([]);
    expect(calls.filter((argv) => argv[1] === "blame")).toEqual([]);
  });

  test("throws when git grep fails", () => {
    const { host } = fakeHost({ grep: failed(128, "fatal: not a git repository") });
    expect(scanRepo(host, ROOT, ["TODO"], NOW)).rejects.toThrow(
      "git grep failed: fatal: not a git repository",
    );
  });

  test("leaves prose and data files out of the grep, and blames only the matched lines", async () => {
    const { host, calls } = fakeHost({
      grep: ok("a.ts\u00004\u0000// TODO: x\na.ts\u00009\u0000// TODO: y\n"),
      blame: { "a.ts": ok(porcelain(4, NOW) + porcelain(9, NOW)) },
    });

    await scanRepo(host, ROOT, ["TODO", "FIXME"], NOW);
    const grep = calls.find((argv) => argv[1] === "grep") ?? [];
    expect(grep).toContain("--no-recurse-submodules");
    expect(grep).toContain(":(exclude)*.md");
    expect(grep).toContain(":(exclude)*.jsonl");
    expect(grep.join(" ")).toContain("-e TODO -e FIXME");
    expect(calls.find((argv) => argv[1] === "blame")).toEqual([
      "git",
      "blame",
      "--line-porcelain",
      "-L",
      "4,4",
      "-L",
      "9,9",
      "--",
      "a.ts",
    ]);
  });
});

describe("scanRepo context", () => {
  test("reports the root, the git email and the GitHub address of origin", async () => {
    const { host } = fakeHost({
      grep: failed(1, ""),
      email: ok("me@example.com\n"),
      remote: ok("git@github.com:bengous/claude-code-plugins.git\n"),
    });

    const scan = await scanRepo(host, ROOT, ["TODO"], NOW);

    expect([scan.root, scan.userEmail, scan.issueBase]).toEqual([
      ROOT,
      "me@example.com",
      "https://github.com/bengous/claude-code-plugins",
    ]);
  });

  test("has no email or address when git has none", async () => {
    const { host } = fakeHost({ grep: failed(1, "") });
    const scan = await scanRepo(host, ROOT, ["TODO"], NOW);

    expect([scan.userEmail, scan.issueBase]).toEqual([null, null]);
  });

  test("runs no git grep without markers", async () => {
    const { host, calls } = fakeHost({ grep: failed(128, "should not run") });
    const scan = await scanRepo(host, ROOT, [], NOW);

    expect(scan.todos).toEqual([]);
    expect(calls.some((argv) => argv[1] === "grep")).toBe(false);
  });
});

describe("repoRoot", () => {
  test("is null outside a git repository", async () => {
    const host: Host = {
      run: () => Promise.resolve(failed(128, "fatal: not a git repository")),
      exists: () => Promise.resolve(false),
      read: () => Promise.resolve(""),
    };

    expect(await repoRoot(host, "/tmp")).toBeNull();
  });
});
