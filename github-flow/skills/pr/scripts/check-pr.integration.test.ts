import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkBody, DEFAULT_CAPS, readCaps } from "./check-pr.ts";

const SKILL_DIR = join(import.meta.dir, "..");

const BODIES = join(SKILL_DIR, "references", "bodies");

const SCRIPT = join(import.meta.dir, "check-pr.ts");

function checks(text: string, caps = DEFAULT_CAPS): string[] {
  return checkBody(text, caps).map(({ check, line }) => `${check}@${line}`);
}

/** A body in the shape, its lines numbered from 1; `extra` lands before **Checks**, `checksLine` replaces it. */
function body({
  extra = [],
  checksLine = "**Checks** `bun test`: 12 pass, 0 fail.",
}: { extra?: string[]; checksLine?: string } = {}): string {
  return [
    "Closes #1.", // 1
    "", // 2
    "**Why** The hook let an empty comment through.", // 3
    "", // 4
    "**Danger** two-way door · reach: a close is denied once.", // 5
    "", // 6
    "**Start at** `gate.test.ts`.", // 7
    "", // 8
    "```diff", // 9
    "- allow when comment is not null", // 10
    "+ allow when comment is not empty", // 11
    "```", // 12
    "", // 13
    "**Proof**", // 14
    "", // 15
    "| Situation | Before | After |", // 16
    "|---|---|---|", // 17
    '| `-c ""` | allowed | denied |', // 18
    "", // 19
    ...extra, // 20...
    checksLine,
    "",
    "<sub>Written by Claude</sub>",
  ].join("\n");
}

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-pr-"));
  tmpDirs.push(dir);

  return dir;
}

