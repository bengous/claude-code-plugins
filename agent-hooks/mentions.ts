import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  DoorKind,
  GhCommand,
  GitCommand,
  PackageScript,
  PushTarget,
  ReleaseScript,
} from "./landing.ts";
import {
  CURRENT_BRANCH,
  PUSH_DESTINATION,
  ghCommandOf,
  gitCommandOf,
  isPrMerge,
  isReleaseCreate,
  isRunner,
  packageScriptOf,
  pushOf,
  releaseScriptOf,
} from "./landing.ts";
import type { Command, Line, Span, Unwrapped, Word } from "./shell.ts";
import { commandsOf, parseLine, separatorAfter, unwrap } from "./shell.ts";

/** Where the raw text of a line names a door, before any parsing. */
export type Mention = {
  readonly kind: DoorKind;
  readonly start: number;
  readonly end: number;
};

/**
 * What the guard knows of the repositories a line can reach: the git aliases that push, the package scripts that
 * open a door, the profiles. Detection reads the names; a door is decided where the walk reached.
 */
export type Vocabulary = {
  readonly gitAliases: ReadonlySet<string>;
  /** The door scripts of every manifest the line can reach: what detection looks for after a package manager. */
  readonly doorScriptNames: ReadonlySet<string>;
  /** The door scripts of the manifest a package manager finds from `dir`. */
  readonly doorScriptsAt: (dir: string) => ReadonlySet<string>;
  /** Whether the repository around `dir` has a landing profile, or one the guard cannot read: its release doors. */
  readonly profiledAt: (dir: string) => boolean;
  /** Whether a repository the line can reach declares profile.approvals, or one the guard cannot read: its gated doors. */
  readonly approvals: boolean;
};

/** A door invocation the guard resolved: literal words, a known directory, no state change before it. */
export type Door =
  | { readonly kind: "push"; readonly git: GitCommand; readonly cwd: string }
  | { readonly kind: "merge"; readonly gh: GhCommand; readonly cwd: string }
  | { readonly kind: "release-create"; readonly gh: GhCommand; readonly cwd: string }
  | { readonly kind: "release-script"; readonly release: ReleaseScript }
  /** A ref `gh api` moves: `git/refs` updated or deleted, `merges` into a base; `repo` null for the cwd's. */
  | {
      readonly kind: "api-ref";
      readonly targets: readonly PushTarget[];
      readonly repo: string | null;
      readonly cwd: string;
    }
  | { readonly kind: "script"; readonly script: PackageScript }
  /** A workflow dispatched: `workflow` as the command names it (its file, its path, its name or its id). */
  | {
      readonly kind: "dispatch";
      readonly workflow: string;
      readonly repo: string | null;
      readonly cwd: string;
    }
  /** Labels added to a pull request; `pr` null when the command names none by its number. */
  | {
      readonly kind: "label";
      readonly pr: number | null;
      readonly labels: readonly string[];
      readonly repo: string | null;
      readonly cwd: string;
    };

/** A door mention the guard cannot account for, and why. */
export type Unresolved = { readonly kind: DoorKind; readonly why: string };

export type Assessment = {
  readonly doors: readonly Door[];
  readonly unresolved: readonly Unresolved[];
};

/** The state a command runs in, as far as the line itself changes it. */
type View = {
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

type Classification =
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

type World = { readonly exists: (dir: string) => boolean };

type Rule = { readonly kind: DoorKind; readonly pattern: RegExp; readonly needs: RegExp | null };

const INERT: Classification = { kind: "inert" };

/** What ends a stretch of the line for detection; parentheses and backticks do not, so `git -C "$(…)" push` is one. */
const BOUNDARY = /[;&|\n]/u;

const GIT = /(?<![\w.-])git(?![\w.-])/u;

const GH = /(?<![\w.-])gh(?![\w.-])/u;

const PACKAGE_MANAGER = /(?<![\w.-])(?:npm|pnpm|yarn|bun)(?![\w.-])/u;

const PUSH = /(?<![\w.-])push(?![\w-])/gu;

const MERGE = /(?<![\w.-])merges?(?![\w-])/gu;

const RELEASE = /(?<![\w.-])release(?![\w-])/gu;

const GRAPHQL_MERGE =
  /(?<![\w.-])(?:mergePullRequest|mergeBranch|enablePullRequestAutoMerge)(?![\w-])/gu;

const GRAPHQL_REF = /(?<![\w.-])(?:updateRefs?|deleteRef|createRef)(?![\w-])/gu;

const GIT_REFS = /(?<![\w.-])git\/refs(?![\w-])/gu;

const RELEASE_PATH = /(?<![\w-])scripts\/release(?:\.[A-Za-z]+)?(?![\w.-])/gu;

const DISPATCH = /(?<![\w.-])(?:workflow|dispatches)(?![\w-])/gu;

const LABEL = /(?<![\w.])(?:--add-label|--label|-l|labels|addLabelsToLabelable)(?![\w-])/gu;

/** The variables that move git or gh to another repository, branch or configuration. */
const GIT_ENV =
  /^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|CONFIG\w*)|GH_(?:REPO|HOST|CONFIG_DIR))=/u;

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

