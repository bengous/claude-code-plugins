import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type Commit,
  isEligible,
  isoWeekOf,
  landedIn,
  lastCompleteWeek,
  parseWeek,
  periodOf,
  pick,
  sessionOf,
  weightOf,
} from "./sample-review.ts";

const SCRIPT = join(import.meta.dir, "sample-review.ts");

const WEEK = "2026-W42";

function weekOf(text: string) {
  const week = parseWeek(text);

  if (week === null) throw new Error(`not a week: ${text}`);

  return week;
}

function commitOf(sha: string, subject: string, ...files: [string, number][]): Commit {
  return {
    sha,
    subject,
    landed: new Date("2026-10-14T10:00:00Z"),
    files: files.map(([path, added]) => ({ path, added, deleted: 0 })),
  };
}

describe("isoWeekOf", () => {
  test.each([
    ["2026-10-17T12:00:00Z", "2026-W42"],
    ["2026-10-18T23:59:59Z", "2026-W42"],
    ["2026-10-19T00:00:00Z", "2026-W43"],
    ["2026-01-01T00:00:00Z", "2026-W01"],
    ["2024-12-30T00:00:00Z", "2025-W01"],
    ["2027-01-01T00:00:00Z", "2026-W53"],
    ["2021-01-03T00:00:00Z", "2020-W53"],
  ])("%s is %s", (instant, week) => {
    expect<string>(isoWeekOf(new Date(instant))).toBe(week);
  });
});

describe("parseWeek", () => {
  test.each(["2026-W42", "2026-W01", "2026-W53", "2020-W53"])("accepts %s", (text) => {
    expect<string | null>(parseWeek(text)).toBe(text);
  });

  test.each(["2025-W53", "2026-W00", "2026-W54", "2026-42", "26-W42", "2026-w42", " 2026-W42", ""])(
    "refuses %p",
    (text) => {
      expect(parseWeek(text)).toBeNull();
    },
  );
});

