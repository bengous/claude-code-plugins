import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { run } from "../lib/platform/process.ts";
import {
  ACTIONS_JQ,
  actionsOf,
  BYPASS_JQ,
  bypassOf,
  parseRepositoryLines,
  parseRuleLines,
  REPOSITORY_JQ,
  RULES_JQ,
} from "./check.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

/** The queries run through `jq` on the trial's real API answers, as `gh --jq` runs them on the live ones. */
async function jq(filter: string, fixture: string): Promise<string> {
  const result = await run(["jq", "-r", filter, join(FIXTURES, fixture)]);

  if (result.kind !== "exited" || result.code !== 0) {
    throw new Error(`jq failed on ${fixture}: ${JSON.stringify(result)}`);
  }

  return result.stdout;
}

describe("the gh queries on the trial's answers", () => {
  test("RULES_JQ reads every rule the factory needs", async () => {
    expect(parseRuleLines(await jq(RULES_JQ, "trial-rules.json"))).toEqual({
      checks: new Set(["test", "review", "owner-gate"]),
      threadsResolved: true,
      mergeQueue: true,
      rulesetId: "27380410",
      rulesetIds: new Set(["27380410"]),
    });
  });

  test("REPOSITORY_JQ reads the default branch, the auto-merge and squash settings and whether it is private", async () => {
    expect(parseRepositoryLines(await jq(REPOSITORY_JQ, "trial-repository.json"))).toEqual({
      defaultBranch: "main",
      allowAutoMerge: true,
      isPrivate: false,
      allowSquashMerge: true,
    });
  });

  test("BYPASS_JQ reads a ruleset without bypass actors", async () => {
    expect(
      bypassOf([
        {
          id: "27380410",
          answer: { kind: "ok", stdout: await jq(BYPASS_JQ, "trial-ruleset.json") },
        },
      ]),
    ).toEqual({ kind: "read", rulesets: [] });
  });

  test("ACTIONS_JQ reads whether Actions runs and which actions it allows", async () => {
    expect(
      actionsOf({ kind: "ok", stdout: await jq(ACTIONS_JQ, "trial-actions-permissions.json") }),
    ).toEqual({ kind: "read", enabled: true, allowed: "all" });
  });
});
