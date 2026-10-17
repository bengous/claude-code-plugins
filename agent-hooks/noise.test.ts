/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- the fixtures are Claude Code transcript lines, JSON of an open shape written as the harness writes it: a closed type would assert the schema the reader is meant to survive. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import type { NoiseReport } from "./noise.ts";
import { formatNoise, kitCommands, laneShares, measureNoise, readTranscript } from "./noise.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const NOW = Date.now();

const RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();

const OLD = new Date(NOW - 30 * DAY_MS).toISOString();

const SINCE = NOW - 7 * DAY_MS;

const KIT_STOP = "agent-hooks: lanes on the session scope";

const KIT_PRE_EDIT = 'bun "${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts" pre-edit';

const KIT_SESSION_START = 'bun "${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts" session-start';

const BLOCK_REASON = [
  "Stop validation failed:",
  "",
  "### lint",
  "a.ts:1:1: bad",
  "",
  "### test [packages/a]",
  "1 fail",
  "",
  "Fix the errors above before stopping.",
  "agent-hooks: no photo of /r, checking its whole dirty tree",
].join("\n");

function entry(fields: Record<string, unknown>, cwd = "/r"): string {
  return JSON.stringify({ cwd, sessionId: "s1", timestamp: RECENT, ...fields });
}

function hookRecord(attachment: Record<string, unknown>, timestamp = RECENT, cwd = "/r"): string {
  return entry({ type: "attachment", attachment, timestamp }, cwd);
}

function success(event: string, command: string, stdout: string, cwd = "/r"): string {
  return hookRecord(
    { type: "hook_success", hookEvent: event, hookName: event, command, stdout, exitCode: 0 },
    RECENT,
    cwd,
  );
}

function blocked(event: string, command: string, reason: string, cwd = "/r"): string {
  return hookRecord(
    {
      type: "hook_blocking_error",
      hookEvent: event,
      hookName: event,
      blockingError: { blockingError: reason, command },
    },
    RECENT,
    cwd,
  );
}

function toolResult(content: string, isError: boolean): string {
  return entry({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", is_error: isError, content }],
    },
  });
}

/** The lines of a transcript as a file stream yields them. */
async function* linesOf(lines: readonly string[]): AsyncGenerator<string> {
  yield* lines;
}

function prompt(cwd = "/r"): string {
  return entry({ type: "user", message: { role: "user", content: "hello" } }, cwd);
}

describe("readTranscript", () => {
  test("reads each output of the kit's hooks once, from its own records, and nothing of other hooks", async () => {
    const lines = [
      prompt(),
      success(
        "PreToolUse",
        KIT_PRE_EDIT,
        `${JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: {} },
          systemMessage: "agent-hooks: fixed and formatted a.ts before writing",
        })}\n`,
      ),
      hookRecord({
        type: "hook_system_message",
        hookEvent: "PreToolUse",
        content: "agent-hooks: fixed and formatted a.ts before writing",
      }),
      success(
        "PreToolUse",
        "~/.local/bin/agent-hooks pre-edit",
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "oxfmt failed" },
        }),
      ),
      success(
        "SessionStart",
        KIT_SESSION_START,
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: "take a worktree",
          },
        }),
      ),
      blocked("Stop", KIT_STOP, BLOCK_REASON),
      success(
        "Stop",
        KIT_STOP,
        JSON.stringify({ systemMessage: "agent-hooks: 3 blocks in a row" }),
      ),
      success("Stop", KIT_STOP, ""),
      toolResult("PreToolUse:Bash hook error: agent-hooks: a push to 'main' is refused", true),
      toolResult("PreToolUse:Bash hook error: Destructive command blocked", true),
      toolResult("x.ts:1: PreToolUse:Bash hook error: agent-hooks: quoted by a grep", false),
      success("SessionStart", "bun ~/x/session-archive.ts --hook", '{"systemMessage":"other"}'),
      success(
        "PreToolUse",
        'bun "$CLAUDE_PROJECT_DIR"/scripts/agent-hooks/cli.ts claude guardDestructive',
        '{"systemMessage":"another kit of the same name"}',
      ),
      blocked("Stop", 'bun "$CLAUDE_PROJECT_DIR"/.claude/hooks/stop-validate.ts', "drift"),
      "",
    ];

    const reading = await readTranscript(linesOf(lines), SINCE, kitCommands());

    expect(reading.injections).toEqual([
      {
        event: "PreToolUse",
        channel: "systemMessage",
        text: "agent-hooks: fixed and formatted a.ts before writing",
      },
      { event: "PreToolUse", channel: "additionalContext", text: "oxfmt failed" },
      { event: "SessionStart", channel: "additionalContext", text: "take a worktree" },
      { event: "Stop", channel: "block", text: BLOCK_REASON },
      { event: "Stop", channel: "systemMessage", text: "agent-hooks: 3 blocks in a row" },
      { event: "PreToolUse", channel: "block", text: "agent-hooks: a push to 'main' is refused" },
    ]);
    expect(reading.stops).toEqual(["blocked", "passed", "passed"]);
    expect(reading.cwds).toEqual(["/r"]);
  });

  test("a Stop or SubagentStop the harness cancelled or saw fail is neither a block nor a pass", async () => {
    const lines = [
      hookRecord({ type: "hook_cancelled", hookEvent: "Stop", command: KIT_STOP }),
      hookRecord({ type: "hook_non_blocking_error", hookEvent: "SubagentStop", command: KIT_STOP }),
      success("SubagentStop", KIT_STOP, ""),
    ];

    expect((await readTranscript(linesOf(lines), SINCE, kitCommands())).stops).toEqual([
      "cancelled",
      "errored",
      "passed",
    ]);
  });

  test("skips the records older than the window, and keeps every cwd the transcript names", async () => {
    const lines = [
      prompt("/old"),
      hookRecord(
        {
          type: "hook_blocking_error",
          hookEvent: "Stop",
          blockingError: { blockingError: "x", command: KIT_STOP },
        },
        OLD,
        "/old",
      ),
      success("Stop", KIT_STOP, "", "/r"),
    ];

    const reading = await readTranscript(linesOf(lines), SINCE, kitCommands());

    expect(reading.injections).toEqual([]);
    expect(reading.stops).toEqual(["passed"]);
    expect(reading.cwds).toEqual(["/old", "/r"]);
  });

  test("a line that is not JSON, or a record of another shape, is skipped", async () => {
    const lines = [
      '{"type":"hook_success" truncated',
      hookRecord({ type: "hook_success", hookEvent: "Stop" }),
      success("Stop", KIT_STOP, "{not json"),
    ];

    expect(await readTranscript(linesOf(lines), SINCE, kitCommands())).toEqual({
      cwds: ["/r"],
      injections: [],
      stops: ["passed"],
    });
  });
});