describe("periods", () => {
  test("an ISO week runs from its Monday to the next one, in UTC", () => {
    const { week, from, to } = periodOf(weekOf(WEEK));

    expect<string>(week).toBe(WEEK);
    expect(from.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });
});

describe("lastCompleteWeek", () => {
  test.each([
    ["2026-10-17T12:00:00Z", "2026-W41"],
    ["2026-10-18T23:59:59Z", "2026-W41"],
    ["2026-10-19T00:00:00Z", "2026-W42"],
    ["2026-10-12T00:00:00Z", "2026-W41"],
    ["2027-01-04T10:00:00Z", "2026-W53"],
    ["2026-01-01T10:00:00Z", "2025-W52"],
  ])("run at %s, it is %s", (now, week) => {
    expect<string>(lastCompleteWeek(new Date(now))).toBe(week);
  });
});

describe("isEligible", () => {
  test("a code change is", () => {
    expect(isEligible(commitOf("a", "feat(x): y", ["src/a.ts", 10]))).toBe(true);
  });

  test("a version bump is not, whatever it touches", () => {
    expect(
      isEligible(
        commitOf(
          "a",
          "chore(agent-hooks): 1.2.0, the landing guard on Bash",
          ["agent-hooks/hooks/pre-bash.ts", 40],
          ["agent-hooks/.claude-plugin/plugin.json", 1],
        ),
      ),
    ).toBe(false);
  });

  test("another chore is", () => {
    expect(isEligible(commitOf("a", "chore(settings): sorted", ["settings.ts", 5]))).toBe(true);
    expect(
      isEligible(commitOf("a", "chore(deps): update yaml to 2.9.1", ["package.json", 1])),
    ).toBe(true);
  });

  test("documentation alone is not", () => {
    expect(
      isEligible(commitOf("a", "docs(x): y", ["docs/repo-ops/checks.md", 30], ["README.md", 2])),
    ).toBe(false);
  });

  test("documentation beside code is", () => {
    expect(isEligible(commitOf("a", "feat(x): y", ["docs/a.md", 30], ["src/a.ts", 1]))).toBe(true);
  });

  test.each([
    "agent-hooks/skills/agent-hooks/SKILL.md",
    "github-flow/agents/issue-worker.md",
    "git/commands/commit.md",
    ".claude/rules/hook-ladder.md",
    "scripts/claude-code-types.prompt.md",
  ])("%s is behaviour, not documentation", (path) => {
    expect(isEligible(commitOf("a", "fix(x): y", [path, 3]))).toBe(true);
  });

  test("a lockfile alone is not", () => {
    expect(isEligible(commitOf("a", "chore(deps): lock", ["bun.lock", 900]))).toBe(false);
  });

  test("a commit with no file is not", () => {
    expect(isEligible(commitOf("a", "chore: empty"))).toBe(false);
  });
});

describe("weightOf", () => {
  test("grows with the code lines, slower than they do", () => {
    const small = weightOf(commitOf("a", "fix: a", ["a.ts", 4]));
    const large = weightOf(commitOf("b", "fix: b", ["b.ts", 400]));

    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(100 * small);
  });

  test("counts neither documentation nor a lockfile", () => {
    const code = weightOf(commitOf("a", "fix: a", ["a.ts", 9]));

    expect(
      weightOf(commitOf("a", "fix: a", ["a.ts", 9], ["docs/a.md", 500], ["bun.lock", 800])),
    ).toBe(code);
  });
});

function shas(commits: readonly Commit[]): string[] {
  return commits.map((commit) => commit.sha);
}

describe("pick", () => {
  const pool = Array.from({ length: 12 }, (_, index) =>
    commitOf(`sha${String(index).padStart(2, "0")}`, `feat(x): change ${index}`, [
      "src/a.ts",
      10 + index * 7,
    ]),
  );

  test("gives the same sample for the same week, whatever the order of the commits", () => {
    const first = pick(pool, weekOf(WEEK), 3);

    expect(first).toHaveLength(3);
    expect(shas(pick(pool, weekOf(WEEK), 3))).toEqual(shas(first));
    expect(shas(pick(pool.toReversed(), weekOf(WEEK), 3))).toEqual(shas(first));
  });

  test("gives other weeks other samples", () => {
    const samples = new Set(
      Array.from({ length: 10 }, (_, index) =>
        shas(pick(pool, weekOf(`2026-W${String(index + 20)}`), 3)).join(),
      ),
    );

    expect(samples.size).toBeGreaterThan(5);
  });

  test("returns every commit when fewer than the count were landed", () => {
    expect(shas(pick(pool.slice(0, 2), weekOf(WEEK), 3)).toSorted()).toEqual(["sha00", "sha01"]);
    expect(pick([], weekOf(WEEK), 3)).toEqual([]);
  });

  test("leaves the sample alone when a commit that was not in it drops out of the pool", () => {
    const sample = pick(pool, weekOf(WEEK), 3);
    const dropped = pool.find((commit) => !sample.includes(commit));
    const rest = pool.filter((commit) => commit !== dropped);

    expect(shas(pick(rest, weekOf(WEEK), 3))).toEqual(shas(sample));
  });

  test("leans toward the larger diff", () => {
    const big = commitOf("big", "feat(x): big", ["src/big.ts", 400]);

    const crowd = Array.from({ length: 9 }, (_, index) =>
      commitOf(`small${index}`, "fix(x): small", ["src/small.ts", 1]),
    );

    const weeks = Array.from({ length: 52 }, (_, index) =>
      weekOf(`2026-W${String(index + 1).padStart(2, "0")}`),
    );

    const bigFirst = weeks.filter((week) => pick([big, ...crowd], week, 1)[0] === big);

    expect(bigFirst.length).toBeGreaterThan(26);
    expect(bigFirst.length).toBeLessThan(46);
  });

  test("lists the sample oldest first", () => {
    const dated = pool.map((commit, index) => ({
      ...commit,
      landed: new Date(Date.UTC(2026, 9, 12 + (index % 6), 10, index)),
    }));

    const landed = pick(dated, weekOf(WEEK), 5).map((commit) => commit.landed.getTime());

    expect(landed).toEqual(landed.toSorted((a, b) => a - b));
  });
});

describe("pick, commits landed at the same second", () => {
  test("lists them by sha", () => {
    const same = ["d", "a", "c", "b"].map((sha) =>
      commitOf(sha, `fix(x): ${sha}`, ["src/a.ts", 5]),
    );

    expect(shas(pick(same, weekOf(WEEK), 4))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("sessionOf", () => {
  test("reads the session a pull request body names", () => {
    expect(sessionOf("## What changes\n\ntext\n\n<!-- opened_by: 9a0d25b6-90e6 -->\n")).toBe(
      "9a0d25b6-90e6",
    );
  });

  test("keeps the opening session when an update follows it", () => {
    expect(
      sessionOf(
        "<!-- opened_by: first -->\n<!-- updated_by: second -->\n<!-- executed_by: third -->",
      ),
    ).toBe("first");
  });

  test("is null for a body without the line", () => {
    expect(sessionOf("## What changes\n\ntext")).toBeNull();
    expect(sessionOf("<!-- updated_by: second -->")).toBeNull();
  });
});

function gitEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function gitEnvAt(date: string) {
  return { ...gitEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

describe("a repository", () => {
  let root = "";

  let repo = "";

  let bin = "";

  const shaOf = new Map<string, string>();

  function git(...args: string[]): string {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnv(),
    });

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());

    return result.stdout.toString().trim();
  }

  function commitStaged(date: string, subject: string): void {
    const result = Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-m", subject], {
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnvAt(date),
    });

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());

    shaOf.set(subject, git("rev-parse", "HEAD"));
  }

  function commit(date: string, subject: string, files: Record<string, number>): void {
    for (const [path, lines] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), `${subject}\n`.repeat(lines));
    }

    git("add", "-A");
    commitStaged(date, subject);
  }

  function mergeAt(date: string, branch: string): void {
    const result = Bun.spawnSync(
      ["git", "-C", repo, "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch],
      { stdout: "pipe", stderr: "pipe", env: gitEnvAt(date) },
    );

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }

  function run(...args: string[]) {
    const result = Bun.spawnSync([process.execPath, SCRIPT, "--ref", "main", ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...gitEnv(), PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });

    return {
      code: result.exitCode,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
    };
  }

  function fakeGh(script: string): void {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "gh"), 0o755);
  }

  function sha(subject: string): string {
    const found = shaOf.get(subject);

    if (found === undefined) throw new Error(`no commit ${subject}`);

    return found;
  }

  function sampled(out: string): string[] {
    return [...shaOf].flatMap(([subject, full]) => (out.includes(full) ? [subject] : []));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sample-review-"));
    repo = join(root, "repo");
    bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(repo);
    fakeGh("echo '[]'");
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Sample test");
    git("config", "user.email", "sample@example.test");
    git("config", "commit.gpgsign", "false");

    commit("2026-10-06T10:00:00Z", "feat(a): the week before", { "a/src/old.ts": 20 });
    commit("2026-10-12T09:00:00Z", "feat(a): parser", { "a/src/parser.ts": 100 });
    commit("2026-10-13T09:00:00Z", "fix(a): edge", { "a/src/parser.ts": 104 });
    commit("2026-10-14T08:00:00Z", "docs(a): explain", { "docs/guide.md": 30 });
    commit("2026-10-14T09:00:00Z", "chore(a): 1.2.0, the parser", {
      "a/.claude-plugin/plugin.json": 3,
      "a/CHANGELOG.md": 8,
    });
    git("switch", "-q", "-c", "side");
    commit("2026-10-15T08:00:00Z", "feat(b): on a branch", { "b/src/b.ts": 30 });
    git("switch", "-q", "main");
    mergeAt("2026-10-15T09:00:00Z", "side");
    commit("2026-10-16T09:00:00Z", "chore(deps): bump yaml", {
      "package.json": 2,
      "bun.lock": 500,
    });
    commit("2026-10-16T10:00:00Z", "fix(a): trigger", { "a/skills/x/SKILL.md": 5 });
    commit("2026-10-20T09:00:00Z", "feat(c): the week after", { "c/src/c.ts": 50 });
    commit("2026-11-02T09:00:00Z", "docs(c): only words", { "docs/words.md": 10 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ELIGIBLE = [
    "feat(a): parser",
    "fix(a): edge",
    "feat(b): on a branch",
    "chore(deps): bump yaml",
    "fix(a): trigger",
  ];

  test("landedIn reads the commits of a period, merges left out, with their files", () => {
    const landed = landedIn(repo, "main", periodOf(weekOf(WEEK)));

    expect(landed.map((found) => found.subject).toSorted()).toEqual(
      [
        "chore(a): 1.2.0, the parser",
        "docs(a): explain",
        "feat(b): on a branch",
        ...ELIGIBLE.filter((subject) => subject !== "feat(b): on a branch"),
      ].toSorted(),
    );

    const parser = landed.find((found) => found.subject === "feat(a): parser");

    expect(parser?.sha).toBe(sha("feat(a): parser"));
    expect(parser?.landed.toISOString()).toBe("2026-10-12T09:00:00.000Z");
    expect(parser?.files).toEqual([{ path: "a/src/parser.ts", added: 100, deleted: 0 }]);
  });

  test("landedIn reads the last complete week as the default names it", () => {
    const week = lastCompleteWeek(new Date("2026-10-17T12:00:00Z"));
    const landed = landedIn(repo, "main", periodOf(week));

    expect(landed.map((found) => found.subject)).toEqual(["feat(a): the week before"]);
  });

  test("landedIn reads a rename once, under its new path, for the lines it moved", () => {
    git("mv", "a/src/parser.ts", "a/src/lexer.ts");
    commitStaged("2026-10-17T08:00:00Z", "refactor(a): rename");

    const renamed = landedIn(repo, "main", periodOf(weekOf(WEEK))).find(
      (found) => found.subject === "refactor(a): rename",
    );

    expect(renamed?.files).toEqual([{ path: "a/src/lexer.ts", added: 0, deleted: 0 }]);
  });

  test("landedIn holds a week from its Monday included to the next one excluded", () => {
    commit("2026-10-12T00:00:00Z", "feat(e): first instant", { "e/src/e.ts": 1 });
    commit("2026-10-18T23:59:59Z", "feat(e): last second", { "e/src/e.ts": 2 });
    commit("2026-10-19T00:00:00Z", "feat(e): next week", { "e/src/e.ts": 3 });

    const subjects = landedIn(repo, "main", periodOf(weekOf(WEEK))).map((found) => found.subject);

    expect(subjects).toContain("feat(e): first instant");
    expect(subjects).toContain("feat(e): last second");
    expect(subjects).not.toContain("feat(e): next week");
  });

  test("landedIn counts a binary file as a file with no lines", () => {
    writeFileSync(join(repo, "logo.png"), Buffer.from([0, 1, 2, 0, 255, 0]));
    git("add", "-A");
    commitStaged("2026-10-17T09:00:00Z", "feat(e): a logo");

    const logo = landedIn(repo, "main", periodOf(weekOf(WEEK))).find(
      (found) => found.subject === "feat(e): a logo",
    );

    expect(logo?.files).toEqual([{ path: "logo.png", added: 0, deleted: 0 }]);
  });

  test("a week samples its eligible commits only", () => {
    const { code, out } = run("--week", WEEK, "--count", "10");

    expect(code).toBe(0);
    expect(sampled(out).toSorted()).toEqual([...ELIGIBLE].toSorted());
    expect(out).toContain("5 of 5 eligible");
  });

  test("two runs of a week give the same sample, three commits by default", () => {
    const first = run("--week", WEEK);
    const second = run("--week", WEEK);

    expect(first.code).toBe(0);
    expect(sampled(first.out)).toHaveLength(3);
    expect(second.out).toBe(first.out);
  });

  test("prints the sha, the subject, the files, the lines and the review of a commit", () => {
    const { out } = run("--week", WEEK, "--count", "10");
    const parser = sha("feat(a): parser");

    expect(out).toContain(parser.slice(0, 8));
    expect(out).toContain("feat(a): parser");
    expect(out).toContain("1 file, +100 -0");
    expect(out).toContain(`/code-review ${parser}^..${parser}`);
    expect(out).toContain("2 files, +502 -0");
  });

  test("names the session a commit's pull request carries, and a hindsight pass over it", () => {
    const parser = sha("feat(a): parser");

    fakeGh(
      `case "$*" in *${parser}*) printf '%s\\n' '[{"body":"text <!-- opened_by: sess-parser -->"}]';; *) printf '%s\\n' '[{"body":"no line"}]';; esac`,
    );

    const { code, out } = run("--week", WEEK, "--count", "10");
    const block = out.slice(out.indexOf(parser.slice(0, 8)), out.indexOf("fix(a): edge"));

    expect(code).toBe(0);
    expect(block).toContain("claude --resume sess-parser");
    expect(block).toContain("/hindsight debrief");
    expect(out.match(/--resume/gu)).toHaveLength(1);
  });

  test("says so, and samples all the same, when gh cannot be asked", () => {
    const asked = join(root, "gh-asked");

    fakeGh(`echo asked >> "${asked}"; echo 'gh: not logged in' >&2; exit 1`);

    const { code, out } = run("--week", WEEK, "--count", "10");

    expect(code).toBe(0);
    expect(sampled(out)).toHaveLength(5);
    expect(out).toContain("session lookup failed: gh: not logged in");
    expect(out).not.toContain("--resume");
    expect(readFileSync(asked, "utf8")).toBe("asked\n");
  });

  test("an empty week has no commit to sample, and exits 0", () => {
    const { code, out } = run("--week", "2026-W30");

    expect(code).toBe(0);
    expect(out).toContain("no commit to sample");
  });

  test("a week of commits all left out has none either", () => {
    const { code, out } = run("--week", "2026-W45");

    expect(code).toBe(0);
    expect(out).toContain("no commit to sample");
    expect(out).toContain("1 landed");
  });

  test("without --week, the last complete week is sampled", () => {
    const aWeekAgo = new Date(Date.now() - 7 * 86_400_000);

    commit(aWeekAgo.toISOString(), "feat(d): a week ago", { "d/src/d.ts": 9 });
    commit(new Date().toISOString(), "feat(d): just now", { "d/src/d.ts": 10 });

    const { code, out } = run("--count", "10");

    expect(code).toBe(0);
    expect(sampled(out)).toContain("feat(d): a week ago");
    expect(sampled(out)).not.toContain("feat(d): just now");
    expect(out).toContain(isoWeekOf(aWeekAgo));
  });

  test.each([
    [["--week", "2026-42"], "--week"],
    [["--week", "2025-W53"], "--week"],
    [["--count", "0"], "--count"],
    [["--count", "three"], "--count"],
    [["--unknown"], "Usage"],
    [["stray"], "Usage"],
  ])("refuses %p as a usage error", (args, mention) => {
    const { code, err } = run(...args);

    expect(code).toBe(2);
    expect(err).toContain(mention);
  });

  test("fails with git's reason on a ref it cannot read", () => {
    const { code, err, out } = run("--ref", "nowhere", "--week", WEEK);

    expect(code).toBe(1);
    expect(err).toContain("nowhere");
    expect(out).toBe("");
  });
});
