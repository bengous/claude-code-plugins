import { describe, expect, test } from "bun:test";

import type { CommitExpansion, Fault } from "./commit-judge.ts";
import { JUDGE_PROMPT, commitMessageOf, judge, judgeInput, judgeRefusal } from "./commit-judge.ts";
import type { Argv, RunOptions, RunResult, Runner } from "./exec.ts";
import { deadlineIn } from "./exec.ts";

const LITERAL: CommitExpansion = { argsExpand: [], heredocExpands: false };

/** The expansion of `args` where each word at `expanding` is one Bash expands. */
function expanding(...indexes: number[]): CommitExpansion {
  return {
    argsExpand: Array.from({ length: 8 }, (_, at) => indexes.includes(at)),
    heredocExpands: false,
  };
}

describe("commitMessageOf", () => {
  test.each([
    [[], null, "new", null, null],
    [["-qm", "fix: a"], null, "new", "fix: a", null],
    [["-m", "fix: a", "-m", "body"], null, "new", "fix: a\n\nbody", null],
    [["--message=fix: a"], null, "new", "fix: a", null],
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
    [
      ["-m", "fix: a", "--trailer", "Reviewed-by: an agent"],
      null,
      "new",
      "fix: a\n\nReviewed-by: an agent",
      null,
    ],
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
    expect(commitMessageOf(args, heredoc, LITERAL)).toMatchObject({
      form,
      message,
      file,
      opaque: false,
    });
  });

  test("a heredoc read through a substitution is literal unless Bash expands its body", () => {
    const quoted = "$(cat <<'EOF'\nfix: d, $5 a seat\nEOF\n)";
    const bare = "$(cat <<EOF\nfix: d, $USER\nEOF\n)";

    expect(commitMessageOf(["-m", quoted], null, expanding(1))).toMatchObject({
      message: "fix: d, $5 a seat",
      opaque: false,
    });
    expect(commitMessageOf(["-m", bare], null, expanding(1)).opaque).toBe(true);
    expect(
      commitMessageOf(["-m", "$(cat <<\\EOF\nfix: d, $5 a seat\nEOF\n)"], null, expanding(1)),
    ).toMatchObject({ message: "fix: d, $5 a seat", opaque: false });
  });

  test("a heredoc read by another command, or followed by more text, is known only once the line runs", () => {
    for (const value of [
      "$(sed 's/x/y/' <<'EOF'\nfix: d\nEOF\n)",
      "$(cat <<'EOF'\nfix: d\nEOF\n) and the review of #12",
      "$(cat <<'EOF'\nfix: d\nEOF\n) $(git log -1 --format=%s)",
    ]) {
      expect(commitMessageOf(["-m", value], null, expanding(1)).opaque).toBe(true);
    }
  });

  test("a value Bash expands, or a -F - no literal heredoc feeds, is known only once the line runs", () => {
    expect(
      commitMessageOf(["-m", "fix: a", "-m", "$(cat body.txt)"], null, expanding(3)),
    ).toMatchObject({
      message: "fix: a",
      opaque: true,
    });
    expect(commitMessageOf(["-m", "$MSG"], null, expanding(1)).opaque).toBe(true);
    expect(commitMessageOf(["--message=$MSG"], null, expanding(0)).opaque).toBe(true);
    expect(commitMessageOf(["-m", "x", "--trailer", "$WHO"], null, expanding(3)).opaque).toBe(true);
    expect(commitMessageOf(["-F", "$HOME/msg.txt"], null, expanding(1)).opaque).toBe(true);
    expect(commitMessageOf(["-F", "msg.txt", "--trailer", "Note: n"], null, LITERAL)).toMatchObject(
      {
        message: null,
        file: "msg.txt",
        trailers: ["Note: n"],
        opaque: false,
      },
    );
    expect(commitMessageOf(["-F", "-"], null, LITERAL).opaque).toBe(true);
    expect(
      commitMessageOf(["-F", "-"], "fix: $X\n", { argsExpand: [], heredocExpands: true }).opaque,
    ).toBe(true);
    expect(commitMessageOf(["-m", "$MSG"], null, LITERAL).opaque).toBe(false);
  });

  test("reads a long option by any unique prefix, as git does", () => {
    expect(commitMessageOf(["--mess=fix: a"], null, LITERAL).message).toBe("fix: a");
    expect(commitMessageOf(["--mes", "fix: a"], null, LITERAL).message).toBe("fix: a");
    expect(commitMessageOf(["--am", "--no-e"], null, LITERAL).form).toBe("kept");
    expect(commitMessageOf(["--am", "-m", "fix: b"], null, LITERAL).form).toBe("amend");
    expect(commitMessageOf(["--dry", "-m", "x"], null, LITERAL).form).toBe("kept");
    expect(
      commitMessageOf(["-m", "fix: a", "--trai", "Reviewed-by: an agent"], null, LITERAL).message,
    ).toBe("fix: a\n\nReviewed-by: an agent");
  });

  test("takes the index, or the tracked files on disk for -a and pathspecs", () => {
    expect(commitMessageOf(["-qm", "x"], null, LITERAL).takes).toBe("staged");
    expect(commitMessageOf(["-am", "x"], null, LITERAL).takes).toBe("worktree");
    expect(commitMessageOf(["--all", "-m", "x"], null, LITERAL).takes).toBe("worktree");
    expect(commitMessageOf(["--al", "-m", "x"], null, LITERAL).takes).toBe("worktree");
    expect(commitMessageOf(["-m", "x", "a.ts"], null, LITERAL).takes).toBe("worktree");
    expect(commitMessageOf(["-m", "x", "--", "a.ts"], null, LITERAL).takes).toBe("worktree");
  });
});

