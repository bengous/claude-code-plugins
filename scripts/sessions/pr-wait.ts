/**
 * Waits until `test` and `review` have a verdict on a pull request's head, then prints what a
 * session reads before its next move: the two verdicts, the labels, the review threads left open.
 *
 * `gh pr checks --watch` answers "no checks reported" on a head whose checks are not created yet,
 * and its exit code stays red while `owner-gate` waits for the owner. This reads the two checks by
 * name, each at its latest run, and takes a check that is not there yet for one still to come while
 * another check of the head runs.
 *
 * Exit 0 when both are green or the pull request merged, 1 when one is red or it closed, 2 on a bad
 * argument, 3 when the wait ended with no verdict.
 */

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

  Exit 0 when both are green or the pull request merged, 1 when one is red or it closed,
  2 on a bad argument, 3 when the wait ended with no verdict.`;

const WATCHED: readonly string[] = ["test", "review"];

const DEFAULT_TIMEOUT_MINUTES = 30;

const POLL_MS = 20_000;

const NUMBER = /^[1-9]\d*$/u;

const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { isResolved path line comments(first: 1) { nodes { body } } } }
    }
  }
}`;

/** One line per open thread: its path, its line, the first line of its first comment. */
const OPEN_THREADS = `.data.repository.pullRequest.reviewThreads.nodes[]
  | select(.isResolved | not)
  | "\\(.path):\\(.line // 0)  \\(.comments.nodes[0].body | split("\\n")[0])"`;

export type Wait =
  | { readonly kind: "merged"; readonly commit: string }
  | { readonly kind: "closed" }
  | { readonly kind: "verdict"; readonly head: string; readonly checks: readonly PullCheck[] }
  | { readonly kind: "none"; readonly head: string; readonly missing: readonly string[] }
  | { readonly kind: "timeout"; readonly head: string; readonly waiting: readonly string[] };

const WAIT = { kind: "wait" } as const;

export function decide(view: PullView, elapsedMs: number, timeoutMs: number): Wait | typeof WAIT {
  if (view.state === "MERGED") return { kind: "merged", commit: view.mergeCommit };

  if (view.state === "CLOSED") return { kind: "closed" };

  const latest = latestChecks(view.checks);
  const watched = latest.filter(({ name }) => WATCHED.includes(name));
  const missing = WATCHED.filter((name) => !watched.some((check) => check.name === name));
  const pending = watched.flatMap(({ name, verdict }) => (verdict === "pending" ? [name] : []));
  const head = view.headRefOid;

  if (missing.length === 0 && pending.length === 0)
    return { kind: "verdict", head, checks: watched };

  if (elapsedMs >= timeoutMs) return { kind: "timeout", head, waiting: [...missing, ...pending] };

  // A check's job is created once the jobs it needs are done: it may yet come while one runs.
  const running = latest.some(({ verdict }) => verdict === "pending");

  if (pending.length === 0 && !running && elapsedMs >= REGISTRATION_MS) {
    return { kind: "none", head, missing };
  }

  return WAIT;
}

export async function waitForVerdict(
  gh: Gh,
  number: number,
  { timeoutMs, pollMs }: WaitLimits,
  clock: Clock = SYSTEM_CLOCK,
): Promise<Wait> {
  const start = clock.now();

  const read = async () => {
    const view = await viewOf(gh, { number, url: "" });
    const elapsedMs = clock.now() - start;

    return { decision: decide(view, elapsedMs, timeoutMs), elapsedMs };
  };

  let { decision, elapsedMs } = await read();

  while (decision.kind === "wait") {
    await clock.sleep(Math.min(pollMs, timeoutMs - elapsedMs));
    ({ decision, elapsedMs } = await read());
  }

  return decision;
}

function linesOf(text: string): readonly string[] {
  return text.split("\n").filter((line) => line !== "");
}

async function labelsOf(gh: Gh, number: number): Promise<readonly string[]> {
  return linesOf(
    await gh(["pr", "view", String(number), "--json", "labels", "--jq", ".labels[].name"]),
  );
}

async function openThreadsOf(gh: Gh, number: number): Promise<readonly string[]> {
  return linesOf(
    await gh([
      "api",
      "graphql",
      "-f",
      `query=${THREADS}`,
      "-F",
      "owner={owner}",
      "-F",
      "name={repo}",
      "-F",
      `number=${number}`,
      "--jq",
      OPEN_THREADS,
    ]),
  );
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
      return 3;
  }
}

function headline(number: number, wait: Wait): readonly string[] {
  switch (wait.kind) {
    case "merged":
      return [`#${number} merged as ${wait.commit.slice(0, 8)}`];
    case "closed":
      return [`#${number} closed without a merge`];
    case "verdict":
      return [
        `#${number} head ${wait.head.slice(0, 8)}`,
        ...wait.checks.map(({ name, verdict, url }) => `${name.padEnd(8)} ${verdict}  ${url}`),
      ];
    case "none":
      return [
        `#${number} head ${wait.head.slice(0, 8)}`,
        `no ${wait.missing.join(" and no ")} on this head, and no check of it runs`,
      ];
    case "timeout":
      return [
        `#${number} head ${wait.head.slice(0, 8)}`,
        `still waiting for ${wait.waiting.join(" and ")} at the timeout`,
      ];
  }
}

export function report(
  number: number,
  wait: Wait,
  labels: readonly string[],
  threads: readonly string[],
): string {
  return [
    ...headline(number, wait),
    `labels   ${labels.length === 0 ? "none" : labels.join(", ")}`,
    `threads  ${threads.length} open`,
    ...threads.map((thread) => `  ${thread}`),
  ].join("\n");
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
): Promise<number> {
  const request = requestOf(argv);

  if (request === null) {
    console.error(USAGE);

    return 2;
  }

  const { number, timeoutMs } = request;
  const wait = await waitForVerdict(gh, number, { timeoutMs, pollMs: POLL_MS }, clock);
  const [labels, threads] = await Promise.all([labelsOf(gh, number), openThreadsOf(gh, number)]);

  console.log(report(number, wait, labels, threads));

  return exitOf(wait);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
