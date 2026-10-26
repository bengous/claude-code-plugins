#!/usr/bin/env bun

/**
 * CI's flaky tests: each test that failed, then passed when CI ran it again, gets one issue
 * labelled `flaky`, found again by the marker `<!-- flaky:<id> -->` in its body, and a comment for
 * each further run where it flakes, which reopens it when closed. The suite jobs write reports,
 * the `flaky` job alone writes issues:
 *
 *   retry bun --job <name> -- bun test <paths>    reruns the files whose tests failed, once
 *   retry kit --job <name> -- claude plugin test <plugin>    reruns the kit, once
 *   playwright --job <name> <report.json>    reads the tests Playwright's own retry passed
 *   report <folder>    opens, reopens or comments on the issues, from every report under the folder
 *
 * The first three write `flaky-reports/<runner>.json` and exit as the suite's last run did. Each
 * report names the run's attempt, and a run already recorded in an issue is never recorded twice,
 * so a re-run of the workflow reports only what it found itself.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { $ } from "bun";

import type { Env } from "./affected.ts";

export const LABEL = "flaky";

export const REPORTS = "flaky-reports";

const MAX_FAILURE = 2000;

const MAX_TITLE = 200;

export type Runner = "bun" | "kit" | "e2e";

export interface Flake {
  readonly id: string;
  readonly runner: Runner;
  readonly firstFailure: string;
}

export interface Report {
  readonly job: string;
  readonly runUrl: string;
  readonly flakes: readonly Flake[];
}

export interface Finished {
  readonly code: number;
  /** Its stdout, then its stderr, with `\n` line ends. */
  readonly output: string;
}

export type Exec = (argv: readonly string[]) => Promise<Finished>;

export interface Retried {
  readonly code: number;
  readonly flakes: readonly Flake[];
}

export type Gh = (args: readonly string[]) => Promise<string>;

function required(env: Env, name: string): string {
  const value = env[name];

  if (value === undefined || value === "") throw new Error(`${name} is unset`);

  return value;
}

export function runUrlOf(env: Env): string {
  const repo = `${required(env, "GITHUB_SERVER_URL")}/${required(env, "GITHUB_REPOSITORY")}`;

  return `${repo}/actions/runs/${required(env, "GITHUB_RUN_ID")}/attempts/${required(env, "GITHUB_RUN_ATTEMPT")}`;
}

function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

function clip(text: string): string {
  const trimmed = text.trim();

  return trimmed.length > MAX_FAILURE ? `${trimmed.slice(0, MAX_FAILURE)}…` : trimmed;
}

const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** HTMLRewriter hands attributes and text over as written, entities and all. */
function unescaped(text: string): string {
  return text.replaceAll(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu,
    (whole: string, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return String.fromCodePoint(Number(decimal));

      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));

      return ENTITIES.get(name ?? "") ?? whole;
    },
  );
}

export interface TestCase {
  readonly id: string;
  readonly file: string;
  readonly failure: string | null;
}

/** The test cases of bun's junit report, each with its failure, or null when it passed. */
export function junitCases(xml: string): TestCase[] {
  const cases: {
    file: string;
    classname: string;
    name: string;
    failure: { summary: string; text: string } | null;
  }[] = [];

  new HTMLRewriter()
    .on("testcase", {
      element(element) {
        cases.push({
          file: element.getAttribute("file") ?? "",
          classname: element.getAttribute("classname") ?? "",
          name: element.getAttribute("name") ?? "",
          failure: null,
        });
      },
    })
    .on("failure", {
      element(element) {
        const last = cases.at(-1);

        const summary = [element.getAttribute("type"), element.getAttribute("message")]
          .filter((part) => part !== null && part !== "")
          .join(": ");

        if (last !== undefined) last.failure = { summary, text: "" };
      },
      text(chunk) {
        const failure = cases.at(-1)?.failure;

        if (failure !== null && failure !== undefined) failure.text += chunk.text;
      },
    })
    .transform(xml);

  return cases.map(({ file, classname, name, failure }) => {
    const parts = [slashed(unescaped(file)), unescaped(classname), unescaped(name)];

    return {
      id: parts.filter((part) => part !== "").join(" > "),
      file: parts[0] ?? "",
      failure:
        failure === null
          ? null
          : clip(unescaped(failure.text.trim() === "" ? failure.summary : failure.text)),
    };
  });
}

