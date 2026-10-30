#!/usr/bin/env bun

/**
 * A Claude Code session on plugins read from source, run in tmux and driven one
 * command at a time: the field test of a behaviour change. One command per call
 * keeps each step inside an agent worktree's Bash guard, which refuses pipes,
 * chains and a bare `sleep`.
 *
 *   field-test.ts start <name> [--ref <ref>] [--model <model>] [--cwd <dir>]
 *                 [--width <columns>] [--height <rows>] <plugin>...
 *   field-test.ts send <name> <text>           type a line and submit it
 *   field-test.ts keys <name> <key>...         tmux key names: Tab BTab Enter Escape C-x
 *   field-test.ts wait <name> <text> [--gone] [--timeout <seconds>]
 *   field-test.ts screen <name> [--pane]       --pane: the docked pane's side alone
 *   field-test.ts focused <name>
 *   field-test.ts press <name> <label> [--nth <n>]
 *   field-test.ts messages <name> [--last]
 *   field-test.ts stop <name>
 *
 * The method: .claude/skills/field-test/SKILL.md.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import { installDependencies } from "./lib/plugin-sources.ts";

const USAGE = [
  "usage: field-test.ts <command> <name> ...",
  "  start <name> [--ref <ref>] [--model <model>] [--cwd <dir>] [--width <n>] [--height <n>] <plugin>...",
  "  send <name> <text> | keys <name> <key>... | wait <name> <text> [--gone] [--timeout <s>]",
  "  screen <name> [--pane] | focused <name> | press <name> <label> [--nth <n>]",
  "  messages <name> [--last] | stop <name>",
].join("\n");

const ROOT = join(import.meta.dir, "..");

const ESC = "\u001B";

const BEL = "\u0007";

/** The rule Claude Code draws between the chat and a docked pane. */
const DIVIDER = "│";

/** Measured with griller: at 220 columns its pane docks beside the chat. */
const WIDTH = 220;

const HEIGHT = 50;

/** The trust dialog's own lines; a path or a tip holding the word alone is no dialog. */
const TRUST = /Is this a project you created or one you trust|Yes, I trust this folder/u;

/** A full turn of Tab through a pane of a dozen cards stays far below it. */
const MAX_TABS = 80;

type State = {
  readonly sessionId: string;
  readonly work: string;
  /** The work directory was made for this test: stop deletes it and its Claude Code data. */
  readonly isOwnWork: boolean;
};

export type Run = { readonly column: number; readonly text: string };

export type Line = { readonly plain: string; readonly reversed: readonly Run[] };

export type Position = { readonly row: number; readonly column: number };

export type Said = { readonly by: "you" | "claude"; readonly text: string };

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/** The SGR parameters' effect on reverse video: 7 sets it, 27 and a reset clear it. */
function reverseAfter(params: string, isReversed: boolean): boolean {
  if (params === "") return false;
  const codes = params.split(";");
  let reversed = isReversed;

  for (let at = 0; at < codes.length; at += 1) {
    const code = codes[at];

    if (code === "0") reversed = false;
    else if (code === "7") reversed = true;
    else if (code === "27") reversed = false;
    else if (code === "38" || code === "48" || code === "58") {
      // An extended color: `5;N` or `2;R;G;B`, whose numbers are no attribute.
      at += codes[at + 1] === "5" ? 2 : 4;
    }
  }

  return reversed;
}

/**
 * A line of `tmux capture-pane -e` as text, and the runs it draws in reverse
 * video: the terminal draws a focused control that way, and nothing else on
 * the screen carries it but the text cursor, a blank.
 */
