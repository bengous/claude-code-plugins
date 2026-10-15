/**
 * Before a git or gh command that may commit or publish, the changes it could
 * carry are read for a kept value: the lines the index and the working tree
 * add, and every untracked file not ignored. The values never leave the mod:
 * git prints the changes, and the mod searches them.
 */

import { type Invocation, invocations, isLocal, parseInvocation, type Program } from "./shell.ts";

/** The shortest line of a value searched for: shorter lines would match ordinary text. */
const MIN_NEEDLE_LENGTH = 8;

/** More untracked files than this and the scan gives up: reading them all would hold the command too long. */
export const MAX_UNTRACKED = 1000;

/** The global options of git that decide which repository and working tree a command acts on. */
const PLACE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree"]);

/** The variables that set the same, as `GIT_DIR=... git commit` writes them. */
const PLACE_VARIABLES = new Map([
  ["GIT_DIR", "--git-dir"],
  ["GIT_WORK_TREE", "--work-tree"],
]);

const DIFF_FLAGS = [
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

export type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isStdoutTruncated: boolean;
};

/** What a scan needs from the machine; the hooks module builds it from `$`, which cannot cross an import. */
export type Host = {
  /** Runs a command in `cwd`; absent, in the session's working directory, which follows Claude's `cd`. */
  readonly run: (argv: readonly string[], cwd: string | undefined) => Promise<RunResult>;
  /** A file's text, or null for what a read cannot take whole: no regular file, or one over 4 MiB. */
  readonly read: (path: string) => Promise<string | null>;
};

export type ScanTarget =
  | {
      readonly kind: "place";
      readonly program: Program;
      /** The command as a person names it, `git commit`, `gh pr`. */
      readonly label: string;
      /** Where the command runs, relative to the session's directory or absolute; none, that directory. */
      readonly dir: string | undefined;
      /** The `-C`, `--git-dir` and `--work-tree` the command gives git, handed to every git the scan runs. */
      readonly options: readonly string[];
      /** The paths a gh command's arguments may name, which it would read and send. */
      readonly files: readonly string[];
    }
  | { readonly kind: "unknown"; readonly label: string; readonly spelling: string };

/** Where a kept value was found: a change git holds, a file git would add, a file gh is handed. */
export type Found = {
  readonly path: string;
  readonly where: "tracked" | "untracked" | "handed";
};

export type Scan =
  | { readonly kind: "clean" }
  | { readonly kind: "found"; readonly files: readonly Found[] }
  | { readonly kind: "failed"; readonly why: string };

