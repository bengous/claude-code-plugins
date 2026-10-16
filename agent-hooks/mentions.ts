import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { DoorKind, GhCommand, GitCommand, PackageScript, ReleaseScript } from "./landing.ts";
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
import { parseLine, unwrap } from "./shell.ts";

/** Where the raw text of a line names a door, before any parsing. */
export type Mention = {
  readonly kind: DoorKind;
  readonly start: number;
  readonly end: number;
};

/** What the guard knows before it reads a line: the git aliases that push, the package scripts that open a door. */
export type Vocabulary = {
  readonly gitAliases: ReadonlySet<string>;
  readonly doorScripts: ReadonlySet<string>;
  /** The repository has a landing profile: `gh release create` is a door there. */
  readonly releaseDoors: boolean;
  /** Whether the repository around `dir` has a landing profile, where its release script is a door. */
  readonly releaseScriptAt: (dir: string) => boolean;
};

/** A door invocation the guard resolved: literal words, a known directory, no state change before it. */
export type Door =
  | { readonly kind: "push"; readonly git: GitCommand; readonly cwd: string }
  | { readonly kind: "merge"; readonly gh: GhCommand; readonly cwd: string }
  | { readonly kind: "release-create"; readonly gh: GhCommand; readonly cwd: string }
  | { readonly kind: "release-script"; readonly release: ReleaseScript }
  | { readonly kind: "script"; readonly script: PackageScript };

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

const BOUNDARY = /[;&|\n()`]/u;

const GIT = /(?<![\w.-])git(?![\w.-])/u;

const GH = /(?<![\w.-])gh(?![\w.-])/u;

const PACKAGE_MANAGER = /(?<![\w.-])(?:npm|pnpm|yarn|bun)(?![\w.-])/u;

const PUSH = /(?<![\w.-])push(?![\w-])/gu;

const MERGE = /(?<![\w.-])merges?(?![\w-])/gu;

const RELEASE = /(?<![\w.-])release(?![\w-])/gu;

const RELEASE_PATH = /(?<![\w-])scripts\/release(?:\.[A-Za-z]+)?(?![\w.-])/gu;

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

/** Interpreter code that references a process API can run a command; other code only computes. */
const PROCESS_API =
  /\b(?:subprocess|os\.system|os\.popen|os\.exec\w*|os\.spawn\w*|pty\.spawn|child_process|execSync|execFileSync|spawnSync|Bun\.spawn\w*|Bun\.\$|Deno\.Command|Deno\.run|IO\.popen|Open3)\b|\b(?:system|exec|popen)\s*\(/u;

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
export function findMentions(script: string, vocabulary: Vocabulary): Mention[] {
  const rules: Rule[] = [
    { kind: "push", pattern: PUSH, needs: GIT },
    ...[...vocabulary.gitAliases].map((alias): Rule => ({
      kind: "push",
      pattern: wordPattern(alias),
      needs: GIT,
    })),
    { kind: "merge", pattern: MERGE, needs: GH },
    ...(vocabulary.releaseDoors ? [{ kind: "release", pattern: RELEASE, needs: GH } as const] : []),
    { kind: "release", pattern: RELEASE_PATH, needs: null },
    ...[...vocabulary.doorScripts].map((name): Rule => ({
      kind: "script",
      pattern: wordPattern(name),
      needs: PACKAGE_MANAGER,
    })),
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
  readonly vars: Map<string, string>;
};

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
  return words.map((word) => substituted(word, scope.vars, scope.dir));
}

function home(): string {
  return process.env["HOME"] ?? homedir();
}

/** Records the literal assignments of a command that assigns and runs nothing: `S=/tmp/x`, `export S=/tmp/x`. */
function assign(words: readonly Word[], vars: Map<string, string>, dir: string | null): void {
  for (const word of words) {
    const equals = word.text.indexOf("=");
    const name = word.text.slice(0, equals);

    if (equals > 0 && /^[A-Za-z_]\w*$/u.test(name)) {
      const value = substituted({ ...word, text: word.text.slice(equals + 1) }, vars, dir);

      if (value.expands) {
        vars.delete(name);
      } else {
        vars.set(name, value.text.replace(/^~(?=\/|$)/u, home()));
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
    const words = substitutedAll(command.words, scope);
    const unwrapped = unwrap(words, scope.dir ?? cwd);
    const first = unwrapped.argv[0]?.text ?? "";

    if (unwrapped.argv.length === 0 && unwrapped.wrappers.length === 0) {
      assign(unwrapped.assignments, scope.vars, scope.dir);
    } else if (DECLARATIONS.has(first)) {
      assign(unwrapped.argv.slice(1), scope.vars, scope.dir);
    }

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

/** The endpoint word of `gh api`: its first positional, past the options and their values. */
function apiEndpoint(argv: readonly Word[]): Word | undefined {
  const api = argv.findIndex((word) => word.text === "api");

  if (api === -1) {
    return undefined;
  }

  for (let index = api + 1; index < argv.length; index += 1) {
    const text = argv[index]?.text ?? "";

    if (GH_API_VALUE_OPTIONS.has(text)) {
      index += 1;
    } else if (!text.startsWith("-")) {
      return argv[index];
    }
  }

  return undefined;
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

    const missing = locationsOf(git, cwd).find((dir) => !world.exists(dir));

    const absolute =
      git.location.length > 0 &&
      git.location.every((value, index) => index % 2 === 0 || path.isAbsolute(value));

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

  if (gh !== null && isReleaseCreate(gh) && vocabulary.releaseDoors) {
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

  if (release !== null && vocabulary.releaseScriptAt(path.dirname(release.path))) {
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

  if (script !== null && vocabulary.doorScripts.has(script.name)) {
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

  // A release script is a door only where the repository has a landing profile.
  return role.kind === "unresolved" &&
    mention.kind === "release" &&
    !vocabulary.releaseScriptAt(view.cwd ?? view.unwrapped.cwd)
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
    const endpoint = gh.group === "api" ? apiEndpoint(unwrapped.argv) : undefined;

    if (endpoint === word && mention.kind === "merge") {
      return unresolved("merge", "it calls the merge endpoint through gh api");
    }

    return gh.group === "alias" ? unresolved(mention.kind, "it defines a gh alias") : INERT;
  }

  if (SHELLS.has(program) || RUNS_ARGUMENTS.has(program)) {
    return unresolved(mention.kind, `it runs through ${program}`);
  }

  if (INTERPRETERS.has(program) && argv.some((arg) => INLINE_CODE.has(arg))) {
    return PROCESS_API.test(word.text)
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

      if (runner === null || (INTERPRETERS.has(runner) && !PROCESS_API.test(code))) {
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
  const views = viewsOf(line, cwd, world, options);
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
