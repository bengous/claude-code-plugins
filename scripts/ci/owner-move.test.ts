import { expect, test } from "bun:test";
import { join } from "node:path";

import { parse } from "yaml";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}

interface Job {
  readonly name?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly jobs: Readonly<Record<string, Job>>;
}

async function jobOf(file: string, job: string): Promise<Job> {
  const workflow: Workflow = parse(
    await Bun.file(join(import.meta.dir, "../../.github/workflows", file)).text(),
  );

  return workflow.jobs[job] ?? {};
}

const review = (): Promise<Job> => jobOf("review.yml", "read");

const reviewVerdict = (): Promise<Job> => jobOf("review.yml", "review");

const gate = (): Promise<Job> => jobOf("owner-gate.yml", "owner-gate");

/** A script's lines, trimmed, so a block compares as text whatever its indentation. */
function lines(script: string | undefined): string {
  return (script ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function startOf(job: Job): string {
  return lines(job.steps?.find((step) => step.id === "start")?.run);
}

/** What decides whose move started a pull request, up to where each workflow does its own with it. */
function moves(job: Job): string {
  const script = startOf(job);
  const end = script.indexOf('if [ "$last" = "labeled true $OWNER" ]; then ready=true; fi');

  return end === -1 ? "" : script.slice(0, script.indexOf("\n", end));
}

test("the review and the gate read the same author, commits and label, word for word", async () => {
  const [read, judge] = await Promise.all([review(), gate()]);

  expect(moves(judge)).toBe(moves(read));
  expect(judge.env?.["AUTHOR"]).toBe(read.env?.["AUTHOR"]);
  expect(judge.env?.["OWNER"]).toBe(read.env?.["OWNER"]);
});

test("the moves: the owner's login, Renovate's own commits, his ready label with no app behind it", async () => {
  const read = await review();
  const shared = moves(read);

  expect(read.env?.["AUTHOR"]).toBe("${{ github.event.pull_request.user.login }}");
  expect(read.env?.["OWNER"]).toBe("bengous");
  expect(shared).toContain('if [ "$AUTHOR" = "$OWNER" ]; then\nwho=owner');
  expect(shared).toContain('elif [ "$AUTHOR" = "renovate[bot]" ]; then');
  expect(shared).toContain(
    'select((.author.login == "renovate[bot]" and .committer.login == "web-flow" and .commit.verification.verified == true) | not)',
  );
  expect(shared).toContain('if [ "$foreign" -eq 0 ]; then who=renovate; fi');
  expect(shared).toContain('.label.name == "ready"');
  expect(shared).toContain('"\\(.event) \\(.performed_via_github_app == null) \\(.actor.login)"');
});

test("the reviewer runs on the owner's pull request, his ready label or a held update, and on nothing else", async () => {
  const read = await review();
  const steps = read.steps ?? [];
  const reviewer = steps.find((step) => step.uses?.startsWith("anthropics/claude-code-action"));

  expect(reviewer?.if).toBe("steps.start.outputs.started == 'true'");
  expect(steps.findIndex((step) => step.id === "start")).toBeLessThan(steps.indexOf(reviewer!));
  expect(startOf(read)).toContain(
    'started=false\nif [ "$who" = owner ] || [ "$ready" = true ]; then started=true; fi',
  );
  expect(read.outputs?.["started"]).toBe("${{ steps.start.outputs.started }}");
});

test("a review no move started succeeds with a notice before it reads any verdict", async () => {
  const job = await reviewVerdict();

  const verdict = lines(
    job.steps?.find((step) => step.name?.startsWith("Fail while the review has findings"))?.run,
  );

  const exit = verdict.indexOf('if [ "$STARTED" = false ]; then');

  expect(job.env?.["STARTED"]).toBe("${{ needs.read.outputs.started }}");
  expect(exit).toBeGreaterThan(-1);
  expect(exit).toBeLessThan(verdict.indexOf("findings=$(jq -er .findings"));
  expect(verdict).toContain("::notice::Not reviewed: a dependency update of Renovate");
  expect(verdict).toContain("::notice::Not reviewed: no move of $OWNER started this pull request.");
});

test("the gate names the move: the owner's login first, then his ready label, then Renovate", async () => {
  expect(startOf(await gate())).toContain(
    [
      'by=""',
      'if [ "$who" = owner ]; then',
      "by=author",
      'elif [ "$ready" = true ]; then',
      "by=label",
      'elif [ "$who" = renovate ]; then',
      "by=renovate",
      "fi",
      'echo "by=$by" >> "$GITHUB_OUTPUT"',
    ].join("\n"),
  );
});

test("the classifier runs on the owner's pull request or Renovate's, and on nothing else", async () => {
  const steps = (await gate()).steps ?? [];

  const spenders = steps.filter(
    (step) => step.name?.includes("Claude Code") || step.id === "judge",
  );

  expect(spenders).toHaveLength(2);

  for (const step of spenders) {
    expect(step.if).toContain(
      "(steps.start.outputs.by == 'author' || steps.start.outputs.by == 'renovate')",
    );
  }
});

test("the last step of the gate makes human a pull request the owner did not open", async () => {
  const steps = (await gate()).steps ?? [];
  const last = steps.at(-1);
  const script = lines(last?.run);
  const open = script.indexOf('case "$BY" in');
  const close = script.indexOf("esac", open);

  const arms = script
    .slice(open + 'case "$BY" in'.length, close)
    .split(";;")
    .map((arm) => arm.trim())
    .filter((arm) => arm !== "");

  expect(last?.name).toStartWith("Hold a human change");
  expect(last?.env?.["BY"]).toBe("${{ steps.start.outputs.by }}");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeLessThan(script.indexOf('if [ "$TIER" = low ]; then'));
  expect(arms[0]).toBe("author | renovate)");
  expect(arms.at(-1)).toStartWith("*)");
  expect(arms.slice(1).map((arm) => arm.split("\n")[1])).toEqual(["TIER=human", "TIER=human"]);
});

test("the owner's ready label on a pull request he did not open runs its review again", async () => {
  const steps = (await gate()).steps ?? [];
  const rerun = steps.find((step) => step.run?.includes("/rerun"));

  expect(rerun?.if).toBe(
    "github.event.action == 'labeled' && github.event.label.name == 'ready' && steps.start.outputs.by == 'label'",
  );
});

/** The check the gate writes on a Renovate update it holds for the owner, which the review reads. */
const HELD = "held for the owner";

/** How both workflows look for that mark on the head: GitHub Actions' own, so no other app can forge it. */
const HELD_QUERY = [
  `gh api "repos/$REPO/commits/$HEAD/check-runs?check_name=${encodeURIComponent(HELD)}&per_page=100" \\`,
  `--jq '[.check_runs[] | select(.app.slug == "github-actions")] | length')`,
].join("\n");

test("a Renovate update the gate holds is reviewed: the gate writes the mark the review reads", async () => {
  const [read, judge] = await Promise.all([review(), gate()]);
  const start = startOf(read);
  const steps = judge.steps ?? [];

  const mark = steps.find((step) =>
    step.name?.startsWith("Have the review read a Renovate update"),
  );

  const script = lines(mark?.run);
  const held = `if [ "$who" = renovate ]; then\nheld=$(${HELD_QUERY}\nif [ "$held" -gt 0 ]; then started=true; fi\nfi`;

  expect(read.env?.["HEAD"]).toBe("${{ github.event.pull_request.head.sha }}");
  expect(judge.env?.["HEAD"]).toBe(read.env?.["HEAD"]);
  expect(start.indexOf(held)).toBeGreaterThan(start.indexOf("started=false"));

  expect(mark?.if).toBe("steps.start.outputs.by == 'renovate'");
  expect(steps.indexOf(mark!)).toBeLessThan(steps.length - 1);
  expect(script).toContain(`marks=$(${HELD_QUERY}`);
  expect(script).toContain(`-f name="${HELD}" -f head_sha="$HEAD"`);
  expect(script).toContain('gh api "repos/$REPO/actions/workflows/review.yml/runs?head_sha=$HEAD');
  expect(script).toContain('gh api -X POST "repos/$REPO/actions/runs/$run/rerun"');
});

test("the gate holds for the owner an update of tier human and any major, and lets the rest through", async () => {
  const mark = (await gate()).steps?.find((step) =>
    step.name?.startsWith("Have the review read a Renovate update"),
  );

  expect(lines(mark?.run)).toContain(
    'if [ "$TIER" = low ] && ! grep -qx major <<<"$labels"; then\necho "Not held: tier low, and no major."\nexit 0\nfi',
  );
});

test("the gate reads the reviewer's step of the review's job by the names review.yml gives them", async () => {
  const [read, judge] = await Promise.all([review(), gate()]);

  const mark = judge.steps?.find((step) =>
    step.name?.startsWith("Have the review read a Renovate update"),
  );

  const reviewer = read.steps?.find((step) =>
    step.uses?.startsWith("anthropics/claude-code-action"),
  );

  expect(read.name).toBe("review (read)");
  // GitHub names a step with no name of its own "Run <uses>", which is how the gate finds it.
  expect(reviewer).toBeDefined();
  expect(reviewer?.name).toBeUndefined();
  expect(lines(mark?.run)).toContain(
    `select(.name == "${read.name}") | .steps[] | select(.name | startswith("Run anthropics/claude-code-action"))`,
  );
});
