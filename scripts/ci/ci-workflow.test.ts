import { expect, test } from "bun:test";
import { join } from "node:path";

import { parse } from "yaml";

interface Job {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly strategy?: unknown;
}

interface Workflow {
  readonly on: { readonly pull_request?: { readonly types?: readonly string[] } };
  readonly jobs: Readonly<Record<string, Job>>;
}

async function ci(): Promise<Workflow> {
  return parse(await Bun.file(join(import.meta.dir, "../../.github/workflows/ci.yml")).text());
}

test("the required check is the job `test`, which reports under that name on every run", async () => {
  const job = (await ci()).jobs["test"];

  // A job with a `name:` or a matrix reports another check name, and one an `if:` skips reads as green to a ruleset.
  expect(job?.name).toBeUndefined();
  expect(job?.strategy).toBeUndefined();
  expect(job?.if).toBe("always()");
});

test("`test` needs every verdict of the workflow", async () => {
  expect((await ci()).jobs["test"]?.needs).toEqual([
    "validate",
    "scope",
    "win32",
    "mutation",
    "e2e",
  ]);
});

test("the browser suite runs when the scope says the change reaches it, and its verdict with it", async () => {
  const { jobs } = await ci();

  expect(jobs["scope"]?.if).toBeUndefined();
  expect(jobs["e2e-window"]?.if).toBe("needs.scope.outputs.e2e == 'true'");
  expect(jobs["e2e-win32"]?.if).toBe("needs.scope.outputs.e2e == 'true'");
  expect(jobs["e2e"]?.if).toBe("always() && needs.scope.outputs.e2e == 'true'");
});

test("a label starts no run: a second `test` on a head could stand in for the first", async () => {
  expect((await ci()).on.pull_request?.types).toBeUndefined();
});
