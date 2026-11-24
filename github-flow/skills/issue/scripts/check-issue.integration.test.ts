import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_CAPS,
  SettingsError,
  capsOf,
  checkArtifact,
  checkIssue,
  formatFindings,
  settingsFile,
} from "./check-issue.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function checks(text: string, caps = DEFAULT_CAPS): string[] {
  return checkIssue(text, caps).map(({ check, line }) => `${check}@${line}`);
}

/** An issue in the shape, with `doneWhen` as its Done when part, from its bold label on. */
function issue(doneWhen: string[], rest: string[] = []): string {
  return [
    "The import drops every person born after 1970.",
    "",
    ...doneWhen,
    "",
    ...rest,
    "<sub>Written by Claude Opus 5.5</sub>",
  ].join("\n");
}

const DONE_WHEN = [
  "**Done when** every person is kept. The counts are the contract; the parser is free.",
  "",
  "| Situation | Expected |",
  "|---|---|",
  "| `tz.ged` | 1,203 people |",
  "| `plain.ged` | 980 people: no regression |",
];

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-issue-"));
  tmpDirs.push(dir);

  return dir;
}

function repo(settings?: string): string {
  const dir = tmpDir();
  mkdirSync(join(dir, ".git"));

  if (settings !== undefined) {
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "github-flow.json"), settings);
  }

  return dir;
}

function draft(dir: string, text: string, name = "draft.md"): string {
  const file = join(dir, name);
  writeFileSync(file, text);

  return file;
}

describe("drafts in the shape", () => {
  const passing = readdirSync(join(FIXTURES, "pass")).filter((name) => name.endsWith(".md"));

  test("cover a bug, a feature, a UI change, a guard and the issues of the shape itself", () => {
    expect(passing.toSorted()).toEqual([
      "bug.md",
      "feature.md",
      "guard.md",
      "issue-588.md",
      "issue-589.md",
      "issue-590.md",
      "ui-change.md",
    ]);
  });

  test.each(passing)("%s passes", (name) => {
    expect(checks(fixture(join("pass", name)))).toEqual([]);
  });
});

describe("the solution stays out", () => {
  test("Fix:, Possible direction and a numbered plan are refused on their line", () => {
    expect(checks(fixture("refuse/prescribes.md"))).toEqual([
      "fix@12",
      "fix@13",
      "plan@14",
      "plan@15",
    ]);
  });

  test.each([
    ["Suggested fix: drop the suffix.", "fix"],
    ["A proposed solution is to drop it.", "fix"],
    ["Approach: parse it twice.", "fix"],
    ["2) Parse it twice.", "plan"],
  ])("%p is refused", (line, check) => {
    expect(checks(issue(DONE_WHEN, [line, ""]))).toEqual([`${check}@10`]);
  });

  test("the words inside code are not read", () => {
    expect(checks(issue(DONE_WHEN, ["The old skill wrote `Fix:` lines.", ""]))).toEqual([]);
  });
});

describe("the issue asks nothing", () => {
  test("a question mark in prose is refused on its line", () => {
    expect(checks(issue(DONE_WHEN, ["Is the parser the cause?", ""]))).toEqual(["question@10"]);
  });

  test.each([
    ["in a code span", "The query `?page=2` is kept."],
    ["in a bare URL", "See https://example.com/search?q=tz for the report."],
    ["in a link target", "See [the report](https://example.com/search?q=tz)."],
    ["in an autolink", "See <https://example.com/search?q=tz>."],
    ["in an HTML comment", "<!-- why? -->"],
  ])("a question mark %s passes: no regression", (_where, line) => {
    expect(checks(issue(DONE_WHEN, [line, ""]))).toEqual([]);
  });

  test("a question mark in a fenced block passes", () => {
    const fence = ["```console", "$ curl 'https://x.test/?q=1'", "Continue? [y/N]", "```", ""];

    expect(checks(issue(DONE_WHEN, fence))).toEqual([]);
  });
});

