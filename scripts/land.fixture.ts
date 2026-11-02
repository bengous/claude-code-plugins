import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Comment } from "./landing/review-verdict.ts";

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
// `stacked` pull requests are the open ones based on the branch. `redDev` are
// the open `red-dev` issues, `landOkAt` the times `land-ok` was added to the
// pull request, oldest first, and `pushes` the branch's pushes GitHub lists,
// each at a time, from a head or else git's zero oid, to a commit or else the
// head origin holds; a label created is one more call. A comment posted is
// kept, its `--body` or else its stdin. A call whose arguments start with one
// of `failing` fails.
//
// The `layers` are more pull requests, each on a branch of its own, read by
// number or branch: one reads merged once origin's branch of its base holds
// its head, after its own `mergeLag` reads. `stacks` are the GitHub stacks the
// REST endpoint answers, their pull requests bottom first; any other number
// answers 404, as a pull request number gh cannot resolve answers its GraphQL
// error. A `workflow_dispatch` starts a `dispatchRun` on the branch's head and
// answers its id. `branchPushes` are the pushes GitHub lists for a layer's
// branch, one at 2000-01-01 to the head origin holds unless given.

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
  readonly event: string;
  readonly past: Outcome[];
  outcome: Outcome;
  polls: number;
  hidden: number;
  stale: number;
  unlabels: boolean;
}

interface Push {
  readonly at: string;
  readonly sha?: string;
  readonly before?: string;
}

/** A pull request besides the default one: a layer of a stack, on its own branch. */
export interface FakeLayer {
  readonly number: number;
  readonly branch: string;
  readonly baseRefName: string;
  state: string;
  labels: string[];
  readonly comments: readonly Comment[];
  readonly landOkAt: readonly string[];
  readonly isDraft: boolean;
  mergeLag: number;
}

export interface FakeGitHub {
  readonly origin: string;
  readonly branch: string;
  readonly pr: {
    readonly number: number;
    state: string;
    readonly baseRefName: string;
    readonly url: string;
    readonly comments: readonly Comment[];
    readonly body: string;
    labels: string[];
  };
  readonly layers: FakeLayer[];
  readonly stacks: readonly { readonly number: number; readonly layers: readonly number[] }[];
  readonly branchPushes: Readonly<Record<string, readonly Push[]>>;
  mergeLag: number;
  readonly stacked: readonly number[];
  readonly redDev: readonly number[];
  readonly landOkAt: readonly string[];
  readonly pushes: readonly Push[];
  readonly failing: readonly string[];
  /** Printed by `gh pr view` in place of the pull request. */
  readonly garbage: string | null;
  /** The head the pull request has, whatever origin holds. */
  readonly pinnedHead: string | null;
  lag: number;
  shown: string | null;
  readonly pushRun: RunSpec | null;
  readonly labelRun: RunSpec;
  readonly dispatchRun: RunSpec;
  readonly rerun: RunSpec;
  readonly rerunLag: number;
  readonly runs: FakeRun[];
  nextId: number;
  readonly calls: string[];
  comment: string | null;
}

export type LayerSpec = Pick<FakeLayer, "number" | "branch" | "baseRefName"> &
  Partial<Omit<FakeLayer, "number" | "branch" | "baseRefName">>;

export type GitHubOverrides = Partial<Omit<FakeGitHub, "pr" | "layers">> & {
  readonly pr?: Partial<FakeGitHub["pr"]>;
  readonly layers?: readonly LayerSpec[];
};

/** A call gh ends with a code and stderr of its own, as GitHub's errors do. */
class Failure {
  constructor(
    readonly exit: number,
    readonly stderr: string,
  ) {}
}

const GREEN_PUSH_RUN: RunSpec = { validate: "success", e2e: "skipped", polls: 0 };

const GREEN_E2E_RUN: RunSpec = { validate: "success", e2e: "success", polls: 1 };

