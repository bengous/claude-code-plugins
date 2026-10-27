import { homedir } from "node:os";
import path from "node:path";

import type { GitCommand } from "./argv.ts";
import { ghCommandOf, gitCommandOf } from "./argv.ts";
import type { Door, Unresolved } from "./mentions.ts";
import {
  BRANCH_OPTIONS,
  GIT_ENV,
  INLINE_CODE,
  INTERPRETERS,
  SHELLS,
  isConfigRead,
} from "./mentions.ts";
import type { DoorKind } from "./refusals.ts";
import type { Command, Line, Span, Unwrapped, Word } from "./shell.ts";
import { commandsOf, unwrap } from "./shell.ts";

/** The state a command runs in, as far as the line itself changes it. */
export type View = {
  /** null once an earlier `cd` leaves the directory unknown. */
  readonly cwd: string | null;
  readonly lost: string | null;
  /** The earlier command that changes the branch or the configuration git reads, if any. */
  readonly branch: string | null;
  readonly config: string | null;
  /** The program that runs this command's output as code (`… | bash`). */
  readonly executedBy: string | null;
  readonly unwrapped: Unwrapped;
};

export type Classification =
  | { readonly kind: "inert" }
  | { readonly kind: "door"; readonly door: Door }
  | { readonly kind: "unresolved"; readonly unresolved: Unresolved }
  /** A literal `bash -c '…'` script, read as a line of its own. */
  | { readonly kind: "nested"; readonly script: Word; readonly view: View };

/** What the walk starts from: a nested script inherits the state of the command that runs it. */
export type AssessOptions = {
  /** Whether a directory exists now; the measurement of real transcripts passes its own. */
  readonly exists?: (dir: string) => boolean;
  readonly branch?: string | null;
  readonly config?: string | null;
};

export type World = { readonly exists: (dir: string) => boolean };

export const INERT: Classification = { kind: "inert" };

export function contains(span: Span, at: number): boolean {
  return span.start <= at && at < span.end;
}

export function programOf(unwrapped: Unwrapped): string | null {
  const program = unwrapped.argv[0];

  return program === undefined ? null : path.basename(program.text);
}

export function texts(words: readonly Word[]): string[] {
  return words.map((word) => word.text);
}

/** A command that runs what it reads on stdin: a shell without `-c`, an interpreter with no file, `xargs`. */
export function stdinRunner(unwrapped: Unwrapped): string | null {
  const program = programOf(unwrapped);
  const args = texts(unwrapped.argv.slice(1));

  if (program !== null && SHELLS.has(program) && !args.some((arg) => /^-\w*c\w*$/u.test(arg))) {
    return program;
  }

  const files = args.filter((arg) => !arg.startsWith("-") || arg === "-");

  return program !== null &&
    INTERPRETERS.has(program) &&
    (files.length === 0 || files[0] === "-") &&
    !args.some((arg) => INLINE_CODE.has(arg))
    ? program
    : null;
}

/** A subshell's view of the shell: its directory, its pipeline, the variables the line assigned literally. */
type Scope = {
  dir: string | null;
  lost: string | null;
  chain: Command[];
  readonly vars: Map<string, Binding>;
};

/** A literal value the line assigned; `list` set when it holds only along the `&&` chain that assigned it. */
type Binding = { readonly value: string; readonly list: number | null };

const VARIABLE = /\$(?:\{(\w+)\}|(\w+))/gu;

const DECLARATIONS = new Set(["export", "declare", "typeset", "local", "readonly"]);

/**
 * The word with each `$NAME` and `${NAME}` the line assigned a literal value before it put in, `$HOME` and `$PWD`
 * included; unchanged while anything else in it expands (`$(…)`, `${NAME:-x}`, a name assigned at run time).
 */