/**
 * Why bun's first run is not retried: a retry reruns only the files junit names, so a failure
 * junit leaves out, a file that threw while loading or an error between tests, would pass unseen.
 */
export function bunRefusal(failedInJunit: number, output: string): string | null {
  if (failedInJunit === 0) return "bun's junit report names no failed test";

  const fail = /^\s*(\d+) fail$/mu.exec(output);

  if (fail === null) return "bun printed no count of failed tests";

  const errors = /^\s*(\d+) errors?$/mu.exec(output);

  if (errors !== null && Number(errors[1]) > 0) {
    return `bun counts ${errors[1]} error(s) outside any test, which junit does not name`;
  }

  if (Number(fail[1]) !== failedInJunit) {
    return `bun counts ${fail[1]} failed test(s) and its junit report names ${failedInJunit}: a file that threw while loading is missing from it`;
  }

  return null;
}

async function junitAt(path: string): Promise<TestCase[]> {
  const file = Bun.file(path);

  return (await file.exists()) ? junitCases(await file.text()) : [];
}

function junitTo(path: string): string[] {
  return ["--reporter=junit", `--reporter-outfile=${path}`];
}

/** Runs `bun test`; on a failure junit accounts for, reruns the failed files alone, once. */
export async function retryBun(argv: readonly string[], exec: Exec, dir: string): Promise<Retried> {
  const testAt = argv.indexOf("test");

  if (testAt === -1) throw new Error(`retry bun runs bun test, not: ${argv.join(" ")}`);

  await mkdir(dir, { recursive: true });

  const firstReport = join(dir, "bun-1.xml");
  const first = await exec([...argv, ...junitTo(firstReport)]);

  if (first.code === 0) return { code: 0, flakes: [] };

  const failed = (await junitAt(firstReport)).filter((testCase) => testCase.failure !== null);
  const refusal = bunRefusal(failed.length, first.output);

  if (refusal !== null) {
    console.error(`flaky-report: no retry: ${refusal}`);

    return { code: first.code, flakes: [] };
  }

  const files = [...new Set(failed.map(({ file }) => (isAbsolute(file) ? file : `./${file}`)))];
  const options = argv.filter((arg, at) => at <= testAt || arg.startsWith("-"));
  const secondReport = join(dir, "bun-2.xml");

  console.error(`flaky-report: retrying ${files.join(" ")}`);

  const second = await exec([...options, ...files, ...junitTo(secondReport)]);

  const after = await junitAt(secondReport);
  const reran = new Set(after.map(({ file }) => file));
  const failing = new Set(after.flatMap(({ id, failure }) => (failure === null ? [] : [id])));

  return {
    code: second.code,
    flakes: failed.flatMap(({ id, file, failure }) =>
      reran.has(file) && !failing.has(id)
        ? [{ id, runner: "bun" as const, firstFailure: failure ?? "" }]
        : [],
    ),
  };
}

export interface KitRun {
  readonly files: ReadonlySet<string>;
  readonly failed: readonly {
    readonly id: string;
    readonly file: string;
    readonly failure: string;
  }[];
}

/** What `claude plugin test` printed: each file it ran, each test that failed and its message. */
export function kitRun(output: string): KitRun {
  const files = new Set<string>();
  const failed: { id: string; file: string; lines: string[] }[] = [];
  let file = "";
  let current: { lines: string[] } | null = null;

  for (const line of output.split("\n")) {
    const header = /^(\S.*\.test\.tsx?):$/u.exec(line);
    const failure = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/u.exec(line);

    if (header !== null) {
      file = slashed(header[1] ?? "");
      files.add(file);
      current = null;
    } else if (failure !== null) {
      current = { lines: [] };
      failed.push({ id: `kit:${file} > ${failure[1] ?? ""}`, file, lines: current.lines });
    } else if (current !== null && /^\s/u.test(line)) {
      current.lines.push(line.trim());
    } else {
      current = null;
    }
  }

  return {
    files,
    failed: failed.map(({ id, file: path, lines }) => ({
      id,
      file: path,
      failure: clip(lines.join("\n")),
    })),
  };
}

