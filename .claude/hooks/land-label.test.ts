import { beforeEach, describe, expect, test } from "bun:test";

import type { Argv, RunResult } from "../../tools/platform/process.ts";
import type { Answer, ExpansionInput, Runner } from "./land-label.ts";
import { encode, landLabel } from "./land-label.ts";

const STACK_470 = {
  stack: 470,
  layers: [
    { number: 467, branch: "feature/a" },
    { number: 468, branch: "feature/b" },
  ],
};

const SINGLE_12 = { stack: null, layers: [{ number: 12, branch: "feature/c" }] };

function exited(code: number, stdout = "", stderr = ""): RunResult {
  return { kind: "exited", code, stdout, stderr };
}

interface World {
  /** Labels of each pull request, as `gh pr view --jq .labels[].name` prints them. */
  labels: Map<string, string>;
  /** The pull request whose `gh pr edit` fails. */
  failsOn: string | null;
  calls: string[];
}

let world: World;

/**
 * `stack.ts resolve` prints the layers of 470 (a stack of 467, 468) and of 12 (one pull request), fails on 13 without
 * a word, and refuses any other number; `gh` answers from the world.
 */
const runner: Runner = (argv: Argv) => {
  const [program, ...args] = argv;

  if (program === "bun") {
    const number = args[2];

    switch (number) {
      case "470": {
        return Promise.resolve(exited(0, JSON.stringify(STACK_470)));
      }

      case "12": {
        return Promise.resolve(exited(0, JSON.stringify(SINGLE_12)));
      }

      case "13": {
        return Promise.resolve(exited(3));
      }

      default: {
        return Promise.resolve(
          exited(
            1,
            "",
            `stack: #${number} is neither an open pull request nor a stack with open pull requests`,
          ),
        );
      }
    }
  }

  world.calls.push(args.join(" "));
  const [, verb, pr = ""] = args;

  if (verb === "view") return Promise.resolve(exited(0, world.labels.get(pr) ?? ""));

  if (pr === world.failsOn) {
    return Promise.resolve(exited(1, "", "could not add label: 'land-ok' not found"));
  }

  return Promise.resolve(exited(0));
};

function expansion(
  name: string,
  args: string,
  extra: Partial<ExpansionInput> = {},
): Promise<Answer> {
  return landLabel(
    { expansion_type: "slash_command", command_name: name, command_args: args, ...extra },
    "/repo",
    runner,
  );
}

beforeEach(() => {
  world = { labels: new Map(), failsOn: null, calls: [] };
});

describe("land-label", () => {
  test("puts land-ok on each pull request the human's /land names, and tells the agent and the human", async () => {
    const told =
      "land-label: land-ok is on #467 #468 (stack #470), put there by the human's own /land 470.";

    const answer = await expansion("land", "470");

    expect(answer).toEqual({ kind: "labelled", line: told });
    expect(JSON.parse(encode(answer) ?? "")).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptExpansion", additionalContext: told },
      systemMessage: told,
    });
    expect(world.calls).toEqual([
      "pr view 467 --json labels --jq .labels[].name",
      "pr edit 467 --add-label land-ok",
      "pr view 468 --json labels --jq .labels[].name",
      "pr edit 468 --add-label land-ok",
    ]);
  });

  test("takes the label off first where it is on, so GitHub dates the ok anew", async () => {
    world.labels.set("12", "tier:human\nland-ok\n");

    expect(await expansion("land", "#12")).toEqual({
      kind: "labelled",
      line: "land-label: land-ok is on #12, put there by the human's own /land 12.",
    });
    expect(world.calls).toEqual([
      "pr view 12 --json labels --jq .labels[].name",
      "pr edit 12 --remove-label land-ok",
      "pr edit 12 --add-label land-ok",
    ]);
  });

  test("blocks a number stack.ts refuses, showing why, and labels nothing", async () => {
    const answer = await expansion("land", "999");

    expect(answer).toEqual({
      kind: "block",
      reason:
        "land-label: /land: stack: #999 is neither an open pull request nor a stack with open pull requests",
    });
    expect(JSON.parse(encode(answer) ?? "")).toEqual({
      decision: "block",
      reason:
        "land-label: /land: stack: #999 is neither an open pull request nor a stack with open pull requests",
    });
    expect(world.calls).toEqual([]);
  });

  test("blocks a stack.ts that fails without a word, naming how it ended", async () => {
    expect(await expansion("land", "13")).toEqual({
      kind: "block",
      reason:
        "land-label: /land: bun ./scripts/landing/stack.ts resolve 13 --json exited with code 3",
    });
    expect(world.calls).toEqual([]);
  });

  test("blocks arguments that are no number, running nothing", async () => {
    expect(await expansion("land", "470 now")).toEqual({
      kind: "block",
      reason: "land-label: /land: /land takes one pull request or stack number, as /land 470",
    });
    expect(world.calls).toEqual([]);
  });

  test("blocks, naming the pull requests already labelled, when the label does not go on one", async () => {
    world.failsOn = "468";

    expect(await expansion("land", "470")).toEqual({
      kind: "block",
      reason:
        "land-label: /land: land-ok did not go on #468: could not add label: 'land-ok' not found; it is on #467",
    });
  });

  test("leaves alone another command and an MCP prompt, printing nothing", async () => {
    expect(encode(await expansion("review", "12"))).toBeNull();
    expect(encode(await expansion("land", "12", { expansion_type: "mcp_prompt" }))).toBeNull();
    expect(world.calls).toEqual([]);
  });
});
