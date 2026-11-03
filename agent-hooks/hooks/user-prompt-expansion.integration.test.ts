/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isRecord, recordField, stringField } from "../core/util/json.ts";
import type { TempRepo } from "../test-support.ts";
import {
  createTempRepo,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "../test-support.ts";

const CLI = path.join(import.meta.dir, "..", "agent-hooks.ts");

const PROFILE = JSON.stringify({
  profile: {
    approvals: {
      labels: { "land-ok": { command: "land", targets: "./targets.sh {args} --json" } },
    },
  },
});

/**
 * Prints the layers of 470 (a stack of 467, 468) and of 12 (one pull request), fails on 13 without a word; any other
 * number is refused.
 */
const TARGETS = `#!/bin/sh
case "$1" in
  470) echo '{"stack":470,"layers":[{"number":467,"branch":"feature/a"},{"number":468,"branch":"feature/b"}]}' ;;
  12) echo '{"stack":null,"layers":[{"number":12,"branch":"feature/c"}]}' ;;
  13) exit 3 ;;
  *) echo "stack: #$1 is neither an open pull request nor a stack with open pull requests" >&2; exit 1 ;;
esac
`;

/** Logs each call; \`pr view N\` prints the labels of labels-N, and \`pr edit N\` fails for N in $FAKE_GH_FAILS. */
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_DIR/calls.log"
case "$1 $2" in
  "pr view") [ -f "$FAKE_GH_DIR/labels-$3" ] && cat "$FAKE_GH_DIR/labels-$3"; exit 0 ;;
  "pr edit") [ "$3" = "$FAKE_GH_FAILS" ] && { echo "could not add label: 'land-ok' not found" >&2; exit 1; }; exit 0 ;;
  *) exit 2 ;;
esac
`;

type Output = {
  readonly decision: string | undefined;
  readonly reason: string | undefined;
  readonly event: string | undefined;
  readonly context: string | undefined;
  readonly shown: string | undefined;
  readonly stdout: string;
};

let temp: TempRepo;

function ghCalls(): string[] {
  const log = path.join(temp.bin, "calls.log");

  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

async function expansion(
  name: string,
  args: string,
  extra: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string>> = {},
): Promise<Output> {
  const payload = {
    session_id: "s-expansion",
    cwd: temp.repo,
    hook_event_name: "UserPromptExpansion",
    expansion_type: "slash_command",
    command_name: name,
    command_args: args,
    command_source: "projectSettings",
    prompt: `/${name} ${args}`,
    ...extra,
  };

  const proc = Bun.spawn([process.execPath, CLI, "user-prompt-expansion"], {
    cwd: temp.repo,
    env: {
      ...process.env,
      AGENT_HOOKS_STATE_DIR: temp.stateDir,
      FAKE_GH_DIR: temp.bin,
      PATH: `${temp.bin}:${process.env["PATH"] ?? ""}`,
      ...env,
    },
    stdin: new Response(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const parsed: unknown = stdout.trim() === "" ? {} : JSON.parse(stdout);
  const output = isRecord(parsed) ? parsed : {};
  const specific = recordField(output, "hookSpecificOutput") ?? {};

  return {
    decision: stringField(output, "decision"),
    reason: stringField(output, "reason"),
    event: stringField(specific, "hookEventName"),
    context: stringField(specific, "additionalContext"),
    shown: stringField(output, "systemMessage"),
    stdout,
  };
}

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo("agent-hooks-expansion-");
  writeConfig(temp.repo, PROFILE);
  writeRepoFile(temp.repo, "targets.sh", TARGETS);
  chmodSync(path.join(temp.repo, "targets.sh"), 0o755);
  writeFileSync(path.join(temp.bin, "gh"), FAKE_GH);
  chmodSync(path.join(temp.bin, "gh"), 0o755);
});

afterEach(() => {
  removeTempRepo(temp);
});

describe("user-prompt-expansion", () => {
  test("puts the label on each pull request the human's command names, and tells the agent and the human", async () => {
    const output = await expansion("land", "470");

    const told =
      "agent-hooks: land-ok is on #467 #468 (stack #470), put there by the human's own /land 470.";

    expect(output.event).toBe("UserPromptExpansion");
    expect(output.context).toBe(told);
    expect(output.shown).toBe(told);
    expect(ghCalls()).toEqual([
      "pr view 467 --json labels --jq .labels[].name",
      "pr edit 467 --add-label land-ok",
      "pr view 468 --json labels --jq .labels[].name",
      "pr edit 468 --add-label land-ok",
    ]);
  });

  test("takes the label off first where it is on, so GitHub dates the ok anew", async () => {
    writeFileSync(path.join(temp.bin, "labels-12"), "tier:human\nland-ok\n");

    const output = await expansion("land", "#12");

    expect(output.context).toBe(
      "agent-hooks: land-ok is on #12, put there by the human's own /land 12.",
    );
    expect(ghCalls()).toEqual([
      "pr view 12 --json labels --jq .labels[].name",
      "pr edit 12 --remove-label land-ok",
      "pr edit 12 --add-label land-ok",
    ]);
  });

  test("blocks a number the targets command refuses, showing why, and labels nothing", async () => {
    const output = await expansion("land", "999");

    expect(output.decision).toBe("block");
    expect(output.reason).toBe(
      "agent-hooks: /land: stack: #999 is neither an open pull request nor a stack with open pull requests",
    );
    expect(ghCalls()).toEqual([]);
  });

  test("blocks a targets command that fails without a word, naming how it ended", async () => {
    const output = await expansion("land", "13");

    expect(output.decision).toBe("block");
    expect(output.reason).toBe("agent-hooks: /land: ./targets.sh 13 --json exited with code 3");
    expect(ghCalls()).toEqual([]);
  });

  test("blocks arguments that are no number, running nothing", async () => {
    const output = await expansion("land", "470 now");

    expect(output.decision).toBe("block");
    expect(output.reason).toBe(
      "agent-hooks: /land: /land takes one pull request or stack number, as /land 470",
    );
    expect(ghCalls()).toEqual([]);
  });

  test("blocks, naming the pull requests already labelled, when the label does not go on one", async () => {
    const output = await expansion("land", "470", {}, { FAKE_GH_FAILS: "468" });

    expect(output.decision).toBe("block");
    expect(output.reason).toBe(
      "agent-hooks: /land: land-ok did not go on #468: could not add label: 'land-ok' not found; it is on #467",
    );
  });

  test("leaves alone a command no label names, an MCP prompt, and a label opened by phrases", async () => {
    expect((await expansion("review", "12")).stdout).toBe("");
    expect((await expansion("land", "12", { expansion_type: "mcp_prompt" })).stdout).toBe("");

    writeConfig(
      temp.repo,
      JSON.stringify({ profile: { approvals: { labels: { "land-ok": ["land #{pr}"] } } } }),
    );

    expect((await expansion("land", "12")).stdout).toBe("");
    expect(ghCalls()).toEqual([]);
  });
});
