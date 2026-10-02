import type { EngineInterface, Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { TodoScan } from "../types/index.d.ts";
import { DEFAULT_MARKERS, displayText, formatAge, shortenStart, sourceLabel } from "./parse.ts";
import { type Host, repoRoot, scanRepo } from "./scan.ts";

const NO_SCAN: TodoScan | null = null;

const scanState = atom({ plugin: "todos", key: "scan" } as const, NO_SCAN);

const isVisible = atom({ plugin: "todos", key: "visible" } as const, false);

const COMMAND = "todos";

const GIT_TIMEOUT_MS = 20_000;

const MAX_ROWS = 8;

const SOURCE_WIDTH = 24;

// The band's border and its header and footer rows.
const BAND_CHROME_ROWS = 4;

function hostOf($: EngineInterface): Host {
  return {
    run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS }),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
  };
}

async function refresh($: EngineInterface, cwd: string): Promise<number | null> {
  const host = hostOf($);
  const root = await repoRoot(host, cwd);

  if (root === null) return null;
  const scan = await scanRepo(host, root, DEFAULT_MARKERS, await $.clock.now());
  const [failure, ...others] = scan.failures;

  if (failure !== undefined) {
    $.ui.toast(`todos: ${failure}${others.length > 0 ? ` (+${others.length} more)` : ""}`);
  }

  await update($, scanState, () => ({ scannedAt: scan.scannedAt, todos: scan.todos }));
  await update($, isVisible, () => scan.todos.length > 0);

  return scan.todos.length;
}

async function refreshOrToast($: EngineInterface, cwd: string): Promise<void> {
  try {
    await refresh($, cwd);
  } catch (error) {
    $.ui.toast(`todos: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function countText(count: number): string {
  if (count === 0) return "No TODOs in this repository.";

  return `${count} ${count === 1 ? "TODO" : "TODOs"} above the prompt.`;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: "Show this repository's TODOs above the prompt, newest first",
      });
    } catch (error) {
      $.ui.toast(
        `todos: /${COMMAND} is not available: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Not awaited: Claude Code holds the first prompt until session.start returns, and a scan blames every file it finds.
    if (e.isInteractive) void refreshOrToast($, e.cwd);

    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (await read($, isVisible)) await update($, isVisible, () => false);

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    try {
      const count = await refresh($, await $.session.cwd());

      return { text: count === null ? "Not inside a git repository." : countText(count) };
    } catch (error) {
      return { text: `todos: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const scan = await read($, scanState);

    if (
      e.props.hasSurvey ||
      scan === null ||
      scan.todos.length === 0 ||
      !(await read($, isVisible))
    ) {
      return next(e);
    }

    const { Box, Button, Text } = $.ui.resolve(e);

    const shown = scan.todos.slice(
      0,
      Math.max(1, Math.min(MAX_ROWS, e.props.maxRows - BAND_CHROME_ROWS)),
    );

    const labels = shown.map((todo) => shortenStart(sourceLabel(todo), SOURCE_WIDTH));
    const ages = shown.map((todo) => formatAge(scan.scannedAt - todo.authoredAt));
    const labelWidth = Math.max(...labels.map((label) => label.length));
    const ageWidth = Math.max(...ages.map((age) => age.length));
    const hiddenCount = scan.todos.length - shown.length;

    const footer = [
      hiddenCount > 0 ? `+${hiddenCount} more` : "",
      "hides on your next message",
      `/${COMMAND} reopens`,
    ]
      .filter((part) => part !== "")
      .join(" · ");

    const band = Box({
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 1,
      children: [
        Box({
          gap: 1,
          children: [
            Text({ bold: true, color: "cyan", children: "todos" }),
            Text({ dimColor: true, children: `· ${scan.todos.length}` }),
          ],
        }),
        ...shown.map((todo, index) =>
          Box({
            key: `todo-${index}`,
            gap: 1,
            children: [
              Text({ color: "cyan", children: String(index + 1).padStart(2) }),
              Box({
                width: labelWidth,
                flexShrink: 0,
                children: [Text({ dimColor: true, children: labels[index] ?? "" })],
              }),
              Box({
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                children: [Text({ wrap: "truncate-end", children: displayText(todo) })],
              }),
              Box({
                width: ageWidth,
                flexShrink: 0,
                children: [Text({ dimColor: true, children: ages[index] ?? "" })],
              }),
            ],
          }),
        ),
        Box({
          gap: 1,
          children: [
            Text({ dimColor: true, children: footer }),
            Button({
              key: "hide",
              label: "Hide",
              dimColor: true,
              onPress: () => update($, isVisible, () => false),
            }),
          ],
        }),
      ],
    });

    // The band is shared: what the mods after this one draw stays below the list.
    return Box({ flexDirection: "column", children: [band, await next(e)] });
  });
};