describe("kitCommands", () => {
  test("knows the kit by its subcommand or by a status message of its own hooks.json", () => {
    const kit = kitCommands();

    expect(kit(KIT_STOP)).toBeTrue();
    expect(kit(KIT_PRE_EDIT)).toBeTrue();
    expect(kit('bun "${CLAUDE_PLUGIN_ROOT}/agent-hooks.ts" pre-bash')).toBeTrue();
    expect(kit("~/.local/bin/agent-hooks stop --harness codex")).toBeTrue();
    expect(
      kit('bun "$CLAUDE_PROJECT_DIR"/scripts/agent-hooks/cli.ts claude guardDestructive'),
    ).toBeFalse();
    expect(kit("agent-hooks: something else")).toBeFalse();
  });
});

describe("laneShares", () => {
  test("gives each `###` section to its lane, and the kit's own lines to none", () => {
    const shares = laneShares(BLOCK_REASON);

    expect(shares).toEqual(
      new Map([
        [
          "(no lane)",
          "Stop validation failed:\n\n".length +
            "Fix the errors above before stopping.\n".length +
            "agent-hooks: no photo of /r, checking its whole dirty tree".length,
        ],
        ["lint", "### lint\na.ts:1:1: bad\n\n".length],
        ["test", "### test [packages/a]\n1 fail\n\n".length],
      ]),
    );
    expect([...shares.values()].reduce((sum, chars) => sum + chars, 0)).toBe(BLOCK_REASON.length);
  });
});

describe("laneShares, the kit's report format", () => {
  test("a `### ` line inside a lane's output stays with that lane: a heading follows the header or a blank line", () => {
    const text = [
      "Stop validation failed:",
      "",
      "### lint",
      "out",
      "### not a heading",
      "",
      "Fix the errors above before stopping.",
    ].join("\n");

    expect(laneShares(text).get("lint")).toBe("### lint\nout\n### not a heading\n\n".length);
    expect(laneShares(text).has("not a heading")).toBeFalse();
  });

  test("a `### ` line outside a report is no lane", () => {
    const text = "agent-hooks: 3 blocks in a row, letting the turn end\n\n### lint";

    expect(laneShares(text)).toEqual(new Map([["(no lane)", text.length]]));
  });

  test("the root label in front of a nested root's report is no lane", () => {
    const text = [
      "Stop validation failed:",
      "",
      "### lint",
      "x",
      "",
      "/r/packages/a:",
      "Stop validation failed:",
      "",
      "### test",
      "y",
    ].join("\n");

    expect(laneShares(text)).toEqual(
      new Map([
        ["(no lane)", "Stop validation failed:\n\n".length * 2 + "/r/packages/a:\n".length],
        ["lint", "### lint\nx\n\n".length],
        ["test", "### test\ny".length],
      ]),
    );
  });
});