export function parseLine(ansi: string): Line {
  let plain = "";
  let isReversed = false;
  let run: { column: number; text: string } | null = null;
  const reversed: Run[] = [];

  const close = () => {
    const text = run?.text.trim() ?? "";

    if (run !== null && text !== "") {
      reversed.push({ column: run.column + run.text.indexOf(text), text });
    }

    run = null;
  };

  let at = 0;

  while (at < ansi.length) {
    if (ansi[at] === ESC && ansi[at + 1] === "]") {
      // An OSC sequence, a hyperlink around a path or a URL: it ends at BEL or at ESC \.
      const bell = ansi.indexOf(BEL, at);
      const terminator = ansi.indexOf(`${ESC}\\`, at + 2);
      const ends = [bell, terminator === -1 ? -1 : terminator + 1].filter((end) => end !== -1);

      at = ends.length === 0 ? ansi.length : Math.min(...ends) + 1;
    } else if (ansi[at] === ESC && ansi[at + 1] === "[") {
      let end = at + 2;

      while (end < ansi.length && !/[@-~]/u.test(ansi[end] ?? "")) end += 1;

      if (ansi[end] === "m") {
        isReversed = reverseAfter(ansi.slice(at + 2, end), isReversed);

        if (!isReversed) close();
      }

      at = end + 1;
    } else {
      const char = String.fromCodePoint(ansi.codePointAt(at) ?? 0);

      if (isReversed) {
        run ??= { column: plain.length, text: "" };
        run.text += char;
      }

      plain += char;
      at += char.length;
    }
  }

  close();

  return { plain, reversed };
}

/**
 * Where each control reading `label` sits, top to bottom: a button draws as
 * `[ label ]`, which the same words in the chat never do; a control drawn
 * without brackets (a pane's close mark) is found by its bare text.
 */
export function controlsNamed(plain: readonly string[], label: string): Position[] {
  const find = (needle: string) =>
    plain.flatMap((line, row) => {
      const found: Position[] = [];

      for (
        let column = line.indexOf(needle);
        column !== -1;
        column = line.indexOf(needle, column + 1)
      ) {
        found.push({ row, column });
      }

      return found;
    });

  const bracketed = find(`[ ${label} ]`);

  return bracketed.length > 0 ? bracketed : find(label);
}

/**
 * The docked pane's side of the screen: what lies right of the divider most
 * rows share, at the same display column. Columns are counted on display
 * width, since a wide character in the chat (❓ takes two cells) shifts its
 * string index. Null when no divider runs down half the rows: no pane docked.
 */
export function paneOf(plain: readonly string[]): string[] | null {
  const dividers = plain.map((line) => {
    const at = new Map<number, number>();

    for (
      let index = line.indexOf(DIVIDER);
      index !== -1;
      index = line.indexOf(DIVIDER, index + 1)
    ) {
      at.set(Bun.stringWidth(line.slice(0, index)), index);
    }

    return at;
  });

  const rows = new Map<number, number>();

  for (const at of dividers)
    for (const column of at.keys()) rows.set(column, (rows.get(column) ?? 0) + 1);

  const [column, count] = [...rows].toSorted(([, left], [, right]) => right - left)[0] ?? [0, 0];

  if (count * 2 < plain.length) return null;

  return dividers.flatMap((at, row) => {
    const index = at.get(column);

    return index === undefined ? [] : [(plain[row] ?? "").slice(index + 1)];
  });
}

type Block = { readonly type?: string; readonly text?: string; readonly name?: string };

type Row = {
  readonly type?: string;
  readonly isMeta?: boolean;
  readonly message?: { readonly content?: string | Block[] };
};

/** A slash command's row, as the person typed it. */
function typed(content: string): string {
  const name = /<command-name>(.*?)<\/command-name>/su.exec(content)?.[1];

  if (name === undefined) return content;
  const args = /<command-args>(.*?)<\/command-args>/su.exec(content)?.[1] ?? "";

  return `${name} ${args}`.trim();
}

/**
 * What each side said, from a session's transcript: prompts and replies, a tool
 * call by its name. Meta rows (a skill's text), thinking and tool results are
 * not said. The last line may be one the session is still writing.
 */
