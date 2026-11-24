/**
 * Waits until `test` and `review` have a verdict on a pull request's head, then prints what a
 * session reads before its next move: the two verdicts, the labels, the review threads left open.
 *
 * `gh pr checks --watch` answers "no checks reported" on a head whose checks are not created yet,
 * and its exit code stays red while `owner-gate` waits for the owner. This reads the two checks by
 * name, each at its latest run, and takes a check that is not there yet for one still to come while
 * another check of the head runs.
 *
 * A workflow run started again leaves the earlier verdict of its check on the head until its own
 * job reports. So a verdict stands once no run of its workflow is queued or in progress on the
 * head, read from the runs themselves as `ci-wait.ts` reads them, never guessed from the checks.
 *
 * Run from a checkout of the pull request's branch, it waits for the verdicts of the commit that
 * checkout is at: right after a push, GitHub may still show the head before it.
 *
 * Exit 0 when both are green or the pull request merged, 1 when one is red or it closed, 2 on a bad
 * argument, 3 when the wait ended with no verdict.
 */

import { isRecord, stringField } from "../../agent-hooks/core/util/json.ts";
import { gitReadSync } from "../../tools/platform/git.ts";
import { messageOf } from "../../tools/platform/pure.ts";
import {
  type Clock,
  type Gh,
  ghCli,
  REGISTRATION_MS,
  SYSTEM_CLOCK,
  type WaitLimits,
} from "../releasing/ci-wait.ts";
import { latestChecks, type PullCheck, type PullView, viewOf } from "../releasing/release-pull.ts";

const USAGE = `usage: pr-wait.ts <pull request number> [--timeout <minutes>]

  Waits until test and review have a verdict on the pull request's head, 30 minutes at most
  by default, then prints the two verdicts, the labels and the open review threads.

  From a checkout of the pull request's branch, the head it waits on is that checkout's commit.

  Exit 0 when both are green or the pull request merged, 1 when one is red or it closed,
  2 on a bad argument, 3 when the wait ended with no verdict: a timeout, checks that never
  came, as on a head that conflicts with its base, another head than the checkout's, or gh
  failing three polls in a row.`;

const WATCHED: readonly string[] = ["test", "review"];

const DEFAULT_TIMEOUT_MINUTES = 30;

const POLL_MS = 20_000;

/** One failed poll is a network's bad moment; this many in a row end the wait. */
const MAX_FAILED_POLLS = 3;

const NUMBER = /^[1-9]\d*$/u;

/** The workflow run a check's link names. */
const RUN_OF = /\/actions\/runs\/(?<run>\d+)\//u;