/** Runs the kit; when its output names a failed test, runs it again, once. */
export async function retryKit(argv: readonly string[], exec: Exec): Promise<Retried> {
  const first = await exec(argv);

  if (first.code === 0) return { code: 0, flakes: [] };

  const before = kitRun(first.output);

  if (before.failed.length === 0) {
    console.error("flaky-report: no retry: the kit's output names no failed test");

    return { code: first.code, flakes: [] };
  }

  console.error("flaky-report: retrying the kit");

  const second = await exec(argv);
  const after = kitRun(second.output);
  const failing = new Set(after.failed.map(({ id }) => id));

  return {
    code: second.code,
    flakes: before.failed.flatMap(({ id, file, failure }) =>
      after.files.has(file) && !failing.has(id)
        ? [{ id, runner: "kit" as const, firstFailure: failure }]
        : [],
    ),
  };
}

interface PlaywrightResult {
  readonly status: string;
  readonly error?: { readonly message?: string };
}

interface PlaywrightSpec {
  readonly title: string;
  readonly file: string;
  readonly tests: readonly {
    readonly status: string;
    readonly results: readonly PlaywrightResult[];
  }[];
}

interface PlaywrightSuite {
  readonly title: string;
  readonly specs?: readonly PlaywrightSpec[];
  readonly suites?: readonly PlaywrightSuite[];
}

export interface PlaywrightReport {
  readonly suites: readonly PlaywrightSuite[];
}

function suiteFlakes(suite: PlaywrightSuite, titles: readonly string[]): Flake[] {
  return [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests
        .filter((test) => test.status === "flaky")
        .map((test) => ({
          id: `e2e:${slashed(spec.file)} > ${[...titles, spec.title].join(" > ")}`,
          runner: "e2e" as const,
          firstFailure: clip(
            Bun.stripANSI(
              test.results.find((result) => result.status !== "passed")?.error?.message ?? "",
            ),
          ),
        })),
    ),
    ...(suite.suites ?? []).flatMap((child) => suiteFlakes(child, [...titles, child.title])),
  ];
}

/** The tests Playwright marks `flaky`: failed, then passed on its own retry. */
export function playwrightFlakes(playwright: PlaywrightReport): Flake[] {
  return playwright.suites.flatMap((file) => suiteFlakes(file, []));
}

/**
 * `retry bun` for a caller that runs several suites in one job: each writes its report under a
 * `name` of its own. Answers the exit code of the suite's last run.
 */
export async function retryBunReported(
  argv: readonly string[],
  job: string,
  name: string,
): Promise<number> {
  const runUrl = runUrlOf(process.env);
  const { code, flakes } = await retryBun(argv, execTeed, REPORTS);
  await write(REPORTS, name, { job, runUrl, flakes });

  return code;
}

async function write(dir: string, name: string, written: Report): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, `${name}.json`), `${JSON.stringify(written, null, 2)}\n`);

  for (const flake of written.flakes) {
    console.error(`flaky-report: ${flake.id} failed, then passed on the retry`);
  }
}

/** Every report under `folder`, at any depth, as `write` wrote it; no folder holds none. */
export async function readReports(folder: string): Promise<Report[]> {
  if (!existsSync(folder)) return [];

  const reports: Report[] = [];

  for await (const path of new Bun.Glob("**/*.json").scan({ cwd: folder })) {
    const read: Report = JSON.parse(await Bun.file(join(folder, path)).text());

    reports.push(read);
  }

  return reports;
}

export interface KnownIssue {
  readonly number: number;
  readonly open: boolean;
  /** Its body, then its comments. */
  readonly texts: readonly string[];
}

export type Action =
  | {
      readonly kind: "open";
      readonly title: string;
      readonly body: string;
      readonly comments: readonly string[];
    }
  | { readonly kind: "reopen"; readonly issue: number; readonly body: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string };

interface Occurrence extends Flake {
  readonly job: string;
  readonly runUrl: string;
}

/** The line that finds a test's issue again. */
export function markerOf(id: string): string {
  return `<!-- flaky:${id.replaceAll("-->", "--&gt;")} -->`;
}

/** The line that records a run of a job as reported, so a re-run never reports it twice. */
export function recordOf(occurrence: { readonly job: string; readonly runUrl: string }): string {
  return `<!-- flaky-run:${occurrence.runUrl} ${occurrence.job} -->`;
}

