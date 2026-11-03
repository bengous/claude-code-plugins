import path from "node:path";

import { configPath } from "../core/config/config.ts";
import { loadProfile } from "../core/config/profile.ts";
import { INERT_ARGUMENTS } from "./mentions.ts";
import { rootOf } from "./repo.ts";
import type { Word } from "./shell.ts";
import { commandsOf, parseLine, unwrap } from "./shell.ts";

const KIT_EXPANSION = "user-prompt-expansion";

/** The programs that hand a prompt to a Claude Code session: its CLI, and the terminals an agent sends keys to. */
const SESSION_PROGRAMS = new Set(["claude", "tmux", "screen"]);

/** The repository's own driver of a Claude Code session in tmux, run as an argument of `bun`. */
const SESSION_SCRIPT = "field-test.ts";

/** `/<name>` where a prompt holds it: at its start, after a space or an option's `=`, alone or before its argument. */
function typing(name: string): RegExp {
  return new RegExp(String.raw`(?:^|[\s=])/${name}(?:\s|$)`, "u");
}

function reads(argv: readonly Word[]): boolean {
  const [program] = argv;

  return program !== undefined && INERT_ARGUMENTS.has(path.basename(program.text));
}

/** The kit's entry, `agent-hooks.ts` or its `agent-hooks` symlink, told to run its UserPromptExpansion hook. */
function runsKitExpansion(argv: readonly Word[]): boolean {
  const entry = argv.findIndex((word, index) => {
    const name = path.basename(word.text);

    return name === "agent-hooks.ts" || (index === 0 && name === "agent-hooks");
  });

  return (
    !reads(argv) &&
    entry !== -1 &&
    argv.slice(entry + 1).some((word) => word.text === KIT_EXPANSION || word.expands)
  );
}

function handsPrompt(argv: readonly Word[]): boolean {
  return (
    !reads(argv) &&
    argv.some(
      (word, index) =>
        (index === 0 && SESSION_PROGRAMS.has(path.basename(word.text))) ||
        path.basename(word.text) === SESSION_SCRIPT,
    )
  );
}

/**
 * Why `command` is refused: one of its commands runs the kit's user-prompt-expansion hook itself, which puts a
 * command's label on from any payload it reads; or it hands a prompt to a Claude Code session (`claude -p`, keys sent
 * to a terminal) and a word or a heredoc of the line holds `/<name>` of a label command of the cwd's profile, which
 * that session takes as the human's typing. Null when it does neither.
 */
export function labelCommandRefusal(command: string, cwd: string): string | null {
  const commands = commandsOf(parseLine(command));
  const argvs = commands.map((each) => unwrap(each.words, cwd).argv);

  if (argvs.some((argv) => runsKitExpansion(argv))) {
    return (
      `agent-hooks: the ${KIT_EXPANSION} hook is Claude Code's to run, on a command the human typed: run by hand, it puts a label on from whatever payload it reads. ` +
      "Ask the human to type the command in their own session."
    );
  }

  if (!argvs.some((argv) => handsPrompt(argv))) return null;

  const root = rootOf(cwd, []);
  const approvals = root === null ? null : loadProfile(configPath(root)).approvals;

  if (approvals?.kind !== "read") return null;

  const texts = commands.flatMap((each) => [
    ...each.words.map((word) => word.text),
    ...each.heredocs.map((body) => command.slice(body.start, body.end)),
  ]);

  const typed = approvals.value.labels.find((label) => {
    const pattern = label.command === null ? null : typing(label.command.name);

    return pattern !== null && texts.some((text) => pattern.test(text));
  });

  return typed?.command === null || typed?.command === undefined
    ? null
    : `agent-hooks: /${typed.command.name} is the human's to type: this command hands it to a Claude Code session, which takes it as the human's own typing and puts ${typed.name} on. ` +
        `Ask the human to type /${typed.command.name} <number> in their own session.`;
}