function substituted(word: Word, vars: ReadonlyMap<string, string>, dir: string | null): Word {
  if (!word.expands) {
    return word;
  }

  const value = (name: string): string | undefined =>
    name === "PWD"
      ? (dir ?? undefined)
      : (vars.get(name) ?? (name === "HOME" ? home() : undefined));

  const text = word.text.replaceAll(
    VARIABLE,
    (match, braced?: string, bare?: string) => value(braced ?? bare ?? "") ?? match,
  );

  return /[$`]/u.test(text) ? word : { ...word, text, expands: false };
}

function substitutedAll(words: readonly Word[], scope: Scope): Word[] {
  const values = new Map([...scope.vars].map(([name, binding]) => [name, binding.value]));

  return words.map((word) => substituted(word, values, scope.dir));
}

/**
 * Forgets what no longer holds for `command`: a binding of another `&&` chain, or of this one once `||` broke it.
 * A binding made at the head of its list holds for the rest of the line.
 */
function prune(vars: Map<string, Binding>, command: Command): void {
  for (const [name, binding] of vars) {
    if (binding.list !== null && (binding.list !== command.list || command.join === "||")) {
      vars.delete(name);
    }
  }
}

const CONSTRUCT_OPENERS = new Set(["if", "while", "until", "for", "case", "select"]);

const CONSTRUCT_CLOSERS = new Set(["fi", "done", "esac"]);

const READ_VALUE_OPTIONS = new Set(["-p", "-d", "-n", "-N", "-t", "-u", "-i"]);

/**
 * The variables whose value the line does not fix: assigned more than once, by a loop, `read`, `mapfile`, `printf -v`,
 * `getopts`, `let` or `${NAME:=…}`, or unset.
 */
function unstableNames(line: Line, script: string): Set<string> {
  const counts = new Map<string, number>();
  const unstable = new Set<string>();

  const count = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };

  for (const command of commandsOf(line)) {
    const { argv, assignments } = unwrap(command.words, "/");
    const [program = "", ...args] = texts(argv);
    const names = args.filter((arg) => !arg.startsWith("-"));

    for (const assignment of argv.length === 0 ? assignments : []) {
      count(assignment.text.split("=")[0] ?? "");
    }

    if (DECLARATIONS.has(program) || program === "let") {
      for (const arg of args.filter((candidate) => candidate.includes("="))) {
        count(arg.split("=")[0] ?? "");
      }
    }

    if (program === "for" || program === "select") {
      unstable.add(args[0] ?? "");
    } else if (program === "read") {
      readTargets(args).forEach((name) => unstable.add(name));
    } else if (program === "mapfile" || program === "readarray" || program === "unset") {
      names.forEach((name) => unstable.add(name));
    } else if (program === "printf" && args.includes("-v")) {
      unstable.add(args[args.indexOf("-v") + 1] ?? "");
    } else if (program === "getopts") {
      unstable.add(args[1] ?? "");
    }
  }

  for (const match of script.matchAll(/\$\{(\w+):?=/gu)) {
    unstable.add(match[1] ?? "");
  }

  for (const [name, assigned] of counts) {
    if (assigned > 1) {
      unstable.add(name);
    }
  }

  return unstable;
}

function readTargets(args: readonly string[]): string[] {
  const targets: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (READ_VALUE_OPTIONS.has(arg)) {
      index += 1;
    } else if (arg === "-a") {
      targets.push(args[index + 1] ?? "");
      index += 1;
    } else if (!arg.startsWith("-")) {
      targets.push(arg);
    }
  }

  return targets;
}

function home(): string {
  return process.env["HOME"] ?? homedir();
}

/** How sure an assignment is: unconditional for the line, for its `&&` chain only, or not at all. */
type Certainty = { readonly list: number | null } | null;

/**
 * Records the literal assignments of a command that assigns and runs nothing (`S=/tmp/x`, `export S=/tmp/x`), as far
 * as `certainty` allows: an unstable name, or an assignment that may not run, leaves its variable unknown.
 */
function assign(
  words: readonly Word[],
  vars: Map<string, Binding>,
  dir: string | null,
  certainty: Certainty,
  unstable: ReadonlySet<string>,
): void {
  const values = new Map([...vars].map(([name, binding]) => [name, binding.value]));

  for (const word of words) {
    const equals = word.text.indexOf("=");
    const name = word.text.slice(0, equals);

    if (equals > 0 && /^[A-Za-z_]\w*$/u.test(name)) {
      const value = substituted({ ...word, text: word.text.slice(equals + 1) }, values, dir);

      if (value.expands || certainty === null || unstable.has(name)) {
        vars.delete(name);
      } else {
        vars.set(name, { value: value.text.replace(/^~(?=\/|$)/u, home()), list: certainty.list });
      }
    }
  }
}

/** What a command changes for the commands after it: the directory, the branch, the configuration git reads. */
type Effect = {
  readonly dir?: string | null;
  readonly lost?: string;
  readonly branch?: string;
  readonly config?: string;
};

/** What each earlier command of the line does to the state the next ones read. */
function effectOf(unwrapped: Unwrapped, dir: string | null, world: World): Effect {
  const program = programOf(unwrapped);
  const args = unwrapped.argv.slice(1);
  const words = texts(args);

  if (program === "cd" || program === "pushd") {
    const target = args.find((word) => !word.text.startsWith("-") || word.text === "-");

    if (target === undefined) {
      return { dir: home() };
    }

    if (target.expands || target.text === "-" || /^~[^/]/u.test(target.text)) {
      return { dir: null, lost: `cd ${target.text}` };
    }

    const resolved =
      dir === null ? null : path.resolve(dir, target.text.replace(/^~(?=\/|$)/u, home()));

    return resolved !== null && world.exists(resolved)
      ? { dir: resolved }
      : { dir: null, lost: `cd ${target.text}` };
  }

  if (program === "popd") {
    return { dir: null, lost: "popd" };
  }

  if (program === "source" || program === ".") {
    return { branch: `${program} ${words.join(" ")}`, config: `${program} ${words.join(" ")}` };
  }

  if (
    program !== null &&
    ["export", "unset", "declare", "typeset", "readonly"].includes(program) &&
    words.some((word) => GIT_ENV.test(word.includes("=") ? word : `${word}=`))
  ) {
    return { config: `${program} ${words.join(" ")}` };
  }

  if (program === null && unwrapped.assignments.some((word) => GIT_ENV.test(word.text))) {
    return { config: unwrapped.assignments.map((word) => word.text).join(" ") };
  }

  const git = gitCommandOf(texts(unwrapped.argv));

  if (git !== null) {
    return gitEffect(git);
  }

  const gh = ghCommandOf(texts(unwrapped.argv));
  const ghName = gh === null ? "" : `gh ${gh.group ?? ""} ${gh.action ?? ""}`;

  if (gh?.group === "pr" && gh.action === "checkout") {
    return { branch: ghName };
  }

  if (gh?.group === "repo" && (gh.action === "set-default" || gh.action === "clone")) {
    return { config: ghName };
  }

  return gh?.group === "auth" ? { config: ghName } : {};
}

const REBASE_VALUE_OPTIONS = new Set([
  "--onto",
  "-s",
  "--strategy",
  "-X",
  "--strategy-option",
  "-x",
  "--exec",
]);

/** `git rebase <upstream> <branch>` checks out <branch> first: the positionals, past the values of its options. */
function rebasePositionals(args: readonly string[]): string[] {
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (REBASE_VALUE_OPTIONS.has(arg)) {
      index += 1;
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  return positionals;
}

function gitEffect(git: GitCommand): Effect {
  const name = `git ${git.subcommand}`;
  const positionals = git.args.filter((arg) => !arg.startsWith("-"));

  switch (git.subcommand) {
    case "checkout": {
      return git.args.includes("--") ? {} : { branch: name };
    }

    case "switch": {
      return { branch: name };
    }

    case "branch": {
      return git.args.some((arg) => BRANCH_OPTIONS.has(arg.split("=")[0] ?? ""))
        ? { branch: name }
        : {};
    }

    case "rebase": {
      return rebasePositionals(git.args).length >= 2 ? { branch: `${name} … <branch>` } : {};
    }

    case "symbolic-ref": {
      return positionals.length >= 2 ? { branch: name } : {};
    }

    case "worktree": {
      return ["add", "move"].includes(positionals[0] ?? "")
        ? { branch: `${name} ${positionals[0] ?? ""}`, config: `${name} ${positionals[0] ?? ""}` }
        : {};
    }

    case "clone":
    case "init": {
      return { branch: name, config: name };
    }

    case "config": {
      return isConfigRead(git) ? {} : { config: name };
    }

    case "remote": {
      return ["add", "set-url", "rename", "remove", "rm", "set-branches", "set-head"].includes(
        positionals[0] ?? "",
      )
        ? { config: `${name} ${positionals[0] ?? ""}` }
        : {};
    }

    default: {
      return {};
    }
  }
}

/** The state each command of `line` runs in, walked in the order Bash runs them; a subshell's `cd` stays inside it. */
export function viewsOf(
  line: Line,
  script: string,
  cwd: string,
  world: World,
  options: AssessOptions,
): Map<Command, View> {
  const views = new Map<Command, View>();
  const stack: Scope[] = [];
  const chains: Command[][] = [];
  let scope: Scope = { dir: cwd, lost: null, chain: [], vars: new Map() };
  let branch: string | null = options.branch ?? null;
  let config: string | null = options.config ?? null;
  let constructs = 0;
  const unstable = unstableNames(line, script);

  for (const item of line.items) {
    if (item.kind === "open") {
      stack.push(scope);
      scope = { dir: scope.dir, lost: scope.lost, chain: [], vars: new Map(scope.vars) };
      continue;
    }

    if (item.kind === "close") {
      scope = stack.pop() ?? scope;
      continue;
    }

    const { command } = item;

    if (!command.piped) {
      scope.chain = [];
      chains.push(scope.chain);
    }

    scope.chain.push(command);
    prune(scope.vars, command);
    const words = substitutedAll(command.words, scope);
    const unwrapped = unwrap(words, scope.dir ?? cwd);
    const first = unwrapped.argv[0]?.text ?? "";
    const keyword = command.words[0]?.text ?? "";
    constructs = Math.max(0, constructs - (CONSTRUCT_CLOSERS.has(keyword) ? 1 : 0));

    const certainty: Certainty =
      constructs > 0 || command.join === "||" || command.join === "|"
        ? null
        : { list: command.join === "&&" ? command.list : null };

    if (unwrapped.argv.length === 0 && unwrapped.wrappers.length === 0) {
      assign(unwrapped.assignments, scope.vars, scope.dir, certainty, unstable);
    } else if (DECLARATIONS.has(first)) {
      assign(unwrapped.argv.slice(1), scope.vars, scope.dir, certainty, unstable);
    }

    constructs += CONSTRUCT_OPENERS.has(keyword) ? 1 : 0;

    views.set(command, {
      cwd: scope.dir === null ? null : unwrapped.cwd,
      lost: scope.lost,
      branch,
      config,
      executedBy: null,
      unwrapped,
    });

    const effect = effectOf(unwrapped, scope.dir, world);

    if (effect.dir !== undefined) {
      scope.dir = effect.dir;
      scope.lost = effect.lost ?? (effect.dir === null ? scope.lost : null);
    }

    branch = effect.branch ?? branch;
    config = effect.config ?? config;
  }

  for (const chain of chains) {
    const runnerIndex = chain.findIndex(
      (command, index) => index > 0 && stdinRunner(views.get(command)?.unwrapped ?? EMPTY) !== null,
    );

    const runner = chain[runnerIndex];
    const by = runner === undefined ? null : stdinRunner(views.get(runner)?.unwrapped ?? EMPTY);

    for (const command of chain.slice(0, Math.max(0, runnerIndex))) {
      const view = views.get(command);

      if (view !== undefined && by !== null) {
        views.set(command, { ...view, executedBy: by });
      }
    }
  }

  return views;
}

const EMPTY: Unwrapped = {
  argv: [],
  assignments: [],
  wrappers: [],
  cwd: "",
  opaque: null,
  runsNothing: false,
};

export function unresolved(kind: DoorKind, why: string): Classification {
  return { kind: "unresolved", unresolved: { kind, why } };
}

/** A word as a reason quotes it: one line, at most 60 characters. */
export function quote(text: string): string {
  const line = text.replaceAll(/\s+/gu, " ");

  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Why a door invocation cannot be judged as written, from the words that decide it; null when it can. */
export function blocker(
  view: View,
  needs: { readonly directory: boolean; readonly branch: boolean },
  decisive: readonly Word[],
): string | null {
  const { unwrapped } = view;
  const named = unwrapped.assignments.find((word) => GIT_ENV.test(word.text));
  const expanding = decisive.find((word) => word.expands);

  if (unwrapped.opaque !== null) {
    return `${unwrapped.opaque} hides its words until it runs`;
  }

  if (named !== undefined) {
    return `${named.text.split("=")[0] ?? ""} is set for it`;
  }

  if (expanding !== undefined) {
    return `${quote(expanding.text)} is known only at run time`;
  }

  if (needs.directory && view.cwd === null) {
    return `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`;
  }

  if (needs.branch && view.branch !== null) {
    return `an earlier ${quote(view.branch)} changes the branch it reads`;
  }

  return view.config === null ? null : `an earlier ${quote(view.config)} changes what it reads`;
}