const INTERPRETERS = new Set(["python", "python3", "node", "bun", "deno", "perl", "ruby", "php"]);

const INLINE_CODE = new Set(["-c", "-e", "-E", "--eval", "-p", "--print"]);

/** Programs that run their arguments as a command. */
const RUNS_ARGUMENTS = new Set([
  "eval",
  "source",
  ".",
  "ssh",
  "watch",
  "su",
  "flock",
  "script",
  "parallel",
  "nix-shell",
  "tmux",
  "screen",
  "entr",
  "nodemon",
  "docker",
  "podman",
  "kubectl",
  "setsid",
  "stdbuf",
  "unbuffer",
  "ionice",
  "taskset",
  "chrt",
  "strace",
  "ltrace",
  "firejail",
  "bwrap",
  "unshare",
  "chroot",
  "nsenter",
  "systemd-run",
]);

/** Package executors, and the tools they start that run a file argument. */
const PACKAGE_EXECUTORS = new Set(["npx", "bunx", "pnpx"]);

const FILE_RUNNERS = new Set([
  "tsx",
  "ts-node",
  "esno",
  "vite-node",
  "jiti",
  "node",
  "bun",
  "deno",
  "babel-node",
  "sucrase-node",
]);

/** Programs whose arguments are data: a file to read, a pattern, text to print. */
const INERT_ARGUMENTS = new Set([
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "ls",
  "tree",
  "find",
  "fd",
  "echo",
  "printf",
  "wc",
  "diff",
  "cmp",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "jq",
  "yq",
  "sed",
  "awk",
  "stat",
  "file",
  "readlink",
  "realpath",
  "basename",
  "dirname",
  "mkdir",
  "touch",
  "rm",
  "cp",
  "mv",
  "ln",
  "chmod",
  "chown",
  "test",
  "[",
  "true",
  "false",
  "sha256sum",
  "md5sum",
  "base64",
  "xxd",
  "od",
  "strings",
  "bat",
  "code",
  "vim",
  "nvim",
  "vi",
  "nano",
  "open",
  "xdg-open",
  "tee",
  "tar",
  "du",
  "which",
  "type",
  "man",
  "oxlint",
  "oxfmt",
  "tsgo",
  "tsc",
  "prettier",
  "eslint",
  "biome",
  "shellcheck",
  "shfmt",
  "actionlint",
]);

/** git subcommands that run a command given in their arguments. */
const GIT_RUNS_COMMANDS = new Set([
  "rebase",
  "submodule",
  "bisect",
  "filter-branch",
  "difftool",
  "mergetool",
]);

const BRANCH_OPTIONS = new Set([
  "-m",
  "-M",
  "--move",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
]);

/** `git config <key>` alone reads; these options read too, and the others write. */
const CONFIG_READS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--list",
  "-l",
  "get",
  "list",
]);

function isConfigRead(git: GitCommand): boolean {
  const positionals = git.args.filter((arg) => !arg.startsWith("-"));
  const options = git.args.filter((arg) => arg.startsWith("-"));

  return (
    git.args.some((arg) => CONFIG_READS.has(arg)) ||
    (positionals.length <= 1 &&
      options.every((option) =>
        ["--global", "--local", "--system", "--show-origin", "-z"].includes(option),
      ))
  );
}

/**
 * Interpreter code that references a process API can run a command; other code only computes. A JavaScript
 * template literal is a string, unless a `$` tag (Bun's shell) runs it; Perl, Ruby and PHP backticks run one.
 */