function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);

  return `${fence}\n${text === "" ? "(no failure message)" : text}\n${fence}`;
}

function evidenceOf(occurrence: Occurrence): string {
  return `${occurrence.runUrl}, job \`${occurrence.job}\`, its first failure:\n\n${fenced(occurrence.firstFailure)}\n\n${recordOf(occurrence)}`;
}

function titleOf(id: string): string {
  const title = `Flaky: ${id}`;

  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE)}…` : title;
}

function openingOf(occurrence: Occurrence): string {
  return `## Problem\n\n\`${occurrence.id}\` failed, then passed when CI ran it again, so its job went green on the retry. Each further run where it flakes adds a comment here.\n\n## Evidence\n\n${evidenceOf(occurrence)}\n\n${markerOf(occurrence.id)}`;
}

function commentOf(occurrence: Occurrence): string {
  return `Flaked again: ${evidenceOf(occurrence)}`;
}

/**
 * One issue per test: a test with no issue opens one, its first occurrence in the body and any
 * other as a comment; a test with one gets a comment per occurrence no issue of it records yet, the
 * first of them reopening it when it is closed. `issues` comes newest first: a test's newest open
 * issue takes its comments, else its newest closed one. Two `flaky` jobs that both found no issue
 * leave two open ones; the older is left as it is.
 */
export function decide(reports: readonly Report[], issues: readonly KnownIssue[]): Action[] {
  const byTest = new Map<string, Occurrence[]>();

  for (const { job, runUrl, flakes } of reports) {
    for (const flake of flakes) {
      const occurrences = byTest.get(flake.id) ?? [];

      if (!occurrences.some((seen) => seen.job === job && seen.runUrl === runUrl)) {
        occurrences.push({ ...flake, job, runUrl });
      }

      byTest.set(flake.id, occurrences);
    }
  }

  return [...byTest].flatMap(([id, occurrences]): Action[] => {
    const marked = issues.filter(({ texts }) => texts.some((text) => text.includes(markerOf(id))));
    const issue = marked.find(({ open }) => open) ?? marked[0];

    if (issue === undefined) {
      const [first, ...rest] = occurrences;

      return first === undefined
        ? []
        : [
            {
              kind: "open",
              title: titleOf(id),
              body: openingOf(first),
              comments: rest.map((occurrence) => commentOf(occurrence)),
            },
          ];
    }

    const recorded = (occurrence: Occurrence): boolean =>
      marked.some(({ texts }) => texts.some((text) => text.includes(recordOf(occurrence))));

    return occurrences
      .filter((occurrence) => !recorded(occurrence))
      .map((occurrence, at): Action => ({
        kind: at === 0 && !issue.open ? "reopen" : "comment",
        issue: issue.number,
        body: commentOf(occurrence),
      }));
  });
}

interface IssueJson {
  number: number;
  state: string;
  body: string;
}

/** The `flaky` issues, open or closed, whose body marks one of `ids`, each with every comment. */
async function knownIssues(gh: Gh, repo: string, ids: readonly string[]): Promise<KnownIssue[]> {
  const listed: IssueJson[] = JSON.parse(
    await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      LABEL,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,state,body",
    ]),
  );

  const markers = ids.map((id) => markerOf(id));

  return Promise.all(
    listed
      .filter(({ body }) => markers.some((marker) => body.includes(marker)))
      .toSorted((a, b) => b.number - a.number)
      .map(async ({ number, state, body }) => ({
        number,
        open: state === "OPEN",
        texts: [
          body,
          await gh([
            "api",
            "--paginate",
            `repos/${repo}/issues/${number}/comments?per_page=100`,
            "--jq",
            ".[].body",
          ]),
        ],
      })),
  );
}

