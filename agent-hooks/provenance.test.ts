/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- these tests build transcript records, JSON lines whose shape Claude Code does not publish: a closed type would assert a schema instead of the reader's behaviour. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Argv, RunResult, Runner } from "./exec.ts";
import { deadlineIn } from "./exec.ts";
import type { Transcript } from "./provenance.ts";
import {
  CLASSIFIER_PROMPT,
  agentTrailersIn,
  classify,
  commitFormOf,
  factTriggerOf,
  factsOf,
  messageOf,
  provenanceTrailers,
  readTranscript,
  sessionValueOf,
  trailersOf,
  transcriptPathOf,
} from "./provenance.ts";
import type { CommitMark } from "./state.ts";
import { transcriptRecord as record, writeTranscript } from "./test-support.ts";

const START = Date.parse("2026-10-19T10:00:00Z");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-provenance-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function transcriptOf(
  records: readonly Record<string, unknown>[],
  subagent = false,
  promptId: string | undefined = "p-fixture",
): Transcript {
  return readTranscript(
    writeTranscript(path.join(dir, "t.jsonl"), records, START),
    subagent,
    promptId,
  );
}

/** The mark of a commit pre-bash rewrote right after the record at `position`. */
function after(position: number, promptId = "p-fixture"): CommitMark {
  return { at: START + position * 1000 + 500, promptId };
}

function facts(
  records: readonly Record<string, unknown>[],
  mark: CommitMark | null = null,
): string {
  return factsOf(transcriptOf(records), mark, "fix(parse): read partial dates", false);
}

const COMMITTED = [record("commit-call"), record("commit-ok")];

describe("what a transcript says of a review", () => {
  test("a /code-review the user typed has finished at its completed notification, not at its launch, nor when killed", () => {
    expect(facts([record("typed-review-launch")])).not.toContain("[review finished");
    expect(facts([record("typed-review-launch"), record("killed")])).not.toContain(
      "[review finished",
    );
    expect(facts([record("typed-review-launch"), record("notified-user")])).toContain(
      '[review finished] Agent "/code-review high" finished',
    );
  });

  test("a code-review the agent ran in the background has finished at its notification, a synchronous one at its result", () => {
    const launched = [record("skill-review-call"), record("skill-review-forked")];

    const notified = record("notified-user", [
      ["a1typedreview", "a3skillreview"],
      ["/code-review high", "/code-review high (agent)"],
    ]);

    expect(facts(launched)).not.toContain("[review finished");
    expect(facts([...launched, notified])).toContain(
      '[review finished] Agent "/code-review high (agent)" finished',
    );

    expect(facts([record("skill-review-call"), record("skill-review-sync")])).toContain(
      "[review finished] Skill code-review high",
    );
  });

  test("an Agent whose description reviews has finished at its notification; another Agent is no review", () => {
    const reviewer = [
      record("agent-review-call"),
      record("agent-review-launched"),
      record("notified-queued"),
    ];

    expect(facts(reviewer)).toContain('[review finished] Agent "Review the parser fix" finished');

    const explorer = [
      record("agent-review-call", [["Review the parser fix", "Explore the parser"]]),
      record("agent-review-launched"),
      record("notified-queued"),
    ];

    expect(facts(explorer)).not.toContain("[review finished");
  });

  test("a Stop or a SubagentStop that blocked the end of a turn is a fact", () => {
    expect(facts([record("stop-blocked")])).toContain(
      "[a Stop hook blocked the end of the turn] Stop validation failed:\nlint: src/parse.ts:3:1: error",
    );
    expect(facts([record("subagent-stop-blocked")])).toContain(
      "[a SubagentStop hook blocked the end of the turn]",
    );
  });
});

