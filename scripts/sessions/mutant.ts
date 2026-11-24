/**
 * Whether a test fails once the code it guards changes: writes one replacement into a file, runs a
 * command, then puts the file back byte for byte with its mode, whatever the command did. The file
 * may hold uncommitted work: nothing is read from git.
 *
 * Exit 0 when the command failed on the mutant, 1 when it passed, 2 when no mutant was played.
 */

import { chmodSync, readFileSync, realpathSync, statSync } from "node:fs";

import { writeAtomicSync } from "../../tools/platform/fs.ts";
import { type Argv, run } from "../../tools/platform/process.ts";
import { messageOf } from "../../tools/platform/pure.ts";

const USAGE = `usage: mutant.ts <file> --from <text> --to <text> -- <command> [<argument>...]

  Replaces <text> of --from, which <file> holds once, with the one of --to, runs the command,
  then restores <file>. Prints the last lines of the command's output: a mutant that fails
  to parse is no proof of the test.

  Exit 0 when the command failed on the mutant, 1 when it passed, 2 when no mutant was played:
  a text the file does not hold once, a command that did not start, was ended by a signal or
  ran past 15 minutes.`;

/** The command's last lines, enough to tell a failed assertion from a file that no longer parses. */
const TAIL_LINES = 15;

/** A mutant can make its command loop: past this, the command is killed and the file restored. */
const TIMEOUT_MS = 15 * 60_000;

/** The exit code of a process a signal ended is 128 plus the signal's number. */
const SIGNALLED = 128;

export interface Mutant {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly command: Argv;
}

export type Played =
  | { readonly kind: "killed"; readonly code: number; readonly output: string }
  | { readonly kind: "survived"; readonly output: string }
  | { readonly kind: "refused"; readonly why: string };

/** The mutant an argv names, or null when it names none. */
export function mutantOf(argv: readonly string[]): Mutant | null {
  const [file, from, fromText, to, toText, separator, program, ...args] = argv;

  if (from !== "--from" || to !== "--to" || separator !== "--") return null;

  if (file === undefined || fromText === undefined || toText === undefined) return null;

  if (program === undefined) return null;

  return { file, from: fromText, to: toText, command: [program, ...args] };
}

export type Mutated =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "none"; readonly why: string };

/** `text` with its one `from` replaced, or why it has no such mutant. */
export function mutated(text: string, from: string, to: string): Mutated {
  if (from === "") return { kind: "none", why: "--from is empty" };

  if (from === to) return { kind: "none", why: "--from and --to are the same text" };

  const first = text.indexOf(from);

  if (first === -1) return { kind: "none", why: "does not hold the text of --from" };

  // An occurrence that overlaps the first one counts: `==` is held twice by `===`.
  if (text.includes(from, first + 1)) {
    return { kind: "none", why: "holds the text of --from more than once" };
  }

  return { kind: "text", text: text.replace(from, () => to) };
}

function tailOf(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-TAIL_LINES)
    .join("\n");
}

export async function play(
  { file, from, to, command }: Mutant,
  timeoutMs = TIMEOUT_MS,
): Promise<Played> {
  // A write replaces the path it is given: through a link, the file the link names is the one to mutate.
  const target = realpathSync(file);
  const original = readFileSync(target);
  const { mode } = statSync(target);
  const mutant = mutated(original.toString("utf8"), from, to);

  if (mutant.kind === "none") return { kind: "refused", why: `${file} ${mutant.why}` };

  const restore = (): void => {
    writeAtomicSync(target, original);
    chmodSync(target, mode);
  };

  const interrupted = (signal: NodeJS.Signals): void => {
    restore();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

  try {
    writeAtomicSync(target, mutant.text);
    chmodSync(target, mode);

    const ran = await run(command, { timeoutMs });

    if (ran.kind === "missing") {
      return { kind: "refused", why: `${ran.program} is not on the PATH` };
    }

    if (ran.kind === "timedOut") {
      return { kind: "refused", why: `the command ran past ${ran.timeoutMs / 60_000} minutes` };
    }

    if (ran.code > SIGNALLED) {
      return { kind: "refused", why: `a signal ended the command (exit ${ran.code})` };
    }

    const output = tailOf(ran.stdout, ran.stderr);

    return ran.code === 0
      ? { kind: "survived", output }
      : { kind: "killed", code: ran.code, output };
  } finally {
    restore();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }
}

export async function main(argv: readonly string[], timeoutMs = TIMEOUT_MS): Promise<number> {
  const mutant = mutantOf(argv);

  if (mutant === null) {
    console.error(USAGE);

    return 2;
  }

  let played: Played;

  try {
    played = await play(mutant, timeoutMs);
  } catch (cause) {
    console.error(`mutant: ${messageOf(cause)}`);

    return 2;
  }

  switch (played.kind) {
    case "refused":
      console.error(`mutant: ${played.why}`);

      return 2;
    case "survived":
      console.log(played.output);
      console.log(`survived  ${mutant.file}: the command passed on the mutant`);

      return 1;
    case "killed":
      console.log(played.output);
      console.log(`killed    ${mutant.file}: the command exited ${played.code} on the mutant`);

      return 0;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