describe("Done when", () => {
  test("a visual that lists no situation is refused", () => {
    const prose = ["**Done when** it works. The counts are the contract; the rest is free."];
    const headerOnly = [...prose, "", "| Situation | Expected |", "|---|---|"];
    const emptyPanel = [...prose, "", "```text", "```"];

    expect(checks(issue(prose))).toEqual(["situations@3"]);
    expect(checks(issue(headerOnly))).toEqual(["situations@3"]);
    expect(checks(issue(emptyPanel))).toEqual(["situations@3"]);
  });

  test("a terminal session or a mockup counts as a panel", () => {
    const panel = [
      "**Done when** it answers. Its output is the contract; the index is free.",
      "",
      "```console",
      "$ sessions find tz",
      "3f2a91c  plan: tz, as before: no regression",
      "```",
    ];

    expect(checks(issue(panel))).toEqual([]);
  });

  test("no situation for no regression is refused", () => {
    const without = DONE_WHEN.filter((line) => !line.includes("regression"));

    expect(checks(issue(without))).toEqual(["regression@3"]);
  });

  test("no line on what is contract and what is free is refused", () => {
    const [, ...rest] = DONE_WHEN;

    expect(checks(issue(["**Done when** every person is kept.", ...rest]))).toEqual(["contract@3"]);
  });

  test("a situation with no expected result is refused on its row", () => {
    const blank = [...DONE_WHEN.slice(0, 4), "| `tz.ged` | |", ...DONE_WHEN.slice(5)];

    expect(checks(issue(blank))).toEqual(["expected@7"]);
  });

  test("checkboxes are refused", () => {
    const boxes = [...DONE_WHEN, "", "- [ ] `bun test` passes."];

    expect(checks(issue(boxes))).toEqual(["checkbox@10"]);
  });

  test("a Done when that names the issue artifact holding its situations passes", () => {
    const named = [
      '**Done when** each situation of the issue artifact "situations" holds. The rows are the contract; the layout is free.',
    ];

    const linked = [
      "**Done when** each situation of [situations](https://github.com/o/r/issues/12/artifacts/1) holds. The rows are the contract; the layout is free.",
    ];

    expect(checks(issue(named))).toEqual([]);
    expect(checks(issue(linked))).toEqual([]);
  });
});

describe("visual size", () => {
  const rows = Array.from({ length: 41 }, (_, i) => `| case ${i} | kept: no regression |`);
  const big = [DONE_WHEN[0] ?? "", "", "| Situation | Expected |", "|---|---|", ...rows];

  test("a visual over 40 lines is refused on its first line", () => {
    expect(checks(issue(big))).toEqual(["visual-size@5"]);
  });

  test("a fenced block over the cap is refused too", () => {
    const fence = ["```text", ...Array.from({ length: 41 }, () => "x"), "```", ""];

    expect(checks(issue(DONE_WHEN, fence))).toEqual(["visual-size@10"]);
  });

  test("the repository's own cap applies", () => {
    expect(checks(issue(big), { ...DEFAULT_CAPS, visualLines: 50 })).toEqual([]);
    expect(checks(issue(DONE_WHEN), { ...DEFAULT_CAPS, visualLines: 3 })).toEqual([
      "visual-size@5",
    ]);
  });
});

describe("sections", () => {
  test("the old template is refused on each of its headings and checkboxes", () => {
    expect(checks(fixture("refuse/old-shape.md"))).toEqual([
      "heading@1",
      "done-when@1",
      "problem@1",
      "heading@5",
      "heading@9",
      "heading@13",
      "checkbox@15",
      "checkbox@16",
      "heading@18",
      "footer@20",
    ]);
  });

  test("a bold label other than Done when and Not this opens a section", () => {
    expect(checks(issue(DONE_WHEN, ["**Evidence**: the parser drops it.", ""]))).toEqual([
      "section@10",
    ]);
  });

  test("a folded section other than the author's leads is refused", () => {
    const folded = ["<details><summary>Context</summary>", "", "Old.", "", "</details>", ""];

    expect(checks(issue(DONE_WHEN, folded))).toEqual(["section@10"]);
  });

  test("the author's leads unfolded are refused", () => {
    expect(checks(issue(DONE_WHEN, ["Author's leads: the suffix.", ""]))).toEqual(["leads@10"]);
  });

  test("a problem over two lines is refused, the repository's cap applies", () => {
    const text = ["One.", "Two.", "Three.", "", ...DONE_WHEN, "", "<sub>Written by X</sub>"].join(
      "\n",
    );

    expect(checks(text)).toEqual(["problem@1"]);
    expect(checks(text, { ...DEFAULT_CAPS, problemLines: 3 })).toEqual([]);
  });

  test("Not this over three lines is refused, the repository's cap applies", () => {
    const notThis = ["**Not this** the export,", "the UI,", "the API,", "the docs.", ""];

    expect(checks(issue(DONE_WHEN, notThis))).toEqual(["not-this@10"]);
    expect(checks(issue(DONE_WHEN, notThis), { ...DEFAULT_CAPS, notThisLines: 4 })).toEqual([]);
  });

  test("the parts out of order are refused", () => {
    const text = [
      "The import drops people.",
      "",
      "**Not this** the export.",
      "",
      ...DONE_WHEN,
      "",
      "<sub>Written by X</sub>",
    ].join("\n");

    expect(checks(text)).toEqual(["order@3"]);
  });

  test("no footer is refused on the last line", () => {
    expect(checks(["The import drops people.", "", ...DONE_WHEN, ""].join("\n"))).toEqual([
      "footer@8",
    ]);
  });
});