type Call = { readonly argv: Argv; readonly options: RunOptions };

function runner(results: readonly RunResult[], calls: Call[] = []): Runner {
  return (argv, options) => {
    calls.push({ argv, options });
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

const MESSAGE =
  "fix: a, from the review of #312\n\nThe new test was  seen red first, as a bare #312 says.";

const REVIEW = answer(
  JSON.stringify({
    passages: [
      { quote: "From the review of #312", kind: "process" },
      { quote: "from the review of #312", kind: "process" },
      { quote: "seen red\nfirst", kind: "check-event" },
      { quote: "after the second review", kind: "process" },
      { quote: "", kind: "check-event" },
      { quote: "a bare #312", kind: "fact" },
    ],
    reason: "r",
  }),
);

const FAULTS: readonly Fault[] = [
  { kind: "process", quote: "from the review of #312" },
  { kind: "check-event", quote: "seen red first" },
];

const CLEAN = answer(
  'Here it is: {"passages": [{"quote": "#312", "kind": "fact"}], "reason": "r"}',
);

describe("judge", () => {
  test("asks Haiku with no tool, hook, MCP server or saved session, the message then the files on stdin", async () => {
    const calls: Call[] = [];

    await judge("fix: a", ["a.ts", "b.ts"], deadlineIn(30_000), runner([CLEAN], calls));

    expect(calls.map((call) => call.argv)).toEqual([
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
      ],
    ]);
    expect(calls[0]?.options.stdin).toBe("Message:\nfix: a\n\nFiles:\na.ts\nb.ts");
  });

  test("keeps the process and check-event passages the message holds, whitespace aside; facts alone pass", async () => {
    expect(await judge(MESSAGE, [], deadlineIn(30_000), runner([REVIEW]))).toEqual({
      kind: "answered",
      faults: FAULTS,
    });
    expect(await judge(MESSAGE, [], deadlineIn(30_000), runner([CLEAN]))).toEqual({
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

    expect(
      await judge("fix: a\n\nReview of #333.", [], deadlineIn(30_000), runner([verbose])),
    ).toEqual({
      kind: "answered",
      faults: [{ kind: "process", quote: "Review of #333" }],
    });
  });

  test("asks once more after an answer it cannot read, never after an error exit", async () => {
    const unreadable = answer('{"verdict": "ok"}');
    const calls: Call[] = [];

    expect(
      await judge(MESSAGE, [], deadlineIn(30_000), runner([unreadable, REVIEW], calls)),
    ).toEqual({
      kind: "answered",
      faults: FAULTS,
    });
    expect(calls).toHaveLength(2);
    expect(await judge("m", [], deadlineIn(30_000), runner([unreadable]))).toEqual({
      kind: "failed",
      why: "claude -p exited 0 with no readable answer",
    });

    const failed: RunResult = { kind: "exited", code: 1, stdout: "", stderr: "" };
    const once: Call[] = [];

    expect(await judge("m", [], deadlineIn(30_000), runner([failed, REVIEW], once))).toEqual({
      kind: "failed",
      why: "claude -p exited 1 with no readable answer",
    });
    expect(once).toHaveLength(1);
  });

  test("a missing claude or a timeout gets no second ask", async () => {
    const calls: Call[] = [];

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
    const calls: Call[] = [];

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
