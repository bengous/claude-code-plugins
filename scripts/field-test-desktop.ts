#!/usr/bin/env bun

/**
 * Claude Desktop driven from outside, one command per call: open a session, show
 * it, capture its window, click and type in it, read Desktop's own log. The
 * desktop side of a field test, beside field-test.ts's terminal drive. Linux on
 * Hyprland only: hyprctl for windows and focus, grim for captures, ydotool for
 * the pointer and keys.
 *
 *   field-test-desktop.ts open <cli session uuid | local_<id> | claude:// url>
 *   field-test-desktop.ts new [--folder <dir>] [--prompt <text>]
 *   field-test-desktop.ts windows
 *   field-test-desktop.ts shot <file.png> [--window <title>] [--half]
 *   field-test-desktop.ts click <x> <y> [--window <title>]
 *   field-test-desktop.ts key <name>... [--window <title>]
 *   field-test-desktop.ts mark
 *   field-test-desktop.ts log [--since <line>] [--grep <text>]
 *   field-test-desktop.ts process <cli session uuid>
 *
 * The method: .claude/skills/field-test/references/desktop.md.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

const USAGE = [
  "usage: field-test-desktop.ts <command> ...",
  "  open <cli session uuid | local_<id> | claude:// url> | new [--folder <dir>] [--prompt <text>]",
  "  windows | shot <file.png> [--window <title>] [--half]",
  "  click <x> <y> [--window <title>] | key <name>... [--window <title>]",
  "  mark | log [--since <line>] [--grep <text>] | process <cli session uuid>",
].join("\n");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Desktop names its main window "Claude"; a popped-out session's window bears the session's title. */
const MAIN_TITLE = "Claude";

/** Linux input event codes, the names ydotool takes as numbers. */
const KEYS = new Map([
  ["Escape", 1],
  ["Backspace", 14],
  ["Tab", 15],
  ["Enter", 28],
  ["Up", 103],
  ["Down", 108],
  ["End", 107],
]);

export type Window = {
  readonly address: string;
  readonly title: string;
  readonly workspace: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type Point = { readonly x: number; readonly y: number };

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

type Client = {
  readonly address?: string;
  readonly class?: string;
  readonly title?: string;
  readonly at?: readonly number[];
  readonly size?: readonly number[];
  readonly workspace?: { readonly name?: string };
};

/** Claude Desktop's windows from `hyprctl clients -j`. */
export function claudeWindows(clients: readonly Client[]): Window[] {
  return clients.flatMap((client) =>
    /claude/iu.test(client.class ?? "") &&
    client.address !== undefined &&
    client.at?.length === 2 &&
    client.size?.length === 2
      ? [
          {
            address: client.address,
            title: client.title ?? "",
            workspace: client.workspace?.name ?? "",
            x: client.at[0] ?? 0,
            y: client.at[1] ?? 0,
            width: client.size[0] ?? 0,
            height: client.size[1] ?? 0,
          },
        ]
      : [],
  );
}

/** The window whose title contains `title`, or Desktop's main window. */
export function pickWindow(windows: readonly Window[], title?: string): Window | undefined {
  return title === undefined
    ? windows.find((window) => window.title === MAIN_TITLE)
    : windows.find((window) => window.title.includes(title));
}

/**
 * The link that opens a target in Desktop: a CLI session's uuid is imported
 * (`claude://resume`, undocumented, reads `session` alone), a Desktop session
 * `local_<id>` is shown, a `claude://` link goes as given.
 */
export function linkOf(target: string): string | undefined {
  if (target.startsWith("claude://")) return target;

  if (UUID.test(target)) return `claude://resume?session=${target}`;

  if (target.startsWith("local_")) return `claude://claude.ai/epitaxy/${target}`;

  return undefined;
}

/** Desktop's new-session page, documented: `folder` names the folder, `q` fills the prompt box. */
export function newSessionLink(folder?: string, prompt?: string): string {
  const query = new URLSearchParams();

  if (folder !== undefined) query.set("folder", folder);

  if (prompt !== undefined) query.set("q", prompt);

  const text = query.toString();

  return text === "" ? "claude://code/new" : `claude://code/new?${text}`;
}

/**
 * Where ydotool must move for a point of the window, read on a full-size
 * capture: the window's origin plus the point, halved, since ydotool's
 * absolute mode doubles what it is given (measured: 2292 1326 landed on 4584 1439).
 */
export function pointerTarget(window: Window, point: Point): Point {
  return {
    x: Math.round((window.x + point.x) / 2),
    y: Math.round((window.y + point.y) / 2),
  };
}

/** `ydotool key` arguments: each key pressed then released. */
export function keyArgs(names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const code = KEYS.get(name);

    if (code === undefined) {
      throw new Error(`unknown key ${name}: one of ${[...KEYS.keys()].join(", ")}`);
    }

    return [`${code}:1`, `${code}:0`];
  });
}

const desktopLog = () =>
  join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "Claude", "logs", "main.log");

async function listWindows(): Promise<Window[]> {
  const listed = await $`hyprctl clients -j`.nothrow().quiet();

  if (listed.exitCode !== 0)
    fail(`hyprctl clients: ${listed.stderr.toString().trim()} (Hyprland only)`);

  // SAFETY: hyprctl -j prints a JSON array of clients; claudeWindows reads every field as optional.
  return claudeWindows(JSON.parse(listed.stdout.toString()) as Client[]);
}

