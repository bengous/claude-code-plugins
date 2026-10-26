import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BASELINE,
  countCommits,
  countDenials,
  countFlaky,
  countTranscripts,
  type Denial,
  isCiWait,
  isGitPush,
  isIsolationRefusal,
  isReleaseRefusal,
  isReviewFollowUp,
  isTypedDestructive,
  isTypedRelease,
  parseDenial,
  parseLine,
  readDenials,
  type Report,
  render,
  scanTranscripts,
  type TranscriptEvent,
  typedCommandOf,
} from "./friction-report.ts";
import { isoWeekOf, parseWeek, periodOf } from "./sample-review.ts";

const SCRIPT = join(import.meta.dir, "friction-report.ts");

const DAY_MS = 86_400_000;

function weekOf(text: string) {
  const week = parseWeek(text);

  if (week === null) throw new Error(`not a week: ${text}`);

  return week;
}

const W42 = periodOf(weekOf("2026-W42"));

const REFUSAL = [
  "<bash-stdout></bash-stdout><bash-stderr>the push to main was refused, nothing tagged:",
  "vellum: ./vellum changed since c206545, version still 0.17.1",
  "Bump each version in its plugin.json before main moves.",
  "error: failed to push some refs to 'github.com:bengous/claude-code-plugins.git'</bash-stderr>",
].join("\n");

const TEAMMATE_QUOTE =
  '<teammate-message teammate_id="s3-impl" summary="S3 PR opened">PR https://github.com/bengous/claude-code-plugins/pull/370 is open: release.ts bumps before it pushes, so the guard\'s "Bump each version in its plugin.json" no longer fires on a release.</teammate-message>';

interface LineOptions {
  readonly uuid?: string;
  readonly session?: string;
  readonly sidechain?: boolean;
}

function lineOf(
  type: string,
  at: string,
  content: string | readonly object[],
  { uuid, session = "s1", sidechain = false }: LineOptions = {},
): string {
  return JSON.stringify({
    type,
    uuid: uuid ?? null,
    sessionId: session,
    timestamp: at,
    isSidechain: sidechain,
    message: { role: type, content },
  });
}

function callLine(
  id: string,
  at: string,
  command: string,
  options: LineOptions & { readonly background?: boolean } = {},
): string {
  const input = options.background === true ? { command, run_in_background: true } : { command };

  return lineOf("assistant", at, [{ type: "tool_use", id, name: "Bash", input }], options);
}

function resultLine(
  id: string,
  at: string,
  text: string,
  isError: boolean,
  options: LineOptions = {},
): string {
  return lineOf(
    "user",
    at,
    [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }],
    options,
  );
}

function saidLine(at: string, text: string, options: LineOptions = {}): string {
  return lineOf("user", at, text, options);
}

function eventsOf(...lines: string[]): TranscriptEvent[] {
  return lines.flatMap((line) => parseLine(line)?.events ?? []);
}

