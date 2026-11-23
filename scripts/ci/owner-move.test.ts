import { expect, test } from "bun:test";
import { join } from "node:path";

import { parse } from "yaml";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly run?: string;
}

interface Workflow {
  readonly jobs: Readonly<
    Record<string, { readonly steps?: readonly Step[]; readonly permissions?: unknown }>
  >;
}

async function stepsOf(file: string, job: string): Promise<readonly Step[]> {
  const workflow: Workflow = parse(
    await Bun.file(join(import.meta.dir, "../../.github/workflows", file)).text(),
  );

  return workflow.jobs[job]?.steps ?? [];
}

function startOf(steps: readonly Step[]): string {
  return steps.find((step) => step.id === "start")?.run ?? "";
}

/** What decides the owner started a pull request, without what each workflow does once it is decided. */
function moves(script: string): string[] {
  return script
    .split("\n")
    .map((line) => line.trim().replace(/; then.*$/u, "; then"))
    .filter((line) => /AUTHOR|performed_via_github_app|labeled true/u.test(line));
}

test("the reviewer runs only on a pull request a move of the owner started", async () => {
  const steps = await stepsOf("review.yml", "read");
  const reviewer = steps.find((step) => step.uses?.startsWith("anthropics/claude-code-action"));

  expect(reviewer?.if).toBe("steps.start.outputs.started == 'true'");
  expect(steps.findIndex((step) => step.id === "start")).toBeLessThan(steps.indexOf(reviewer!));
});

test("the classifier runs only on a pull request a move of the owner started", async () => {
  const steps = await stepsOf("owner-gate.yml", "owner-gate");

  const spenders = steps.filter(
    (step) => step.name?.includes("Claude Code") || step.id === "judge",
  );

  expect(spenders).toHaveLength(2);

  for (const step of spenders) {
    expect(step.if).toContain("steps.start.outputs.started == 'true'");
  }
});

test("the three moves: the owner's login, Renovate's, or his ready label with no app behind it", async () => {
  const script = startOf(await stepsOf("review.yml", "read"));

  expect(script).toContain('[ "$AUTHOR" = "$OWNER" ] || [ "$AUTHOR" = "renovate[bot]" ]');
  expect(script).toContain('.label.name == "ready"');
  expect(script).toContain('[ "$last" = "labeled true $OWNER" ]');
});

test("the review and the gate read the same moves", async () => {
  const review = startOf(await stepsOf("review.yml", "read"));
  const gate = startOf(await stepsOf("owner-gate.yml", "owner-gate"));

  expect(moves(gate)).toEqual(moves(review));
  expect(moves(review).length).toBeGreaterThan(0);
});

test("a pull request nobody started is the owner's, whatever tier a head of it was given", async () => {
  const steps = await stepsOf("owner-gate.yml", "owner-gate");
  const verdict = steps.find((step) => step.name?.startsWith("Hold a human change"))?.run ?? "";

  expect(verdict.indexOf('if [ "$STARTED" != true ]; then')).toBeGreaterThan(-1);
  expect(verdict.indexOf('if [ "$STARTED" != true ]; then')).toBeLessThan(
    verdict.indexOf('if [ "$TIER" = low ]; then'),
  );
});

test("the owner's ready label on a pull request runs its review again, and no other label does", async () => {
  const steps = await stepsOf("owner-gate.yml", "owner-gate");
  const rerun = steps.find((step) => step.run?.includes("/rerun"));

  expect(rerun?.if).toBe(
    "github.event.action == 'labeled' && github.event.label.name == 'ready' && steps.start.outputs.by == 'label'",
  );
});
