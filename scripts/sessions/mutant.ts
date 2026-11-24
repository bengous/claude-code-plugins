/**
 * Whether a test fails once the code it guards changes: writes one replacement into a file, runs a
 * command, then puts the file back byte for byte with its mode. The file may hold uncommitted work:
 * nothing is read from git.
 *
 * The command runs first on the file as it is and has to pass there: a command that fails anyway
 * proves nothing by failing on the mutant.
 *
 * The file's bytes are kept in a copy under the temporary directory for as long as the mutant is in
 * the file. A copy that exists means a mutant is in the file, played now by another run or left by
 * one that was killed: no second mutant is written over it. The file is restored only while it
 * still holds the mutant, so an edit made meanwhile is never written over either.
 *
 * Exit 0 when the command failed on the mutant, 1 when it passed, 2 when no mutant was played.
 */

import { createHash } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExclusiveSync, writeAtomicSync } from "../../tools/platform/fs.ts";
import { type Argv, run } from "../../tools/platform/process.ts";
import { messageOf } from "../../tools/platform/pure.ts";

const USAGE = `usage: mutant.ts <file> --from <text> --to <text> -- <command> [<argument>...]

  Runs the command on <file> as it is, which has to pass. Then replaces <text> of --from,
  which <file> holds once, with the one of --to, runs the command again and restores <file>.
  Prints the last lines of the command's output: a mutant that fails to parse is no proof
  of the test.

  Exit 0 when the command failed on the mutant, 1 when it passed, 2 when no mutant was played
  or it proves nothing: a text the file does not hold once, a command that fails without the
  mutant, did not start, was ended by a signal or ran past 15 minutes, a file that already
  holds a mutant, or one that changed while the command ran.`;

/** The command's last lines, enough to tell a failed assertion from a file that no longer parses. */
const TAIL_LINES = 15;

/** A mutant can make its command loop: past this, the command is killed and the file restored. */
const TIMEOUT_MS = 15 * 60_000;

/**
 * The exit codes of a process a signal ended: 128 plus the signal's number, 1 to 31. `run` folds
 * the signal into the code, so a command that exits in this range by itself reads as signalled.
 */
const SIGNALLED = { from: 129, to: 159 } as const;

/** What a shell reports for each signal this script restores the file on. */
const EXIT_ON = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

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

/** Where the bytes of the file at `target`, a real path, are kept while it holds a mutant. */
export function copyOf(target: string): string {
  return join(tmpdir(), `mutant-${createHash("sha256").update(target).digest("hex")}.original`);
}

function tailOf(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-TAIL_LINES)
    .join("\n");
}

type Ran =
  | { readonly kind: "exited"; readonly code: number; readonly output: string }
  | { readonly kind: "refused"; readonly why: string };

/** The command run to its end, or why its end says nothing about the test. */
async function ranOf(command: Argv, timeoutMs: number): Promise<Ran> {
  const ran = await run(command, { timeoutMs });

  if (ran.kind === "missing") return { kind: "refused", why: `${ran.program} is not on the PATH` };

  if (ran.kind === "timedOut") {
    return { kind: "refused", why: `the command ran past ${ran.timeoutMs / 60_000} minutes` };
  }

  if (ran.code >= SIGNALLED.from && ran.code <= SIGNALLED.to) {
    return { kind: "refused", why: `a signal ended the command (exit ${ran.code})` };
  }

  return { kind: "exited", code: ran.code, output: tailOf(ran.stdout, ran.stderr) };
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

  const before = await ranOf(command, timeoutMs);

  if (before.kind === "refused") return before;

  if (before.code !== 0) {
    return {
      kind: "refused",
      why: `the command fails without the mutant (exit ${before.code}):\n${before.output}`,
    };
  }

  const copy = copyOf(target);

  if (!createExclusiveSync(copy, original)) {
    return {
      kind: "refused",
      why: `${file} already holds a mutant, played by another run or left by one that was killed: its bytes from before are in ${copy}`,
    };
  }

  /** Whether the file was put back: false when it no longer holds the mutant this run wrote. */
  const restore = (): boolean => {
    if (readFileSync(target, "utf8") !== mutant.text) return false;

    writeAtomicSync(target, original);
    chmodSync(target, mode);
    rmSync(copy, { force: true });

    return true;
  };

  const interrupted = (signal: keyof typeof EXIT_ON): void => {
    restore();
    process.exit(EXIT_ON[signal]);
  };

  process.once("SIGHUP", interrupted);
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

  let after: Ran;

  try {
    writeAtomicSync(target, mutant.text);
    chmodSync(target, mode);
    after = await ranOf(command, timeoutMs);
  } catch (cause) {
    // The write is a rename: the file holds the mutant, which restore takes back, or its own bytes.
    if (!restore()) rmSync(copy, { force: true });

    throw cause;
  } finally {
    process.off("SIGHUP", interrupted);
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
  }

  if (!restore()) {
    return {
      kind: "refused",
      why: `${file} changed while the command ran and is left as it is: its bytes from before the mutant are in ${copy}`,
    };
  }

  if (after.kind === "refused") return after;

  return after.code === 0
    ? { kind: "survived", output: after.output }
    : { kind: "killed", code: after.code, output: after.output };
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