describe("parseLine", () => {
  test("reads a Bash call with its command and whether it runs in the background", () => {
    expect(parseLine(callLine("t1", "2026-10-13T10:00:00Z", "gh run watch 1"))).toEqual({
      uuid: null,
      events: [
        {
          kind: "call",
          id: "t1",
          at: new Date("2026-10-13T10:00:00Z"),
          command: "gh run watch 1",
          background: false,
        },
      ],
    });

    expect(
      eventsOf(callLine("t2", "2026-10-13T10:00:00Z", "sleep 9", { background: true })),
    ).toMatchObject([{ kind: "call", background: true }]);
  });

  test("leaves out a call to another tool", () => {
    const line = lineOf("assistant", "2026-10-13T10:00:00Z", [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
      { type: "text", text: "gh run watch" },
    ]);

    expect(eventsOf(line)).toEqual([]);
  });

  test("reads a tool result, its text from a string or from text blocks, and whether it is an error", () => {
    const blocks = lineOf("user", "2026-10-13T10:01:00Z", [
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "first" },
          { type: "image", source: {} },
          { type: "text", text: "second" },
        ],
      },
    ]);

    expect(eventsOf(resultLine("t1", "2026-10-13T10:01:00Z", "refused", true))).toEqual([
      {
        kind: "result",
        id: "t1",
        at: new Date("2026-10-13T10:01:00Z"),
        text: "refused",
        isError: true,
      },
    ]);
    expect(eventsOf(blocks)).toMatchObject([{ text: "first\nsecond", isError: false }]);
  });

  test("reads what a main session's user said, with its session and uuid", () => {
    expect(
      parseLine(
        saidLine("2026-10-13T10:00:00Z", "<bash-input>git status</bash-input>", {
          uuid: "u1",
          session: "s9",
        }),
      ),
    ).toEqual({
      uuid: "u1",
      events: [
        {
          kind: "said",
          at: new Date("2026-10-13T10:00:00Z"),
          session: "s9",
          text: "<bash-input>git status</bash-input>",
        },
      ],
    });
  });

  test("reads no user message in a subagent's transcript, only its tool results", () => {
    expect(eventsOf(saidLine("2026-10-13T10:00:00Z", REFUSAL, { sidechain: true }))).toEqual([]);
    expect(
      eventsOf(resultLine("t1", "2026-10-13T10:00:00Z", "out", false, { sidechain: true })),
    ).toHaveLength(1);
  });

  test("reads nothing from a line with no timestamp or no message, or from JSON that is no object", () => {
    expect(parseLine(JSON.stringify({ type: "ai-title", sessionId: "s1" }))).toEqual({
      uuid: null,
      events: [],
    });
    expect(
      parseLine(JSON.stringify({ type: "user", uuid: "u2", timestamp: "2026-10-13T10:00:00Z" })),
    ).toEqual({
      uuid: "u2",
      events: [],
    });
    expect(parseLine("null")).toEqual({ uuid: null, events: [] });
    expect(parseLine("[1, 2]")).toEqual({ uuid: null, events: [] });
  });

  test("is null on a line that is not JSON", () => {
    expect(parseLine('{"type":"user","timest')).toBeNull();
  });
});

describe("isCiWait", () => {
  test.each([
    "gh run watch 123 --exit-status",
    "gh pr checks 12 --watch --interval 30",
    'until [ "$(gh pr view 12 --json state -q .state)" = MERGED ]; do sleep 5; done',
    "while gh run list --limit 1 | grep -q in_progress; do sleep 10; done",
    "gh run view 99 --json status; sleep 60",
    "sleep 120 && gh pr view 12 --json statusCheckRollup",
    "gh run list --limit 1\nsleep 30",
  ])("%p waits", (command) => {
    expect(isCiWait(command)).toBe(true);
  });

  test.each([
    "gh pr view 12 --json state",
    "gh pr checks 12",
    "gh pr checks 12 | grep fail; echo --watch",
    "sleep 5",
    "bun test --watch",
  ])("%p does not", (command) => {
    expect(isCiWait(command)).toBe(false);
  });
});

describe("isGitPush", () => {
  test.each([
    "git push origin dev",
    "git -C /home/x/repo push --force-with-lease origin feature/a",
    "cd repo && git push -u origin feature/a 2>&1 | tail -3",
  ])("%p pushes", (command) => {
    expect(isGitPush(command)).toBe(true);
  });

  test.each(["git status", "git log --oneline origin/dev", "echo git pushes nothing"])(
    "%p does not",
    (command) => {
      expect(isGitPush(command)).toBe(false);
    },
  );
});

describe("commands typed with !", () => {
  test("reads the command between the bash-input tags", () => {
    expect(typedCommandOf("<bash-input> git branch -D a b</bash-input>")).toBe("git branch -D a b");
    expect(typedCommandOf("<bash-input>cd x\ngit status</bash-input>")).toBe("cd x\ngit status");
  });

  test("is null for a message that does not open with the tags", () => {
    expect(typedCommandOf("the regex <bash-input>(.*?)</bash-input> reads it")).toBeNull();
    expect(typedCommandOf("<bash-stdout>ok</bash-stdout>")).toBeNull();
  });

  test.each([
    ["release-plugins", true, false],
    ["bun ./scripts/release.ts", true, false],
    ["git branch -D feature/a", false, true],
    ["git push origin --delete feature/a", false, true],
    ["git push --force-with-lease origin feature/a", false, true],
    ["git push origin feature/a:dev", false, true],
    ["gh stack merge 255 --squash --yes", false, true],
    ["git status", false, false],
    ["git push origin feature/a", false, false],
  ])("%p: release %p, destructive %p", (command, release, destructive) => {
    expect(isTypedRelease(command)).toBe(release);
    expect(isTypedDestructive(command)).toBe(destructive);
  });
});