/** Reads every report under `folder`, settles what to record, records it with `gh`, says what it did. */
export async function report(env: Env, gh: Gh, folder: string): Promise<string[]> {
  const repo = required(env, "GITHUB_REPOSITORY");
  const reports = await readReports(folder);

  if (reports.every(({ flakes }) => flakes.length === 0)) return ["no flaky test in this run"];

  const ids = [...new Set(reports.flatMap(({ flakes }) => flakes.map(({ id }) => id)))];
  const actions = decide(reports, await knownIssues(gh, repo, ids));

  if (actions.length === 0) return ["every flaky test of this run is recorded already"];

  if (actions.some(({ kind }) => kind === "open")) {
    await gh([
      "label",
      "create",
      LABEL,
      "--repo",
      repo,
      "--color",
      "FBCA04",
      "--description",
      "A test that failed, then passed on CI's retry",
      "--force",
    ]);
  }

  const done: string[] = [];

  for (const action of actions) {
    if (action.kind === "open") {
      const url = (
        await gh([
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          action.title,
          "--body",
          action.body,
          "--label",
          LABEL,
        ])
      ).trim();

      for (const comment of action.comments) {
        await gh(["issue", "comment", url, "--repo", repo, "--body", comment]);
      }

      done.push(`opened ${url}`);
    } else if (action.kind === "reopen") {
      // `gh issue reopen --comment` posts nothing when the issue is open already, as another job may have made it.
      await gh(["issue", "reopen", String(action.issue), "--repo", repo]);
      await gh(["issue", "comment", String(action.issue), "--repo", repo, "--body", action.body]);
      done.push(`reopened #${action.issue}`);
    } else {
      await gh(["issue", "comment", String(action.issue), "--repo", repo, "--body", action.body]);
      done.push(`commented on #${action.issue}`);
    }
  }

  return done;
}

async function teed(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of stream) {
    sink.write(chunk);
    text += decoder.decode(chunk, { stream: true });
  }

  return text + decoder.decode();
}

/** Runs `argv` with its output shown as it comes, and kept. */
export const execTeed: Exec = async (argv) => {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    teed(child.stdout, process.stdout),
    teed(child.stderr, process.stderr),
    child.exited,
  ]);

  return { code, output: `${stdout}\n${stderr}`.replaceAll("\r\n", "\n") };
};

function ghCli(args: readonly string[]): Promise<string> {
  return $`gh ${args}`.quiet().text();
}

export type Command =
  | {
      readonly kind: "retry";
      readonly runner: "bun" | "kit";
      readonly job: string;
      readonly argv: readonly string[];
    }
  | { readonly kind: "playwright"; readonly job: string; readonly path: string }
  | { readonly kind: "report"; readonly folder: string };

export function parseArgs(args: readonly string[]): Command | null {
  const separator = args.indexOf("--");
  const [kind, ...rest] = separator === -1 ? args : args.slice(0, separator);
  const argv = separator === -1 ? [] : args.slice(separator + 1);

  if (kind === "report" && rest.length === 1 && rest[0] !== undefined && argv.length === 0) {
    return { kind, folder: rest[0] };
  }

  const [first, second, third, ...extra] = rest;

  if (extra.length > 0) return null;

  if (kind === "retry" && (first === "bun" || first === "kit") && second === "--job") {
    return third !== undefined && argv.length > 0
      ? { kind, runner: first, job: third, argv }
      : null;
  }

  if (kind === "playwright" && first === "--job" && second !== undefined && third !== undefined) {
    return argv.length === 0 ? { kind, job: second, path: third } : null;
  }

  return null;
}

const USAGE = `usage: bun ./scripts/flaky-report.ts retry <bun|kit> --job <name> -- <command...>
       bun ./scripts/flaky-report.ts playwright --job <name> <report.json>
       bun ./scripts/flaky-report.ts report <folder>`;

if (import.meta.main) {
  const command = parseArgs(process.argv.slice(2));

  if (command === null) {
    console.error(USAGE);
    process.exit(2);
  }

  switch (command.kind) {
    case "retry": {
      const runUrl = runUrlOf(process.env);

      const { code, flakes } =
        command.runner === "bun"
          ? await retryBun(command.argv, execTeed, REPORTS)
          : await retryKit(command.argv, execTeed);

      await write(REPORTS, command.runner, { job: command.job, runUrl, flakes });
      process.exit(code);
      break;
    }

    case "playwright": {
      const runUrl = runUrlOf(process.env);
      const parsed: PlaywrightReport = JSON.parse(await Bun.file(command.path).text());

      await write(REPORTS, "e2e", { job: command.job, runUrl, flakes: playwrightFlakes(parsed) });
      break;
    }

    case "report":
      for (const line of await report(process.env, ghCli, command.folder)) {
        console.log(`flaky-report: ${line}`);
      }
  }
}