export function conversation(jsonl: string): Said[] {
  const lines = jsonl.split("\n").filter((line) => line.trim() !== "");

  return lines.flatMap((line, at): Said[] => {
    let row: Row;

    try {
      // SAFETY: Claude Code writes one object per line; every field read below is optional.
      row = JSON.parse(line) as Row;
    } catch (error) {
      if (at === lines.length - 1) return [];
      throw error;
    }

    const content = row.message?.content;

    if (row.isMeta === true || content === undefined) return [];

    if (row.type === "user") {
      if (!Array.isArray(content)) return [{ by: "you", text: typed(content) }];
      const text = content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []));

      return text.length === 0 ? [] : [{ by: "you", text: text.join("\n") }];
    }

    if (row.type !== "assistant" || !Array.isArray(content)) return [];

    return content.flatMap((block): Said[] => {
      if (block.type === "text") return [{ by: "claude", text: block.text ?? "" }];

      return block.type === "tool_use"
        ? [{ by: "claude", text: `[tool ${block.name ?? "?"}]` }]
        : [];
    });
  });
}

/** What Claude said since the last message it received. */
export function lastReply(said: readonly Said[]): string[] {
  const after = said.findLastIndex((entry) => entry.by === "you");

  return said.slice(after + 1).map((entry) => entry.text);
}

/** Lines without trailing blanks, one blank line between blocks, none at the end. */
export function tidy(lines: readonly string[]): string[] {
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (trimmed !== "" || (kept.length > 0 && kept.at(-1) !== "")) kept.push(trimmed);
  }

  while (kept.at(-1) === "") kept.pop();

  return kept;
}

