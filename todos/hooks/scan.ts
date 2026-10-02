import type { Todo, TodoScan } from "../types/index.d.ts";
import {
  githubWebUrl,
  type GrepHit,
  LIST_FILE,
  type Origin,
  parseBlame,
  parseGrep,
  parseList,
  SKIPPED_EXTENSIONS,
  sortNewestFirst,
} from "./parse.ts";

const BLAME_CONCURRENCY = 6;

const GREP_NO_MATCH = 1;

type Blamed =
  | { readonly isOk: true; readonly origins: Map<number, Origin> }
  | { readonly isOk: false; readonly error: string };

export type ScanResult = TodoScan & { readonly failures: readonly string[] };

export type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

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

async function grepComments(
  host: Host,
  root: string,
  markers: readonly string[],
): Promise<GrepHit[]> {
  if (markers.length === 0) return [];

  const run = await host.run(
    [
      "git",
      "grep",
      // A configured submodule.recurse makes git refuse --untracked.
      "--no-recurse-submodules",
      "--untracked",
      "-z",
      "-n",
      "-I",
      "-F",
      ...markers.flatMap((marker) => ["-e", marker]),
      "--",
      ".",
      ...SKIPPED_EXTENSIONS.map((extension) => `:(exclude)*.${extension}`),
    ],
    root,
  );

  if (run.exitCode === GREP_NO_MATCH) return [];

  if (run.exitCode !== 0) throw new Error(`git grep failed: ${run.stderr.trim()}`);

  return parseGrep(run.stdout, markers);
}

async function blame(
  host: Host,
  root: string,
  path: string,
  lines: readonly number[] | null,
): Promise<Blamed> {
  const ranges = lines === null ? [] : lines.flatMap((line) => ["-L", `${line},${line}`]);
  const run = await host.run(["git", "blame", "--line-porcelain", ...ranges, "--", path], root);

  if (run.exitCode === 0) return { isOk: true, origins: parseBlame(run.stdout) };

  // An untracked file has no history: every line in it counts as uncommitted.
  if (run.stderr.includes("no such path")) return { isOk: true, origins: new Map() };

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
  const [hits, listText, userEmail, remote] = await Promise.all([
    grepComments(host, root, markers),
    readList(host, root),
    gitValue(host, root, ["config", "user.email"]),
    gitValue(host, root, ["remote", "get-url", "origin"]),
  ]);

  const listItems = listText === null ? [] : parseList(listText);

  const linesByPath = new Map<string, number[]>();

  for (const hit of hits)
    linesByPath.set(hit.path, [...(linesByPath.get(hit.path) ?? []), hit.line]);

  const jobs: { readonly path: string; readonly lines: readonly number[] | null }[] = [
    ...[...linesByPath].map(([path, lines]) => ({ path, lines })),
    ...(listItems.length > 0 ? [{ path: LIST_FILE, lines: null }] : []),
  ];

  const blamed = await mapPool(jobs, BLAME_CONCURRENCY, (job) =>
    blame(host, root, job.path, job.lines),
  );

  const originsByPath = new Map<string, Map<number, Origin>>();
  const failures: string[] = [];
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
