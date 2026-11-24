import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

interface Job {
  readonly if?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly { readonly run?: string }[];
}

interface Workflow {
  readonly on: { readonly issues?: { readonly types?: readonly string[] } };
  readonly jobs: Readonly<Record<string, Job>>;
}

async function unclaim(): Promise<Workflow> {
  return parse(await Bun.file(join(import.meta.dir, "../../.github/workflows/unclaim.yml")).text());
}

let bin = "";

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "unclaim-"));
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

/** Runs the job's step with a `gh` that records its arguments and answers as `answer` says. */
async function runStep(answer: string): Promise<{ code: number; calls: string; out: string }> {
  const script = (await unclaim()).jobs["unclaim"]?.steps?.[0]?.run ?? "";
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho "$*" >> "${calls}"\n${answer}\n`);
  chmodSync(join(bin, "gh"), 0o755);

  const step = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, REPO: "o/r", ISSUE: "7" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err] = await Promise.all([
    new Response(step.stdout).text(),
    new Response(step.stderr).text(),
  ]);

  const code = await step.exited;

  return { code, calls: readFileSync(calls, "utf8").trim(), out: `${out}${err}` };
}

test("it runs when an issue closes, on an issue that carries in-progress, with the right to label it", async () => {
  const workflow = await unclaim();
  const job = workflow.jobs["unclaim"];

  expect(workflow.on.issues?.types).toEqual(["closed"]);
  expect(job?.if).toBe("contains(github.event.issue.labels.*.name, 'in-progress')");
  expect(job?.permissions).toEqual({ issues: "write" });
});

test("the step removes in-progress from the closed issue", async () => {
  const { code, calls } = await runStep("exit 0");

  expect(code).toBe(0);
  expect(calls).toBe("api -X DELETE repos/o/r/issues/7/labels/in-progress --silent");
});

test("a label already gone is the state wanted, not a failure", async () => {
  const { code, out } = await runStep('echo "gh: Label does not exist (HTTP 404)" >&2; exit 1');

  expect(code).toBe(0);
  expect(out).toContain("#7 no longer carries in-progress.");
});

test("any other refusal fails the job with GitHub's answer", async () => {
  const { code, out } = await runStep(
    'echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1',
  );

  expect(code).toBe(1);
  expect(out).toContain("HTTP 403");
});
