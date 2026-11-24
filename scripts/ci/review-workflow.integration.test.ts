import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

interface Step {
  readonly name?: string;
  readonly run?: string;
}

interface Workflow {
  readonly jobs: Readonly<Record<string, { readonly steps?: readonly Step[] }>>;
}

interface CheckRun {
  readonly name: string;
  readonly conclusion: string;
  readonly completed_at: string;
  readonly check_suite: { readonly id: number };
}

const DRAFT_SUITE = 1;

const REVIEW_SUITE = 2;

const CI_SUITE = 3;

const FIRST_ATTEMPT = "2026-01-02T00:00:00Z";

const SECOND_ATTEMPT = "2026-01-02T01:00:00Z";

function checkRun(
  name: string,
  conclusion: string,
  suite: number,
  completed = FIRST_ATTEMPT,
): CheckRun {
  return { name, conclusion, completed_at: completed, check_suite: { id: suite } };
}

/** The script of a step of `review.yml`'s verdict job, read from the workflow itself. */
async function reviewStep(name: string): Promise<string> {
  const workflow: Workflow = parse(
    await Bun.file(join(import.meta.dir, "../../.github/workflows/review.yml")).text(),
  );

  return workflow.jobs["review"]?.steps?.find((step) => step.name?.startsWith(name))?.run ?? "";
}

/** The step of `review.yml` that counts the failed rounds. */
const roundStep = (): Promise<string> => reviewStep("Fail while the review has findings");

async function roundFilter(): Promise<string> {
  const script = await roundStep();

  return /jq --arg since "\$since" '(?<filter>[^']*)'/u.exec(script)?.groups?.["filter"] ?? "";
}