export function claudeArgv(
  claude: string,
  run: {
    readonly model: string;
    readonly sessionId: string;
    readonly debugLog: string;
    readonly pluginDirs: readonly string[];
  },
): string[] {
  return [
    claude,
    "--permission-mode",
    "default",
    "--model",
    run.model,
    "--session-id",
    run.sessionId,
    "--debug-file",
    run.debugLog,
    ...run.pluginDirs.flatMap((dir) => ["--plugin-dir", dir]),
  ];
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

const scratchOf = (name: string) => join(tmpdir(), `field-test-${name}`);

const target = (name: string) => `field-test-${name}`;

async function stateOf(name: string): Promise<State> {
  const path = join(scratchOf(name), "state.json");

  if (!existsSync(path)) fail(`no field test named ${name}: start it first`);

  // SAFETY: only `start` writes the file, from a `State`.
  return (await Bun.file(path).json()) as State;
}

async function capture(name: string): Promise<Line[]> {
  const shown = await $`tmux capture-pane -p -e -t ${target(name)}`.nothrow().quiet();

  if (shown.exitCode !== 0)
    fail(`no tmux session ${target(name)}: ${shown.stderr.toString().trim()}`);

  return shown.stdout
    .toString()
    .replace(/\n$/u, "")
    .split("\n")
    .map((line) => parseLine(line));
}

async function plainOf(name: string): Promise<string[]> {
  return (await capture(name)).map((line) => line.plain);
}

async function keys(name: string, names: readonly string[]): Promise<void> {
  await $`tmux send-keys -t ${target(name)} ${names}`.quiet();
}

function focusOf(lines: readonly Line[]): (Run & { readonly row: number })[] {
  return lines.flatMap((line, row) => line.reversed.map((run) => ({ ...run, row })));
}

/** Until Claude Code's prompt is ready to take a line, or it asks to trust the folder. */
async function ready(name: string): Promise<void> {
  for (let waited = 0; waited < 60_000; waited += 300) {
    const plain = await plainOf(name);
    const text = plain.join("\n");

    if (TRUST.test(text)) {
      console.log(tidy(plain).join("\n"));
      fail(
        `${name}: Claude Code asks to trust the folder. Read the choices, answer with keys, then send.`,
        3,
      );
    }

    if (text.includes("❯")) return;

    await Bun.sleep(300);
  }

  fail(`${name}: no prompt after 60 s\n${tidy(await plainOf(name)).join("\n")}`);
}

async function start(name: string, args: string[]): Promise<void> {
  const { values, positionals: plugins } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      model: { type: "string", default: "sonnet" },
      cwd: { type: "string" },
      width: { type: "string", default: String(WIDTH) },
      height: { type: "string", default: String(HEIGHT) },
    },
  });

  if (!/^[a-z0-9-]+$/u.test(name)) fail("a name is lowercase letters, digits and dashes");

  if (plugins.length === 0) fail(USAGE, 2);

  const scratch = scratchOf(name);

  // A fixed path per name, made by mkdir alone: it fails on anything already there.
  try {
    mkdirSync(scratch);
  } catch {
    fail(`${scratch} exists: a field test named ${name} runs or was not stopped (stop ${name})`);
  }

  let from = ROOT;

  if (values.ref !== undefined) {
    from = join(scratch, "source");

    const added = await $`git -C ${ROOT} worktree add --detach ${from} ${values.ref}`
      .nothrow()
      .quiet();

    if (added.exitCode !== 0)
      fail(`git worktree add ${values.ref}: ${added.stderr.toString().trim()}`);
  }

  const pluginDirs = plugins.map((plugin) => {
    const dir = join(from, plugin);

    if (!existsSync(join(dir, ".claude-plugin", "plugin.json")))
      fail(`no plugin ${plugin} at ${from}`);

    return dir;
  });

  for (const dir of pluginDirs) {
    const failure = await installDependencies(dir);

    if (failure !== null) fail(failure);
  }

  const work = values.cwd ?? join(scratch, "work");

  if (values.cwd === undefined) mkdirSync(work);

  const state: State = {
    sessionId: crypto.randomUUID(),
    work,
    isOwnWork: values.cwd === undefined,
  };

  await Bun.write(join(scratch, "state.json"), `${JSON.stringify(state, null, 2)}\n`);

  // The binary, never the owner's shell function, which injects --dangerously-skip-permissions.
  const claude = Bun.which("claude") ?? fail("claude is not on PATH");
  const debugLog = join(scratch, "debug.log");

  const command = claudeArgv(claude, {
    model: values.model,
    sessionId: state.sessionId,
    debugLog,
    pluginDirs,
  })
    .map((word) => shellQuote(word))
    .join(" ");

  await $`tmux new-session -d -s ${target(name)} -x ${values.width} -y ${values.height} -c ${work} ${command}`.quiet();
  await ready(name);

  const commit = (await $`git -C ${from} log -1 --format=${"%h %s"}`.quiet().text()).trim();
  const dirty = (await $`git -C ${from} status --porcelain`.quiet().text()).trim();

  console.log(
    [
      `field test: ${name} (tmux ${target(name)}, ${values.model})`,
      `plugins:    ${pluginDirs.join(" ")}`,
      `commit:     ${commit}${dirty === "" ? "" : " + uncommitted changes"}`,
      `work:       ${work}`,
      `session:    ${state.sessionId}`,
      `debug log:  ${debugLog}`,
    ].join("\n"),
  );
}

async function wait(name: string, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      gone: { type: "boolean", default: false },
      timeout: { type: "string", default: "120" },
    },
  });

  const text = positionals.join(" ");
  const limit = Number(values.timeout) * 1000;

  for (let waited = 0; waited < limit; waited += 300) {
    const shown = (await plainOf(name)).some((line) => line.includes(text));

    if (shown !== values.gone) {
      console.log(`${values.gone ? "gone" : "seen"}: ${text}`);

      return;
    }

    await Bun.sleep(300);
  }

  console.log(tidy(await plainOf(name)).join("\n"));
  fail(
    `${name}: "${text}" ${values.gone ? "still shows" : "never showed"} after ${values.timeout} s`,
  );
}