describe("isReleaseRefusal", () => {
  test("holds for the guard's refusal of a push to this repository", () => {
    expect(isReleaseRefusal(REFUSAL)).toBe(true);
    expect(isReleaseRefusal(`<pasted_content id="a">\n${REFUSAL}\n</pasted_content>`)).toBe(true);
  });

  test("not for the guard run alone, with no push in it", () => {
    expect(
      isReleaseRefusal(
        "vellum: ./vellum changed since c206545, version still 0.17.1\nBump each version in its plugin.json before main moves.",
      ),
    ).toBe(false);
  });

  test("not for a message that names the guard and links a pull request, with no failed push", () => {
    expect(isReleaseRefusal(TEAMMATE_QUOTE)).toBe(false);
    expect(isReleaseRefusal(TEAMMATE_QUOTE.replace(/^<teammate-message[^>]*>/u, ""))).toBe(false);
  });

  test.each([
    `<task-notification>\n<result>${REFUSAL}</result>`,
    `<teammate-message teammate_id="s3-impl">${REFUSAL}</teammate-message>`,
    `<agent-message from="s3-impl">${REFUSAL}</agent-message>`,
    `Another Claude session sent a message:\n${REFUSAL}`,
  ])("not for an agent's message that quotes a whole refusal: %p", (text) => {
    expect(isReleaseRefusal(text)).toBe(false);
  });
});

describe("isIsolationRefusal", () => {
  test.each([
    "This agent is isolated in the worktree /repo/.claude/worktrees/a, but this command runs rg",
    "<tool_use_error>This session is isolated in the worktree /repo/.claude/worktrees/a</tool_use_error>",
    "The working-directory isolation context for this agent was lost, so this command would run",
    "inside a construct too complex to verify, so what it runs cannot be shown not to be git",
  ])("holds for the error %p", (text) => {
    expect(isIsolationRefusal(text, true)).toBe(true);
  });

  test("not for a result that quotes one, a grep of transcripts", () => {
    expect(isIsolationRefusal("12: This agent is isolated in the worktree /a", false)).toBe(false);
  });

  test("not for another error", () => {
    expect(isIsolationRefusal("Exit code 1", true)).toBe(false);
  });
});

describe("isReviewFollowUp", () => {
  test.each([
    "fix(agent-hooks): provenance answers the review of #358",
    "fix(agent-hooks): provenance answers the second review of #358",
    "fix(vellum): the review's findings on the grill",
    "fix(x): answers the review",
  ])("%p is one", (subject) => {
    expect(isReviewFollowUp(subject)).toBe(true);
  });

  test.each(["feat(vellum): the review page", "fix(x): reviewed paths", "chore(x): 1.2.0, review"])(
    "%p is not",
    (subject) => {
      expect(isReviewFollowUp(subject)).toBe(false);
    },
  );
});

