import { describe, expect, test } from "bun:test";

import {
  claudeArgv,
  controlsNamed,
  conversation,
  lastReply,
  paneOf,
  parseLine,
  tidy,
} from "./field-test.ts";

const ESC = "\u001B";

/** A row of the griller pane as `tmux capture-pane -e` printed it, (b) focused. */
const CHOICES = `${ESC}[38;5;153m${ESC}[48;5;235m│${ESC}[39m ${ESC}[2m│${ESC}[0m${ESC}[48;5;235m ${ESC}[1m[ (a) ]${ESC}[0m${ESC}[48;5;235m ${ESC}[1;7m[ (b) ]${ESC}[0m${ESC}[48;5;235m   `;

describe("parseLine", () => {
  test("finds the reversed control, whatever the colors around it", () => {
    expect(parseLine(CHOICES)).toEqual({
      plain: "│ │ [ (a) ] [ (b) ]   ",
      reversed: [{ column: 12, text: "[ (b) ]" }],
    });
  });

  test("reads a 256-color index ending in 7 as a color, not as reverse video", () => {
    expect(parseLine(`${ESC}[48;5;237m❯ /griller:grill${ESC}[0m`).reversed).toEqual([]);
  });

  test("ends a reversed run at 27, at 0 and at a bare reset", () => {
    const line = `${ESC}[7mA${ESC}[27m ${ESC}[7mB${ESC}[0m ${ESC}[7mC${ESC}[m D`;

    expect(parseLine(line).reversed).toEqual([
      { column: 0, text: "A" },
      { column: 2, text: "B" },
      { column: 4, text: "C" },
    ]);
  });

  test("ignores a reversed run of blanks, the text cursor", () => {
    expect(parseLine(`❯ ${ESC}[7m ${ESC}[0m`).reversed).toEqual([]);
  });

  test("drops a hyperlink's OSC sequences, ended by ESC \\ or by BEL", () => {
    const link = `/work · ${ESC}]8;id=1;https://claude.ai/code${ESC}\\/rc${ESC}]8;;\u0007 ok`;

    expect(parseLine(link).plain).toBe("/work · /rc ok");
  });
});

describe("paneOf", () => {
  test("keeps the side right of the divider, a wide character in the chat notwithstanding", () => {
    const screen = [
      "chat                │ ✕",
      "● ❓ Q1 - Database? │ [ (a) ] [ (b) ]",
      "  Postgres          │ 0 of 1 answered",
      "─────────────────────────────────────",
    ];

    expect(paneOf(screen)).toEqual([" ✕", " [ (a) ] [ (b) ]", " 0 of 1 answered"]);
  });

  test("finds none when no divider runs down half the rows", () => {
    expect(paneOf(["❯ prompt", "a │ b", "", "status"])).toBeNull();
  });
});

describe("controlsNamed", () => {
  const screen = [
    "Q1 (a) Postgres",
    "[ (a) ] [ (b) ]",
    "[ Peek at Claude's ]",
    "",
    "[ Peek at Claude's ] ✕",
  ];

  test("finds a button by its bracketed label, never the same text in the chat", () => {
    expect(controlsNamed(screen, "(a)")).toEqual([{ row: 1, column: 0 }]);
  });

  test("lists every button with that label, top to bottom", () => {
    expect(controlsNamed(screen, "Peek at Claude's")).toEqual([
      { row: 2, column: 0 },
      { row: 4, column: 0 },
    ]);
  });

  test("falls back on the bare text for a control drawn without brackets", () => {
    expect(controlsNamed(screen, "✕")).toEqual([{ row: 4, column: 21 }]);
  });
});

/** Rows as Claude Code writes a transcript: meta rows, thinking and tool results are not said. */
const TRANSCRIPT = [
  { type: "mode" },
  {
    type: "user",
    message: {
      content:
        "<command-message>griller:grill</command-message>\n<command-name>/griller:grill</command-name>\n<command-args>the storage engine</command-args>",
    },
  },
  {
    type: "user",
    isMeta: true,
    message: { content: [{ type: "text", text: "Base directory for this skill" }] },
  },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }] } },
  {
    type: "assistant",
    message: { content: [{ type: "text", text: "❓ **Q1** - **Engine**\n\n➡️ (b)" }] },
  },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", content: "…" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "---" }] } },
  { type: "user", message: { content: "Grill answers:\nQ1: (b)" } },
  { type: "assistant", message: { content: [{ type: "text", text: "Noted: SQLite." }] } },
]
  .map((row) => JSON.stringify(row))
  .join("\n");

describe("conversation", () => {
  test("keeps what each side said, a command as typed, a tool call by its name", () => {
    expect(conversation(TRANSCRIPT)).toEqual([
      { by: "you", text: "/griller:grill the storage engine" },
      { by: "claude", text: "❓ **Q1** - **Engine**\n\n➡️ (b)" },
      { by: "claude", text: "[tool Read]" },
      { by: "claude", text: "---" },
      { by: "you", text: "Grill answers:\nQ1: (b)" },
      { by: "claude", text: "Noted: SQLite." },
    ]);
  });

  test("skips a last line the session is still writing", () => {
    expect(conversation(`${TRANSCRIPT}\n{"type":"assis`)).toHaveLength(6);
  });

  test("lastReply is what Claude said since the last message it received", () => {
    const said = conversation(TRANSCRIPT);

    expect(lastReply(said.slice(0, 4))).toEqual([
      "❓ **Q1** - **Engine**\n\n➡️ (b)",
      "[tool Read]",
      "---",
    ]);
    expect(lastReply(said)).toEqual(["Noted: SQLite."]);
  });
});

test("tidy trims each line and keeps one blank line between blocks", () => {
  expect(tidy(["a   ", "", "", "", "b ", "", ""])).toEqual(["a", "", "b"]);
});

test("claudeArgv names the session, the model and the debug log before the plugins", () => {
  expect(
    claudeArgv("/usr/bin/claude", {
      model: "sonnet",
      sessionId: "id-1",
      debugLog: "/tmp/field-test-x/debug.log",
      pluginDirs: ["/repo/griller", "/repo/todos"],
    }),
  ).toEqual([
    "/usr/bin/claude",
    "--permission-mode",
    "default",
    "--model",
    "sonnet",
    "--session-id",
    "id-1",
    "--debug-file",
    "/tmp/field-test-x/debug.log",
    "--plugin-dir",
    "/repo/griller",
    "--plugin-dir",
    "/repo/todos",
  ]);
});