async function windowNamed(title?: string): Promise<Window> {
  const found = pickWindow(await listWindows(), title);

  return (
    found ??
    fail(
      `no Claude Desktop window ${title === undefined ? "named Claude" : `whose title holds "${title}"`}: see windows`,
    )
  );
}

/** Desktop survives the caller as a service when uwsm runs the session, as the owner's herdr-go opens it. */
async function openLink(url: string): Promise<void> {
  const opened =
    Bun.which("uwsm") !== null && Bun.which("claude-desktop") !== null
      ? await $`uwsm app -t service -- claude-desktop ${url}`.nothrow().quiet()
      : await $`xdg-open ${url}`.nothrow().quiet();

  if (opened.exitCode !== 0) fail(`opening ${url}: ${opened.stderr.toString().trim()}`);
  console.log(`opened: ${url}`);
}

async function focus(window: Window): Promise<void> {
  // The Hyprland config is Lua: dispatchers are hl.dsp calls, `dispatch movecursor x y` is refused.
  const focused =
    await $`hyprctl dispatch ${`hl.dsp.focus({ window = "address:${window.address}" })`}`
      .nothrow()
      .quiet();

  if (focused.exitCode !== 0) fail(`focusing ${window.title}: ${focused.stderr.toString().trim()}`);
  await Bun.sleep(300);
}

async function click(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { window: { type: "string" } },
  });

  const [x, y] = positionals.map(Number);

  if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) fail(USAGE, 2);

  const window = await windowNamed(values.window);
  const target = pointerTarget(window, { x, y });

  await focus(window);
  await $`ydotool mousemove --absolute -x ${target.x} -y ${target.y}`.quiet();
  await Bun.sleep(200);

  const at = (await $`hyprctl cursorpos`.quiet().text()).trim();
  const expected = `${window.x + x}, ${window.y + y}`;

  if (Math.abs(Number(at.split(",")[0]) - (window.x + x)) > 2) {
    fail(`the pointer is at ${at}, not ${expected}: ydotoold running? nothing clicked`);
  }

  await $`ydotool click 0xC0`.quiet();
  console.log(
    `clicked ${x},${y} in "${window.title}" (screen ${expected}, workspace ${window.workspace})`,
  );
}

async function key(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { window: { type: "string" } },
  });

  if (positionals.length === 0) fail(USAGE, 2);

  let codes: string[];

  try {
    codes = keyArgs(positionals);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), 2);
  }

  const window = await windowNamed(values.window);

  await focus(window);
  await $`ydotool key ${codes}`.quiet();
  console.log(`keys ${positionals.join(" ")} in "${window.title}"`);
}

async function shot(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { window: { type: "string" }, half: { type: "boolean", default: false } },
  });

  const [file] = positionals;

  if (file === undefined) fail(USAGE, 2);

  const window = await windowNamed(values.window);
  const geometry = `${window.x},${window.y} ${window.width}x${window.height}`;
  const scale = values.half ? ["-s", "0.5"] : [];

  await $`grim ${scale} -g ${geometry} ${file}`.quiet();
  console.log(
    `${file}: "${window.title}", ${window.width}x${window.height}${values.half ? " shown at half size (click coordinates are full size: double them)" : ""}`,
  );
}

async function logLines(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { since: { type: "string", default: "0" }, grep: { type: "string" } },
  });

  const path = desktopLog();

  if (!existsSync(path)) fail(`no Desktop log at ${path}`);

  const lines = (await Bun.file(path).text()).split("\n").slice(Number(values.since));
  const grep = values.grep;
  const kept = grep === undefined ? lines : lines.filter((line) => line.includes(grep));

  console.log(kept.join("\n").trim());
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "open": {
      const url = linkOf(rest[0] ?? "") ?? fail(USAGE, 2);

      await openLink(url);
      break;
    }

    case "new": {
      const { values } = parseArgs({
        args: rest,
        options: { folder: { type: "string" }, prompt: { type: "string" } },
      });

      await openLink(newSessionLink(values.folder, values.prompt));
      break;
    }

    case "windows":
      for (const window of await listWindows()) {
        console.log(
          `${window.address} "${window.title}" workspace ${window.workspace} at ${window.x},${window.y} ${window.width}x${window.height}`,
        );
      }

      break;
    case "shot":
      await shot(rest);
      break;
    case "click":
      await click(rest);
      break;
    case "key":
      await key(rest);
      break;
    case "mark": {
      const path = desktopLog();

      console.log(existsSync(path) ? (await Bun.file(path).text()).split("\n").length - 1 : 0);
      break;
    }

    case "log":
      await logLines(rest);
      break;
    case "process": {
      const uuid = rest[0] ?? fail(USAGE, 2);
      const listed = await $`ps -eo pid,args`.quiet().text();
      const running = listed.split("\n").filter((line) => line.includes(`--resume=${uuid}`));

      console.log(running.length === 0 ? `no process resumes ${uuid}` : running.join("\n"));
      break;
    }

    default:
      fail(USAGE, 2);
  }
}
