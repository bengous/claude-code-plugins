import type { Todo } from "../types/index.d.ts";
import {
  ATTRIBUTE_PATHSPECS,
  EXCLUDING_ATTRIBUTE_NAMES,
  githubWebUrl,
  type GrepHit,
  isExcludedByAttributes,
  LIST_FILE,
  type Origin,
  parseBlame,
  parseGrep,
  parseList,
  SKIPPED_EXTENSIONS,
  sortNewestFirst,
} from "./parse.ts";

const DEFAULT_BLAME_CONCURRENCY = 6;

// Measured on openai/codex with 16 CPUs: 12 blames at once took 964 ms, 16 took 834 ms, and more gained nothing.
const MAX_BLAME_CONCURRENCY = 16;

const GREP_NO_MATCH = 1;

type Blamed =
  | { readonly isOk: true; readonly origins: Map<number, Origin> }
  | { readonly isOk: false; readonly error: string };

export type ScanResult = {
  readonly scannedAt: number;
  readonly root: string;
  readonly userEmail: string | null;
  readonly issueBase: string | null;
  readonly todos: readonly Todo[];
  readonly failures: readonly string[];
};

export type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly isStdoutTruncated: boolean;
};

type Grepped = { readonly hits: readonly GrepHit[]; readonly isTruncated: boolean };

export type Located = { readonly root: string; readonly path: string };

// An untracked file, or a repository with no commit yet, has no history, so its lines count as uncommitted.
const NO_HISTORY = /no such path|no such ref/u;

/** What a scan needs from the machine; the hooks module builds it from `$`, which cannot cross an import. */
export type Host = {
  readonly run: (argv: readonly string[], cwd: string) => Promise<RunResult>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly read: (path: string) => Promise<string>;
};

export async function repoRoot(host: Host, cwd: string): Promise<string | null> {
  const run = await host.run(["git", "rev-parse", "--show-toplevel"], cwd);

  return run.exitCode === 0 ? run.stdout.trim() : null;
}

/**
 * Where an edited file sits, as git names it: asked from the file's own directory, so a symlinked
 * path or a Windows path with backslashes still lands on the repository-relative path.
 */
export async function locate(host: Host, filePath: string): Promise<Located | null> {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));

  if (slash < 0) return null;

  const run = await host
    .run(["git", "rev-parse", "--show-toplevel", "--show-prefix"], filePath.slice(0, slash) || "/")
    .catch(() => null);

  const [root, prefix] = run?.exitCode === 0 ? run.stdout.split("\n") : [];

  if (root === undefined || root === "" || prefix === undefined) return null;

  return { root, path: `${prefix}${filePath.slice(slash + 1)}` };
}

export async function isExcludedPath(host: Host, root: string, path: string): Promise<boolean> {
  const run = await host.run(
    ["git", "check-attr", "-z", ...EXCLUDING_ATTRIBUTE_NAMES, "--", path],
    root,
  );

  if (run.exitCode !== 0) throw new Error(`git check-attr ${path} failed: ${run.stderr.trim()}`);

  return isExcludedByAttributes(run.stdout);
}

async function grepComments(
  host: Host,
  root: string,
  markers: readonly string[],
): Promise<Grepped> {
  if (markers.length === 0) return { hits: [], isTruncated: false };

  const run = await host.run(
    [
      "git",
      "grep",
      // A configured submodule.recurse makes git refuse --untracked.
      "--no-recurse-submodules",
      "--untracked",
      // color.ui=always would wrap each marker in escape codes.
      "--no-color",
      "-z",
      "-n",
      "-I",
      "-F",
      ...markers.flatMap((marker) => ["-e", marker]),
      "--",
      ".",
      ...SKIPPED_EXTENSIONS.map((extension) => `:(exclude,icase)*.${extension}`),
      ...ATTRIBUTE_PATHSPECS,
    ],
    root,
  );

  if (run.exitCode === GREP_NO_MATCH) return { hits: [], isTruncated: false };

  if (run.exitCode !== 0) throw new Error(`git grep failed: ${run.stderr.trim()}`);

  return { hits: parseGrep(run.stdout, markers), isTruncated: run.isStdoutTruncated };
}