const THREADS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved path line comments(first: 1) { nodes { body } } }
      }
    }
  }
}`;

/** One line of JSON per thread, resolved or not. */
const THREAD_NODES = ".data.repository.pullRequest.reviewThreads.nodes[] | @json";

/** The watched checks whose verdict stands on the head, each at its latest run. */
type Seen = { readonly head: string; readonly checks: readonly PullCheck[] };

export type Wait =
  | { readonly kind: "merged"; readonly commit: string }
  | { readonly kind: "closed" }
  | ({ readonly kind: "verdict" } & Seen)
  | ({
      readonly kind: "none";
      readonly missing: readonly string[];
      /** The head conflicts with its base, on which GitHub starts no pull_request run. */
      readonly conflict: boolean;
    } & Seen)
  | ({ readonly kind: "timeout"; readonly waiting: readonly string[] } & Seen)
  | { readonly kind: "other-head"; readonly head: string; readonly expected: string }
  | {
      readonly kind: "failed";
      readonly why: string;
      /** The verdicts the last view showed, which the failed read left unconfirmed. */
      readonly seen: Seen | null;
    };

const WAIT = { kind: "wait" } as const;

/**
 * `expected` is the commit the caller's checkout is at, when that checkout is the pull request's
 * branch, and null otherwise: verdicts are read on that head alone. `rerunning` names the watched
 * checks whose workflow has a run queued or in progress on the head.
 */
export function decide(
  view: PullView,
  expected: string | null,
  rerunning: readonly string[],
  elapsedMs: number,
  timeoutMs: number,
): Wait | typeof WAIT {
  if (view.state === "CLOSED") return { kind: "closed" };

  const head = view.headRefOid;
  const other = expected !== null && head !== expected;

  if (view.state === "MERGED") {
    return other
      ? { kind: "other-head", head, expected }
      : { kind: "merged", commit: view.mergeCommit };
  }

  if (other) {
    // GitHub moves the pull request's head a moment after the push that changed it.
    return elapsedMs < REGISTRATION_MS ? WAIT : { kind: "other-head", head, expected };
  }

  const latest = latestChecks(view.checks);
  const watched = latest.filter(({ name }) => WATCHED.includes(name));
  const missing = WATCHED.filter((name) => !watched.some((check) => check.name === name));

  const settled = ({ name, verdict }: PullCheck) =>
    verdict !== "pending" && !rerunning.includes(name);

  const checks = watched.filter((check) => settled(check));
  const pending = watched.flatMap((check) => (settled(check) ? [] : [check.name]));

  if (missing.length === 0 && pending.length === 0) return { kind: "verdict", head, checks };

  if (elapsedMs >= timeoutMs) {
    return { kind: "timeout", head, checks, waiting: [...missing, ...pending] };
  }

  // A check's job is created once the jobs it needs are done: it may yet come while one runs.
  const running = latest.some(({ verdict }) => verdict === "pending");

  if (pending.length === 0 && !running && elapsedMs >= REGISTRATION_MS) {
    return { kind: "none", head, checks, missing, conflict: view.mergeable === "CONFLICTING" };
  }

  return WAIT;
}

/** One workflow run on a head, as the runs listing gives it. */
interface WorkflowRun {
  readonly id: string;
  readonly workflow: string;
  readonly status: string;
}

function workflowRunOf(line: string): WorkflowRun {
  const [id, workflow, status, ...rest] = line.split("\t");

  if (id === undefined || workflow === undefined || status === undefined || rest.length > 0) {
    throw new Error(`gh gave a workflow run that is no id, workflow and status: ${line}`);
  }

  return { id, workflow, status };
}

/** The names of `checks` whose workflow has, among `runs`, one that has not completed. */
export function rerunningOf(
  checks: readonly PullCheck[],
  runs: readonly WorkflowRun[],
): readonly string[] {
  return checks.flatMap(({ name, url }) => {
    const linked = RUN_OF.exec(url)?.groups?.["run"];

    // A commit status links to no workflow run: nothing runs it again.
    if (linked === undefined) return [];

    const own = runs.find(({ id }) => id === linked);

    if (own === undefined) throw new Error(`the runs of the head hold no run ${linked}, ${name}'s`);

    return runs.some(({ workflow, status }) => workflow === own.workflow && status !== "completed")
      ? [name]
      : [];
  });
}

function linesOf(text: string): readonly string[] {
  return text.split("\n").filter((line) => line !== "");
}

/** The watched checks of a view that show a verdict, each at its latest run. */
function decidedOf(view: PullView): readonly PullCheck[] {
  if (view.state !== "OPEN") return [];

  return latestChecks(view.checks).filter(
    ({ name, verdict }) => WATCHED.includes(name) && verdict !== "pending",
  );
}

async function runsOn(gh: Gh, head: string): Promise<readonly WorkflowRun[]> {
  const listed = await gh([
    "api",
    "--paginate",
    `repos/{owner}/{repo}/actions/runs?head_sha=${head}&per_page=100`,
    "--jq",
    ".workflow_runs[] | [.id, .workflow_id, .status] | @tsv",
  ]);

  return linesOf(listed).map((line) => workflowRunOf(line));
}

/** Both verdicts as a view shows them, or null while it does not show both. */
function seenOf(view: PullView): Seen | null {
  const checks = decidedOf(view);

  return view.state === "OPEN" && checks.length === WATCHED.length
    ? { head: view.headRefOid, checks }
    : null;
}

/**
 * What a view answers. The head's workflow runs are listed once the view shows both verdicts:
 * before that, the checks themselves say to wait. A run can end between the view and the listing,
 * which then shows nothing running beside the verdict of the run before it: so the pull request is
 * read again once the listing is clear, and two views that differ answer nothing.
 */
