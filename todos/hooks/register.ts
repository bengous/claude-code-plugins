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
  pickedTodos,
  promptText,
  shortenStart,
  sourceLabel,
  todoId,
} from "./parse.ts";
import { type Host, isExcludedPath, locate, repoRoot, type ScanResult, scanRepo } from "./scan.ts";

const NO_SCAN: TodoScan | null = null;

const scanState = atom({ plugin: "todos", key: "scan" } as const, NO_SCAN);

const isVisible = atom({ plugin: "todos", key: "visible" } as const, false);

const isMineOnly = atom({ plugin: "todos", key: "mineOnly" } as const, false);

const windowOffset = atom({ plugin: "todos", key: "offset" } as const, 0);

const NOTHING_PICKED: readonly string[] = [];

const pickedIds = atom({ plugin: "todos", key: "picked" } as const, NOTHING_PICKED);

const COMMAND = "todos";

const GIT_TIMEOUT_MS = 20_000;

const DEFAULT_ROWS = 8;

// $.state refuses a value over 4,194,304 characters, and a TODO takes a few hundred.
const KEPT_TODOS = 500;

const MIN_SOURCE_WIDTH = 16;

const SOURCE_SHARE = 0.35;

// The band's border and its header and footer rows.
const BAND_CHROME_ROWS = 4;

// The band's top border and its header.
const LIST_FIRST_ROW = 2;

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
    rows: Math.floor(Number(options.rows ?? DEFAULT_ROWS)),
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

function kept(scan: ScanResult): TodoScan {
  const mine = scan.todos.filter((todo) => isMine(todo, scan.userEmail));

  return {
    scannedAt: scan.scannedAt,
    root: scan.root,
    issueBase: scan.issueBase,
    total: scan.todos.length,
    mineTotal: mine.length,
    todos: scan.todos.slice(0, KEPT_TODOS),
    mineTodos: mine.slice(0, KEPT_TODOS),
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

  const state = kept(scan);

  if (generation === latestScan) {
    await update($, scanState, () => state);
    await update($, pickedIds, (ids) => pickedTodos(state, ids).map((todo) => todoId(todo)));
  }

  if (reveal) {
    await update($, windowOffset, () => 0);
    await update($, isVisible, () => state.total > 0);
  }

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

function windowStart(offset: number, count: number, windowRows: number): number {
  return Math.max(0, Math.min(offset, count - windowRows));
}

async function showClaude($: EngineInterface): Promise<void> {
  const scan = await read($, scanState);

  if (scan === null) return;
  const todos = pickedTodos(scan, await read($, pickedIds));

  if (todos.length === 0) return;
  const root = (await $.session.cwd()) === scan.root ? null : scan.root;
  const box = await $.prompt.read();
  const before = box.text.slice(0, box.cursor);

  // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- $.prompt.fill writes the prompt box; it is no Array.prototype.fill
  const filled = await $.prompt.fill({
    text: `${before === "" || before.endsWith("\n") ? "" : "\n"}${promptText(todos, root)}`,
    mode: "insert",
  });

  if (!filled.isFilled) {
    $.ui.toast(
      `The prompt box did not take the TODOs${filled.refusal === undefined ? "" : ` (${filled.refusal})`}.`,
    );

    return;
  }

  await update($, pickedIds, () => NOTHING_PICKED);
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options);
  // A scroll event's bodyRows is not the band's maxRows, so the scroll hook clamps to the window the band last drew.
  let drawnRows = settings.rows;

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

  on("ui.scroll", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.origin.kind !== "person" || !(await read($, isVisible))) return next(e);

    // Only in a band that fits its window is the pointer's row the tree's row.
    if (
      e.pointer !== undefined &&
      e.contentRows <= e.bodyRows &&
      (e.pointer.row < LIST_FIRST_ROW || e.pointer.row >= LIST_FIRST_ROW + drawnRows)
    )
      return next(e);
    const scan = await read($, scanState);

    if (scan === null) return next(e);
    const count = ((await read($, isMineOnly)) ? scan.mineTodos : scan.todos).length;
    const from = windowStart(await read($, windowOffset), count, drawnRows);

    const to = windowStart(
      from + Math.sign(e.by) * Math.min(Math.abs(e.by), drawnRows),
      count,
      drawnRows,
    );

    // At its edge the list hands the move on: the engine scrolls a band taller than its window.
    if (to === from) return next(e);
    await update($, windowOffset, () => to);

    return {};
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

    const windowRows = Math.max(1, Math.min(settings.rows, e.props.maxRows - BAND_CHROME_ROWS));
    drawnRows = windowRows;
    const start = windowStart(await read($, windowOffset), listed.length, windowRows);
    const shown = listed.slice(start, start + windowRows);
    const picked = await read($, pickedIds);

    const labelLimit = Math.max(MIN_SOURCE_WIDTH, Math.floor(e.props.bodyColumns * SOURCE_SHARE));
    // Measured over the whole list, so the columns hold still while it scrolls.
    const labels = listed.map((todo) => shortenStart(sourceLabel(todo), labelLimit));
    const ages = listed.map((todo) => formatAge(scan.scannedAt - todo.authoredAt));
    const labelWidth = Math.max(0, ...labels.map((label) => label.length));
    const ageWidth = Math.max(0, ...ages.map((age) => age.length));
    const unkeptCount = listedTotal - listed.length;
    const count = mineOnly ? `${scan.mineTotal} of ${scan.total} yours` : `${scan.total}`;

    const footer = [
      listed.length > shown.length
        ? `${start + 1}–${start + shown.length} of ${listed.length}`
        : "",
      unkeptCount > 0 ? `+${unkeptCount} more` : "",
      picked.length > 0 ? `${picked.length} selected` : "hides on your next message",
      picked.length > 0 ? "" : `/${COMMAND} reopens`,
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

    const togglePicked = (id: string) =>
      update($, pickedIds, (ids) =>
        ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id],
      );

    const rows = shown.map((todo, index) =>
      Box({
        key: `todo:${todoId(todo)}`,
        gap: 1,
        children: [
          Button({
            key: `pick:${todoId(todo)}`,
            label: picked.includes(todoId(todo)) ? "●" : "○",
            plain: true,
            dimColor: !picked.includes(todoId(todo)),
            onPress: () => togglePicked(todoId(todo)),
          }),
          Box({
            width: labelWidth,
            flexShrink: 0,
            children: [Text({ dimColor: true, children: labels[start + index] ?? "" })],
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
            children: [Text({ dimColor: true, children: ages[start + index] ?? "" })],
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
            Box({
              flexGrow: 1,
              flexShrink: 1,
              minWidth: 0,
              children: [Text({ dimColor: true, wrap: "truncate-end", children: footer })],
            }),
            Box({
              flexShrink: 0,
              gap: 1,
              children: [
                ...(picked.length > 0
                  ? [
                      Button({
                        key: "show",
                        label: "Show Claude",
                        variant: "primary",
                        onPress: () => showClaude($),
                      }),
                      Button({
                        key: "clear",
                        label: "Clear",
                        dimColor: true,
                        onPress: () => update($, pickedIds, () => NOTHING_PICKED),
                      }),
                    ]
                  : []),
                Button({
                  key: "mine",
                  label: mineOnly ? "All" : "Mine",
                  dimColor: true,
                  onPress: async () => {
                    await update($, isMineOnly, (value) => !value);
                    await update($, windowOffset, () => 0);
                  },
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
        }),
      ],
    });

    // The band is shared: what the mods after this one draw stays below the list.
    return Box({ flexDirection: "column", children: [band, await next(e)] });
  });
};