describe("countTranscripts", () => {
  test("counts a CI wait in the week it was made, its foreground time up to its result", () => {
    const counts = countTranscripts(
      eventsOf(
        callLine("a", "2026-10-13T10:00:00Z", "gh run watch 1"),
        resultLine("a", "2026-10-13T10:01:30Z", "ok", false),
        callLine("b", "2026-10-18T23:59:00Z", "gh pr checks 3 --watch"),
        resultLine("b", "2026-10-19T00:01:00Z", "ok", false),
        callLine("c", "2026-10-11T23:59:00Z", "gh run watch 2"),
        resultLine("c", "2026-10-12T00:10:00Z", "ok", false),
        callLine("d", "2026-10-14T10:00:00Z", "gh run watch 4", { background: true }),
        resultLine("d", "2026-10-14T10:00:01Z", "started", false),
        callLine("e", "2026-10-15T10:00:00Z", "gh run watch 5"),
        callLine("f", "2026-10-15T11:00:00Z", "gh pr view 5"),
        resultLine("f", "2026-10-15T12:00:00Z", "OPEN", false),
      ),
      W42,
    );

    expect(counts.ciWaits).toEqual({ calls: 4, foregroundMs: 90_000 + 120_000 });
  });

  test("pairs a result read before its call", () => {
    const [call, result] = eventsOf(
      callLine("a", "2026-10-13T10:00:00Z", "gh run watch 1"),
      resultLine("a", "2026-10-13T10:00:10Z", "ok", false),
    );

    if (call === undefined || result === undefined) throw new Error("no events");

    expect(countTranscripts([result, call], W42).ciWaits).toEqual({
      calls: 1,
      foregroundMs: 10_000,
    });
  });

  test("counts git pushes like CI waits", () => {
    const counts = countTranscripts(
      eventsOf(
        callLine("a", "2026-10-13T10:00:00Z", "git push origin dev"),
        resultLine("a", "2026-10-13T10:00:45Z", "ok", false),
      ),
      W42,
    );

    expect(counts.pushes).toEqual({ calls: 1, foregroundMs: 45_000 });
    expect(counts.ciWaits.calls).toBe(0);
  });

  test("counts one release refusal per session", () => {
    const counts = countTranscripts(
      eventsOf(
        saidLine("2026-10-13T10:00:00Z", REFUSAL, { session: "s1" }),
        saidLine("2026-10-13T10:05:00Z", REFUSAL, { session: "s1" }),
        saidLine("2026-10-14T10:00:00Z", REFUSAL, { session: "s2" }),
        saidLine("2026-10-19T10:00:00Z", REFUSAL, { session: "s3" }),
        saidLine("2026-10-15T10:00:00Z", TEAMMATE_QUOTE, { session: "s4" }),
        resultLine("x", "2026-10-15T10:00:00Z", REFUSAL, false),
      ),
      W42,
    );

    expect(counts.releaseRefusals).toBe(2);
  });

  test("counts the commands typed with !, the releases and the destructive ones among them", () => {
    const counts = countTranscripts(
      eventsOf(
        saidLine("2026-10-13T10:00:00Z", "<bash-input>release-plugins</bash-input>"),
        saidLine("2026-10-13T10:01:00Z", "<bash-input> git branch -D a</bash-input>"),
        saidLine("2026-10-13T10:02:00Z", "<bash-input>git status</bash-input>"),
        saidLine("2026-10-13T10:03:00Z", "<bash-stdout>On branch dev</bash-stdout>"),
        saidLine("2026-10-13T10:04:00Z", "please run git branch -D a"),
        saidLine("2026-10-20T10:00:00Z", "<bash-input>git push origin --delete b</bash-input>"),
      ),
      W42,
    );

    expect(counts.typed).toEqual({ total: 3, releases: 1, destructive: 1 });
  });

  test("counts the isolation refusals of the week, errors only", () => {
    const refusal = "This agent is isolated in the worktree /repo/.claude/worktrees/a";

    const counts = countTranscripts(
      eventsOf(
        resultLine("a", "2026-10-13T10:00:00Z", refusal, true),
        resultLine("b", "2026-10-13T10:00:00Z", refusal, false),
        resultLine("c", "2026-10-19T00:00:00Z", refusal, true),
        resultLine("d", "2026-10-12T00:00:00Z", refusal, true, { sidechain: true }),
      ),
      W42,
    );

    expect(counts.isolationRefusals).toBe(2);
  });
});

