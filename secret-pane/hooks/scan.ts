/**
 * Before a git or gh command that may commit or publish, the changes it could
 * carry are read for a kept value: the lines the index and the working tree
 * add, and every untracked file not ignored. The values never leave the mod:
 * git prints the changes, and the mod searches them.
 */

import { invocations, isLocal, parseInvocation, type Program } from "./shell.ts";

/** The shortest line of a value searched for: shorter lines would match ordinary text. */
const MIN_NEEDLE_LENGTH = 8;

/** More untracked files than this and the scan gives up: reading them all would hold the command too long. */
export const MAX_UNTRACKED = 1000;

/** The global options of git that decide which repository and working tree a command acts on. */
const PLACE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree"]);

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
      /** The command as a person names it, `git commit`, `gh pr`. */
      readonly label: string;
      /** Where the command runs, relative to the session's directory or absolute; none, that directory. */
      readonly dir: string | undefined;
      /** The `-C`, `--git-dir` and `--work-tree` the command gives git, handed to every git the scan runs. */
      readonly options: readonly string[];
    }
  | { readonly kind: "unknown"; readonly label: string; readonly spelling: string };

export type Found = { readonly path: string; readonly isTracked: boolean };

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

function targetOf(
  program: Program,
  args: readonly string[],
  cds: readonly string[],
  home: string | undefined,
): ScanTarget {
  const { options, subcommand } = parseInvocation(program, args);
  const label = subcommand === undefined ? program : `${program} ${subcommand}`;
  let dir: string | undefined;

  for (const cd of cds) {
    const path = expanded(cd, home);

    if (path === undefined) return { kind: "unknown", label, spelling: `cd ${cd}` };
    dir = dir === undefined || path.startsWith("/") ? path : `${dir}/${path}`;
  }

  const place: string[] = [];

  for (const { name, value } of program === "git" ? options : []) {
    if (!PLACE_OPTIONS.has(name)) continue;
    const path = value === undefined ? undefined : expanded(value, home);

    if (path === undefined) return { kind: "unknown", label, spelling: `${name} ${value ?? ""}` };
    place.push(name, path);
  }

  return { kind: "place", label, dir, options: place };
}

/**
 * Each place a git or gh command of the command may commit or publish from:
 * a git subcommand outside the local ones, any gh but gh secret. A git with no
 * subcommand prints its help, and gives none.
 */
export function scanTargets(command: string, home: string | undefined): readonly ScanTarget[] {
  const targets = new Map<string, ScanTarget>();

  for (const program of ["git", "gh"] as const) {
    for (const { args, cds } of invocations(command, program)) {
      if (isLocal(program, args)) continue;
      const target = targetOf(program, args, cds, home);

      targets.set(
        JSON.stringify(target.kind === "place" ? [target.dir, target.options] : target),
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

type Ran =
  | { readonly kind: "ran"; readonly stdout: string }
  | { readonly kind: "failed"; readonly why: string };

/** The changes a command at `target` could carry, read for a needle; failed whenever they could not all be read. */
export async function scanChanges(
  host: Host,
  target: Extract<ScanTarget, { kind: "place" }>,
  needles: readonly string[],
): Promise<Scan> {
  if (needles.length === 0) return { kind: "clean" };
  const where = target.dir ?? "the working directory";

  const git = async (args: readonly string[]): Promise<Ran> => {
    const shown = `git ${args.join(" ")}`;
    let ran: RunResult;

    try {
      ran = await host.run(["git", ...target.options, ...args], target.dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return { kind: "failed", why: `${shown} did not run in ${where}: ${message}` };
    }

    if (ran.exitCode !== 0) {
      return {
        kind: "failed",
        why: `${shown} exited ${ran.exitCode} in ${where}: ${firstLine(ran.stderr)}`,
      };
    }

    return ran.isStdoutTruncated
      ? { kind: "failed", why: `${shown} printed more than the 4 MiB the check reads` }
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
    };
  }

  const files = new Map<string, Found>();

  for (const path of [
    ...addedHits(staged.stdout, needles),
    ...addedHits(unstaged.stdout, needles),
  ]) {
    files.set(path, { path, isTracked: true });
  }

  const top = root.stdout.trim();

  for (const path of untracked) {
    let text: string | null;

    try {
      text = await host.read(`${top}/${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return { kind: "failed", why: `${path} could not be read: ${message}` };
    }

    if (text !== null && needles.some((needle) => text.includes(needle)))
      files.set(path, { path, isTracked: false });
  }

  return files.size === 0 ? { kind: "clean" } : { kind: "found", files: [...files.values()] };
}
