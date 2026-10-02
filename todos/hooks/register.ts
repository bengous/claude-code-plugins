import type { EngineInterface, PluginOptions, Register } from "claude-code";
import { atom, read, update } from "claude-code";

import type { TodoScan } from "../types/index.d.ts";
import {
  addedTodos,
  DEFAULT_MARKERS,
  displayText,
  formatAge,
  isMine,
  isScannedPath,
  issueNumber,
  LIST_FILE,
  parseMarkers,
  shortenStart,
  sourceLabel,
} from "./parse.ts";
import { type Host, isExcludedPath, locate, repoRoot, type ScanResult, scanRepo } from "./scan.ts";

const NO_SCAN: TodoScan | null = null;

const scanState = atom({ plugin: "todos", key: "scan" } as const, NO_SCAN);

const isVisible = atom({ plugin: "todos", key: "visible" } as const, false);

const isMineOnly = atom({ plugin: "todos", key: "mineOnly" } as const, false);

const COMMAND = "todos";

const GIT_TIMEOUT_MS = 20_000;

const DEFAULT_ROWS = 8;

const MIN_SOURCE_WIDTH = 16;

const SOURCE_SHARE = 0.35;

// The band's border and its header and footer rows.
const BAND_CHROME_ROWS = 4;

type Settings = {
  readonly showOnStart: boolean;
  readonly rows: number;
  readonly markers: readonly string[];
  readonly mineOnly: boolean;
};

// Claude Code checks the options against plugin.json's userConfig and fills in its defaults before register runs.
function settingsOf(options: PluginOptions): Settings {
  return {
    showOnStart: options.show_on_start !== false,
    rows: Number(options.rows ?? DEFAULT_ROWS),
    markers: parseMarkers(String(options.markers ?? DEFAULT_MARKERS.join(","))),
    mineOnly: options.mine_only === true,
  };
}

function messageOf(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

function hostOf($: EngineInterface): Host {
  return {
    run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS }),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
  };
}

function kept(scan: ScanResult, rows: number): TodoScan {
  const mine = scan.todos.filter((todo) => isMine(todo, scan.userEmail));

  return {
    scannedAt: scan.scannedAt,
    root: scan.root,
    issueBase: scan.issueBase,
    total: scan.todos.length,
    mineTotal: mine.length,
    todos: scan.todos.slice(0, rows),
    mineTodos: mine.slice(0, rows),
  };
}

function countText(scan: TodoScan, mineOnly: boolean): string {
  if (scan.total === 0) return "No TODOs in this repository.";
  const counted = `${scan.total} ${scan.total === 1 ? "TODO" : "TODOs"} above the prompt`;

  return mineOnly ? `${counted}, ${scan.mineTotal} of them yours.` : `${counted}.`;
}

// Scans overlap when an edit lands during one: only the latest to start writes the band.
let latestScan = 0;

async function refresh(
  $: EngineInterface,
  settings: Settings,
  cwd: string,
  reveal: boolean,
): Promise<TodoScan | null> {
  const generation = ++latestScan;
  const host = hostOf($);
  const root = await repoRoot(host, cwd);

  if (root === null) return null;
  const scan = await scanRepo(host, root, settings.markers, await $.clock.now());
  const [failure, ...others] = scan.failures;

  if (failure !== undefined) {
    $.ui.toast(`${failure}${others.length > 0 ? ` (+${others.length} more)` : ""}`);
  }

  const state = kept(scan, settings.rows);

  if (generation === latestScan) await update($, scanState, () => state);

  if (reveal) await update($, isVisible, () => state.total > 0);

  return state;
}