async function readingOf(
  gh: Gh,
  number: number,
  view: PullView,
  expected: string | null,
  elapsedMs: number,
  timeoutMs: number,
): Promise<Wait | typeof WAIT> {
  const seen = seenOf(view);

  if (seen === null) return decide(view, expected, [], elapsedMs, timeoutMs);

  const rerunning = rerunningOf(seen.checks, await runsOn(gh, seen.head));

  if (rerunning.length === 0) {
    const again = seenOf(await viewOf(gh, { number, url: "" }));

    if (JSON.stringify(again) !== JSON.stringify(seen)) return WAIT;
  }

  return decide(view, expected, rerunning, elapsedMs, timeoutMs);
}

export async function waitForVerdict(
  gh: Gh,
  number: number,
  expected: string | null,
  { timeoutMs, pollMs }: WaitLimits,
  clock: Clock = SYSTEM_CLOCK,
): Promise<Wait> {
  const start = clock.now();

  // Between the end of the jobs a check needs and its own creation, a head shows no check running:
  // "none" is the answer once two polls in a row read it.
  let quiet = false;
  let failed = 0;
  let seen: Seen | null = null;

  for (;;) {
    const elapsedMs = clock.now() - start;
    let reading: Wait | typeof WAIT = WAIT;

    try {
      const view = await viewOf(gh, { number, url: "" });

      seen = seenOf(view);
      reading = await readingOf(gh, number, view, expected, elapsedMs, timeoutMs);
      failed = 0;
    } catch (cause) {
      failed += 1;

      if (failed === MAX_FAILED_POLLS) return { kind: "failed", why: messageOf(cause), seen };
    }

    if (reading.kind !== "wait" && (reading.kind !== "none" || quiet)) return reading;

    quiet = reading.kind === "none";
    await clock.sleep(Math.max(0, Math.min(pollMs, timeoutMs - elapsedMs)));
  }
}

/** The pull request's head commit, as the caller's checkout holds it. */
export interface Checkout {
  readonly branch: string;
  readonly head: string;
}

function checkoutHere(): Checkout {
  return {
    branch: gitReadSync(["branch", "--show-current"]).trim(),
    head: gitReadSync(["rev-parse", "HEAD"]).trim(),
  };
}

/** The checkout's commit when the checkout is on the pull request's branch, null otherwise. */
async function expectedHead(gh: Gh, number: number, checkout: Checkout): Promise<string | null> {
  const branch = await gh([
    "pr",
    "view",
    String(number),
    "--json",
    "headRefName",
    "--jq",
    ".headRefName",
  ]);

  return branch.trim() === checkout.branch ? checkout.head : null;
}

async function labelsOf(gh: Gh, number: number): Promise<readonly string[]> {
  return linesOf(
    await gh(["pr", "view", String(number), "--json", "labels", "--jq", ".labels[].name"]),
  );
}

/**
 * An open thread as the report prints it: its path, its line, the first line of its first comment.
 * Null for a resolved thread. An outdated thread has no line: 0 stands for it.
 */
export function openThreadOf(node: string): string | null {
  const thread: unknown = JSON.parse(node);

  if (!isRecord(thread)) throw new Error(`gh gave a review thread that is no object: ${node}`);

  if (thread["isResolved"] === true) return null;

  const comments = thread["comments"];

  const first =
    isRecord(comments) && Array.isArray(comments["nodes"]) ? comments["nodes"][0] : null;

  const body = isRecord(first) ? (stringField(first, "body") ?? "") : "";
  const line = Number.isInteger(thread["line"]) ? thread["line"] : 0;

  return `${stringField(thread, "path") ?? ""}:${line}  ${body.split("\n")[0] ?? ""}`;
}

async function openThreadsOf(gh: Gh, number: number): Promise<readonly string[]> {
  const nodes = linesOf(
    await gh([
      "api",
      "graphql",
      "--paginate",
      "-f",
      `query=${THREADS}`,
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-F",
      `number=${number}`,
      "--jq",
      THREAD_NODES,
    ]),
  );

  return nodes.flatMap((node) => {
    const thread = openThreadOf(node);

    return thread === null ? [] : [thread];
  });
}

/** The exit code a wait ends on. */
export function exitOf(wait: Wait): number {
  switch (wait.kind) {
    case "merged":
      return 0;
    case "closed":
      return 1;
    case "verdict":
      return wait.checks.every(({ verdict }) => verdict === "green") ? 0 : 1;
    case "none":
    case "timeout":
    case "other-head":
    case "failed":
      return 3;
  }
}

