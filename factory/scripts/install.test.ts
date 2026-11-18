import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAtomicSync } from "../lib/platform/fs.ts";
import { decide, flagErrors, main, placements, report } from "./install.ts";

const FILES = [
  { path: "repo/.github/CODEOWNERS", content: "owners" },
  { path: "repo/.github/workflows/review.yml", content: "review" },
  { path: "routine/prompt.md", content: "prompt" },
  { path: "claude-md-sections.md", content: "sections" },
];

const ON_DISK: ReadonlyMap<string, string> = new Map([
  ["/t/.github/CODEOWNERS", "owners"],
  ["/t/.github/workflows/review.yml", "edited"],
]);

const current = (dest: string): string | null => ON_DISK.get(dest) ?? null;

describe("placements", () => {
  test("repo puts the repo/ files under the target, and nothing else", () => {
    expect(placements(FILES, { kind: "repo", target: "/t" })).toEqual([
      { dest: "/t/.github/CODEOWNERS", shown: ".github/CODEOWNERS", content: "owners" },
      {
        dest: "/t/.github/workflows/review.yml",
        shown: ".github/workflows/review.yml",
        content: "review",
      },
    ]);
  });

  test("prompt puts the routine prompt in its directory, and nothing else", () => {
    expect(placements(FILES, { kind: "prompt", dir: "/r" })).toEqual([
      { dest: "/r/prompt.md", shown: "/r/prompt.md", content: "prompt" },
    ]);
  });
});

describe("decide", () => {
  const items = placements(FILES, { kind: "repo", target: "/t" });

  test("never overwrites a differing file without force", () => {
    const decisions = decide(items, current, false);

    expect(decisions.map(({ outcome }) => outcome)).toEqual(["identical", "refused"]);
    expect(report(decisions)).toBe(
      [
        "identical  .github/CODEOWNERS",
        "refused    .github/workflows/review.yml: its content differs; --force overwrites it",
      ].join("\n"),
    );
  });

  test("overwrites a differing file with force and writes a missing one", () => {
    const decisions = decide(
      items,
      (dest) => (dest.endsWith("review.yml") ? "edited" : null),
      true,
    );

    expect(decisions.map(({ outcome }) => outcome)).toEqual(["wrote", "overwrote"]);
  });
});

describe("flagErrors", () => {
  test("asks for every flag the templates name and refuses one they do not", () => {
    expect(
      flagErrors({ owner: "o", repo: "o/r" }, new Set(["OWNER", "ROUTINE_ID", "BRANCH"]), "repo"),
    ).toEqual([
      "--repo is not used by install.ts repo",
      "--routine is missing",
      "--branch is missing",
    ]);
  });
});

describe("main", () => {
  const REPO_FLAGS = ["--owner", "octo", "--routine", "trig_01Ab", "--branch", "main"];
  let root = "";
  let out: string[] = [];
  let err: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "factory-install-"));
    mkdirSync(join(root, ".git"));
    out = [];
    err = [];
    spyOn(console, "log").mockImplementation((line: string) => out.push(line));
    spyOn(console, "error").mockImplementation((line: string) => err.push(line));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (...argv: string[]): number => {
    out = [];
    err = [];

    return main(argv);
  };

  test("writes, finds identical, refuses a changed file, and overwrites it with --force", () => {
    const repo = ["repo", ...REPO_FLAGS, "--target", root];
    const owners = join(root, ".github/CODEOWNERS");

    expect(run(...repo)).toBe(0);
    expect(out.join("\n")).toContain("wrote      .github/CODEOWNERS");
    expect(readFileSync(owners, "utf8")).toContain("/.github/CODEOWNERS @octo");

    expect(run(...repo)).toBe(0);
    expect(out.join("\n")).toContain("identical  .github/CODEOWNERS");

    writeAtomicSync(owners, "edited\n");

    expect(run(...repo)).toBe(1);
    expect(out.join("\n")).toContain("refused    .github/CODEOWNERS: its content differs");
    expect(readFileSync(owners, "utf8")).toBe("edited\n");

    expect(run(...repo, "--force")).toBe(0);
    expect(out.join("\n")).toContain("overwrote  .github/CODEOWNERS");
    expect(readFileSync(owners, "utf8")).toContain("@octo");
  });

  test.each([
    [["repo", "--target", ""], "install: --target is empty"],
    [
      ["prompt", "--owner", "octo", "--repo", "octo/w", "--branch", "main", "--dir", ""],
      "install: --dir is empty",
    ],
  ])("refuses an empty path %p", (argv, reason) => {
    expect(run(...argv)).toBe(2);
    expect(err.join("\n")).toContain(reason);
  });

  test("each subject takes exactly the flags its templates name", () => {
    expect(run("repo", ...REPO_FLAGS, "--repo", "octo/w", "--target", root)).toBe(2);
    expect(err.join("\n")).toContain("install: --repo is not used by install.ts repo");

    const dir = join(root, "routine");

    expect(
      run("prompt", "--owner", "octo", "--repo", "octo/w", "--routine", "trig_1", "--dir", dir),
    ).toBe(2);
    expect(err.join("\n")).toContain("install: --routine is not used by install.ts prompt");
    expect(err.join("\n")).toContain("install: --branch is missing");

    expect(
      run("prompt", "--owner", "octo", "--repo", "octo/w", "--branch", "dev", "--dir", dir),
    ).toBe(0);
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).toContain("pull request against `dev`");
  });

  test("refuses a branch git would refuse", () => {
    expect(
      run("repo", "--owner", "octo", "--routine", "trig_1", "--branch", "a..b", "--target", root),
    ).toBe(2);
    expect(err.join("\n")).toContain('install: --branch is not a git branch name: "a..b"');
  });
});