describe("factTriggerOf", () => {
  test("a message the user typed, or a plan the user approved, since the previous commit is human", () => {
    for (const message of [record("typed"), record("approved-plan")]) {
      const transcript = transcriptOf([...COMMITTED, message, record("say")]);

      expect(factTriggerOf(transcript, null, "p-fixture", false)).toBe("human");
      expect(factTriggerOf(transcript, after(1), "p-fixture", false)).toBe("human");
      expect(factTriggerOf(transcript, after(3), "p-fixture", false)).toBe("self");
    }
  });

  test("a notification, a message from another session or a lead's message in a main session is not human", () => {
    for (const message of [record("notified-user"), record("peer"), record("lead")]) {
      expect(factTriggerOf(transcriptOf([message]), null, "p-fixture", false)).toBe("self");
    }
  });

  test("a subagent's brief is human for its first commit, a lead's later message for the next", () => {
    const brief = transcriptOf([record("brief"), record("say")], true);

    expect(factTriggerOf(brief, null, "p-fixture", true)).toBe("human");
    expect(factTriggerOf(brief, after(1), "p-fixture", true)).toBe("self");

    const lead = transcriptOf([record("brief"), ...COMMITTED, record("lead")], true);

    expect(factTriggerOf(lead, after(2), "p-fixture", true)).toBe("human");
  });

  test("a main session whose transcript lags behind the turn counts a new prompt as a message", () => {
    const transcript = transcriptOf([record("say")], false, "p-new");

    expect(factTriggerOf(transcript, after(0, "p-old"), "p-new", false)).toBe("human");
    expect(factTriggerOf(transcript, after(0, "p-new"), "p-new", false)).toBe("self");
    expect(
      factTriggerOf(transcriptOf([record("say")], true, "p-new"), after(0), "p-new", true),
    ).toBe("self");
  });
});

describe("factsOf", () => {
  test("a review that finished before the user's last message still shows, so every commit of the arbitration sees it", () => {
    const records = [
      record("typed"),
      record("typed-review-launch"),
      record("notified-user"),
      record("typed", [["Fix the date parser.", "Arbitrate and fix."]]),
      ...COMMITTED,
    ];

    expect(facts(records, after(5))).toContain(
      '[review finished (before the previous commit)] Agent "/code-review high" finished',
    );
  });

  test("a review the previous commit already followed, two messages ago, no longer shows", () => {
    const records = [
      record("typed"),
      record("typed-review-launch"),
      record("notified-user"),
      ...COMMITTED,
      record("typed", [["Fix the date parser.", "Now the docs."]]),
      record("typed", [["Fix the date parser.", "And the README."]]),
    ];

    expect(facts(records, after(4))).not.toContain("[review finished");
  });

  test("lists the facts oldest first and ends with the commit to classify", () => {
    expect(facts([record("typed"), record("say")])).toBe(
      "[user message] Fix the date parser.\n\n[agent] The parser is fixed; committing.\n\n[THE COMMIT TO CLASSIFY] fix(parse): read partial dates",
    );
  });

  test("always shows a subagent's brief, and keeps the tail of facts too long to send", () => {
    const says = Array.from({ length: 80 }, () =>
      record("commit-call", [["fix(parse): read partial dates", "x".repeat(200)]]),
    );

    const subagent = factsOf(
      transcriptOf([record("brief"), ...says.flatMap((call) => [call, record("commit-ok")])], true),
      null,
      null,
      true,
    );

    expect(subagent.length).toBeLessThanOrEqual(12_000);
    expect(subagent).toStartWith("…");
    expect(subagent).toEndWith("[THE COMMIT TO CLASSIFY] (message not shown in the command)");

    expect(
      factsOf(
        transcriptOf([record("brief"), ...COMMITTED, record("say")], true),
        after(2),
        null,
        true,
      ),
    ).toStartWith("[the agent's brief (before the previous commit)] <teammate-message");
  });
});

describe("messageOf", () => {
  test("reads -m, a heredoc and a heredoc inside -m; -F names a file it cannot read", () => {
    expect(messageOf("git commit -qm 'fix: a'")).toBe("fix: a");
    expect(messageOf('git commit -m "fix: \\"b\\""')).toBe('fix: \\"b\\"');
    expect(messageOf("git commit -F - <<'EOF'\nfix: c\n\nbody\nEOF")).toBe("fix: c\n\nbody");
    expect(messageOf("git commit -m \"$(cat <<'EOF'\nfix: d\nEOF\n)\"")).toBe("fix: d");
    expect(messageOf("git commit -F msg.txt")).toBeNull();
  });
});