/** A path as the shell would expand its leading `~`, or nothing where the mod cannot tell what it names. */
function expanded(path: string, home: string | undefined): string | undefined {
  if (path === "-" || /[$`]/u.test(path)) return undefined;

  if (path === "~" || path.startsWith("~/"))
    return home === undefined ? undefined : home + path.slice(1);

  return path.startsWith("~") ? undefined : path;
}

function joined(dir: string | undefined, path: string): string {
  return dir === undefined || path.startsWith("/") ? path : `${dir}/${path}`;
}

/** Each argument of a gh command that may name a file it reads: `@file`, `name=@file` and `--option=file` included. */
function ghPaths(args: readonly string[]): readonly string[] {
  return args.flatMap((arg) => {
    const value = arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;

    const path = value.includes("=@")
      ? value.slice(value.indexOf("=@") + 2)
      : value.replace(/^@/u, "");

    return path === "" || path.startsWith("-") ? [] : [path];
  });
}

function targetOf(
  program: Program,
  { before, args, cds }: Invocation,
  home: string | undefined,
): ScanTarget {
  const { options, subcommand, rest } = parseInvocation(program, args);
  const label = subcommand === undefined ? program : `${program} ${subcommand}`;
  let dir: string | undefined;

  for (const cd of cds) {
    const path = expanded(cd, home);

    if (path === undefined) return { kind: "unknown", label, spelling: `cd ${cd}` };
    dir = joined(dir, path);
  }

  // The variables git reads for its place, in front of the command, come before the options that override them.
  const assigned = before.flatMap((word) => {
    const [name = "", ...value] = word.split("=");
    const option = PLACE_VARIABLES.get(name);

    return option === undefined || value.length === 0
      ? []
      : [{ name: option, value: value.join("=") }];
  });

  const place: string[] = [];

  for (const { name, value } of program === "git" ? [...assigned, ...options] : []) {
    if (!PLACE_OPTIONS.has(name)) continue;
    const path = value === undefined ? undefined : expanded(value, home);

    if (path === undefined) return { kind: "unknown", label, spelling: `${name} ${value ?? ""}` };
    place.push(name, path);
  }

  const files: string[] = [];

  // `gh gist create .env`: the word after the subcommand names its action, the files come after.
  for (const path of program === "gh" ? ghPaths(rest.slice(1)) : []) {
    const resolved = expanded(path, home);

    if (resolved !== undefined) files.push(joined(dir, resolved));
  }

  return { kind: "place", program, label, dir, options: place, files };
}

/**
 * Each place a git or gh command of the command may commit or publish from:
 * a git subcommand outside the local ones, any gh but gh secret. A git with no
 * subcommand prints its help, and gives none.
 */
export function scanTargets(command: string, home: string | undefined): readonly ScanTarget[] {
  const targets = new Map<string, ScanTarget>();

  for (const program of ["git", "gh"] as const) {
    for (const call of invocations(command, program)) {
      if (isLocal(program, call.args)) continue;
      const target = targetOf(program, call, home);

      targets.set(
        JSON.stringify(
          target.kind === "place"
            ? [target.program, target.dir, target.options, target.files]
            : target,
        ),
        target,
      );
    }
  }

  return [...targets.values()];
}

/** What the scan looks for: each value's longest line, so a value spread over lines is found in a diff that splits it. */
export function needlesOf(values: readonly string[]): readonly string[] {
  return values.flatMap((value) => {
    const longest = value
      .split(/\r?\n/u)
      .reduce((best, line) => (line.length > best.length ? line : best), "");

    return longest.length >= MIN_NEEDLE_LENGTH ? [longest] : [];
  });
}

/** The path of a `+++` header line, quotes git puts around an unusual name kept off. */
function headerPath(line: string): string {
  const path = line.slice("+++ ".length);
  const bare = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;

  return bare.startsWith("b/") ? bare.slice("b/".length) : bare;
}

/** The files whose added lines hold a needle, read off a `-U0` diff. */
export function addedHits(diff: string, needles: readonly string[]): readonly string[] {
  const hits = new Set<string>();
  let path: string | undefined;
  let isInHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ")) {
      path = undefined;
      isInHunk = false;
    } else if (!isInHunk && line.startsWith("+++ ")) {
      path = headerPath(line);
    } else if (line.startsWith("@@")) {
      isInHunk = true;
    } else if (
      isInHunk &&
      path !== undefined &&
      line.startsWith("+") &&
      needles.some((needle) => line.includes(needle))
    ) {
      hits.add(path);
    }
  }

  return [...hits];
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** git's word for a place that is no repository at all. */
const OUTSIDE = /not a git repository/u;

type Ran =
  | { readonly kind: "ran"; readonly stdout: string }
  | { readonly kind: "failed"; readonly why: string; readonly isOutside: boolean };

type Hits =
  | { readonly kind: "read"; readonly files: readonly Found[] }
  | { readonly kind: "failed"; readonly why: string; readonly isOutside: boolean };

/** The changes of the repository at `target`, read for a needle: the lines the index and the working tree add, the untracked files. */
async function repositoryHits(
  host: Host,
  target: Extract<ScanTarget, { kind: "place" }>,
  needles: readonly string[],
): Promise<Hits> {
  const where = target.dir ?? "the working directory";

  const git = async (args: readonly string[]): Promise<Ran> => {
    const shown = `git ${args.join(" ")}`;
    let ran: RunResult;

    try {
      ran = await host.run(["git", ...target.options, ...args], target.dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        kind: "failed",
        why: `${shown} did not run in ${where}: ${message}`,
        isOutside: false,
      };
    }

    if (ran.exitCode !== 0) {
      return {
        kind: "failed",
        why: `${shown} exited ${ran.exitCode} in ${where}: ${firstLine(ran.stderr)}`,
        isOutside: OUTSIDE.test(ran.stderr),
      };
    }

    return ran.isStdoutTruncated
      ? {
          kind: "failed",
          why: `${shown} printed more than the 4 MiB the check reads`,
          isOutside: false,
        }
      : { kind: "ran", stdout: ran.stdout };
  };

  const root = await git(["rev-parse", "--show-toplevel"]);

  if (root.kind === "failed") return root;
  const staged = await git(["diff", "--cached", ...DIFF_FLAGS]);

  if (staged.kind === "failed") return staged;
  const unstaged = await git(["diff", ...DIFF_FLAGS]);

  if (unstaged.kind === "failed") return unstaged;

  const listed = await git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--full-name",
    ":/",
  ]);

  if (listed.kind === "failed") return listed;
  const untracked = listed.stdout.split("\0").filter((path) => path !== "");

  if (untracked.length > MAX_UNTRACKED) {
    return {
      kind: "failed",
      why: `${untracked.length} untracked files, more than the ${MAX_UNTRACKED} the check reads: add what is never committed to .gitignore`,
      isOutside: false,
    };
  }

  const files: Found[] = [
    ...addedHits(staged.stdout, needles),
    ...addedHits(unstaged.stdout, needles),
  ].map((path) => ({ path, where: "tracked" }));

  const top = root.stdout.trim();

  for (const path of untracked) {
    let text: string | null;

    try {
      text = await host.read(`${top}/${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return { kind: "failed", why: `${path} could not be read: ${message}`, isOutside: false };
    }

    if (text !== null && needles.some((needle) => text.includes(needle)))
      files.push({ path, where: "untracked" });
  }

  return { kind: "read", files };
}

/**
 * What a command at `target` could carry, read for a needle: the files a gh
 * command is handed, and the changes of the repository. Failed whenever the
 * changes could not all be read, but for gh outside any repository, which
 * carries none.
 */
export async function scanChanges(
  host: Host,
  target: Extract<ScanTarget, { kind: "place" }>,
  needles: readonly string[],
): Promise<Scan> {
  if (needles.length === 0) return { kind: "clean" };
  const files = new Map<string, Found>();

  for (const path of target.files) {
    // Most of a gh command's words are no path: one that names no file a read takes is no file gh sends.
    const text = await host.read(path).catch(() => null);

    if (text !== null && needles.some((needle) => text.includes(needle)))
      files.set(path, { path, where: "handed" });
  }

  const hits = await repositoryHits(host, target, needles);

  if (hits.kind === "failed" && !(target.program === "gh" && hits.isOutside))
    return { kind: "failed", why: hits.why };

  for (const found of hits.kind === "read" ? hits.files : []) files.set(found.path, found);

  return files.size === 0 ? { kind: "clean" } : { kind: "found", files: [...files.values()] };
}