describe("scanTranscripts", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "friction-report-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function write(path: string, lines: readonly string[], modified?: Date): void {
    const file = join(root, path);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join("\n")}\n`);

    if (modified !== undefined) utimesSync(file, modified, modified);
  }

  test("reads this repository's projects and their subagents, each event once, and counts what it cannot read", () => {
    const refusal = "This agent is isolated in the worktree /a";

    write("-home-x-Work-claude-code-plugins/s1.jsonl", [
      resultLine("a", "2026-10-13T10:00:00Z", refusal, true, { uuid: "u1" }),
      "{not json",
    ]);
    write("-home-x-Work-claude-code-plugins/s1/subagents/agent-1.jsonl", [
      resultLine("b", "2026-10-13T10:00:00Z", refusal, true, { uuid: "u2", sidechain: true }),
    ]);
    write("-home-x-Work-claude-code-plugins--claude-worktrees-w/s2.jsonl", [
      resultLine("a", "2026-10-13T10:00:00Z", refusal, true, { uuid: "u1" }),
      resultLine("c", "2026-10-13T11:00:00Z", refusal, true),
    ]);
    write("-home-x-Work-other/s3.jsonl", [resultLine("d", "2026-10-13T10:00:00Z", refusal, true)]);
    write("-home-x-Work-claude-code-plugins/notes.txt", [refusal]);

    const scan = scanTranscripts(root, W42);

    expect(scan.files).toBe(3);
    expect(scan.unreadable).toBe(1);
    expect(scan.counts.isolationRefusals).toBe(3);
  });

  test("skips a transcript last written before the week began", () => {
    const refusal = "This agent is isolated in the worktree /a";

    write(
      "-home-x-Work-claude-code-plugins/old.jsonl",
      [resultLine("a", "2026-10-13T10:00:00Z", refusal, true)],
      new Date("2026-10-11T00:00:00Z"),
    );
    write("-home-x-Work-claude-code-plugins/new.jsonl", [
      resultLine("b", "2026-10-13T10:00:00Z", refusal, true),
    ]);

    const scan = scanTranscripts(root, W42);

    expect(scan.files).toBe(1);
    expect(scan.counts.isolationRefusals).toBe(1);
  });
});

function denial(ts: string, cwd: string, reason: string): Denial {
  return { at: new Date(ts), cwd, reason };
}

describe("denials", () => {
  test("parseDenial reads the hook's line, its local time as an instant", () => {
    expect(
      parseDenial(
        JSON.stringify({
          ts: "2026-10-13T01:30:00+02:00",
          session: "s1",
          cwd: "/home/x/Work/claude-code-plugins",
          tool: "Bash",
          command: "git branch -D a",
          reason: "[Git Destructive]",
        }),
      ),
    ).toEqual(
      denial("2026-10-12T23:30:00Z", "/home/x/Work/claude-code-plugins", "[Git Destructive]"),
    );
  });

  test.each([
    "{bad",
    "null",
    JSON.stringify({ ts: "2026-10-13T10:00:00Z", cwd: "/a" }),
    JSON.stringify({ ts: "x", cwd: "/a", reason: "r" }),
  ])("parseDenial is null for %p", (line) => {
    expect(parseDenial(line)).toBeNull();
  });

  test("countDenials keeps the week's denials in this repository's checkouts, by reason, the most frequent first", () => {
    const counts = countDenials(
      [
        denial("2026-10-13T10:00:00Z", "/home/x/Work/claude-code-plugins", "[Self-Modification]"),
        denial(
          "2026-10-13T11:00:00Z",
          "/home/x/Work/claude-code-plugins/.claude/worktrees/a",
          "[Git Destructive]",
        ),
        denial(
          "2026-10-14T11:00:00Z",
          "/home/x/Work/claude-code-plugins.wt/b",
          "[Git Destructive]",
        ),
        denial("2026-10-14T12:00:00Z", "/home/x/dotfiles", "[Git Destructive]"),
        denial("2026-10-19T00:00:00Z", "/home/x/Work/claude-code-plugins", "[Git Destructive]"),
        denial(
          "2026-10-15T12:00:00Z",
          "/home/x/Work/claude-code-plugins",
          "Classifier unavailable",
        ),
      ],
      W42,
      2,
    );

    expect(counts).toEqual({
      total: 4,
      byReason: [
        ["[Git Destructive]", 2],
        ["Classifier unavailable", 1],
        ["[Self-Modification]", 1],
      ],
      unreadable: 2,
    });
  });

  test("readDenials names a missing log instead of counting zero", () => {
    expect(readDenials(join(tmpdir(), "friction-report-no-such-log.jsonl"), W42)).toEqual({
      kind: "failed",
      why: `no denial log at ${join(tmpdir(), "friction-report-no-such-log.jsonl")}`,
    });
  });
});

describe("countFlaky", () => {
  test("counts the issues opened in the week and the comments posted in it", () => {
    expect(
      countFlaky(
        [
          {
            createdAt: new Date("2026-10-13T10:00:00Z"),
            comments: [new Date("2026-10-14T10:00:00Z"), new Date("2026-10-20T10:00:00Z")],
          },
          {
            createdAt: new Date("2026-09-30T10:00:00Z"),
            comments: [new Date("2026-10-15T10:00:00Z"), new Date("2026-10-16T10:00:00Z")],
          },
        ],
        W42,
      ),
    ).toEqual({ opened: 1, commented: 3 });
  });
});

describe("countCommits", () => {
  test("counts the review follow-ups and the version bumps among the subjects", () => {
    expect(
      countCommits([
        "fix(agent-hooks): provenance answers the review of #358",
        "chore(vellum): 0.17.9, the code and tests follow oxlint 1.88",
        "chore(deps): update yaml to 2.9.1",
        "feat(x): y",
      ]),
    ).toEqual({ landed: 4, reviewFollowUps: 1, versionBumps: 1 });
  });
});

describe("BASELINE", () => {
  test("spans as many days as its window, both ends included", () => {
    expect((Date.parse(BASELINE.through) - Date.parse(BASELINE.from)) / DAY_MS + 1).toBe(
      BASELINE.days,
    );
  });
});

describe("render", () => {
  const report: Report = {
    period: W42,
    ref: "origin/dev",
    head: "405e6c8cabcdef",
    transcripts: {
      files: 12,
      unreadable: 0,
      counts: {
        releaseRefusals: 1,
        ciWaits: { calls: 140, foregroundMs: 2.5 * 3_600_000 },
        pushes: { calls: 30, foregroundMs: 1_800_000 },
        typed: { total: 9, releases: 2, destructive: 3 },
        isolationRefusals: 40,
      },
    },
    denials: {
      kind: "found",
      value: {
        total: 3,
        byReason: [
          ["[Git Destructive]", 2],
          ["Classifier unavailable", 1],
        ],
        unreadable: 0,
      },
    },
    flaky: { kind: "found", value: { opened: 1, commented: 4 } },
    commits: { landed: 80, reviewFollowUps: 6, versionBumps: 12 },
  };

  test("heads the report with the week, its sources and the baseline's window", () => {
    const [title, sources, baseline] = render(report).split("\n");

    expect(title).toBe("friction-report 2026-W42: 2026-10-12T00:00Z..2026-10-19T00:00Z");
    expect(sources).toBe(
      "sources: 12 transcript files, 80 commits landed on origin/dev (405e6c8c)",
    );
    expect(baseline).toBe(
      "baseline: the friction audit, 2026-09-21..2026-10-19 (29 days), per 7 days",
    );
  });

  test.each([
    [/^release refusals +1 +1\.0$/mu],
    [/^agent CI waits +140 +118\.3$/mu],
    [/^ {2}foreground hours +2\.50 +2\.22$/mu],
    [/^agent git pushes +30 +-$/mu],
    [/^ {2}foreground hours +0\.50 +-$/mu],
    [/^! commands typed +9 +-$/mu],
    [/^ {2}releases +2 +2\.7$/mu],
    [/^ {2}destructive git +3 +4\.1$/mu],
    [/^worktree isolation refusals +40 +79\.4$/mu],
    [/^classifier denials +3 +-$/mu],
    [/^flaky issues opened +1 +-$/mu],
    [/^flaky issues commented +4 +-$/mu],
    [/^review follow-up commits +6 +17\.9$/mu],
    [/^version bump commits +12 +15\.4$/mu],
    [
      /^classifier denials by reason:\n {2}2 {2}\[Git Destructive\]\n {2}1 {2}Classifier unavailable$/mu,
    ],
  ])("prints %p", (line) => {
    expect(render(report)).toMatch(line);
  });

  test("aligns the counters in columns", () => {
    const lines = render(report).split("\n").slice(4, 19);
    const widths = new Set(lines.map((line) => line.length));

    expect(widths.size).toBe(1);
  });

  test("prints ? for what could not be asked, and says why under the table", () => {
    const out = render({
      ...report,
      transcripts: { ...report.transcripts, unreadable: 2 },
      denials: { kind: "failed", why: "no denial log at /x" },
      flaky: { kind: "failed", why: "gh: not logged in" },
    });

    expect(out).toMatch(/^classifier denials +\? +-$/mu);
    expect(out).toMatch(/^flaky issues opened +\? +-$/mu);
    expect(out).not.toContain("by reason");
    expect(out).toContain("transcripts: 2 lines left out, not JSON objects");
    expect(out).toContain("denials: no denial log at /x");
    expect(out).toContain("flaky issues: gh failed: gh: not logged in");
  });

  test("says how many denial lines it left out", () => {
    const out = render({
      ...report,
      denials: { kind: "found", value: { total: 0, byReason: [], unreadable: 1 } },
    });

    expect(out).toContain("denials: 1 line left out, not denials");
    expect(out).not.toContain("by reason");
  });
});

function gitEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

describe("the script", () => {
  let root = "";

  let repo = "";

  let bin = "";

  let projects = "";

  let log = "";

  function git(args: readonly string[], env: Record<string, string> = {}): void {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...gitEnv(), ...env },
    });

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }

  function commit(date: string, subject: string): void {
    git(["commit", "-q", "--allow-empty", "-m", subject], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  }

  function fakeGh(script: string): void {
    writeFileSync(join(bin, "gh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "gh"), 0o755);
  }

  function run(...args: string[]) {
    const result = Bun.spawnSync(
      [
        process.execPath,
        SCRIPT,
        "--ref",
        "main",
        "--projects-dir",
        projects,
        "--denial-log",
        log,
        ...args,
      ],
      {
        cwd: repo,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...gitEnv(), PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      },
    );

    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "friction-report-"));
    repo = join(root, "repo");
    bin = join(root, "bin");
    projects = join(root, "projects");
    log = join(root, "permission-denied.jsonl");

    for (const dir of [repo, bin, join(projects, "-home-x-Work-claude-code-plugins")]) {
      mkdirSync(dir, { recursive: true });
    }

    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Friction test"]);
    git(["config", "user.email", "friction@example.test"]);
    git(["config", "commit.gpgsign", "false"]);
    commit("2026-10-06T10:00:00Z", "fix(a): answers the review of #1, the week before");
    commit("2026-10-13T10:00:00Z", "fix(a): answers the review of #2");
    commit("2026-10-14T10:00:00Z", "chore(a): 1.2.0, the parser");
    commit("2026-10-15T10:00:00Z", "feat(a): parser");

    writeFileSync(
      join(projects, "-home-x-Work-claude-code-plugins", "s1.jsonl"),
      [
        callLine("a", "2026-10-13T10:00:00Z", "gh run watch 1 --exit-status"),
        resultLine("a", "2026-10-13T10:30:00Z", "ok", false),
        saidLine("2026-10-14T09:00:00Z", "<bash-input>release-plugins</bash-input>"),
        saidLine("2026-10-14T09:01:00Z", REFUSAL),
        saidLine("2026-10-14T09:02:00Z", TEAMMATE_QUOTE, { session: "lead" }),
        resultLine(
          "b",
          "2026-10-15T10:00:00Z",
          "This session is isolated in the worktree /w",
          true,
        ),
      ].join("\n"),
    );

    writeFileSync(
      log,
      `${[
        JSON.stringify({
          ts: "2026-10-13T12:00:00+02:00",
          cwd: "/home/x/Work/claude-code-plugins",
          reason: "[Git Destructive]",
        }),
        JSON.stringify({
          ts: "2026-10-13T12:00:00+02:00",
          cwd: "/home/x/dotfiles",
          reason: "[Git Destructive]",
        }),
      ].join("\n")}\n`,
    );

    fakeGh(
      [
        `printf '%s\\n' "$@" > "${join(root, "gh-args")}"`,
        `printf '%s\\n' '[{"createdAt":"2026-10-13T08:00:00Z","comments":["2026-10-14T08:00:00Z","2026-10-01T08:00:00Z"]}]'`,
      ].join("\n"),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("reports a week from its transcripts, its denial log, its commits and its flaky issues", () => {
    const { code, out, err } = run("--week", "2026-W42");

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("sources: 1 transcript file, 3 commits landed on main");

    for (const line of [
      /^release refusals +1 /mu,
      /^agent CI waits +1 /mu,
      /^ {2}foreground hours +0\.50 /mu,
      /^ {2}releases +1 /mu,
      /^worktree isolation refusals +1 /mu,
      /^classifier denials +1 /mu,
      /^flaky issues opened +1 /mu,
      /^flaky issues commented +1 /mu,
      /^review follow-up commits +1 /mu,
      /^version bump commits +1 /mu,
    ]) {
      expect(out).toMatch(line);
    }
  });

  test("asks gh for the flaky issues in every state, closed ones included", () => {
    expect(run("--week", "2026-W42").code).toBe(0);

    const asked = readFileSync(join(root, "gh-args"), "utf8").trimEnd().split("\n");

    expect(asked.slice(0, 2)).toEqual(["issue", "list"]);
    expect(asked.join(" ")).toContain("--label flaky");
    expect(asked.join(" ")).toContain("--state all");
    expect(asked.join(" ")).toContain("--json createdAt,comments");
  });

  test("says so, and reports all the same, when gh cannot be asked", () => {
    fakeGh(`echo 'gh: not logged in' >&2; exit 1`);

    const { code, out } = run("--week", "2026-W42");

    expect(code).toBe(0);
    expect(out).toMatch(/^flaky issues opened +\? /mu);
    expect(out).toContain("flaky issues: gh failed: gh: not logged in");
    expect(out).toMatch(/^version bump commits +1 /mu);
  });

  test("names a missing denial log", () => {
    rmSync(log);

    const { code, out } = run("--week", "2026-W42");

    expect(code).toBe(0);
    expect(out).toContain(`denials: no denial log at ${log}`);
  });

  test("without --week, reports the last complete week", () => {
    const aWeekAgo = new Date(Date.now() - 7 * DAY_MS);

    commit(aWeekAgo.toISOString(), "chore(b): 2.0.0, a week ago");
    commit(new Date().toISOString(), "chore(b): 2.0.1, just now");

    const { code, out } = run();
    const period = periodOf(isoWeekOf(aWeekAgo));
    const fixtureBump = new Date("2026-10-14T10:00:00Z");
    const bumps = 1 + (fixtureBump >= period.from && fixtureBump < period.to ? 1 : 0);

    expect(code).toBe(0);
    expect(out).toContain(`friction-report ${isoWeekOf(aWeekAgo)}:`);
    expect(out).toMatch(new RegExp(`^version bump commits +${bumps} `, "mu"));
  });

  test.each([
    [["--week", "2026-42"], "--week"],
    [["--week", "2025-W53"], "--week"],
    [["--unknown"], "Usage"],
    [["stray"], "Usage"],
  ])("refuses %p as a usage error", (args, mention) => {
    const { code, err } = run(...args);

    expect(code).toBe(2);
    expect(err).toContain(mention);
  });

  test("fails with git's reason on a ref it cannot read", () => {
    const { code, err, out } = run("--week", "2026-W42", "--ref", "nowhere");

    expect(code).toBe(1);
    expect(err).toContain("nowhere");
    expect(out).toBe("");
  });

  test("fails on a projects directory that does not exist", () => {
    const { code, err } = run("--week", "2026-W42", "--projects-dir", join(root, "none"));

    expect(code).toBe(1);
    expect(err).toContain("friction-report:");
  });
});