/** Writes the GitHub `gh` reads at `file`, then a `gh` in `bin` that reads it. */
export function serveGitHub(
  bin: string,
  file: string,
  { origin, branch }: { origin: string; branch: string },
  { pr, layers = [], ...overrides }: GitHubOverrides = {},
) {
  const github: FakeGitHub = {
    origin,
    branch,
    pr: {
      number: 7,
      state: "OPEN",
      baseRefName: "dev",
      url: "https://github.com/o/r/pull/7",
      comments: [],
      body: "",
      labels: [],
      ...pr,
    },
    layers: layers.map((layer) => ({
      state: "OPEN",
      labels: [],
      comments: [],
      landOkAt: [],
      isDraft: false,
      mergeLag: 0,
      ...layer,
    })),
    stacks: [],
    branchPushes: {},
    mergeLag: 0,
    stacked: [],
    redDev: [],
    landOkAt: [],
    pushes: [{ at: "2000-01-01T00:00:00Z" }],
    failing: [],
    garbage: null,
    pinnedHead: null,
    lag: 0,
    shown: null,
    pushRun: GREEN_PUSH_RUN,
    labelRun: GREEN_E2E_RUN,
    dispatchRun: GREEN_E2E_RUN,
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

function originHead({ origin }: FakeGitHub, branch: string): string {
  const head = Bun.spawnSync(["git", "-C", origin, "rev-parse", `refs/heads/${branch}`], {
    stdout: "pipe",
    stderr: "pipe",
  });

  return head.stdout.toString().trim();
}

function headOf(github: FakeGitHub): string {
  return github.pinnedHead ?? originHead(github, github.branch);
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

function holds({ origin }: FakeGitHub, branch: string, head: string): boolean {
  return (
    head !== "" &&
    Bun.spawnSync([
      "git",
      "-C",
      origin,
      "merge-base",
      "--is-ancestor",
      head,
      `refs/heads/${branch}`,
    ]).exitCode === 0
  );
}

function stateOf(github: FakeGitHub): string {
  const { pr } = github;

  if (pr.state === "OPEN" && holds(github, "dev", headOf(github))) {
    if (github.mergeLag > 0) github.mergeLag -= 1;
    else pr.state = "MERGED";
  }

  return pr.state;
}

function layerState(github: FakeGitHub, layer: FakeLayer): string {
  if (
    layer.state === "OPEN" &&
    holds(github, layer.baseRefName, originHead(github, layer.branch))
  ) {
    if (layer.mergeLag > 0) layer.mergeLag -= 1;
    else layer.state = "MERGED";
  }

  return layer.state;
}

function start(github: FakeGitHub, sha: string, spec: RunSpec, unlabels: boolean, event: string) {
  github.runs.push({
    id: github.nextId,
    sha,
    event,
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

function listRuns(github: FakeGitHub, sha: string, event: string): string {
  if (
    event === "pull_request" &&
    github.pushRun !== null &&
    sha === headOf(github) &&
    !github.runs.some((run) => run.sha === sha && run.event === event)
  ) {
    start(github, sha, github.pushRun, false, event);
  }

  const lines: string[] = [];

  for (const run of github.runs) {
    if (run.sha !== sha || run.event !== event) continue;

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

/** The pull request a selector names, by number or by branch: the default one, a layer, or none. */
function selected(github: FakeGitHub, selector: string): "default" | FakeLayer | null {
  if (selector === String(github.pr.number) || selector === github.branch) return "default";

  return (
    github.layers.find((layer) => selector === String(layer.number) || selector === layer.branch) ??
    null
  );
}

/** Every field `gh pr view --json` may be asked of a pull request, as gh prints them. */
function viewOf(github: FakeGitHub, pr: "default" | FakeLayer) {
  if (pr === "default") {
    const state = stateOf(github);
    const { labels, ...rest } = github.pr;

    return {
      ...rest,
      state,
      headRefName: github.branch,
      headRefOid: shownHead(github),
      isDraft: false,
      labels: labels.map((name) => ({ name })),
    };
  }

  return {
    number: pr.number,
    state: layerState(github, pr),
    baseRefName: pr.baseRefName,
    headRefName: pr.branch,
    headRefOid: originHead(github, pr.branch),
    isDraft: pr.isDraft,
    url: `https://github.com/o/r/pull/${pr.number}`,
    comments: pr.comments,
    body: "",
    labels: pr.labels.map((name) => ({ name })),
  };
}

/** The fields `--json` names of `view`; null when one is a field gh does not know. */
function fieldsOf(args: readonly string[], view: ReturnType<typeof viewOf>): string | null {
  const fields = (args[args.indexOf("--json") + 1] ?? "").split(",");

  if (!fields.every((field) => Object.hasOwn(view, field))) return null;

  return JSON.stringify(
    Object.fromEntries(Object.entries(view).filter(([field]) => fields.includes(field))),
  );
}

function stackOf(github: FakeGitHub, number: number): string | Failure {
  const stack = github.stacks.find((listed) => listed.number === number);

  if (stack === undefined) return new Failure(1, "gh: Not Found (HTTP 404)");

  return JSON.stringify({
    number,
    base: { ref: "dev" },
    open: true,
    pull_requests: stack.layers.map((n) => {
      const layer = github.layers.find((listed) => listed.number === n);

      if (layer === undefined) throw new Error(`stack #${number} names #${n}, which no layer is`);

      const state = layerState(github, layer);

      return {
        number: n,
        state: state === "OPEN" ? "open" : "closed",
        merged_at: state === "MERGED" ? "2000-01-01T00:00:00Z" : null,
        draft: layer.isDraft,
        head: { ref: layer.branch, sha: originHead(github, layer.branch) },
        base: { ref: layer.baseRefName, sha: originHead(github, layer.baseRefName) },
      };
    }),
  });
}

function pushesOf(github: FakeGitHub, branch: string): string {
  const pushes =
    branch === github.branch
      ? github.pushes
      : (github.branchPushes[branch] ?? [{ at: "2000-01-01T00:00:00Z" }]);

  const head = branch === github.branch ? headOf(github) : originHead(github, branch);

  return pushes
    .map(({ at, before, sha }) => `${at} ${before ?? "0".repeat(40)} ${sha ?? head}\n`)
    .join("");
}

const RUNS = /actions\/workflows\/ci\.yml\/runs\?head_sha=([0-9a-f]+)&event=(\w+)&/u;

const CHECK_RUNS = /commits\/([0-9a-f]+)\/check-runs\?/u;

const EVENTS = /issues\/(\d+)\/events$/u;

const ACTIVITY = /\/activity\?ref=refs\/heads\/([^&]+)&/u;

const STACK = /\/stacks\/(\d+)$/u;

const DISPATCH = /actions\/workflows\/ci\.yml\/dispatches$/u;

function answerApi(github: FakeGitHub, args: readonly string[]): string | Failure | null {
  const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
  const [, runsOf, event = ""] = RUNS.exec(path) ?? [];
  const [, checksOf] = CHECK_RUNS.exec(path) ?? [];
  const [, eventsOf] = EVENTS.exec(path) ?? [];
  const [, activityOf] = ACTIVITY.exec(path) ?? [];
  const [, stackNumber] = STACK.exec(path) ?? [];

  if (runsOf !== undefined) return listRuns(github, runsOf, event);

  if (checksOf !== undefined) return listCheckRuns(github, checksOf);

  if (eventsOf === String(github.pr.number)) {
    return github.landOkAt.map((at) => `${at}\n`).join("");
  }

  const labelled = github.layers.find((layer) => String(layer.number) === eventsOf);

  if (labelled !== undefined) return labelled.landOkAt.map((at) => `${at}\n`).join("");

  if (activityOf !== undefined) return pushesOf(github, activityOf);

  if (stackNumber !== undefined) return stackOf(github, Number(stackNumber));

  if (DISPATCH.test(path) && args.includes("POST")) {
    const ref = args.find((arg) => arg.startsWith("ref="))?.slice("ref=".length) ?? "";
    const id = github.nextId;

    start(github, originHead(github, ref), github.dispatchRun, false, "workflow_dispatch");

    // What `--jq .workflow_run_id` keeps of GitHub's answer.
    return `${id}\n`;
  }

  return null;
}

function answerPullRequest(
  github: FakeGitHub,
  verb: string | undefined,
  args: readonly string[],
): string | Failure | null {
  const [, , target = "", flag, value] = args;

  if (verb === "view") {
    if (github.garbage !== null) return github.garbage;

    const pr = selected(github, target);

    if (pr === null) {
      return new Failure(
        1,
        `GraphQL: Could not resolve to a PullRequest with the number of ${target}. (repository.pullRequest)`,
      );
    }

    return fieldsOf(args, viewOf(github, pr));
  }

  if (verb === "list") {
    const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;
    const head = args.includes("--head") ? args[args.indexOf("--head") + 1] : undefined;

    if (base !== undefined) {
      const open = github.layers.filter(
        (layer) => layer.baseRefName === base && layerState(github, layer) === "OPEN",
      );

      return [
        ...(base === github.branch ? github.stacked : []),
        ...open.map((layer) => layer.number),
      ]
        .map((number) => `${number}\n`)
        .join("");
    }

    const named: ("default" | FakeLayer)[] = [
      ...(head === github.branch ? ["default" as const] : []),
      ...github.layers.filter((layer) => layer.branch === head),
    ];

    return `[${named
      .flatMap((pr) => {
        const view = viewOf(github, pr);

        return view.state === "OPEN" ? [fieldsOf(args, view)] : [];
      })
      .join(",")}]`;
  }

  if (verb === "edit" && value !== undefined) {
    const pr = selected(github, target);

    if (pr === null) return null;

    const labels = pr === "default" ? github.pr.labels : pr.labels;

    if (flag === "--remove-label") {
      labels.splice(0, labels.length, ...labels.filter((label) => label !== value));

      return "";
    }

    if (flag === "--add-label") {
      if (labels.includes(value)) return "";

      labels.push(value);

      if (value === "e2e" && pr === "default") {
        start(github, github.shown ?? headOf(github), github.labelRun, true, "pull_request");
      }

      return "";
    }
  }

  return null;
}

async function answer(
  github: FakeGitHub,
  args: readonly string[],
): Promise<string | Failure | null> {
  const [command, verb, target] = args;

  if (command === "api") return answerApi(github, args);

  if (command === "issue" && verb === "list" && args.includes("red-dev")) {
    return github.redDev.map((number) => `${number}\n`).join("");
  }

  if (command === "label" && verb === "create") return "";

  if (command === "pr" && verb === "comment") {
    const body = args.indexOf("--body");

    github.comment = body === -1 ? await Bun.stdin.text() : (args[body + 1] ?? "");

    return "";
  }

  if (command === "pr") return answerPullRequest(github, verb, args);

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

  if (out instanceof Failure) {
    console.error(out.stderr);
    process.exit(out.exit);
  }

  process.stdout.write(out);
}
