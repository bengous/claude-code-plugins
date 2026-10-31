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
 *   field-test-desktop.ts shot [--out <file.png>] [--window <title>] [--half] [--focus]
 *   field-test-desktop.ts click <x> <y> [--window <title>]
 *   field-test-desktop.ts key <name>... [--window <title>]
 *   field-test-desktop.ts mark
 *   field-test-desktop.ts log [--since <mark>] [--grep <text>]
 *   field-test-desktop.ts process <cli session uuid>
 *
 * The method: .claude/skills/field-test/references/desktop.md.
 */

import { existsSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

const USAGE = [
  "usage: field-test-desktop.ts <command> ...",
  "  open <cli session uuid | local_<id> | claude:// url> | new [--folder <dir>] [--prompt <text>]",
  "  windows | shot [--out <file.png>] [--window <title>] [--half] [--focus]",
  "  click <x> <y> [--window <title>] | key <name>... [--window <title>]",
  "  mark | log [--since <mark>] [--grep <text>] | process <cli session uuid>",
].join("\n");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Desktop names its main window "Claude"; a popped-out session's window bears the session's title. */
const MAIN_TITLE = "Claude";

/** Where the pointer goes, in ydotool's own units, to learn how ydotool's absolute range maps onto the screen. */
const CALIBRATION: Point = { x: 200, y: 200 };

/** How far, in screen pixels, the pointer may sit from the target before a click is refused. */
const TOLERANCE = 2;

/** How long `open` watches Desktop's log for the line that says it took the link. */
const CONFIRM_MS = 10_000;

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

/** A part of a log file to print: from `offset` bytes to its end. */
export type LogPart = { readonly file: string; readonly offset: number };

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

  if (UUID.test(target)) return `claude://resume?session=${target.toLowerCase()}`;

  if (target.startsWith("local_")) return `claude://claude.ai/epitaxy/${target}`;

  return undefined;
}

