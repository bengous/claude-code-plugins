import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Comment } from "./review-verdict.ts";

// Stands in for `gh` in land.integration.test.ts: one pull request and the ci.yml runs of
// its heads, kept in a JSON file. The pull request's head is the one the bare
// origin holds for the branch, shown as soon as a push lands unless `lag`
// holds the one before for that many reads. A head gets its push run the
// first time its runs are listed. Adding the e2e label, when it is not on
// already, starts one more run on the head shown, which takes the label off
// as it shows, as ci.yml's `unlabel` job does. A re-run gives a run another
// attempt, which `rerunLag` listings still show as the attempt before. Each
// listing of a run in progress takes one poll off it; a hidden run sits out
// that many listings before it shows. An open pull request whose head origin's
// dev holds reads merged, once `mergeLag` reads have still shown it open. The
// `stacked` pull requests are the open ones based on the branch. A call whose
// arguments start with one of `failing` fails.

export type JobEnd = "success" | "failure";

export interface RunSpec {
  readonly validate: JobEnd;
  readonly e2e: JobEnd | "skipped";
  readonly polls: number;
  readonly hidden?: number;
}

interface Outcome {
  readonly validate: JobEnd;
  readonly e2e: JobEnd | "skipped";
}

interface FakeRun {
  readonly id: number;
  readonly sha: string;
  readonly past: Outcome[];
  outcome: Outcome;
  polls: number;
  hidden: number;
  stale: number;
  unlabels: boolean;
}

export interface FakeGitHub {
  readonly origin: string;
  readonly branch: string;
  readonly pr: {
    readonly number: number;
    state: string;
    readonly baseRefName: string;
    readonly comments: readonly Comment[];
    labels: string[];
  };
  mergeLag: number;
  readonly stacked: readonly number[];
  readonly failing: readonly string[];
  /** Printed by `gh pr view` in place of the pull request. */
  readonly garbage: string | null;
  /** The head the pull request has, whatever origin holds. */
  readonly pinnedHead: string | null;
  lag: number;
  shown: string | null;
  readonly pushRun: RunSpec | null;
  readonly labelRun: RunSpec;
  readonly rerun: RunSpec;
  readonly rerunLag: number;
  readonly runs: FakeRun[];
  nextId: number;
  readonly calls: string[];
  comment: string | null;
}

export type GitHubOverrides = Partial<Omit<FakeGitHub, "pr">> & {
  readonly pr?: Partial<FakeGitHub["pr"]>;
};

const GREEN_PUSH_RUN: RunSpec = { validate: "success", e2e: "skipped", polls: 0 };

const GREEN_E2E_RUN: RunSpec = { validate: "success", e2e: "success", polls: 1 };

/** Writes the GitHub `gh` reads at `file`, then a `gh` in `bin` that reads it. */
export function serveGitHub(
  bin: string,
  file: string,
  { origin, branch }: { origin: string; branch: string },
  { pr, ...overrides }: GitHubOverrides = {},
) {
  const github: FakeGitHub = {
    origin,
    branch,
    pr: { number: 7, state: "OPEN", baseRefName: "dev", comments: [], labels: [], ...pr },
    mergeLag: 0,
    stacked: [],
    failing: [],
    garbage: null,
    pinnedHead: null,
    lag: 0,
    shown: null,
    pushRun: GREEN_PUSH_RUN,
    labelRun: GREEN_E2E_RUN,
    rerun: GREEN_E2E_RUN,
    rerunLag: 2,
    runs: [],
    nextId: 100,
    calls: [],
    comment: null,
    ...overrides,
  };

  writeFileSync(file, JSON.stringify(github));
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nexec '${process.execPath}' '${import.meta.path}' '${file}' "$@"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
}

export function readGitHub(file: string): FakeGitHub {
  // SAFETY: the file holds what serveGitHub and the stub wrote.
  return JSON.parse(readFileSync(file, "utf8"));
}

function originHead({ origin, branch }: FakeGitHub): string {
  const head = Bun.spawnSync(["git", "-C", origin, "rev-parse", `refs/heads/${branch}`], {
    stdout: "pipe",
    stderr: "pipe",
  });

  return head.stdout.toString().trim();
}

function headOf(github: FakeGitHub): string {
  return github.pinnedHead ?? originHead(github);
}

function shownHead(github: FakeGitHub): string {
  const head = headOf(github);

  if (github.shown !== null && github.shown !== head && github.lag > 0) {
    github.lag -= 1;

    return github.shown;
  }

  github.shown = head;

  return head;
}

function stateOf(github: FakeGitHub): string {
  const { origin, pr } = github;

  const merged =
    Bun.spawnSync(["git", "-C", origin, "merge-base", "--is-ancestor", headOf(github), "dev"])
      .exitCode === 0;

  if (pr.state === "OPEN" && merged) {
    if (github.mergeLag > 0) github.mergeLag -= 1;
    else pr.state = "MERGED";
  }

  return pr.state;
}

function start(github: FakeGitHub, sha: string, spec: RunSpec, unlabels: boolean) {
  github.runs.push({
    id: github.nextId,
    sha,
    past: [],
    outcome: { validate: spec.validate, e2e: spec.e2e },
    polls: spec.polls,
    hidden: spec.hidden ?? 0,
    stale: 0,
    unlabels,
  });
  github.nextId += 1;
}

