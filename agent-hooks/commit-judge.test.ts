import { describe, expect, test } from "bun:test";

import { JUDGE_PROMPT, commitMessageOf, judge, judgeInput, judgeRefusal } from "./commit-judge.ts";
import type { Argv, RunResult, Runner } from "./exec.ts";
import { deadlineIn } from "./exec.ts";

describe("commitMessageOf", () => {
  test.each([
    [[], null, "new", null, null],
    [["-qm", "fix: a"], null, "new", "fix: a", null],
    [["-m", "fix: a", "-m", "body"], null, "new", "fix: a\n\nbody", null],
    [["--message=fix: a"], null, "new", "fix: a", null],
    [["-m", "$(cat <<'EOF'\nfix: d\nEOF\n)"], null, "new", "fix: d", null],
    [["-F", "-"], "fix: c\n\nbody\n", "new", "fix: c\n\nbody", null],
    [["-F", "msg.txt"], null, "new", null, "msg.txt"],
    [["-F", "/dev/stdin"], "fix: c\n", "new", "fix: c", null],
    [["-S0xC0FFEE", "-m", "fix: s"], null, "new", "fix: s", null],
    [["-unormal", "-m", "fix: u"], null, "new", "fix: u", null],
    [["-m", "--amend"], null, "new", "--amend", null],
    [["--fixup", "HEAD~1"], null, "new", null, null],
    [["--amend", "-m", "fix: b"], null, "amend", "fix: b", null],
    [["--amend", "-F", "msg.txt"], null, "amend", null, "msg.txt"],
    [["-am", "fix: b", "--amend"], null, "amend", "fix: b", null],
    [["--amend", "--no-edit"], null, "kept", null, null],
    [["--amend"], null, "kept", null, null],
    [["--no-edit"], null, "kept", null, null],
    [["-C", "HEAD"], null, "kept", null, null],
    [["--reuse-message=ORIG_HEAD"], null, "kept", null, null],
    [["--fixup=amend:HEAD"], null, "kept", null, null],
    [["--dry-run", "-m", "x"], null, "kept", "x", null],
    [["--porcelain"], null, "kept", null, null],
    [["-h"], null, "kept", null, null],
  ] as const)("%j with heredoc %j is %s", (args, heredoc, form, message, file) => {
    expect(commitMessageOf(args, heredoc)).toEqual({ form, message, file, opaque: false });
  });

  test("a -m substitution other than a heredoc is known only once the line runs", () => {
    expect(commitMessageOf(["-m", "fix: a", "-m", "$(cat body.txt)"], null)).toEqual({
      form: "new",
      message: "fix: a",
      file: null,
      opaque: true,
    });
  });
});

function runner(results: readonly RunResult[], calls: Argv[] = []): Runner {
  return (argv) => {
    calls.push(argv);
    const result = results[Math.min(calls.length, results.length) - 1];

    if (result === undefined) {
      throw new Error("the fake runner has no result");
    }

    return Promise.resolve(result);
  };
}

function answer(result: string): RunResult {
  return {
    kind: "exited",
    code: 0,
    stdout: JSON.stringify({ type: "result", result }),
    stderr: "",
  };
}

const REVIEW = answer(
  JSON.stringify({
    passages: [
      { quote: "From the review of #312", kind: "process" },
      { quote: "seen red first", kind: "check-event" },
      { quote: "a bare #312", kind: "fact" },
    ],
    reason: "r",
  }),
);

const CLEAN = answer(
  'Here it is: {"passages": [{"quote": "#312", "kind": "fact"}], "reason": "r"}',
);