/** What the filter counts on the pages `gh api --paginate --slurp` gives for one commit. */
async function failedRounds(pages: readonly (readonly CheckRun[])[], since = ""): Promise<string> {
  const jq = Bun.spawn(["jq", "--arg", "since", since, await roundFilter()], {
    stdin: Buffer.from(JSON.stringify(pages.map((runs) => ({ check_runs: runs })))),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [counted, complaint] = await Promise.all([
    new Response(jq.stdout).text(),
    new Response(jq.stderr).text(),
  ]);

  return `${counted.trim()}${complaint.trim()}`;
}

test("the filter is fed every attempt of every check of the commit, as one array of pages", async () => {
  expect(await roundStep()).toMatch(
    /gh api --paginate --slurp "repos\/\$REPO\/commits\/\$sha\/check-runs\?filter=all&per_page=100" \\\n\s+\| jq --arg since "\$since" '/u,
  );
});

test("a red review a re-run turned green is no failed round: its last attempt speaks", async () => {
  expect(
    await failedRounds([
      [
        checkRun("review (read)", "success", REVIEW_SUITE),
        checkRun("review", "failure", REVIEW_SUITE),
        checkRun("review", "success", REVIEW_SUITE, SECOND_ATTEMPT),
      ],
    ]),
  ).toBe("0");
});

test("a red test a re-run turned green is none, and one a re-run left red is one", async () => {
  expect(
    await failedRounds([
      [
        checkRun("test", "failure", CI_SUITE),
        checkRun("test", "success", CI_SUITE, SECOND_ATTEMPT),
      ],
    ]),
  ).toBe("0");

  expect(
    await failedRounds([
      [
        checkRun("test", "success", CI_SUITE),
        checkRun("test", "failure", CI_SUITE, SECOND_ATTEMPT),
      ],
    ]),
  ).toBe("1");
});

test("a draft's held review is no failed round: its run read nothing", async () => {
  expect(
    await failedRounds([
      [
        checkRun("review (read)", "skipped", DRAFT_SUITE),
        checkRun("review", "failure", DRAFT_SUITE),
      ],
    ]),
  ).toBe("0");
});

test("a review that read the commit and failed is one", async () => {
  expect(
    await failedRounds([
      [
        checkRun("review (read)", "success", REVIEW_SUITE),
        checkRun("review", "failure", REVIEW_SUITE),
      ],
    ]),
  ).toBe("1");
});

test("a head held as a draft, then reviewed clean, is none", async () => {
  expect(
    await failedRounds([
      [
        checkRun("review (read)", "skipped", DRAFT_SUITE),
        checkRun("review", "failure", DRAFT_SUITE),
      ],
      [
        checkRun("review (read)", "success", REVIEW_SUITE),
        checkRun("review", "success", REVIEW_SUITE),
      ],
    ]),
  ).toBe("0");
});

test("a review's two runs are paired across the pages of a commit's checks", async () => {
  expect(
    await failedRounds([
      [
        checkRun("review (read)", "skipped", DRAFT_SUITE),
        checkRun("review", "failure", DRAFT_SUITE),
      ],
      [checkRun("review (read)", "success", REVIEW_SUITE)],
      [checkRun("review", "failure", REVIEW_SUITE)],
    ]),
  ).toBe("1");
});

test("a red test is a failed round whatever the review did", async () => {
  expect(
    await failedRounds([
      [checkRun("test", "failure", CI_SUITE), checkRun("review (read)", "skipped", DRAFT_SUITE)],
    ]),
  ).toBe("1");
});

test("a round that failed before the owner's restart is not counted again", async () => {
  expect(
    await failedRounds(
      [
        [
          checkRun("review (read)", "success", REVIEW_SUITE),
          checkRun("review", "failure", REVIEW_SUITE),
        ],
      ],
      "2026-02-01T00:00:00Z",
    ),
  ).toBe("0");
});

/** A reviewer's answer: its schema's fields, which a bent answer may fill with any text. */
interface Verdict {
  readonly findings: number;
  readonly read: readonly string[];
  readonly issue: number | string | null;
  readonly round: string;
}

/** What the summary step writes for a reviewer's answer, and whether the sentinel the answer names exists after. */
async function summaryOf(
  verdict: (sentinel: string) => Verdict,
): Promise<{ summary: string; ran: boolean; sentinel: string }> {
  const dir = await mkdtemp(join(tmpdir(), "review-summary-"));

  try {
    const sentinel = join(dir, "ran");
    const summary = join(dir, "summary.md");

    await Bun.write(summary, "");

    const step = Bun.spawn(["bash", "-c", await reviewStep("Write what the round read")], {
      cwd: dir,
      env: {
        PATH: process.env["PATH"] ?? "",
        VERDICT: JSON.stringify(verdict(sentinel)),
        GITHUB_STEP_SUMMARY: summary,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, complaint] = await Promise.all([step.exited, new Response(step.stderr).text()]);

    expect(complaint).toBe("");
    expect(code).toBe(0);

    return {
      summary: await Bun.file(summary).text(),
      ran: await Bun.file(sentinel).exists(),
      sentinel,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a reviewer's answer reaches the summary as text inside <pre>, and none of it runs", async () => {
  const { summary, ran, sentinel } = await summaryOf((path) => ({
    findings: 0,
    read: [
      `$(touch ${path})`,
      `\`touch ${path}\``,
      `a; touch ${path}`,
      "</pre><img src=x onerror=alert(1)>",
      "**bold** [link](https://example.com) # heading",
      "a & b",
    ],
    issue: 561,
    round: "first",
  }));

  expect(ran).toBe(false);
  expect(summary).toBe(
    [
      "<pre>",
      "Round: a first round",
      "Judged against issue: #561",
      "Files read: 6",
      `  $(touch ${sentinel})`,
      `  \`touch ${sentinel}\``,
      `  a; touch ${sentinel}`,
      "  &lt;/pre&gt;&lt;img src=x onerror=alert(1)&gt;",
      "  **bold** [link](https://example.com) # heading",
      "  a &amp; b",
      "</pre>",
      "",
    ].join("\n"),
  );
});

test("a round field the reviewer bent out of its schema reaches the summary escaped", async () => {
  const { summary, ran, sentinel } = await summaryOf((path) => ({
    findings: 0,
    read: [],
    issue: `<b>$(touch ${path})</b>`,
    round: `$(touch ${path})`,
  }));

  expect(ran).toBe(false);
  expect(summary).toContain("Round: a round that did not say which\n");
  expect(summary).toContain(`Judged against issue: #&lt;b&gt;$(touch ${sentinel})&lt;/b&gt;\n`);
  expect(summary).toContain("Files read: 0\n</pre>\n");
});
