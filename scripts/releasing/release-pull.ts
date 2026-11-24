/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- this module IS the parser of what `gh` prints of a release's pull request: each reader narrows one field of a JSON record and refuses one of another shape. */

/**
 * The release's pull request on GitHub, read and driven through `gh`: found by its branch, opened,
 * waited on until GitHub calls it mergeable, and squash-merged on the one head commit the release
 * pushed. A re-run check shows beside its earlier runs, so each check is judged by its latest run,
 * ordered by `startedAt`; `owner-gate` is never a reason to stop, since it stays red until the
 * owner adds his label.
 */

import { isRecord, stringField } from "../../agent-hooks/core/util/json.ts";
import { type Clock, type Gh, SYSTEM_CLOCK, type WaitLimits } from "./ci-wait.ts";

const OWNER_GATE = "owner-gate";

const PULL_URL = /\/pull\/(\d+)$/u;

const GREEN_CONCLUSIONS: ReadonlySet<unknown> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * GitHub's `mergeStateStatus` once nothing blocks the merge, the required checks and the rulesets
 * included: CLEAN, or HAS_HOOKS where the server runs pre-receive hooks.
 */
const MERGEABLE_STATES: ReadonlySet<string> = new Set(["CLEAN", "HAS_HOOKS"]);

export interface PullRequest {
  readonly number: number;
  readonly url: string;
}

type PullState = "OPEN" | "MERGED" | "CLOSED";

/** A pull request as `gh pr list` gives it. */
export type ListedPull = PullRequest & {
  readonly title: string;
  readonly body: string;
  readonly headRefOid: string;
} & (
    | { readonly state: "OPEN" | "CLOSED" }
    | { readonly state: "MERGED"; readonly mergeCommit: string }
  );

/** One run of a check on a pull request's head. */
export interface PullCheck {
  readonly name: string;
  readonly url: string;
  readonly verdict: "green" | "red" | "pending";
  /** When it started; null for a run queued and not started yet. */
  readonly startedAt: string | null;
}

/** A pull request as `gh pr view` gives it. */
export type PullView =
  | { readonly state: "MERGED"; readonly mergeCommit: string; readonly headRefOid: string }
  | { readonly state: "CLOSED" }
  | {
      readonly state: "OPEN";
      readonly headRefOid: string;
      /** GitHub's `mergeable`: MERGEABLE, CONFLICTING or UNKNOWN. */
      readonly mergeable: string;
      /** GitHub's `mergeStateStatus`: BLOCKED, BEHIND, CLEAN, DIRTY, ... */
      readonly mergeStateStatus: string;
      readonly checks: readonly PullCheck[];
    };

/** What the wait for a pull request to become mergeable ends on. */
export type MergeWait =
  | { readonly kind: "mergeable" }
  | { readonly kind: "merged"; readonly commit: string; readonly head: string }
  | { readonly kind: "closed" }
  | { readonly kind: "conflict" }
  | { readonly kind: "foreign-head"; readonly head: string; readonly pushed: string }
  | { readonly kind: "red"; readonly checks: readonly PullCheck[] }
  | { readonly kind: "timeout"; readonly status: string }
  | { readonly kind: "failed"; readonly why: string };

const WAIT = { kind: "wait" } as const;

function jsonOf(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} printed no JSON: ${text.trim().slice(0, 300)}`, { cause: error });
  }
}

function pullStateOf(value: unknown, what: string): PullState {
  if (value === "OPEN" || value === "MERGED" || value === "CLOSED") return value;

  throw new Error(`${what}: the state ${JSON.stringify(value)} is not OPEN, MERGED or CLOSED`);
}

function mergeCommitOf(value: unknown, what: string): string {
  const oid = isRecord(value) ? stringField(value, "oid") : undefined;

  if (oid === undefined) throw new Error(`${what}: merged, with no merge commit`);

  return oid;
}

function textOf(record: Record<string, unknown>, key: string, what: string): string {
  const text = stringField(record, key);

  if (text === undefined) throw new Error(`${what}: no ${key}`);

  return text;
}

function listedPullOf(item: unknown): ListedPull {
  if (!isRecord(item) || typeof item["number"] !== "number") {
    throw new Error(
      `gh pr list gave a pull request that does not read as one: ${JSON.stringify(item)}`,
    );
  }

  const number = item["number"];
  const what = `gh pr list: #${number}`;

  const read = {
    number,
    url: textOf(item, "url", what),
    title: textOf(item, "title", what),
    body: textOf(item, "body", what),
    headRefOid: textOf(item, "headRefOid", what),
  };

  const state = pullStateOf(item["state"], what);

  return state === "MERGED"
    ? { ...read, state, mergeCommit: mergeCommitOf(item["mergeCommit"], what) }
    : { ...read, state };
}