function conclusionOf({ validate, e2e }: Outcome): string {
  return validate === "success" && e2e !== "failure" ? "success" : "failure";
}

function listRuns(github: FakeGitHub, sha: string): string {
  if (
    github.pushRun !== null &&
    sha === headOf(github) &&
    !github.runs.some((run) => run.sha === sha)
  ) {
    start(github, sha, github.pushRun, false);
  }

  const lines: string[] = [];

  for (const run of github.runs) {
    if (run.sha !== sha) continue;

    if (run.hidden > 0) {
      run.hidden -= 1;
      continue;
    }

    if (run.unlabels) {
      github.pr.labels = github.pr.labels.filter((label) => label !== "e2e");
      run.unlabels = false;
    }

    const url = `https://github.com/o/r/actions/runs/${run.id}`;

    if (run.stale > 0) {
      lines.push(
        [run.id, "completed", conclusionOf(run.past.at(-1) ?? run.outcome), url].join("\t"),
      );
      run.stale -= 1;
      continue;
    }

    const done = run.polls === 0;

    lines.push(
      [run.id, done ? "completed" : "in_progress", done ? conclusionOf(run.outcome) : "", url].join(
        "\t",
      ),
    );

    if (!done) run.polls -= 1;
  }

  return lines.map((line) => `${line}\n`).join("");
}

function listCheckRuns(github: FakeGitHub, sha: string): string {
  const lines: string[] = [];

  for (const run of github.runs) {
    if (run.sha !== sha || run.hidden > 0) continue;

    const attempts = [
      ...run.past.map((outcome) => ({ outcome, done: true })),
      ...(run.stale > 0 ? [] : [{ outcome: run.outcome, done: run.polls === 0 }]),
    ];

    for (const [index, { outcome, done }] of attempts.entries()) {
      const job = (name: string, conclusion: string) => {
        const id = run.id * 100 + index * 10 + lines.length;

        lines.push(
          JSON.stringify({
            id,
            name,
            status: done ? "completed" : "in_progress",
            conclusion: done ? conclusion : null,
            detailsUrl: `https://github.com/o/r/actions/runs/${run.id}/job/${id}`,
          }),
        );
      };

      job("validate (scoped)", outcome.validate);

      if (outcome.e2e !== "skipped") job("e2e (light-1024)", outcome.e2e);

      if (done) job("e2e", outcome.e2e);
    }
  }

  return lines.map((line) => `${line}\n`).join("");
}

const RUNS = /actions\/workflows\/ci\.yml\/runs\?head_sha=([0-9a-f]+)&event=pull_request&/u;

const CHECK_RUNS = /commits\/([0-9a-f]+)\/check-runs\?/u;

async function answer(github: FakeGitHub, args: readonly string[]): Promise<string | null> {
  const [command, verb, target, flag, value] = args;

  if (command === "api") {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const [, runsOf] = RUNS.exec(path) ?? [];
    const [, checksOf] = CHECK_RUNS.exec(path) ?? [];

    if (runsOf !== undefined) return listRuns(github, runsOf);

    if (checksOf !== undefined) return listCheckRuns(github, checksOf);

    return null;
  }

  if (command === "pr" && verb === "view") {
    if (github.garbage !== null) return github.garbage;

    const state = stateOf(github);
    const { labels, ...pr } = github.pr;

    return JSON.stringify({
      ...pr,
      state,
      headRefOid: shownHead(github),
      labels: labels.map((name) => ({ name })),
    });
  }

  if (command === "pr" && verb === "list") {
    const base = args[args.indexOf("--base") + 1];

    return base === github.branch ? github.stacked.map((number) => `${number}\n`).join("") : "";
  }

  if (command === "pr" && verb === "comment") {
    github.comment = await Bun.stdin.text();

    return "";
  }

  if (command === "pr" && verb === "edit" && value !== undefined) {
    if (flag === "--remove-label") {
      github.pr.labels = github.pr.labels.filter((label) => label !== value);

      return "";
    }

    if (flag === "--add-label") {
      if (github.pr.labels.includes(value)) return "";

      github.pr.labels.push(value);

      if (value === "e2e") start(github, github.shown ?? headOf(github), github.labelRun, true);

      return "";
    }
  }

  if (command === "run" && verb === "rerun") {
    const run = github.runs.find((listed) => String(listed.id) === target);

    if (run === undefined) return null;

    run.past.push(run.outcome);
    run.outcome = { validate: github.rerun.validate, e2e: github.rerun.e2e };
    run.polls = github.rerun.polls;
    run.stale = github.rerunLag;

    return "";
  }

  return null;
}

if (import.meta.main) {
  const [file = "", ...args] = process.argv.slice(2);
  const github = readGitHub(file);

  const call = args.join(" ");

  github.calls.push(call);

  const out = github.failing.some((prefix) => call.startsWith(prefix))
    ? null
    : await answer(github, args);

  writeFileSync(file, JSON.stringify(github));

  if (out === null) {
    console.error(`fake gh: no answer for gh ${args.join(" ")}`);
    process.exit(1);
  }

  process.stdout.write(out);
}