describe("commitFormOf", () => {
  test.each([
    [[], "new"],
    [["-qm", "x"], "new"],
    [["-C", "HEAD"], "new"],
    [["-m", "--amend"], "new"],
    [["--amend", "--no-edit"], "kept"],
    [["--amend"], "kept"],
    [["--amend", "-C", "HEAD"], "kept"],
    [["--amend", "-m", "x"], "amend"],
    [["--amend", "-F", "msg.txt"], "amend"],
    [["--amend", "--message=x"], "amend"],
    [["-am", "x", "--amend"], "amend"],
    [["--dry-run", "-m", "x"], "kept"],
  ] as const)("%j is %s", (args, form) => {
    expect(commitFormOf(args)).toBe(form);
  });
});

describe("trailers", () => {
  test("pins the text inserted after `commit`", () => {
    expect(trailersOf(provenanceTrailers("review", "s1.a2"))).toBe(
      " --trailer 'Agent-Trigger: review' --trailer 'Agent-Session: s1.a2'",
    );
    expect(trailersOf([["Agent-Note", "it's"]])).toBe(` --trailer 'Agent-Note: it'\\''s'`);
  });

  test("reads the Agent-* trailers git prints, and only those", () => {
    expect(
      agentTrailersIn(
        "Agent-Trigger: human\nAgent-Session: s1\nSigned-off-by: T <t@example.com>\n",
      ),
    ).toEqual([
      ["Agent-Trigger", "human"],
      ["Agent-Session", "s1"],
    ]);
  });

  test("names a subagent's session and transcript after its session's", () => {
    expect(sessionValueOf("s1", undefined)).toBe("s1");
    expect(sessionValueOf("s1", "a2")).toBe("s1.a2");
    expect(transcriptPathOf("/p/s1.jsonl", "s1", undefined)).toBe("/p/s1.jsonl");
    expect(transcriptPathOf("/p/s1.jsonl", "s1", "a2")).toBe("/p/s1/subagents/agent-a2.jsonl");
  });
});

function runner(result: RunResult, calls: Argv[] = []): Runner {
  return (argv) => {
    calls.push(argv);

    return Promise.resolve(result);
  };
}

const answer = (trigger: string): RunResult => ({
  kind: "exited",
  code: 0,
  stdout: JSON.stringify({ type: "result", result: `{"trigger": "${trigger}", "reason": "r"}` }),
  stderr: "",
});

describe("classify", () => {
  test("asks Haiku with no tool, hook, MCP server or saved session, and keeps only its review", async () => {
    const calls: Argv[] = [];

    expect(await classify("facts", deadlineIn(30_000), runner(answer("review"), calls))).toEqual({
      kind: "answered",
      review: true,
    });
    expect(await classify("facts", deadlineIn(30_000), runner(answer("human")))).toEqual({
      kind: "answered",
      review: false,
    });
    expect(calls[0]).toEqual([
      "claude",
      "-p",
      "--model",
      "haiku",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
      "--system-prompt",
      CLASSIFIER_PROMPT,
      "facts",
    ]);
  });

  test("says why it gave no answer", async () => {
    const deadline = deadlineIn(30_000);

    expect(
      await classify("f", deadline, runner({ kind: "exited", code: 1, stdout: "", stderr: "" })),
    ).toEqual({ kind: "failed", why: "claude -p exited 1 with no trigger" });
    expect(
      await classify(
        "f",
        deadline,
        runner({ kind: "timedOut", timeoutMs: 9, stdout: "", stderr: "" }),
      ),
    ).toEqual({ kind: "failed", why: "no answer within 9 ms" });
    expect(await classify("f", deadline, runner({ kind: "missing", program: "claude" }))).toEqual({
      kind: "failed",
      why: "claude is not on PATH",
    });

    const calls: Argv[] = [];

    expect(await classify("f", deadlineIn(1000), runner(answer("review"), calls))).toEqual({
      kind: "failed",
      why: "no time left before the hook's deadline",
    });
    expect(calls).toEqual([]);
  });
});