function run(args: string[], cwd: string, script = SCRIPT, stdin?: string) {
  const proc = Bun.spawnSync(["bun", script, ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
  });

  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("bodies in the shape", () => {
  const files = readdirSync(BODIES).filter((f) => f.endsWith(".md"));

  test("a fix, a feature, a UI change and a cross-module change are each a worked body", () => {
    expect(files.toSorted()).toEqual(["cross-module.md", "feature.md", "fix.md", "ui.md"]);
  });

  for (const file of files) {
    test(`${file} passes`, () => {
      expect(checks(readFileSync(join(BODIES, file), "utf8"))).toEqual([]);
    });
  }

  test("the body built by this file passes", () => {
    expect(checks(body())).toEqual([]);
  });
});

describe("refusals name the line", () => {
  test("a question", () => {
    expect(checks(body({ extra: ["Should the hook also cover `gh pr edit`?", ""] }))).toEqual([
      "question@20",
    ]);
  });

  test("a question in a table cell", () => {
    expect(checks(body({ extra: ["| `-c x` | allowed | allowed? |", ""] }))).toEqual([
      "question@20",
    ]);
  });

  test.each([
    "**Ask** whether to cover edits.",
    "## Left open",
    "*Not shown*: the clip.",
    "Known gaps:",
  ])("an open point: %s", (line) => {
    expect(checks(body({ extra: [line, ""] }))).toEqual(["open-point@20"]);
  });

  test.each([
    "<details><summary>Left open</summary>",
    "<b>Ask</b>: keep the old flag or drop it.",
    "| Left open | Why |",
  ])("an open point in HTML or a table cell: %s", (line) => {
    expect(checks(body({ extra: [line, ""] }))).toEqual(["open-point@20"]);
  });

  test("prose before Why other than the issue it closes", () => {
    const opening = body().replace(
      "Closes #1.",
      "Closes #1.\nThe hook let an empty comment through.",
    );

    expect(checks(opening)).toEqual(["section@2"]);
  });

  test("a heading or a bold lead-in that is no section", () => {
    expect(checks(body({ extra: ["## Notes", ""] }))).toEqual(["section@20"]);
    expect(checks(body({ extra: ["**Summary** the hook is fixed.", ""] }))).toEqual(["section@20"]);
  });

  test("a review recap under Checks", () => {
    expect(
      checks(
        body({
          checksLine:
            "**Checks** `/code-review medium`: 2 findings, both fixed. `bun test`: 12 pass.",
        }),
      ),
    ).toEqual(["recap@20"]);
  });

  test("a line on what did not run", () => {
    expect(
      checks(
        body({
          checksLine: "**Checks** `bun test`: 12 pass; the panel is not played in a session.",
        }),
      ),
    ).toEqual(["not-run@20"]);
    expect(
      checks(body({ checksLine: "**Checks** `bun test`: 12 pass; Windows untested." })),
    ).toEqual(["not-run@20"]);
  });

  test("a missing section, a section out of order, a second one", () => {
    expect(checks(body().replace(/\*\*Danger\*\*.*/u, ""))).toEqual(["missing@7"]);
    expect(checks(body({ extra: ["**Why** again.", ""] }))).toEqual(["section@20"]);
    const danger = "**Danger** two-way door · reach: a close is denied once.";
    const startAt = "**Start at** `gate.test.ts`.";
    const swapped = body().replace(`${danger}\n\n${startAt}`, `${startAt}\n\n${danger}`);

    // The view now sits under Danger, so Start at shows none.
    expect(checks(swapped)).toEqual(["view@5", "order@7"]);
  });

  test("Why of two sentences, Danger with no door or no reach, no view, Checks with no number", () => {
    expect(checks(body().replace("through.", "through. It is fixed."))).toEqual(["why@3"]);
    expect(checks(body().replace("two-way door · ", ""))).toEqual(["danger@5"]);
    expect(checks(body().replace("reach:", "then:"))).toEqual(["danger@5"]);
    expect(checks(body({ checksLine: "**Checks** `bun test` passes." }))).toEqual(["checks@20"]);
    expect(
      checks(
        body({
          checksLine: "**Checks** `bun test` passes.\n\nhttps://claude.ai/code/session_012ea2\n",
        }),
      ),
    ).toEqual(["checks@20"]);
    expect(checks(body().replace(/```diff\n[^`]*```\n/u, ""))).toEqual(["view@7"]);
  });

  test("a still alone under Start at is no view", () => {
    const still = body().replace(/```diff\n[^`]*```\n/u, "![the tree](/tmp/x/tree.png)\n");

    expect(checks(still)).toEqual(["view@7"]);
  });

  test("a digit inside a code span is no count", () => {
    expect(checks(body({ checksLine: "**Checks** `bun run e2e` green." }))).toEqual(["checks@20"]);
  });

  test("an issue number in Checks is no count", () => {
    expect(checks(body({ checksLine: "**Checks** ran the suite for #588." }))).toEqual([
      "checks@20",
    ]);
  });

  test("no footer", () => {
    expect(checks(body().replace("<sub>Written by Claude</sub>", ""))).toEqual(["footer@20"]);
  });

  test("a review recap or a line on what did not run under the footer", () => {
    const under = `${body()}\n\n\`/code-review medium\`: 2 findings, both fixed.\n\nThe e2e suite was not run.`;

    expect(checks(under)).toEqual(["recap@24", "not-run@26"]);
  });

  test("a review recap or a line on what did not run on the footer line itself", () => {
    expect(checks(body().replace("Written by Claude", "Written by Claude; e2e not run"))).toEqual([
      "not-run@22",
    ]);
    expect(
      checks(body().replace("Written by Claude", "Written by Claude after the review")),
    ).toEqual(["recap@22"]);
  });

  test("a recap or a line on what did not run in Proof or Decided", () => {
    expect(checks(body({ extra: ["The code review found 3 findings; all fixed.", ""] }))).toEqual([
      "recap@20",
    ]);
    expect(checks(body({ extra: ["The panel was not played in a live session.", ""] }))).toEqual([
      "not-run@20",
    ]);
    expect(
      checks(body({ extra: ["**Decided** The e2e suite was not run in the container.", ""] })),
    ).toEqual(["not-run@20"]);
  });

  test("a suite skipped in Checks", () => {
    expect(
      checks(
        body({ checksLine: "**Checks** `bun test`: 9 pass. `bun run e2e`: skipped, no Chromium." }),
      ),
    ).toEqual(["not-run@20"]);
  });

  test("a review recap under Decided", () => {
    const extra = ["**Decided** `/code-review medium` raised 2 findings; both fixed.", ""];

    expect(checks(body({ extra }))).toEqual(["recap@20"]);
  });

  test.each([
    "The e2e suite cannot be run here.",
    "Windows could not be verified.",
    "12 pass, not yet field-tested.",
  ])("a passive or hyphenated line on what did not run: %s", (line) => {
    expect(checks(body({ checksLine: `**Checks** \`bun test\`: 12 pass. ${line}` }))).toEqual([
      "not-run@20",
    ]);
  });

  test("a line of Checks that opens on Generated by is no footer", () => {
    const fake = body({ checksLine: "**Checks** `bun test`: 12 pass.\nGenerated by `bun test`." });

    expect(checks(fake.replace("<sub>Written by Claude</sub>", ""))).toEqual(["footer@21"]);
  });

  test("an open point or a question under the footer", () => {
    const under = `${body()}\n\n## Left open\n\n- Should the hook also cover \`gh pr edit\`?`;

    expect(checks(under)).toEqual(["open-point@24", "question@26"]);
  });

  test("the facts of Decided count on its lead-in line and in a table", () => {
    const leadIn = ["**Decided** keep A.", "", "- one", "- two", "- three", ""];
    const table = ["**Decided**", "", "| Fact |", "|---|", "| a |", "| b |", "| c |", "| d |", ""];

    expect(checks(body({ extra: leadIn }))).toEqual(["decided@24"]);
    expect(checks(body({ extra: table }))).toEqual(["decided@27"]);
  });

  test("more than three facts under Decided", () => {
    const decided = ["**Decided**", "", "- one", "- two", "- three", "- four", ""];

    expect(checks(body({ extra: decided }))).toEqual(["decided@25"]);
    expect(checks(body({ extra: decided.filter((l) => l !== "- four") }))).toEqual([]);
  });
});

function words(n: number): string {
  return Array.from({ length: n }, () => "word").join(" ");
}

describe("prose", () => {
  // The body around holds 21 words of prose, the last 4 on its Checks line, 22.
  const base = checkBody(body({ extra: [words(99), ""] }));

  test("120 words of prose pass, 121 are refused on the line that crosses the cap", () => {
    expect(base).toEqual([]);
    expect(checks(body({ extra: [words(100), ""] }))).toEqual(["prose@22"]);
  });

  test("prose under the footer counts", () => {
    expect(checks(`${body()}\n\n${words(200)}`)).toEqual(["prose@24"]);
  });

  test("views, tables and code do not count", () => {
    const fenced = [
      "```text",
      words(200),
      "```",
      "",
      `| ${words(200)} |`,
      "",
      `\`${words(200)}\``,
      "",
    ];

    expect(checks(body({ extra: fenced }))).toEqual([]);
  });
});

describe("no regression", () => {
  test("a ? inside a code block, a code span or a link target passes", () => {
    const extra = [
      "```ts",
      "const x = a ?? b?.c;",
      "```",
      "",
      "Run `gh pr view 1 --json body?`.",
      "",
    ];

    expect(checks(body({ extra }))).toEqual([]);
    expect(checks(body({ extra: ["See [the run](https://example.com/run?id=3).", ""] }))).toEqual(
      [],
    );
  });

  test("a command whose path holds the word review is no recap", () => {
    expect(
      checks(body({ checksLine: "**Checks** `bun test vellum/src/review/`: 212 pass, 0 fail." })),
    ).toEqual([]);
  });

  test("a lint's findings in Checks are no recap", () => {
    expect(
      checks(body({ checksLine: "**Checks** `oxlint`: 0 findings; `bun test`: 12 pass." })),
    ).toEqual([]);
  });

  test("true lines on what ran, and decisions about a review or a hook, pass", () => {
    const extra = [
      "**Decided**",
      "",
      "- The review check stays required on every push.",
      "- The hook is not run for subagents, which never close a PR.",
      "",
    ];

    const checksLine =
      "**Checks** `vitest run`: 40 passed, 2 skipped. `bun test plugins/code-review/x.test.ts`: 9 pass.";

    expect(checks(body({ extra, checksLine }))).toEqual([]);
  });

  test("an emoji inside the sub of the footer, an abbreviation in Why, a form of reach", () => {
    const text = body()
      .replace("Written by Claude", "🤖 Written by Claude")
      .replace("through.", "through, e.g. GitHub showed nothing.")
      .replace("reach:", "it reaches");

    expect(checks(text)).toEqual([]);
  });

  test("Decided counts a paragraph beside a list, an indented list, and no intro ending on a colon", () => {
    const mixed = ["**Decided** one fact.", "", "A second fact.", "", "- third", "- fourth", ""];
    const indented = ["**Decided**", "", " - one", " - two", " - three", " - four", ""];
    const intro = ["**Decided** three choices:", "", "- one", "- two", "- three", ""];

    expect(checks(body({ extra: mixed }))).toEqual(["decided@25"]);
    expect(checks(body({ extra: indented }))).toEqual(["decided@25"]);
    expect(checks(body({ extra: intro }))).toEqual([]);
  });

  test("Why: an abbreviation is no stop, a URL keeps the stop after it, a door in a code span counts", () => {
    expect(checks(body().replace("through.", "through, approx. 3 s per call."))).toEqual([]);
    expect(
      checks(
        body().replace("through.", "through, see https://x.y/a. Then the close said nothing."),
      ),
    ).toEqual(["why@3"]);
    expect(checks(body().replace("two-way door", "`two-way` door"))).toEqual([]);
  });

  test("Decided as one wrapped paragraph is one fact", () => {
    const extra = [
      "**Decided** The cap stays at 3,",
      "since a longer list",
      "reads as a plan",
      "nobody keeps.",
      "",
    ];

    expect(checks(body({ extra }))).toEqual([]);
  });

  test("the words that open no section pass inside a sentence", () => {
    expect(
      checks(
        body({ extra: ["The hook asks for a comment, and the question is settled by it.", ""] }),
      ),
    ).toEqual([]);
  });

  test("the attribution lines a host writes around the body pass", () => {
    const hosted = [
      '<!-- attribution: {"login":"x"} -->',
      "_Requested by **someone** · [thread](https://example.com/t?id=1)_",
      body().replace(
        "<sub>Written by Claude</sub>",
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      ),
      "",
      "https://example.com/session_1",
    ].join("\n");

    expect(checks(hosted)).toEqual([]);
  });
});

describe("clips", () => {
  const clip = ["![](/tmp/x/after.mp4)", ""];
  const protocol = "Protocol: build `a1b2c3`, viewport 393×830, page `/`, action tap Save.";
  const test2e = "Asserted by `e2e/save.spec.ts`.";

  test("a clip with its protocol line and its e2e test passes", () => {
    expect(checks(body({ extra: [...clip, protocol, test2e, ""] }))).toEqual([]);
  });

  test("a clip with no protocol line or no e2e test is refused on the clip", () => {
    expect(checks(body({ extra: [...clip, test2e, ""] }))).toEqual(["clip@20"]);
    expect(checks(body({ extra: [...clip, protocol, ""] }))).toEqual(["clip@20"]);
  });

  test("each clip needs its own protocol line and e2e test, before the next clip", () => {
    const two = ["![](/tmp/c/open.mp4)", protocol, test2e, "", "![](/tmp/c/close.mp4)", ""];

    // The second clip has neither: two findings on its line, 24.
    expect(checks(body({ extra: two }))).toEqual(["clip@24", "clip@24"]);
  });

  test("two clips of one table row share their protocol line and e2e test", () => {
    const row = ["| ![](/t/a.mp4) | ![](/t/b.mp4) |", "", protocol, test2e, ""];

    expect(checks(body({ extra: row }))).toEqual([]);
  });

  test("a clip in a table, its protocol in a cell", () => {
    const row = [
      "| Clip | Protocol | Test |",
      "|---|---|---|",
      `| ![](/t/a.mp4) | ${protocol} | ${test2e} |`,
      "",
    ];

    expect(checks(body({ extra: row }))).toEqual([]);
  });

  test("a clip takes no e2e test from Checks", () => {
    const extra = ["![](/tmp/x/after.mp4)", protocol, ""];

    expect(
      checks(body({ extra, checksLine: "**Checks** `bun test gate.test.ts`: 12 pass." })),
    ).toEqual(["clip@20"]);
  });

  test("a clip under the footer is held to the same rules", () => {
    expect(checks(`${body()}\n\n![](/tmp/x/after.mp4)`)).toEqual(["clip@24", "clip@24"]);
  });

  test("a clip written as a video tag is held to the same rules", () => {
    const video = ['<video src="/tmp/x/after.mp4"></video>', test2e, ""];

    expect(checks(body({ extra: video }))).toEqual(["clip@20"]);
  });

  test("a fourth clip is refused", () => {
    const four = ["/a.mp4", "/b.mov", "/c.webm", "/d.mp4"].flatMap((target) => [
      `![](${target})`,
      protocol,
      test2e,
    ]);

    expect(checks(body({ extra: [...four, ""] }))).toEqual(["clip@29"]);
  });
});

describe("a repository's own caps", () => {
  test("no settings file: the defaults", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".git"));

    expect(readCaps(repo)).toEqual(DEFAULT_CAPS);
  });

  test("the key pr of .github/github-flow.json, found from a subdirectory, over the defaults", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".github"));
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    writeFileSync(
      join(repo, ".github", "github-flow.json"),
      JSON.stringify({ pr: { decided: 1 }, issue: { x: 1 } }),
    );

    expect(readCaps(join(repo, "a", "b"))).toEqual({ ...DEFAULT_CAPS, decided: 1 });
  });

  test("the CLI uses them, and exits 2 on a cap that is no positive integer", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".github"));
    const file = join(repo, "body.md");
    writeFileSync(file, body({ extra: ["**Decided**", "", "- one", "- two", ""] }));

    expect(run([file], repo).code).toBe(0);

    writeFileSync(
      join(repo, ".github", "github-flow.json"),
      JSON.stringify({ pr: { decided: 1 } }),
    );
    const refused = run([file], repo);

    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain(`${file}:23: decided:`);

    writeFileSync(
      join(repo, ".github", "github-flow.json"),
      JSON.stringify({ pr: { decided: 0 } }),
    );

    expect(run([file], repo).code).toBe(2);
  });

  test.each([
    ["a key that is no cap", { pr: { prose: 100 } }],
    ["a pr that is no object", { pr: 5 }],
    ["a top level that is no object", []],
  ])("the CLI exits 2 on %s", (_case, settings) => {
    const repo = tmp();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".github"));
    const file = join(repo, "body.md");
    writeFileSync(file, body());
    writeFileSync(join(repo, ".github", "github-flow.json"), JSON.stringify(settings));

    expect(run([file], repo).code).toBe(2);
  });
});

describe("the CLI", () => {
  test("reads the body from stdin with -, prints <file>:<line>: <check>: <message>, exits 1", () => {
    const result = run(["-"], tmp(), SCRIPT, body({ extra: ["Is it done?", ""] }));

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^-:20: question: /u);
  });

  test("exits 2 on a file it cannot read, and with no file", () => {
    const dir = tmp();

    expect(run([join(dir, "missing.md")], dir).code).toBe(2);
    expect(run([], dir).code).toBe(2);
  });

  test("the skill directory copied alone into another repository runs its check there", () => {
    const repo = tmp();
    mkdirSync(join(repo, ".git"));
    const copy = join(repo, ".claude", "skills", "pr");
    cpSync(SKILL_DIR, copy, { recursive: true });

    const result = run(
      [join(copy, "references", "bodies", "ui.md")],
      repo,
      join(copy, "scripts", "check-pr.ts"),
    );

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