async function refreshOrToast(
  $: EngineInterface,
  settings: Settings,
  cwd: string,
  reveal: boolean,
): Promise<void> {
  try {
    await refresh($, settings, cwd, reveal);
  } catch (error) {
    $.ui.toast(messageOf(error instanceof Error ? error : String(error)));
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options);
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: "Show this repository's TODOs above the prompt, newest first",
      });
    } catch (error) {
      $.ui.toast(
        `/${COMMAND} is not available: ${messageOf(error instanceof Error ? error : String(error))}`,
      );
    }

    await update($, isMineOnly, () => settings.mineOnly);

    // Not awaited: Claude Code holds the first prompt until session.start returns, and a scan blames every file it finds.
    if (e.isInteractive) void refreshOrToast($, settings, e.cwd, settings.showOnStart);

    return next(e);
  });

  // /clear, /resume and /branch reset $.state, and session.start does not fire again.
  on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
    await update($, isMineOnly, () => settings.mineOnly);
    void refreshOrToast($, settings, e.cwd, settings.showOnStart);

    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (await read($, isVisible)) await update($, isVisible, () => false);

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    try {
      const scan = await refresh($, settings, await $.session.cwd(), true);

      if (scan === null) return { text: "Not inside a git repository." };

      return { text: countText(scan, await read($, isMineOnly)) };
    } catch (error) {
      return { text: messageOf(error instanceof Error ? error : String(error)) };
    }
  });

  on("tool.call", { tool: ["Edit", "Write"] }, async ($, e, next) => {
    if (e.tool !== "Edit" && e.tool !== "Write") return next(e);
    const written = e.tool === "Write" ? e.content : e.new_string;

    const name = e.file_path.slice(
      Math.max(e.file_path.lastIndexOf("/"), e.file_path.lastIndexOf("\\")) + 1,
    );

    if (name !== LIST_FILE && !settings.markers.some((marker) => written.includes(marker)))
      return next(e);
    const located = await locate(hostOf($), e.file_path);

    if (located === null || !isScannedPath(located.path)) return next(e);
    const before = (await $.fs.exists(e.file_path)) ? await $.fs.read(e.file_path) : "";
    const result = await next(e);

    if ("deny" in result || result.isError === true) return result;
    const added = addedTodos(located.path, before, await $.fs.read(e.file_path), settings.markers);
    const [first, ...others] = added;

    if (
      first === undefined ||
      (located.path !== LIST_FILE && (await isExcludedPath(hostOf($), located.root, located.path)))
    )
      return result;
    const where = located.path === LIST_FILE ? located.path : `${located.path}:${first.line}`;

    $.ui.toast(
      `New ${first.marker} at ${where}: ${first.text === "" ? "(no description)" : first.text}${others.length > 0 ? ` (+${others.length} more)` : ""}`,
    );

    if ((await read($, scanState))?.root === located.root)
      void refreshOrToast($, settings, located.root, false);

    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const scan = await read($, scanState);

    if (e.props.hasSurvey || scan === null || scan.total === 0 || !(await read($, isVisible))) {
      return next(e);
    }

    const { Box, Button, Link, Text } = $.ui.resolve(e);
    const mineOnly = await read($, isMineOnly);
    const listed = mineOnly ? scan.mineTodos : scan.todos;
    const listedTotal = mineOnly ? scan.mineTotal : scan.total;

    const shown = listed.slice(
      0,
      Math.max(1, Math.min(settings.rows, e.props.maxRows - BAND_CHROME_ROWS)),
    );

    const labelLimit = Math.max(MIN_SOURCE_WIDTH, Math.floor(e.props.bodyColumns * SOURCE_SHARE));
    const labels = shown.map((todo) => shortenStart(sourceLabel(todo), labelLimit));
    const ages = shown.map((todo) => formatAge(scan.scannedAt - todo.authoredAt));
    const labelWidth = Math.max(0, ...labels.map((label) => label.length));
    const ageWidth = Math.max(0, ...ages.map((age) => age.length));
    const hiddenCount = listedTotal - shown.length;
    const count = mineOnly ? `${scan.mineTotal} of ${scan.total} yours` : `${scan.total}`;

    const footer = [
      hiddenCount > 0 ? `+${hiddenCount} more` : "",
      "hides on your next message",
      `/${COMMAND} reopens`,
    ]
      .filter((part) => part !== "")
      .join(" · ");

    const issueOf = (tag: string | null) => {
      const number = issueNumber(tag);

      if (number === null) return [];

      return [
        Box({
          flexShrink: 0,
          children: [
            scan.issueBase === null
              ? Text({ dimColor: true, children: `#${number}` })
              : Link({ href: `${scan.issueBase}/issues/${number}`, label: `#${number}` }),
          ],
        }),
      ];
    };

    const rows = shown.map((todo, index) =>
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
          ...issueOf(todo.tag),
          Box({
            width: ageWidth,
            flexShrink: 0,
            children: [Text({ dimColor: true, children: ages[index] ?? "" })],
          }),
        ],
      }),
    );

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
            Text({ dimColor: true, children: `· ${count}` }),
          ],
        }),
        ...(rows.length > 0
          ? rows
          : [Text({ dimColor: true, children: "None of these TODOs is yours." })]),
        Box({
          gap: 1,
          children: [
            Text({ dimColor: true, children: footer }),
            Button({
              key: "mine",
              label: mineOnly ? "All" : "Mine",
              dimColor: true,
              onPress: () => update($, isMineOnly, (value) => !value),
            }),
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