function verdictLines(checks: readonly PullCheck[]): readonly string[] {
  return checks.map(({ name, verdict, url }) => `${name.padEnd(8)} ${verdict}  ${url}`);
}

function headline(number: number, wait: Wait): readonly string[] {
  switch (wait.kind) {
    case "merged":
      return [`#${number} merged as ${wait.commit.slice(0, 8)}`];
    case "closed":
      return [`#${number} closed without a merge`];
    case "failed":
      return wait.seen === null
        ? [`#${number} no verdict: ${wait.why}`]
        : [
            `#${number} head ${wait.seen.head.slice(0, 8)}`,
            ...verdictLines(wait.seen.checks),
            `no verdict: these could not be confirmed: ${wait.why}`,
          ];
    case "verdict":
      return [`#${number} head ${wait.head.slice(0, 8)}`, ...verdictLines(wait.checks)];
    case "none":
      return [
        `#${number} head ${wait.head.slice(0, 8)}`,
        ...verdictLines(wait.checks),
        wait.conflict
          ? `no ${wait.missing.join(" and no ")} on this head: it conflicts with its base, where GitHub starts no check. Merge the base in`
          : `no ${wait.missing.join(" and no ")} on this head, and no check of it runs`,
      ];
    case "timeout":
      return [
        `#${number} head ${wait.head.slice(0, 8)}`,
        ...verdictLines(wait.checks),
        `still waiting for ${wait.waiting.join(" and ")} at the timeout`,
      ];
    case "other-head":
      return [
        `#${number} head ${wait.head.slice(0, 8)}`,
        `this checkout is at ${wait.expected.slice(0, 8)}: push it, or pull the branch`,
      ];
  }
}

/** The labels and the open threads, or why they could not be read. */
export type Notes =
  | { readonly labels: readonly string[]; readonly threads: readonly string[] }
  | { readonly unread: string };

export function report(number: number, wait: Wait, notes: Notes): string {
  if ("unread" in notes) {
    return [...headline(number, wait), `labels and threads not read: ${notes.unread}`].join("\n");
  }

  return [
    ...headline(number, wait),
    `labels   ${notes.labels.length === 0 ? "none" : notes.labels.join(", ")}`,
    `threads  ${notes.threads.length} open`,
    ...notes.threads.map((thread) => `  ${thread}`),
  ].join("\n");
}

async function notesOf(gh: Gh, number: number): Promise<Notes> {
  try {
    const [labels, threads] = await Promise.all([labelsOf(gh, number), openThreadsOf(gh, number)]);

    return { labels, threads };
  } catch (cause) {
    return { unread: messageOf(cause) };
  }
}

export interface Request {
  readonly number: number;
  readonly timeoutMs: number;
}

/** What an argv asks for, or null when it asks for nothing this script does. */
export function requestOf(argv: readonly string[]): Request | null {
  const [number, flag, minutes, ...rest] = argv;

  if (number === undefined || !NUMBER.test(number) || rest.length > 0) return null;

  if (flag === undefined) {
    return { number: Number(number), timeoutMs: DEFAULT_TIMEOUT_MINUTES * 60_000 };
  }

  if (flag !== "--timeout" || minutes === undefined || !NUMBER.test(minutes)) return null;

  return { number: Number(number), timeoutMs: Number(minutes) * 60_000 };
}

export async function main(
  argv: readonly string[],
  gh: Gh = ghCli,
  clock: Clock = SYSTEM_CLOCK,
  checkout: () => Checkout = checkoutHere,
): Promise<number> {
  const request = requestOf(argv);

  if (request === null) {
    console.error(USAGE);

    return 2;
  }

  const { number, timeoutMs } = request;
  let expected: string | null;

  try {
    expected = await expectedHead(gh, number, checkout());
  } catch (cause) {
    console.error(`pr-wait: no verdict: ${messageOf(cause)}`);

    return 3;
  }

  const wait = await waitForVerdict(gh, number, expected, { timeoutMs, pollMs: POLL_MS }, clock);

  // A verdict that was read is printed, and decides the exit code, whatever the two reads after it do.
  console.log(report(number, wait, await notesOf(gh, number)));

  return exitOf(wait);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