/** The line Desktop's log writes once it took the link for `target`; undefined when no line names it. */
export function confirmationOf(target: string): string | undefined {
  if (UUID.test(target)) return `CLI session ${target.toLowerCase()}`;

  if (target.startsWith("local_")) return `setFocusedSession: sessionId=${target}`;

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

/** A non-negative whole number written in decimal digits alone; undefined for anything else, the empty string included. */
export function wholeNumber(text: string | undefined): number | undefined {
  return text !== undefined && /^\d+$/u.test(text) ? Number(text) : undefined;
}

/** `hyprctl cursorpos` as a point; undefined for any other text (an error, a notice). */
export function parseCursor(text: string): Point | undefined {
  const match = /^(-?\d+), (-?\d+)$/u.exec(text.trim());

  return match === null ? undefined : { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * Screen pixels per ydotool unit on each axis, from where a move to `sent`
 * landed: ydotool's absolute range does not map one to one onto the screen
 * (measured here: 2292 1326 landed on 4584 1439). Undefined when a move did not land.
 */
export function scaleOf(sent: Point, landed: Point): Point | undefined {
  const scale = { x: landed.x / sent.x, y: landed.y / sent.y };

  return scale.x > 0 && scale.y > 0 ? scale : undefined;
}

/** Where ydotool must move, in its own units, for a point of the window read on a full-size capture. */
export function pointerTarget(window: Window, point: Point, scale: Point): Point {
  return {
    x: Math.round((window.x + point.x) / scale.x),
    y: Math.round((window.y + point.y) / scale.y),
  };
}

/** Whether the pointer sits on the target, on both axes. */
export function isOnTarget(at: Point, target: Point): boolean {
  return Math.abs(at.x - target.x) <= TOLERANCE && Math.abs(at.y - target.y) <= TOLERANCE;
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

/**
 * The parts of Desktop's log written since a mark, a byte offset into the
 * current log. Desktop rotates it to `main1.log`: a log now shorter than the
 * mark was rotated, so the rest of the old one comes first. Undefined when even
 * the rotated one is shorter: the mark is older than both files.
 */
export function logParts(
  mark: number,
  current: LogPart & { readonly size: number },
  rotated: (LogPart & { readonly size: number }) | undefined,
): LogPart[] | undefined {
  if (current.size >= mark) return [{ file: current.file, offset: mark }];

  if (rotated === undefined || rotated.size < mark) return undefined;

  return [
    { file: rotated.file, offset: mark },
    { file: current.file, offset: 0 },
  ];
}

const logsDir = () =>
  join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "Claude", "logs");

const desktopLog = () => join(logsDir(), "main.log");

const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);

async function readParts(parts: readonly LogPart[]): Promise<string> {
  const texts = await Promise.all(
    parts.map((part) => Bun.file(part.file).slice(part.offset).text()),
  );

  return texts.join("");
}

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

async function activeWorkspace(): Promise<string> {
  const shown = await $`hyprctl activeworkspace -j`.nothrow().quiet();

  if (shown.exitCode !== 0) fail(`hyprctl activeworkspace: ${shown.stderr.toString().trim()}`);

  // SAFETY: hyprctl -j prints one workspace object whose `name` is a string; a missing one is refused below.
  const { name } = JSON.parse(shown.stdout.toString()) as { readonly name?: string };

  return name ?? fail("hyprctl activeworkspace printed no name");
}

/** Desktop survives the caller as a service when uwsm runs the session, as the owner's herdr-go opens it. */
async function openLink(url: string): Promise<void> {
  const opened =
    Bun.which("uwsm") !== null && Bun.which("claude-desktop") !== null
      ? await $`uwsm app -t service -- claude-desktop ${url}`.nothrow().quiet()
      : await $`xdg-open ${url}`.nothrow().quiet();

  if (opened.exitCode !== 0) fail(`opening ${url}: ${opened.stderr.toString().trim()}`);
}

/** Opens the target, then reads Desktop's log for its own word that it took the link. */
async function open(target: string): Promise<void> {
  const url = linkOf(target) ?? fail(USAGE, 2);
  const expected = confirmationOf(target);
  const mark = sizeOf(desktopLog());

  await openLink(url);

  if (expected === undefined) {
    console.log(`opened: ${url} (no Desktop log line names this link: check with shot)`);

    return;
  }

  for (let waited = 0; waited < CONFIRM_MS; waited += 300) {
    const parts = logParts(
      mark,
      { file: desktopLog(), offset: 0, size: sizeOf(desktopLog()) },
      undefined,
    );

    const written = parts === undefined ? "" : await readParts(parts);

    if (written.includes(expected)) {
      console.log(`opened: ${url} (Desktop's log: ${expected})`);

      return;
    }

    await Bun.sleep(300);
  }

  fail(`sent ${url}, but Desktop's log never said "${expected}" within ${CONFIRM_MS / 1000} s`);
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

async function moveTo(point: Point): Promise<Point> {
  await $`ydotool mousemove --absolute -x ${point.x} -y ${point.y}`.quiet();
  await Bun.sleep(200);

  const text = await $`hyprctl cursorpos`.quiet().text();

  return (
    parseCursor(text) ??
    fail(`hyprctl cursorpos printed "${text.trim()}", not a position: nothing clicked`)
  );
}

async function click(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { window: { type: "string" } },
  });

  const x = wholeNumber(positionals[0]);
  const y = wholeNumber(positionals[1]);

  if (x === undefined || y === undefined) fail(USAGE, 2);

  const window = await windowNamed(values.window);

  await focus(window);

  const scale =
    scaleOf(CALIBRATION, await moveTo(CALIBRATION)) ??
    fail("the pointer did not move: is ydotoold running? nothing clicked");

  const goal = { x: window.x + x, y: window.y + y };
  const at = await moveTo(pointerTarget(window, { x, y }, scale));

  if (!isOnTarget(at, goal)) {
    fail(`the pointer is at ${at.x}, ${at.y}, not ${goal.x}, ${goal.y}: nothing clicked`);
  }

  await $`ydotool click 0xC0`.quiet();
  console.log(
    `clicked ${x},${y} in "${window.title}" (screen ${goal.x}, ${goal.y}, workspace ${window.workspace})`,
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
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string" },
      window: { type: "string" },
      half: { type: "boolean", default: false },
      focus: { type: "boolean", default: false },
    },
  });

  const window = await windowNamed(values.window);
  const shown = await activeWorkspace();

  if (shown !== window.workspace) {
    if (!values.focus) {
      fail(
        `"${window.title}" is on workspace ${window.workspace}, the screen shows ${shown}: a capture would show the wrong window. Pass --focus to bring it forward.`,
      );
    }

    await focus(window);
  }

  // Each capture gets its own directory unless one is named: no file lands in the checkout, and two tests never share one.
  const file = values.out ?? join(mkdtempSync(join(tmpdir(), "field-test-desktop-")), "shot.png");
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

  const mark = wholeNumber(values.since) ?? fail(`--since takes the number mark printed`, 2);
  const current = desktopLog();

  if (!existsSync(current)) fail(`no Desktop log at ${current}`);

  const rotated = join(logsDir(), "main1.log");

  const parts =
    logParts(
      mark,
      { file: current, offset: 0, size: sizeOf(current) },
      existsSync(rotated) ? { file: rotated, offset: 0, size: sizeOf(rotated) } : undefined,
    ) ?? fail(`the mark ${mark} is older than Desktop's two logs: mark again`);

  const lines = (await readParts(parts)).split("\n");
  const grep = values.grep;
  const kept = grep === undefined ? lines : lines.filter((line) => line.includes(grep));

  console.log(kept.join("\n").trim());
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "open":
      await open(rest[0] ?? "");
      break;
    case "new": {
      const { values } = parseArgs({
        args: rest,
        options: { folder: { type: "string" }, prompt: { type: "string" } },
      });

      const url = newSessionLink(values.folder, values.prompt);

      await openLink(url);
      console.log(`opened: ${url} (a new session writes no log line of its own: check with shot)`);
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
    case "mark":
      console.log(sizeOf(desktopLog()));
      break;
    case "log":
      await logLines(rest);
      break;
    case "process": {
      const uuid = rest[0] ?? fail(USAGE, 2);
      const listed = await $`ps -eo pid,args`.quiet().text();

      const running = listed
        .split("\n")
        .filter((line) => line.toLowerCase().includes(`--resume=${uuid.toLowerCase()}`));

      console.log(running.length === 0 ? `no process resumes ${uuid}` : running.join("\n"));
      break;
    }

    default:
      fail(USAGE, 2);
  }
}