/** gh prints Go's zero time, not null, for a run that has not started. */
function startedAtOf(record: Record<string, unknown>): string | null {
  const startedAt = stringField(record, "startedAt");

  return startedAt === undefined || startedAt.startsWith("0001-") ? null : startedAt;
}

/** One entry of `statusCheckRollup`: a check run of GitHub Actions, or a commit status. */
function checkOf(item: unknown): PullCheck {
  if (isRecord(item) && item["__typename"] === "CheckRun") {
    return {
      name: stringField(item, "name") ?? "",
      url: stringField(item, "detailsUrl") ?? "",
      startedAt: startedAtOf(item),
      verdict:
        item["status"] === "COMPLETED"
          ? GREEN_CONCLUSIONS.has(item["conclusion"])
            ? "green"
            : "red"
          : "pending",
    };
  }

  if (isRecord(item) && item["__typename"] === "StatusContext") {
    const state = item["state"];

    return {
      name: stringField(item, "context") ?? "",
      url: stringField(item, "targetUrl") ?? "",
      startedAt: startedAtOf(item),
      verdict:
        state === "SUCCESS"
          ? "green"
          : state === "FAILURE" || state === "ERROR"
            ? "red"
            : "pending",
    };
  }

  throw new Error(
    `gh pr view gave a check that is neither a CheckRun nor a StatusContext: ${JSON.stringify(item)}`,
  );
}

export async function viewOf(gh: Gh, pr: PullRequest): Promise<PullView> {
  const what = `gh pr view ${pr.number}`;

  const view = jsonOf(
    await gh([
      "pr",
      "view",
      String(pr.number),
      "--json",
      "state,headRefOid,mergeCommit,mergeable,mergeStateStatus,statusCheckRollup",
    ]),
    what,
  );

  if (!isRecord(view)) throw new Error(`${what} printed no object`);

  const state = pullStateOf(view["state"], what);

  if (state === "CLOSED") return { state };

  const headRefOid = textOf(view, "headRefOid", what);

  if (state === "MERGED") {
    return { state, headRefOid, mergeCommit: mergeCommitOf(view["mergeCommit"], what) };
  }

  // gh prints null, not [], for a head with no check yet.
  const rollup = view["statusCheckRollup"] ?? [];

  if (!Array.isArray(rollup)) throw new Error(`${what}: statusCheckRollup is not a list`);

  return {
    state,
    headRefOid,
    mergeable: textOf(view, "mergeable", what),
    mergeStateStatus: textOf(view, "mergeStateStatus", what),
    checks: rollup.map((item) => checkOf(item)),
  };
}

/**
 * Whether `a` started after `b`. A run not started yet is the newest, a re-run just queued; between
 * two of them, or two runs started at the same instant, the one listed later.
 */
function startedAfter(a: PullCheck, b: PullCheck): boolean {
  if (a.startedAt === null) return true;

  if (b.startedAt === null) return false;

  return a.startedAt >= b.startedAt;
}

/** The latest run of each check, each named once. */
export function latestChecks(checks: readonly PullCheck[]): readonly PullCheck[] {
  const latest = new Map<string, PullCheck>();

  for (const check of checks) {
    const known = latest.get(check.name);

    if (known === undefined || startedAfter(check, known)) latest.set(check.name, check);
  }

  return [...latest.values()];
}