const PROCESS_API: ReadonlyMap<string, RegExp> = new Map([
  [
    "python",
    /\b(?:subprocess|os\.system|os\.popen|os\.exec\w*|os\.spawn\w*|pty\.spawn|commands\.getoutput)\b/u,
  ],
  [
    "javascript",
    /\b(?:child_process|execSync|execFileSync|spawnSync|Deno\.Command|Deno\.run)\b|Bun\.spawn|Bun\.\$|\$`/u,
  ],
  [
    "scripting",
    /`|\b(?:system|exec|popen|qx|IO\.popen|Open3|spawn|shell_exec|passthru|proc_open)\b|%x[{([]/u,
  ],
]);

const LANGUAGE: ReadonlyMap<string, string> = new Map([
  ["python", "python"],
  ["python3", "python"],
  ["node", "javascript"],
  ["bun", "javascript"],
  ["deno", "javascript"],
  ["perl", "scripting"],
  ["ruby", "scripting"],
  ["php", "scripting"],
]);

function startsProcesses(program: string, code: string): boolean {
  const pattern = PROCESS_API.get(LANGUAGE.get(program) ?? "");

  return pattern === undefined || pattern.test(code);
}

function wordPattern(word: string): RegExp {
  return new RegExp(
    `(?<![\\w.:-])${word.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w.:-])`,
    "gu",
  );
}

function segmentBefore(script: string, at: number): string {
  let start = at;

  while (start > 0 && !BOUNDARY.test(script[start - 1] ?? "")) {
    start -= 1;
  }

  return script.slice(start, at);
}

/**
 * Every place the raw text names a door, read broadly: the word `push` after `git` in the same stretch of the line,
 * a git alias that pushes, `merge` after `gh`, `release` after `gh` and a `scripts/release` path where the
 * repository has a landing profile, a package script that opens a door after a package manager. Quotes and
 * comments do not hide a mention: the parser decides what each one is.
 */
export function findMentions(raw: string, vocabulary: Vocabulary): Mention[] {
  // A line continuation joins two lines into one command; two spaces keep every offset where the parser puts it.
  const script = raw.replaceAll("\\\n", "  ");

  const rules: Rule[] = [
    { kind: "push", pattern: PUSH, needs: GIT },
    ...[...vocabulary.gitAliases].map((alias): Rule => ({
      kind: "push",
      pattern: wordPattern(alias),
      needs: GIT,
    })),
    { kind: "merge", pattern: MERGE, needs: GH },
    { kind: "merge", pattern: GRAPHQL_MERGE, needs: GH },
    { kind: "push", pattern: GRAPHQL_REF, needs: GH },
    { kind: "push", pattern: GIT_REFS, needs: GH },
    { kind: "release", pattern: RELEASE, needs: GH },
    { kind: "release", pattern: RELEASE_PATH, needs: null },
    ...[...vocabulary.doorScriptNames].map((name): Rule => ({
      kind: "script",
      pattern: wordPattern(name),
      needs: PACKAGE_MANAGER,
    })),
    ...(vocabulary.approvals
      ? [
          { kind: "dispatch", pattern: DISPATCH, needs: GH } satisfies Rule,
          { kind: "label", pattern: LABEL, needs: GH } satisfies Rule,
        ]
      : []),
  ];

  return rules.flatMap((rule) =>
    [...script.matchAll(rule.pattern)].flatMap((match): Mention[] => {
      const start = match.index;

      return rule.needs === null || rule.needs.test(segmentBefore(script, start))
        ? [{ kind: rule.kind, start, end: start + match[0].length }]
        : [];
    }),
  );
}

export function mentionsGit(script: string): boolean {
  return GIT.test(script);
}

export function mentionsGh(script: string): boolean {
  return GH.test(script);
}

export function mentionsPackageManager(script: string): boolean {
  return PACKAGE_MANAGER.test(script);
}

function contains(span: Span, at: number): boolean {
  return span.start <= at && at < span.end;
}

function programOf(unwrapped: Unwrapped): string | null {
  const program = unwrapped.argv[0];

  return program === undefined ? null : path.basename(program.text);
}

function texts(words: readonly Word[]): string[] {
  return words.map((word) => word.text);
}

/** A command that runs what it reads on stdin: a shell without `-c`, an interpreter with no file, `xargs`. */
function stdinRunner(unwrapped: Unwrapped): string | null {
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
function viewsOf(
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

function unresolved(kind: DoorKind, why: string): Classification {
  return { kind: "unresolved", unresolved: { kind, why } };
}

/** A word as a reason quotes it: one line, at most 60 characters. */
function quote(text: string): string {
  const line = text.replaceAll(/\s+/gu, " ");

  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Why a door invocation cannot be judged as written, from the words that decide it; null when it can. */
function blocker(
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

/** The words of a gh invocation that decide its door: `--repo`'s value, and its positionals unless `repoOnly`. */
function ghDecisive(argv: readonly Word[], repoOnly: boolean): Word[] {
  const decisive: Word[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    const text = word?.text ?? "";
    const [name = "", attached] = text.split(/=(.*)/su);

    if (word === undefined) {
      continue;
    }

    if (name === "-R" || name === "--repo") {
      const value = attached === undefined ? argv[index + 1] : word;
      index += attached === undefined ? 1 : 0;

      if (value !== undefined) {
        decisive.push(value);
      }
    } else if (text.startsWith("-R") && text.length > 2) {
      decisive.push(word);
    } else if (attached === undefined && GH_VALUE_OPTIONS.has(name)) {
      index += 1;
    } else if (!text.startsWith("-") && !repoOnly) {
      decisive.push(word);
    }
  }

  return decisive;
}

const GH_VALUE_OPTIONS = new Set([
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-t",
  "--subject",
  "--match-head-commit",
  "-A",
  "--author-email",
  "-n",
  "--notes",
  "--notes-file",
  "--title",
  "--target",
  "--discussion-category",
  "--notes-start-tag",
]);

const GH_API_VALUE_OPTIONS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

/** What a `gh api` call sends: its method, its endpoint, its fields, and whether its body comes from a file. */
type ApiCall = {
  readonly method: Word | null;
  readonly endpoint: Word | null;
  readonly fields: ReadonlyMap<string, Word>;
  /** Every field in order, a repeated one (`-f labels[]=a -f labels[]=b`) included. */
  readonly entries: readonly (readonly [string, Word])[];
  readonly bodyFromFile: boolean;
};

function apiCallOf(argv: readonly Word[]): ApiCall {
  const api = argv.findIndex((word) => word.text === "api");
  const fields = new Map<string, Word>();
  const entries: (readonly [string, Word])[] = [];
  let method: Word | null = null;
  let endpoint: Word | null = null;
  let bodyFromFile = false;

  if (api === -1) {
    return { method, endpoint, fields, entries, bodyFromFile };
  }

  for (let index = api + 1; index < argv.length; index += 1) {
    const word = argv[index];
    const text = word?.text ?? "";
    const [name = "", attached] = text.split(/=(.*)/su);
    const value = attached === undefined ? argv[index + 1] : word;

    if (word === undefined) {
      continue;
    }

    if (GH_API_VALUE_OPTIONS.has(name) && attached === undefined) {
      index += 1;
    }

    if (name === "-X" || name === "--method") {
      method = value === undefined ? null : { ...value, text: attached ?? value.text };
    } else if (["-f", "--raw-field", "-F", "--field"].includes(name) && value !== undefined) {
      const field = attached ?? value.text;
      const equals = field.indexOf("=");
      const entry = [field.slice(0, equals), { ...value, text: field.slice(equals + 1) }] as const;
      fields.set(...entry);
      entries.push(entry);
      bodyFromFile ||=
        (name === "-F" || name === "--field") && field.slice(equals + 1).startsWith("@");
    } else if (name === "--input") {
      bodyFromFile = true;
    } else if (!text.startsWith("-") && endpoint === null) {
      endpoint = word;
    }
  }

  return { method, endpoint, fields, entries, bodyFromFile };
}

const PULL_MERGE = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/u;

const BRANCH_MERGES = /^repos\/([^/]+)\/([^/]+)\/merges$/u;

const BRANCH_REF = /^repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/u;

const NEW_REF = /^repos\/([^/]+)\/([^/]+)\/git\/refs$/u;

const WORKFLOW_DISPATCH = /^repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/u;

const ISSUE_LABELS = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/u;

const ISSUE = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/u;

/** `owner/name` of an endpoint, null for gh's `{owner}/{repo}`, which names the cwd's repository. */
function apiRepo(owner: string, name: string): string | null {
  return owner === "{owner}" && name === "{repo}" ? null : `${owner}/${name}`;
}

/**
 * The door a `gh api` call opens: the merge endpoint, a branch ref moved or deleted, a GraphQL mutation; where
 * `approvals` holds, a workflow dispatch and labels added to an issue or a pull request too.
 */
function apiDoor(view: View, cwd: string, approvals: boolean): Classification | null {
  const call = apiCallOf(view.unwrapped.argv);
  const endpoint = (call.endpoint?.text ?? "").replace(/^\//u, "").replace(/\?.*$/u, "");

  const method = (
    call.method?.text ?? (call.fields.size > 0 || call.bodyFromFile ? "POST" : "GET")
  ).toUpperCase();

  const decisive = [call.endpoint, call.method, ...call.fields.values()].filter(
    (word) => word !== null,
  );

  const pull = PULL_MERGE.exec(endpoint);
  const merges = BRANCH_MERGES.exec(endpoint);
  const ref = BRANCH_REF.exec(endpoint);
  const created = NEW_REF.exec(endpoint);

  if (call.endpoint?.expands === true) {
    return unresolved("merge", `${quote(call.endpoint.text)} is known only at run time`);
  }

  if (endpoint === "graphql") {
    const query = call.fields.get("query")?.text ?? "";
    const merging = new RegExp(GRAPHQL_MERGE.source, "u").test(query);

    if (approvals && /\baddLabelsToLabelable\b/u.test(query)) {
      return unresolved("label", "a GraphQL mutation names its target by node id");
    }

    return merging || new RegExp(GRAPHQL_REF.source, "u").test(query)
      ? unresolved(merging ? "merge" : "push", "a GraphQL mutation names its target by node id")
      : null;
  }

  const target = (repo: string | null, targets: PushTarget[]): Classification => {
    const why = call.bodyFromFile
      ? "its body comes from a file"
      : blocker(view, { directory: repo === null, branch: false }, decisive);

    return why === null
      ? { kind: "door", door: { kind: "api-ref", targets, repo, cwd } }
      : unresolved("push", why);
  };

  if (pull !== null && method === "PUT") {
    const repo = apiRepo(pull[1] ?? "", pull[2] ?? "");
    const why = blocker(view, { directory: repo === null, branch: false }, decisive);

    const gh: GhCommand = {
      group: "pr",
      action: "merge",
      positionals: [pull[3] ?? ""],
      repo,
      flags: new Set(),
    };

    return why === null
      ? { kind: "door", door: { kind: "merge", gh, cwd } }
      : unresolved("merge", why);
  }

  if (merges !== null && method === "POST") {
    const base = call.fields.get("base")?.text ?? "";

    return target(apiRepo(merges[1] ?? "", merges[2] ?? ""), [
      { ref: base, forced: false, deleted: false },
    ]);
  }

  if (ref !== null && (method === "PATCH" || method === "DELETE")) {
    return target(apiRepo(ref[1] ?? "", ref[2] ?? ""), [
      {
        ref: ref[3] ?? "",
        forced: call.fields.get("force")?.text === "true",
        deleted: method === "DELETE",
      },
    ]);
  }

  const dispatched = approvals ? WORKFLOW_DISPATCH.exec(endpoint) : null;
  const labelled = approvals ? (ISSUE_LABELS.exec(endpoint) ?? ISSUE.exec(endpoint)) : null;

  if (dispatched !== null && method === "POST") {
    const repo = apiRepo(dispatched[1] ?? "", dispatched[2] ?? "");
    const why = blocker(view, { directory: repo === null, branch: false }, decisive);

    return why === null
      ? { kind: "door", door: { kind: "dispatch", workflow: dispatched[3] ?? "", repo, cwd } }
      : unresolved("dispatch", why);
  }

  if (labelled !== null && method !== "GET" && method !== "DELETE") {
    const repo = apiRepo(labelled[1] ?? "", labelled[2] ?? "");
    const labels = call.entries.filter(([name]) => /^labels(?:\[\])?$/u.test(name));

    const why = call.bodyFromFile
      ? "its body comes from a file"
      : blocker(view, { directory: repo === null, branch: false }, [
          ...(call.endpoint === null ? [] : [call.endpoint]),
          ...labels.map(([, word]) => word),
        ]);

    return why === null
      ? {
          kind: "door",
          door: {
            kind: "label",
            pr: Number(labelled[3]),
            labels: labels.map(([, word]) => word.text),
            repo,
            cwd,
          },
        }
      : unresolved("label", why);
  }

  if (created !== null && method === "POST") {
    const name = (call.fields.get("ref")?.text ?? "").replace(/^refs\/heads\//u, "");

    return target(apiRepo(created[1] ?? "", created[2] ?? ""), [
      { ref: name, forced: false, deleted: false },
    ]);
  }

  return null;
}

/** The door `command` opens, resolved or not; null when it opens none. */
function doorOf(view: View, vocabulary: Vocabulary, world: World): Classification | null {
  const { unwrapped } = view;
  const argv = texts(unwrapped.argv);
  const cwd = view.cwd ?? unwrapped.cwd;
  const git = gitCommandOf(argv);

  if (git !== null) {
    if (vocabulary.gitAliases.has(git.subcommand) || git.inlineAliases.includes(git.subcommand)) {
      return unresolved("push", `it runs through the git alias ${git.subcommand}`);
    }

    const push = git.subcommand === "push" ? pushOf(git.args) : null;

    if (push === null) {
      return null;
    }

    const moves = git.configs.find((key) => /^(?:remote|push|branch|url)\./u.test(key));

    if (moves !== undefined) {
      return unresolved("push", `git -c ${moves} changes where it pushes`);
    }

    const missing = locationsOf(git, cwd).find((dir) => !world.exists(dir));

    const absolute = isAbsoluteLocation(git.location);

    const why =
      missing === undefined
        ? blocker(
            view,
            {
              directory: !absolute,
              branch: push.targets.some(
                (target) => target.ref === CURRENT_BRANCH || target.ref === PUSH_DESTINATION,
              ),
            },
            unwrapped.argv.filter((word) => !word.text.startsWith("-")),
          )
        : `git -C ${quote(missing)}: no such directory yet`;

    return why === null
      ? { kind: "door", door: { kind: "push", git, cwd } }
      : unresolved("push", why);
  }

  const gh = ghCommandOf(argv);

  if (gh !== null && isPrMerge(gh)) {
    const why = blocker(
      view,
      { directory: gh.repo === null, branch: gh.positionals.length === 0 },
      ghDecisive(unwrapped.argv, false),
    );

    return why === null
      ? { kind: "door", door: { kind: "merge", gh, cwd } }
      : unresolved("merge", why);
  }

  if (gh?.group === "api") {
    return apiDoor(view, cwd, vocabulary.approvals);
  }

  const gated = vocabulary.approvals && gh !== null ? gatedDoorOf(view, gh, cwd) : null;

  if (gated !== null) {
    return gated;
  }

  if (gh !== null && isReleaseCreate(gh) && gh.repo === null && view.cwd === null) {
    return unresolved(
      "release",
      `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`,
    );
  }

  if (gh !== null && isReleaseCreate(gh) && vocabulary.profiledAt(cwd)) {
    const why = blocker(
      view,
      { directory: gh.repo === null, branch: false },
      ghDecisive(unwrapped.argv, true),
    );

    return why === null
      ? { kind: "door", door: { kind: "release-create", gh, cwd } }
      : unresolved("release", why);
  }

  const release = releaseScriptOf(argv, cwd);

  if (
    release !== null &&
    !release.dryRun &&
    view.cwd === null &&
    !path.isAbsolute(release.script)
  ) {
    return unresolved(
      "release",
      `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`,
    );
  }

  if (release !== null && vocabulary.profiledAt(path.dirname(release.path))) {
    if (release.dryRun) {
      return null;
    }

    const why = blocker(
      view,
      { directory: !path.isAbsolute(release.script), branch: false },
      unwrapped.argv.filter((word) => word.text === release.script),
    );

    return why === null
      ? { kind: "door", door: { kind: "release-script", release } }
      : unresolved("release", why);
  }

  const script = packageScriptOf(argv, cwd);

  if (script !== null && view.cwd === null && vocabulary.doorScriptNames.has(script.name)) {
    return unresolved(
      "script",
      `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`,
    );
  }

  if (script !== null && vocabulary.doorScriptsAt(script.cwd).has(script.name)) {
    const named = unwrapped.argv.findIndex((word) => word.text === script.name);

    const why = blocker(
      view,
      { directory: true, branch: false },
      unwrapped.argv.slice(0, named + 1),
    );

    return why === null
      ? { kind: "door", door: { kind: "script", script } }
      : unresolved("script", why);
  }

  return null;
}

/** Options of `gh workflow run`, `gh pr edit|create` and `gh issue edit` that take a value, as the next word. */
const GATED_VALUE_OPTIONS = new Set([
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-r",
  "--ref",
  "-R",
  "--repo",
  "-b",
  "--body",
  "--body-file",
  "-t",
  "--title",
  "-B",
  "--base",
  "-H",
  "--head",
  "-a",
  "--assignee",
  "--add-assignee",
  "--remove-assignee",
  "--remove-label",
  "-m",
  "--milestone",
  "-p",
  "--project",
  "--add-project",
  "--remove-project",
  "--add-reviewer",
  "--remove-reviewer",
  "--reviewer",
  "-T",
  "--template",
  "--recover",
]);

const LABEL_OPTIONS = new Set(["--add-label", "--label", "-l"]);

/** The number a `gh pr|issue` selector names: digits, `#<n>` or a URL; null for a branch. */
function numberOf(selector: string): number | null {
  const digits =
    /^#?(\d+)$/u.exec(selector)?.[1] ??
    /\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/u.exec(selector)?.[1];

  return digits === undefined ? null : Number(digits);
}

/**
 * The door a gh command opens where profile.approvals may gate it: `gh workflow run <workflow>`, or labels added by
 * `gh pr edit`, `gh issue edit` (a pull request is an issue) or `gh pr create`; null for any other.
 */
function gatedDoorOf(view: View, gh: GhCommand, cwd: string): Classification | null {
  const dispatch = gh.group === "workflow" && gh.action === "run";
  const edits = (gh.group === "pr" || gh.group === "issue") && gh.action === "edit";
  const creates = gh.group === "pr" && gh.action === "create";

  if (!dispatch && !edits && !creates) {
    return null;
  }

  const words = view.unwrapped.argv;
  const start = words.findIndex((word) => word.text === gh.group) + 2;
  const positionals: Word[] = [];
  const labels: Word[] = [];
  const decisive: Word[] = [];

  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    const text = word?.text ?? "";
    const [name = "", attached] = text.split(/=(.*)/su);

    if (word === undefined) {
      continue;
    }

    const value = attached === undefined ? words[index + 1] : { ...word, text: attached };

    if (LABEL_OPTIONS.has(name) && value !== undefined) {
      labels.push(value);
      index += attached === undefined ? 1 : 0;
    } else if ((name === "-R" || name === "--repo") && value !== undefined) {
      decisive.push(value);
      index += attached === undefined ? 1 : 0;
    } else if (GATED_VALUE_OPTIONS.has(name)) {
      index += attached === undefined ? 1 : 0;
    } else if (!text.startsWith("-")) {
      positionals.push(word);
    }
  }

  const [selector] = positionals;

  if (dispatch) {
    if (selector === undefined) {
      return null;
    }

    const why = blocker(view, { directory: gh.repo === null, branch: false }, [
      ...decisive,
      selector,
    ]);

    return why === null
      ? { kind: "door", door: { kind: "dispatch", workflow: selector.text, repo: gh.repo, cwd } }
      : unresolved("dispatch", why);
  }

  if (labels.length === 0) {
    return null;
  }

  const why = blocker(view, { directory: gh.repo === null, branch: false }, [
    ...decisive,
    ...labels,
    ...(selector === undefined ? [] : [selector]),
  ]);

  return why === null
    ? {
        kind: "door",
        door: {
          kind: "label",
          pr: creates || selector === undefined ? null : numberOf(selector.text),
          labels: labels.flatMap((word) => word.text.split(",").map((label) => label.trim())),
          repo: gh.repo,
          cwd,
        },
      }
    : unresolved("label", why);
}

function locationsOf(git: GitCommand, cwd: string): string[] {
  const dirs: string[] = [];
  let dir = cwd;

  for (let index = 0; index < git.location.length; index += 2) {
    const value = git.location[index + 1] ?? "";

    if (git.location[index] === "-C") {
      dir = path.resolve(dir, value);
      dirs.push(dir);
    }
  }

  return dirs;
}

/** What a mention that stands in an argument of a command opening no door is: data, or a command run another way. */
function argumentRole(
  mention: Mention,
  word: Word,
  view: View,
  vocabulary: Vocabulary,
): Classification {
  const role = roleOf(mention, word, view);

  // A release command is a door only where the repository has a landing profile; an unknown directory may have one.
  return role.kind === "unresolved" &&
    mention.kind === "release" &&
    view.cwd !== null &&
    !vocabulary.profiledAt(view.cwd)
    ? INERT
    : role;
}

function roleOf(mention: Mention, word: Word, view: View): Classification {
  const { unwrapped } = view;
  const program = programOf(unwrapped) ?? "";
  const argv = texts(unwrapped.argv);
  const quoted = word.quoted.some((span) => contains(span, mention.start));
  const git = gitCommandOf(argv);
  const gh = ghCommandOf(argv);

  if (git !== null) {
    const index = unwrapped.argv.indexOf(word);

    if (index > 0 && index < git.index && !quoted) {
      return unresolved(mention.kind, "it stands in a git -c option, which can define an alias");
    }

    if (GIT_RUNS_COMMANDS.has(git.subcommand)) {
      return unresolved(mention.kind, `it runs through git ${git.subcommand}`);
    }

    return git.subcommand === "config" && git.args.some((arg) => arg.startsWith("alias."))
      ? unresolved(mention.kind, "it defines a git alias")
      : INERT;
  }

  if (gh !== null) {
    return gh.group === "alias" ? unresolved(mention.kind, "it defines a gh alias") : INERT;
  }

  if (SHELLS.has(program) || RUNS_ARGUMENTS.has(program)) {
    return unresolved(mention.kind, `it runs through ${program}`);
  }

  if (INTERPRETERS.has(program) && argv.some((arg) => INLINE_CODE.has(arg))) {
    return startsProcesses(program, word.text)
      ? unresolved(mention.kind, `it runs as ${program} code that starts processes`)
      : INERT;
  }

  if (program === "find" && argv.some((arg) => arg.startsWith("-exec") || arg.startsWith("-ok"))) {
    return unresolved(mention.kind, "it runs through find -exec");
  }

  const tool = packageTool(argv);

  if (tool !== null) {
    return FILE_RUNNERS.has(path.basename(tool.name))
      ? unresolved(mention.kind, `it runs through ${tool.via} ${tool.name}`)
      : INERT;
  }

  if (quoted || INERT_ARGUMENTS.has(program) || isRunner(program)) {
    return INERT;
  }

  return mention.kind === "script"
    ? INERT
    : unresolved(mention.kind, `it runs through ${program}, which the guard does not read`);
}

/** The tool a package executor starts: `npx tsx`, `bunx tsx`, `bun x tsx`, `pnpm dlx tsx`, `npm exec tsx`. */
function packageTool(
  argv: readonly string[],
): { readonly via: string; readonly name: string } | null {
  const [program = "", first, ...rest] = argv.filter((arg) => !arg.startsWith("-"));
  const name = path.basename(program);

  if (PACKAGE_EXECUTORS.has(name)) {
    return first === undefined ? null : { via: name, name: first };
  }

  const via = `${name} ${first ?? ""}`;
  const tool = rest[0];

  return ["bun x", "pnpm dlx", "pnpm exec", "yarn dlx", "yarn exec", "npm exec"].includes(via) &&
    tool !== undefined
    ? { via, name: tool }
    : null;
}

/** A literal script of `bash -c '…'`: the word right after a `-c` flag, with nothing expanded in it. */
function isLiteralShellScript(unwrapped: Unwrapped, word: Word): boolean {
  const program = programOf(unwrapped) ?? "";
  const index = unwrapped.argv.indexOf(word);
  const flag = unwrapped.argv[index - 1]?.text ?? "";

  return SHELLS.has(program) && /^-\w*c\w*$/u.test(flag) && !word.expands;
}

function classify(
  mention: Mention,
  script: string,
  line: Line,
  views: ReadonlyMap<Command, View>,
  vocabulary: Vocabulary,
  world: World,
): Classification {
  for (const [command, view] of views) {
    const body = command.heredocs.find((span) => contains(span, mention.start));

    if (body !== undefined) {
      const runner = stdinRunner(view.unwrapped);
      const code = script.slice(body.start, body.end);

      if (body.expands && /\$\(|`/u.test(code)) {
        return unresolved(mention.kind, "its heredoc runs $(…) or backticks as the shell reads it");
      }

      if (runner === null || (INTERPRETERS.has(runner) && !startsProcesses(runner, code))) {
        return INERT;
      }

      return unresolved(mention.kind, `its heredoc feeds ${runner}`);
    }
  }

  let found: { readonly command: Command; readonly word: Word } | null = null;

  for (const command of views.keys()) {
    for (const word of command.words) {
      const narrower = found === null || word.end - word.start < found.word.end - found.word.start;

      if (contains(word, mention.start) && narrower) {
        found = { command, word };
      }
    }
  }

  if (found === null) {
    return line.inert.some((span) => contains(span, mention.start))
      ? INERT
      : unresolved(mention.kind, "the guard cannot place it in a command");
  }

  const view = views.get(found.command);

  if (view === undefined) {
    return unresolved(mention.kind, "the guard cannot place it in a command");
  }

  if (view.executedBy !== null) {
    return unresolved(mention.kind, `it is piped into ${view.executedBy}`);
  }

  if (view.unwrapped.runsNothing) {
    return INERT;
  }

  if (view.unwrapped.opaque !== null) {
    return unresolved(mention.kind, `${view.unwrapped.opaque} hides its words until it runs`);
  }

  const start = found.word.start;

  const word =
    [...view.unwrapped.argv, ...view.unwrapped.assignments].find(
      (candidate) => candidate.start === start,
    ) ?? found.word;

  const door = doorOf(view, vocabulary, world);

  if (door !== null) {
    return door;
  }

  if (isLiteralShellScript(view.unwrapped, word)) {
    return { kind: "nested", script: word, view };
  }

  if (!view.unwrapped.argv.includes(word)) {
    return word.quoted.some((span) => contains(span, mention.start)) &&
      view.unwrapped.opaque === null
      ? INERT
      : unresolved(
          mention.kind,
          `it stands in the options of ${view.unwrapped.wrappers.join(" ")}`,
        );
  }

  return argumentRole(mention, word, view, vocabulary);
}

/**
 * Accounts for every door the raw text of `script` mentions: inert text, a door invocation the guard can judge, or
 * a mention it cannot resolve. No mention, no parsing.
 */
export function assess(
  script: string,
  cwd: string,
  vocabulary: Vocabulary,
  options: AssessOptions = {},
): Assessment {
  const mentions = findMentions(script, vocabulary);

  if (mentions.length === 0) {
    return { doors: [], unresolved: [] };
  }

  const line = parseLine(script);

  if (line.definesFunction) {
    return {
      doors: [],
      unresolved: mentions.map((mention) => ({
        kind: mention.kind,
        why: "the line defines a shell function, which runs what the guard cannot follow",
      })),
    };
  }

  const world: World = { exists: options.exists ?? existsSync };
  const views = viewsOf(line, script, cwd, world, options);
  const doors: Door[] = [];
  const found: Unresolved[] = [];
  const nested = new Set<Word>();

  for (const mention of mentions) {
    const classification = classify(mention, script, line, views, vocabulary, world);

    if (classification.kind === "door") {
      doors.push(classification.door);
    } else if (classification.kind === "unresolved") {
      found.push(classification.unresolved);
    } else if (classification.kind === "nested" && !nested.has(classification.script)) {
      nested.add(classification.script);
      const { view } = classification;

      if (view.cwd === null) {
        found.push({
          kind: mention.kind,
          why: `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`,
        });
      } else {
        const inner = assess(classification.script.text, view.cwd, vocabulary, {
          exists: world.exists,
          branch: view.branch,
          config: view.config,
        });

        doors.push(...inner.doors);
        found.push(...inner.unresolved);
      }
    }
  }

  return { doors: uniqueDoors(doors), unresolved: found };
}

/** Whether a git invocation names where it acts by absolute paths alone: `-C`, `--git-dir`, `--work-tree`. */
export function isAbsoluteLocation(location: readonly string[]): boolean {
  return (
    location.length > 0 &&
    location.every((value, index) => index % 2 === 0 || path.isAbsolute(value))
  );
}

/** A `git commit` a line runs as written: where its trailers go, where it runs, and the heredoc it reads. */
export type CommitInvocation = {
  /** The offset in the line where the command starts: what the line runs before it ends there. */
  readonly start: number;
  /**
   * The offset in the line after its last argument before a `--`: options added there keep matching a permission
   * rule written for the command's start (`Bash(git commit -m:*)`).
   */
  readonly offset: number;
  /** null once an earlier `cd` leaves the directory unknown. */
  readonly cwd: string | null;
  readonly lost: string | null;
  readonly git: GitCommand;
  /** The body of the first heredoc the command reads, as written: `-F -` takes its message from it. */
  readonly heredoc: string | null;
};

const COMMIT = /(?<![\w.-])commit(?![\w.-])/u;

/**
 * Every `git commit` the line runs as written, in a subshell too. A commit inside `$(…)` or backticks, behind a
 * wrapper that hides its words (`xargs`, `env -S`), in a nested script (`bash -c`) or on a line that defines a
 * function is not one.
 */
export function commitsOf(
  script: string,
  cwd: string,
  options: AssessOptions = {},
): CommitInvocation[] {
  if (!GIT.test(script) || !COMMIT.test(script)) {
    return [];
  }

  const line = parseLine(script);

  if (line.definesFunction) {
    return [];
  }

  const views = viewsOf(line, script, cwd, { exists: options.exists ?? existsSync }, options);

  return commandsOf(line).flatMap((command) => {
    const view = views.get(command);

    if (command.substitution || view === undefined || view.unwrapped.opaque !== null) {
      return [];
    }

    const git = gitCommandOf(texts(view.unwrapped.argv));

    if (git?.subcommand !== "commit") {
      return [];
    }

    const words = view.unwrapped.argv.slice(git.index);
    const separator = separatorAfter(words, 0);
    const last = (separator === -1 ? words : words.slice(0, separator)).at(-1);
    const [heredoc] = command.heredocs;

    return last === undefined
      ? []
      : [
          {
            start: command.words[0]?.start ?? last.start,
            offset: last.end,
            cwd: view.cwd,
            lost: view.lost,
            git,
            heredoc: heredoc === undefined ? null : script.slice(heredoc.start, heredoc.end),
          },
        ];
  });
}

/** One door per invocation: a command mentioned twice (`git push origin push`) is judged once. */
function uniqueDoors(doors: readonly Door[]): Door[] {
  const seen = new Set<string>();

  return doors.filter((door) => {
    const key = JSON.stringify(door);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}