describe("measureNoise", () => {
  let dir: string;
  let projects: string;
  let root: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-noise-"));
    projects = path.join(dir, "projects");
    root = path.join(dir, "root");
    mkdirSync(path.join(root, ".claude"), { recursive: true });
    writeFileSync(path.join(root, CONFIG_RELATIVE_PATH), "{}");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function transcript(relativePath: string, lines: readonly string[]): string {
    const file = path.join(projects, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join("\n")}\n`);

    return file;
  }

  test("sums the transcripts whose cwd lies in a root, subagents included, over the window", async () => {
    const inRoot = path.join(root, "gone", "worktree");
    transcript("-root/s1.jsonl", [
      prompt(inRoot),
      blocked("Stop", KIT_STOP, BLOCK_REASON, inRoot),
      success("Stop", KIT_STOP, "", inRoot),
    ]);
    transcript("-root/s1/subagents/agent-a1.jsonl", [
      success(
        "PreToolUse",
        KIT_PRE_EDIT,
        JSON.stringify({ systemMessage: "agent-hooks: fixed" }),
        root,
      ),
      success("SubagentStop", KIT_STOP, "", root),
    ]);
    transcript("-elsewhere/s2.jsonl", [
      prompt(path.join(dir, "elsewhere")),
      blocked("Stop", KIT_STOP, "x", path.join(dir, "elsewhere")),
    ]);
    const old = transcript("-root/s3.jsonl", [prompt(root), blocked("Stop", KIT_STOP, "y", root)]);
    utimesSync(old, new Date(NOW - 30 * DAY_MS), new Date(NOW - 30 * DAY_MS));

    expect(await measureNoise({ projectsDir: projects, days: 7, now: NOW })).toEqual({
      days: 7,
      read: 3,
      transcripts: 2,
      roots: 1,
      events: [
        {
          event: "PreToolUse",
          channel: "systemMessage",
          count: 1,
          chars: "agent-hooks: fixed".length,
        },
        { event: "Stop", channel: "block", count: 1, chars: BLOCK_REASON.length },
      ],
      lanes: [
        { lane: "(no lane)", count: 1, chars: laneShares(BLOCK_REASON).get("(no lane)") ?? 0 },
        { lane: "test", count: 1, chars: "### test [packages/a]\n1 fail\n\n".length },
        { lane: "lint", count: 1, chars: "### lint\na.ts:1:1: bad\n\n".length },
      ],
      stops: { passed: 2, blocked: 1, cancelled: 0, errored: 0 },
    });
  });

  test("streams each transcript: no file is read whole", async () => {
    const file = transcript("-root/s1.jsonl", [prompt(root), success("Stop", KIT_STOP, "", root)]);
    const reads = spyOn(fs, "readFileSync");

    try {
      expect((await measureNoise({ projectsDir: projects, days: 7, now: NOW })).stops.passed).toBe(
        1,
      );
      expect(reads.mock.calls.map(([read]) => read)).not.toContain(file);
    } finally {
      reads.mockRestore();
    }
  });

  test("no projects directory reads as no transcript", async () => {
    expect(
      (await measureNoise({ projectsDir: path.join(dir, "none"), days: 7, now: NOW })).read,
    ).toBe(0);
  });
});

describe("formatNoise", () => {
  test("prints aggregates only: one row per event and channel, the Stops, one row per lane", () => {
    const report: NoiseReport = {
      days: 7,
      read: 12,
      transcripts: 3,
      roots: 2,
      events: [
        { event: "PreToolUse", channel: "systemMessage", count: 174, chars: 12_345 },
        { event: "Stop", channel: "block", count: 27, chars: 45_678 },
      ],
      lanes: [{ lane: "gates", count: 20, chars: 40_000 }],
      stops: { passed: 120, blocked: 27, cancelled: 1, errored: 0 },
    };

    expect(formatNoise(report)).toBe(
      [
        "agent-hooks noise, the last 7 days",
        "transcripts: 12 read, 3 in 2 roots holding .claude/agent-hooks.jsonc",
        "",
        "event       channel        count  chars",
        "PreToolUse  systemMessage    174  12345",
        "Stop        block             27  45678",
        "",
        "Stops: 120 passed, 27 blocked, 1 cancelled, 0 errored",
        "",
        "lane   reports  chars",
        "gates       20  40000",
        "",
        "additionalContext and block reasons reach the agent's context; a systemMessage is shown to the user.",
        "",
      ].join("\n"),
    );
  });

  test("an empty table says so", () => {
    const report: NoiseReport = {
      days: 1,
      read: 0,
      transcripts: 0,
      roots: 0,
      events: [],
      lanes: [],
      stops: { passed: 0, blocked: 0, cancelled: 0, errored: 0 },
    };

    expect(formatNoise(report)).toContain("event  channel  count  chars\n(none)\n");
  });
});

describe("agent-hooks noise", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-noise-cli-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function noise(
    ...args: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "agent-hooks.ts"), "noise", ...args],
      {
        cwd: dir,
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { code, stdout, stderr };
  }

  test("reads the projects of CLAUDE_CONFIG_DIR over 7 days by default", async () => {
    const result = await noise();

    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("agent-hooks noise, the last 7 days\ntranscripts: 0 read");
  });

  test("--days takes a positive whole number", async () => {
    expect((await noise("--days", "2")).stdout).toStartWith("agent-hooks noise, the last 2 days\n");

    for (const days of ["0", "1.5", "x"]) {
      const result = await noise("--days", days);

      expect(result.code).toBe(2);
      expect(result.stderr).toBe(
        `agent-hooks: --days expects a positive whole number, not "${days}"\n`,
      );
    }
  });
});