/** The checks whose latest run is red, `owner-gate` aside. */
function redChecks(checks: readonly PullCheck[]): readonly PullCheck[] {
  return latestChecks(checks).filter(
    ({ name, verdict }) => name !== OWNER_GATE && verdict === "red",
  );
}

/** `pushed` is the head commit the release pushed: any other head ends the wait. */
export function decideMerge(
  view: PullView,
  pushed: string,
  elapsedMs: number,
  timeoutMs: number,
): MergeWait | typeof WAIT {
  switch (view.state) {
    case "MERGED":
      return { kind: "merged", commit: view.mergeCommit, head: view.headRefOid };
    case "CLOSED":
      return { kind: "closed" };
    case "OPEN": {
      if (view.headRefOid !== pushed)
        return { kind: "foreign-head", head: view.headRefOid, pushed };

      if (view.mergeable === "CONFLICTING") return { kind: "conflict" };

      const red = redChecks(view.checks);

      if (red.length > 0) return { kind: "red", checks: red };

      if (MERGEABLE_STATES.has(view.mergeStateStatus)) return { kind: "mergeable" };

      return elapsedMs < timeoutMs ? WAIT : { kind: "timeout", status: view.mergeStateStatus };
    }
  }
}

export async function waitForMergeable(
  gh: Gh,
  pr: PullRequest,
  pushed: string,
  { timeoutMs, pollMs }: WaitLimits,
  clock: Clock = SYSTEM_CLOCK,
): Promise<MergeWait> {
  const start = clock.now();

  const read = async () => {
    const view = await viewOf(gh, pr);
    const elapsedMs = clock.now() - start;

    return { decision: decideMerge(view, pushed, elapsedMs, timeoutMs), elapsedMs };
  };

  let { decision, elapsedMs } = await read();

  while (decision.kind === "wait") {
    await clock.sleep(Math.min(pollMs, timeoutMs - elapsedMs));
    ({ decision, elapsedMs } = await read());
  }

  return decision;
}

/** Every pull request from `branch` into `base`, whatever its state. */
export async function pullsFrom(
  gh: Gh,
  branch: string,
  base: string,
): Promise<readonly ListedPull[]> {
  const what = `gh pr list --head ${branch}`;

  const listed = jsonOf(
    await gh([
      "pr",
      "list",
      "--head",
      branch,
      "--base",
      base,
      "--state",
      "all",
      "--json",
      "number,state,title,body,url,headRefOid,mergeCommit",
    ]),
    what,
  );

  if (!Array.isArray(listed)) throw new Error(`${what} printed no list`);

  return listed.map((item) => listedPullOf(item));
}

/** The pull request from `branch` into `base`: the open one, else the last merged; a closed one is left for a new one. */
export async function pullFrom(gh: Gh, branch: string, base: string): Promise<ListedPull | null> {
  const pulls = await pullsFrom(gh, branch, base);
  const open = pulls.filter(({ state }) => state === "OPEN");

  if (open.length > 1) {
    throw new Error(
      `${branch} heads ${open.length} open pull requests (${open.map(({ url }) => url).join(", ")}): close all but one`,
    );
  }

  const merged = pulls
    .filter(({ state }) => state === "MERGED")
    .toSorted((a, b) => b.number - a.number);

  return open[0] ?? merged[0] ?? null;
}

export interface NewPull {
  readonly base: string;
  readonly branch: string;
  readonly title: string;
  readonly body: string;
}

export async function openPull(
  gh: Gh,
  { base, branch, title, body }: NewPull,
): Promise<PullRequest> {
  const printed = await gh([
    "pr",
    "create",
    "--base",
    base,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);

  const url = printed.trim().split("\n").at(-1) ?? "";
  const number = PULL_URL.exec(url)?.[1];

  if (number === undefined) {
    throw new Error(`gh pr create printed no pull request URL: ${printed.trim()}`);
  }

  return { number: Number(number), url };
}

/** Squash-merges `pr`, refused by GitHub unless its head is still `head`. */
export async function squashMerge(gh: Gh, pr: PullRequest, head: string): Promise<void> {
  await gh(["pr", "merge", String(pr.number), "--squash", "--match-head-commit", head]);
}