describe("judge", () => {
  test("asks Haiku with no tool, hook, MCP server or saved session, the message then the files", async () => {
    const calls: Argv[] = [];

    await judge("fix: a", ["a.ts", "b.ts"], deadlineIn(30_000), runner([CLEAN], calls));

    expect(calls).toEqual([
      [
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
        JUDGE_PROMPT,
        "Message:\nfix: a\n\nFiles:\na.ts\nb.ts",
      ],
    ]);
  });

  test("keeps the process and check-event passages; a message of facts alone passes", async () => {
    expect(await judge("m", [], deadlineIn(30_000), runner([REVIEW]))).toEqual({
      kind: "answered",
      faults: [
        { kind: "process", quote: "From the review of #312" },
        { kind: "check-event", quote: "seen red first" },
      ],
    });
    expect(await judge("m", [], deadlineIn(30_000), runner([CLEAN]))).toEqual({
      kind: "answered",
      faults: [],
    });
  });

  test("reads the result message out of the array a verbose setting prints", async () => {
    const verbose: RunResult = {
      kind: "exited",
      code: 0,
      stdout: JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "assistant", message: { content: [] } },
        {
          type: "result",
          result: '{"passages": [{"quote": "Review of #333", "kind": "process"}]}',
        },
      ]),
      stderr: "",
    };

    expect(await judge("m", [], deadlineIn(30_000), runner([verbose]))).toEqual({
      kind: "answered",
      faults: [{ kind: "process", quote: "Review of #333" }],
    });
  });

  test("asks once more after an answer it cannot read, never after an error exit", async () => {
    const unreadable = answer('{"verdict": "ok"}');
    const calls: Argv[] = [];

    expect(await judge("m", [], deadlineIn(30_000), runner([unreadable, REVIEW], calls))).toEqual({
      kind: "answered",
      faults: [
        { kind: "process", quote: "From the review of #312" },
        { kind: "check-event", quote: "seen red first" },
      ],
    });
    expect(calls).toHaveLength(2);

    expect(await judge("m", [], deadlineIn(30_000), runner([unreadable]))).toEqual({
      kind: "failed",
      why: "claude -p exited 0 with no readable answer",
    });

    const failed: RunResult = { kind: "exited", code: 1, stdout: "", stderr: "" };
    const once: Argv[] = [];

    expect(await judge("m", [], deadlineIn(30_000), runner([failed, REVIEW], once))).toEqual({
      kind: "failed",
      why: "claude -p exited 1 with no readable answer",
    });
    expect(once).toHaveLength(1);
  });

  test("a missing claude or a timeout gets no second ask", async () => {
    const calls: Argv[] = [];

    expect(
      await judge(
        "m",
        [],
        deadlineIn(30_000),
        runner([{ kind: "timedOut", timeoutMs: 9, stdout: "", stderr: "" }], calls),
      ),
    ).toEqual({ kind: "failed", why: "no answer within 9 ms" });
    expect(calls).toHaveLength(1);
    expect(
      await judge("m", [], deadlineIn(30_000), runner([{ kind: "missing", program: "claude" }])),
    ).toEqual({ kind: "failed", why: "claude is not on PATH" });
  });

  test("asks nothing once the hook's deadline is too close", async () => {
    const calls: Argv[] = [];

    expect(await judge("m", [], deadlineIn(1000), runner([REVIEW], calls))).toEqual({
      kind: "failed",
      why: "no time left before the hook's deadline",
    });
    expect(calls).toEqual([]);
  });
});

describe("judgeInput", () => {
  test("lists no file for a branch without HEAD, and cuts a long list", () => {
    expect(judgeInput("fix: a", [])).toBe("Message:\nfix: a\n\nFiles:\n");

    const files = Array.from({ length: 205 }, (_, index) => `f${index}.ts`);

    expect(judgeInput("fix: a", files)).toEndWith("f199.ts\n… and 5 more");
  });
});

describe("judgeRefusal", () => {
  test("quotes each passage with what it tells, and puts the rewrite and the rerun side by side", () => {
    expect(
      judgeRefusal([
        {
          message: "fix: a\n\nbody",
          faults: [
            { kind: "process", quote: "From the review of #312" },
            { kind: "check-event", quote: "seen red first" },
          ],
        },
      ]),
    ).toBe(
      [
        "agent-hooks: this commit message tells how the change came about or how it was checked, which goes in the pull request, not in the history:",
        '- "From the review of #312" (how the change came about)',
        '- "seen red first" (how it was checked)',
        "A commit message says what the code does and why, the reason in words. Rewrite these passages, or rerun exactly the same command if the message is right.",
      ].join("\n"),
    );
  });

  test("names each commit by its subject when a line makes several", () => {
    const refusal = judgeRefusal([
      { message: "fix: a\n\nbody", faults: [{ kind: "process", quote: "p" }] },
      { message: "fix: b", faults: [{ kind: "check-event", quote: "c" }] },
    ]);

    expect(refusal).toStartWith("agent-hooks: these commit messages tell");
    expect(refusal).toContain('In "fix: a":\n- "p" (how the change came about)\nIn "fix: b":');
  });
});