async function press(name: string, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { nth: { type: "string" } },
  });

  const label = positionals.join(" ");
  const found = controlsNamed(await plainOf(name), label);
  const rows = found.map((at) => at.row + 1).join(", ");

  if (found.length === 0) fail(`${name}: no control reads "${label}" on the screen`);

  if (found.length > 1 && values.nth === undefined) {
    fail(`${name}: ${found.length} controls read "${label}", on rows ${rows}: pass --nth`);
  }

  const goal =
    found[Number(values.nth ?? "1") - 1] ??
    fail(`${name}: no control number ${values.nth}, rows ${rows}`);

  for (let step = 0; step <= MAX_TABS; step += 1) {
    const focus = focusOf(await capture(name));

    if (focus.some((run) => run.row === goal.row && run.column === goal.column)) {
      await keys(name, ["Enter"]);
      console.log(`pressed: ${label} (row ${goal.row + 1})`);

      return;
    }

    await keys(name, ["Tab"]);
    await Bun.sleep(150);
  }

  fail(`${name}: Tab never reached "${label}": focus the pane first (a band: keys C-x Tab)`);
}

async function messages(name: string, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { last: { type: "boolean", default: false } } });
  const { sessionId } = await stateOf(name);
  const projects = join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects");
  const [path] = await Array.fromAsync(new Bun.Glob(`*/${sessionId}.jsonl`).scan(projects));

  if (path === undefined) fail(`${name}: no transcript ${sessionId}.jsonl under ${projects} yet`);

  const said = conversation(await Bun.file(join(projects, path)).text());

  if (values.last) {
    console.log(lastReply(said).join("\n\n"));

    return;
  }

  console.log(
    said
      .map((entry, at) =>
        said[at - 1]?.by === entry.by ? entry.text : `## ${entry.by}\n${entry.text}`,
      )
      .join("\n\n"),
  );
}

async function stop(name: string): Promise<void> {
  const scratch = scratchOf(name);

  if (!existsSync(scratch)) fail(`no field test named ${name}`);

  await $`tmux kill-session -t ${target(name)}`.nothrow().quiet();

  const state = existsSync(join(scratch, "state.json")) ? await stateOf(name) : null;
  const removed = [`tmux ${target(name)}`];
  // A step that fails is said once the rest is removed: a stop that aborts halfway cannot be run again.
  const failed: string[] = [];

  if (state?.isOwnWork === true) {
    const purged = await $`claude purge --yes ${state.work}`.nothrow().quiet();

    if (purged.exitCode === 0) removed.push(`Claude Code's data for ${state.work}`);
    else failed.push(`claude purge ${state.work}: ${purged.stderr.toString().trim()}`);
  }

  const source = join(scratch, "source");

  if (existsSync(source)) {
    const unlinked = await $`git -C ${ROOT} worktree remove --force ${source}`.nothrow().quiet();

    if (unlinked.exitCode === 0) removed.push(`worktree ${source}`);
    else failed.push(`git worktree remove ${source}: ${unlinked.stderr.toString().trim()}`);
  }

  rmSync(scratch, { recursive: true, force: true });
  removed.push(scratch);
  console.log(`removed: ${removed.join(", ")}`);

  if (failed.length > 0) fail(`not removed:\n${failed.join("\n")}`);
}

if (import.meta.main) {
  const [command, name, ...rest] = process.argv.slice(2);

  if (name === undefined) fail(USAGE, 2);

  switch (command) {
    case "start":
      await start(name, rest);
      break;
    case "send":
      await $`tmux send-keys -l -t ${target(name)} -- ${rest.join(" ")}`.quiet();
      await Bun.sleep(150);
      await keys(name, ["Enter"]);
      break;
    case "keys":
      await keys(name, rest);
      break;
    case "wait":
      await wait(name, rest);
      break;
    case "screen": {
      const plain = await plainOf(name);
      const pane = rest.includes("--pane") ? paneOf(plain) : plain;

      if (pane === null) fail(`${name}: no docked pane on the screen; screen without --pane`);
      console.log(tidy(pane).join("\n"));
      break;
    }

    case "focused": {
      const focus = focusOf(await capture(name));

      console.log(
        focus.length === 0
          ? "no control has the focus: it is in a text field or the prompt"
          : focus.map((run) => `row ${run.row + 1}: ${run.text}`).join("\n"),
      );
      break;
    }

    case "press":
      await press(name, rest);
      break;
    case "messages":
      await messages(name, rest);
      break;
    case "stop":
      await stop(name);
      break;
    default:
      fail(USAGE, 2);
  }
}