describe("checkArtifact", () => {
  test("an artifact with no script and a no-regression row passes", () => {
    expect(checkArtifact(fixture("pass/artifact.html"))).toEqual([]);
  });

  test("a script is refused on its line", () => {
    expect(checkArtifact(fixture("refuse/artifact-script.html")).map(({ line }) => line)).toEqual([
      6, 7,
    ]);
  });

  test("a javascript: URL is a script", () => {
    const html = '<a href="javascript:void(0)">x</a>\n<tr><td>a</td><td>no regression</td></tr>';

    expect(checkArtifact(html).map(({ check }) => check)).toEqual(["script"]);
  });

  test("an artifact with no situation, or none for no regression, is refused", () => {
    expect(checkArtifact("<p>Nothing.</p>").map(({ check }) => check)).toEqual(["situations"]);
    expect(
      checkArtifact("<table><tr><td>a</td><td>b</td></tr></table>").map(({ check }) => check),
    ).toEqual(["regression"]);
  });
});

describe("settings", () => {
  test("a missing key keeps the defaults, a set one replaces its cap alone", () => {
    expect(capsOf('{ "pr": { "proseWords": 80 } }', "s.json")).toEqual(DEFAULT_CAPS);
    expect(capsOf('{ "issue": { "visualLines": 60 } }', "s.json")).toEqual({
      ...DEFAULT_CAPS,
      visualLines: 60,
    });
  });

  test.each([
    ["{", "s.json: JSON Parse error"],
    ["[]", "not a JSON object"],
    ['{ "issue": 3 }', '"issue" is not an object'],
    ['{ "issue": { "visualLines": 0 } }', '"issue.visualLines" is not a positive integer'],
    ['{ "issue": { "visualLines": 2.5 } }', '"issue.visualLines" is not a positive integer'],
    ['{ "issue": { "visualLines": "40" } }', '"issue.visualLines" is not a positive integer'],
    ['{ "issue": { "visual": 40 } }', '"issue.visual" is no cap'],
  ])("%p is refused", (settings, message) => {
    expect(() => capsOf(settings, "s.json")).toThrow(SettingsError);
    expect(() => capsOf(settings, "s.json")).toThrow(message);
  });

  test("the file is found upward, and the search stops at the repository's root", () => {
    const root = tmpDir();
    const deep = join(root, "repo", "a", "b");
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(deep, { recursive: true });

    expect(settingsFile(deep)).toBeNull();

    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github", "github-flow.json"), "{}");
    expect(settingsFile(deep)).toBeNull();

    mkdirSync(join(root, "repo", ".github"));
    writeFileSync(join(root, "repo", ".github", "github-flow.json"), "{}");
    expect(settingsFile(deep)).toBe(join(root, "repo", ".github", "github-flow.json"));
  });
});

describe("formatFindings", () => {
  test("names the file and the line", () => {
    const findings = checkIssue(issue(DONE_WHEN, ["Why?", ""]));

    expect(formatFindings(findings, "draft.md")).toStartWith("draft.md:10: question: ");
  });
});

describe("CLI", () => {
  const cli = join(import.meta.dir, "check-issue.ts");

  test("prints each finding and exits 1", () => {
    const dir = repo();
    const file = draft(dir, issue(DONE_WHEN, ["Why?", ""]));
    const run = Bun.spawnSync(["bun", cli, file], { cwd: dir });

    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toStartWith(`${file}:10: question: `);
  });

  test("a draft in the shape exits 0 in silence", () => {
    const dir = repo();
    const run = Bun.spawnSync(["bun", cli, draft(dir, issue(DONE_WHEN))], { cwd: dir });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("");
  });

  test("- reads the draft from stdin", () => {
    const dir = repo();

    const run = Bun.spawnSync(["bun", cli, "-"], {
      cwd: dir,
      stdin: Buffer.from(issue(DONE_WHEN, ["Why?", ""])),
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toStartWith("-:10: question: ");
  });

  test("an .html file is checked as an issue artifact", () => {
    const dir = repo();
    const file = draft(dir, fixture("refuse/artifact-script.html"), "situations.html");
    const run = Bun.spawnSync(["bun", cli, file], { cwd: dir });

    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(`${file}:7: script: `);
  });

  test("the repository's caps apply from its settings file", () => {
    const notThis = ["**Not this** the export,", "the UI,", "the API,", "the docs.", ""];
    const text = issue(DONE_WHEN, notThis);
    const tuned = repo('{ "issue": { "notThisLines": 4 } }');
    const plain = repo();

    expect(Bun.spawnSync(["bun", cli, draft(tuned, text)], { cwd: tuned }).exitCode).toBe(0);
    expect(Bun.spawnSync(["bun", cli, draft(plain, text)], { cwd: plain }).exitCode).toBe(1);
  });

  test("bad settings exit 2", () => {
    const dir = repo('{ "issue": { "notThisLines": -1 } }');
    const run = Bun.spawnSync(["bun", cli, draft(dir, issue(DONE_WHEN))], { cwd: dir });

    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain('"issue.notThisLines" is not a positive integer');
  });

  test("no file is a usage error, a file it cannot read exits 2", () => {
    const dir = repo();

    expect(Bun.spawnSync(["bun", cli], { cwd: dir }).exitCode).toBe(2);

    const run = Bun.spawnSync(["bun", cli, join(dir, "missing.md")], { cwd: dir });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toStartWith(
      `check-issue: cannot read ${join(dir, "missing.md")}`,
    );
  });
});
