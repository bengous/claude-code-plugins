import type { GhCommand, GitCommand, PackageScript, PushTarget, ReleaseScript } from "./argv.ts";
import type { DoorKind } from "./refusals.ts";

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
  /** Labels added to pull requests; `prs` null when the command does not name each by its number. */
  | {
      readonly kind: "label";
      readonly prs: readonly number[] | null;
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

type Rule = { readonly kind: DoorKind; readonly pattern: RegExp; readonly needs: RegExp | null };

/** What ends a stretch of the line for detection; parentheses and backticks do not, so `git -C "$(…)" push` is one. */
const BOUNDARY = /[;&|\n]/u;

export const GIT = /(?<![\w.-])git(?![\w.-])/u;

const GH = /(?<![\w.-])gh(?![\w.-])/u;

const PACKAGE_MANAGER = /(?<![\w.-])(?:npm|pnpm|yarn|bun)(?![\w.-])/u;

const PUSH = /(?<![\w.-])push(?![\w-])/gu;

const MERGE = /(?<![\w.-])merges?(?![\w-])/gu;

const RELEASE = /(?<![\w.-])release(?![\w-])/gu;

export const GRAPHQL_MERGE =
  /(?<![\w.-])(?:mergePullRequest|mergeBranch|enablePullRequestAutoMerge)(?![\w-])/gu;

export const GRAPHQL_REF = /(?<![\w.-])(?:updateRefs?|deleteRef|createRef)(?![\w-])/gu;

const GIT_REFS = /(?<![\w.-])git\/refs(?![\w-])/gu;

const RELEASE_PATH = /(?<![\w-])scripts\/release(?:\.[A-Za-z]+)?(?![\w.-])/gu;

const DISPATCH = /(?<![\w.-])(?:workflow|dispatches)(?![\w-])/gu;

const LABEL =
  /(?<![\w.])(?:--add-label|--label|-l|labels|labelIds|addLabelsToLabelable)(?![\w-])/gu;

/** The variables that move git or gh to another repository, branch or configuration. */
export const GIT_ENV =
  /^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|CONFIG\w*)|GH_(?:REPO|HOST|CONFIG_DIR))=/u;

export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

export const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
  "php",
]);

export const INLINE_CODE = new Set(["-c", "-e", "-E", "--eval", "-p", "--print"]);

/** Programs that run their arguments as a command. */
export const RUNS_ARGUMENTS = new Set([
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
export const PACKAGE_EXECUTORS = new Set(["npx", "bunx", "pnpx"]);

export const FILE_RUNNERS = new Set([
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
export const INERT_ARGUMENTS = new Set([
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
export const GIT_RUNS_COMMANDS = new Set([
  "rebase",
  "submodule",
  "bisect",
  "filter-branch",
  "difftool",
  "mergetool",
]);

export const BRANCH_OPTIONS = new Set([
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

export function isConfigRead(git: GitCommand): boolean {
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

export function startsProcesses(program: string, code: string): boolean {
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