async function blame(
  host: Host,
  root: string,
  path: string,
  lines: readonly number[] | null,
): Promise<Blamed> {
  const ranges = lines === null ? [] : lines.flatMap((line) => ["-L", `${line},${line}`]);
  let run: RunResult;

  try {
    run = await host.run(["git", "blame", "--line-porcelain", ...ranges, "--", path], root);
  } catch (error) {
    return {
      isOk: false,
      error: `git blame ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (run.exitCode === 0) return { isOk: true, origins: parseBlame(run.stdout) };

  if (NO_HISTORY.test(run.stderr)) return { isOk: true, origins: new Map() };

  return { isOk: false, error: `git blame ${path}: ${run.stderr.trim()}` };
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];

      if (item !== undefined) results[index] = await work(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

// A hooks module has no `os`: getconf counts the CPUs on Linux and macOS, and Windows, without it, keeps the default.
async function blameConcurrency(host: Host, root: string): Promise<number> {
  const run = await host.run(["getconf", "_NPROCESSORS_ONLN"], root).catch(() => null);
  const count = run?.exitCode === 0 ? Number.parseInt(run.stdout, 10) : Number.NaN;

  return Number.isInteger(count) && count > 0
    ? Math.min(count, MAX_BLAME_CONCURRENCY)
    : DEFAULT_BLAME_CONCURRENCY;
}

/** One line of git output, or null when git exits non-zero: an unset `user.email`, no `origin` remote. */
async function gitValue(host: Host, root: string, args: readonly string[]): Promise<string | null> {
  const run = await host.run(["git", ...args], root);
  const value = run.stdout.trim();

  return run.exitCode === 0 && value !== "" ? value : null;
}

async function readList(host: Host, root: string): Promise<string | null> {
  const path = `${root}/${LIST_FILE}`;

  return (await host.exists(path)) ? host.read(path) : null;
}

export async function scanRepo(
  host: Host,
  root: string,
  markers: readonly string[],
  scannedAt: number,
): Promise<ScanResult> {
  const [{ hits, isTruncated }, listText, userEmail, remote, concurrency] = await Promise.all([
    grepComments(host, root, markers),
    readList(host, root),
    gitValue(host, root, ["config", "user.email"]),
    gitValue(host, root, ["remote", "get-url", "origin"]),
    blameConcurrency(host, root),
  ]);

  const listItems = listText === null ? [] : parseList(listText);

  const linesByPath = new Map<string, number[]>();

  for (const hit of hits)
    linesByPath.set(hit.path, [...(linesByPath.get(hit.path) ?? []), hit.line]);

  const jobs: { readonly path: string; readonly lines: readonly number[] | null }[] = [
    ...[...linesByPath].map(([path, lines]) => ({ path, lines })),
    ...(listItems.length > 0 ? [{ path: LIST_FILE, lines: null }] : []),
  ];

  const blamed = await mapPool(jobs, concurrency, (job) => blame(host, root, job.path, job.lines));

  const originsByPath = new Map<string, Map<number, Origin>>();
  const failures: string[] = isTruncated ? ["git grep printed over 4 MiB: the list is cut"] : [];
  jobs.forEach((job, index) => {
    const result = blamed[index];

    if (result?.isOk === true) originsByPath.set(job.path, result.origins);
    else if (result !== undefined) failures.push(result.error);
  });

  const originOf = (path: string, line: number): Origin =>
    originsByPath.get(path)?.get(line) ?? {
      commit: null,
      authoredAt: scannedAt,
      authorEmail: null,
    };

  const todos: Todo[] = [
    ...listItems.map((item): Todo => ({
      source: "list",
      path: LIST_FILE,
      line: item.line,
      marker: "TODO",
      tag: null,
      text: item.text,
      ...originOf(LIST_FILE, item.line),
    })),
    ...hits.map((hit): Todo => ({ source: "comment", ...hit, ...originOf(hit.path, hit.line) })),
  ];

  return {
    scannedAt,
    root,
    userEmail,
    issueBase: remote === null ? null : githubWebUrl(remote),
    todos: sortNewestFirst(todos),
    failures,
  };
}
