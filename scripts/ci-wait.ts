/**
 * Whether CI is done and green on one commit, read from its `ci.yml` workflow runs of one event,
 * and a wait on that verdict for a script that must not move on before it.
 *
 * A commit carries several runs of one event: a pull request's head gets one when it is opened or
 * pushed and one more per label added (`types: labeled`), a commit gets one per push to `dev` and
 * to `main`. The verdict reads every such run, each as the REST listing gives it, at its latest
 * attempt, and judges on the run's `status` and `conclusion` alone: never on the check runs
 * `gh pr checks` shows, whose skipped jobs stayed `in_progress` for minutes after their run had
 * concluded on #361. Whether a commit may reach `dev` past the e2e gate is `refusalFor` in
 * `check-e2e-green.ts`, the pre-push hook's own predicate.
 */

const WORKFLOW = "ci.yml";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const RUN_ID = /^\d+$/u;

const RUN_STATUSES = [
  "requested",
  "queued",
  "pending",
  "waiting",
  "in_progress",
  "completed",
] as const;

const RUN_CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
] as const;

/** A push registers its run within seconds. */
export const REGISTRATION_MS = 60_000;

export type Gh = (args: readonly string[]) => Promise<string>;

export type CiEvent = "push" | "pull_request";

export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunConclusion = (typeof RUN_CONCLUSIONS)[number];

export interface CiQuery {
  readonly sha: string;
  readonly event: CiEvent;
  /**
   * The runs seen before the caller started another: until a run besides them shows, the commit
   * counts as having none. A re-run keeps its run's id, so it never shows as another.
   */
  readonly known?: readonly number[];
}

export interface CiRun {
  readonly id: number;
  readonly status: RunStatus;
  readonly conclusion: RunConclusion | null;
  readonly url: string;
}

/**
 * A red run decides before the others end, and stays red until it is re-run: a new run beside it,
 * a label added again, does not clear it.
 */
export type CiVerdict =
  | { readonly kind: "green"; readonly runs: readonly CiRun[] }
  | { readonly kind: "red"; readonly red: readonly CiRun[] }
  | { readonly kind: "running"; readonly running: readonly CiRun[] }
  | { readonly kind: "none" };

export type CiOutcome =
  | Exclude<CiVerdict, { readonly kind: "running" }>
  | { readonly kind: "timeout"; readonly running: readonly CiRun[] };

export type Decision = CiOutcome | { readonly kind: "wait" };

export interface Observed {
  readonly runs: readonly CiRun[];
  readonly known?: readonly number[];
  readonly elapsedMs: number;
}

export interface WaitLimits {
  readonly timeoutMs: number;
  readonly pollMs: number;
}

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const WAIT: Decision = { kind: "wait" };

const SYSTEM_CLOCK: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

function verdictOf(runs: readonly CiRun[], known: readonly number[]): CiVerdict {
  if (runs.every((run) => known.includes(run.id))) return { kind: "none" };

  const red = runs.filter((run) => run.status === "completed" && run.conclusion !== "success");

  if (red.length > 0) return { kind: "red", red };

  const running = runs.filter((run) => run.status !== "completed");

  if (running.length > 0) return { kind: "running", running };

  return { kind: "green", runs };
}

export function decide({ runs, known = [], elapsedMs }: Observed, timeoutMs: number): Decision {
  const verdict = verdictOf(runs, known);

  switch (verdict.kind) {
    case "green":
    case "red":
      return verdict;
    case "none":
      return elapsedMs < Math.min(REGISTRATION_MS, timeoutMs) ? WAIT : verdict;
    case "running":
      return elapsedMs < timeoutMs ? WAIT : { kind: "timeout", running: verdict.running };
  }
}

function runOf(line: string): CiRun {
  const [id, status, conclusion, url, ...extra] = line.split("\t");
  const listedStatus = RUN_STATUSES.find((known) => known === status);

  const listedConclusion =
    conclusion === "" ? null : RUN_CONCLUSIONS.find((known) => known === conclusion);

  if (
    id === undefined ||
    !RUN_ID.test(id) ||
    listedStatus === undefined ||
    listedConclusion === undefined ||
    url === undefined ||
    url === "" ||
    extra.length > 0
  ) {
    throw new Error(
      `gh listed a ${WORKFLOW} run that does not read as one: ${JSON.stringify(line)}`,
    );
  }

  return { id: Number(id), status: listedStatus, conclusion: listedConclusion, url };
}

async function runsOf(gh: Gh, { sha, event }: CiQuery): Promise<readonly CiRun[]> {
  if (!FULL_SHA.test(sha)) {
    throw new Error(
      `${JSON.stringify(sha)} is not a full commit SHA: the runs listing matches head_sha whole, and nothing for a short SHA or a ref`,
    );
  }

  const listed = await gh([
    "api",
    "--paginate",
    `repos/{owner}/{repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&event=${event}&per_page=100`,
    "--jq",
    '.workflow_runs[] | [.id, .status, .conclusion // "", .html_url] | @tsv',
  ]);

  return listed
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => runOf(line));
}

export async function ciVerdict(gh: Gh, query: CiQuery): Promise<CiVerdict> {
  return verdictOf(await runsOf(gh, query), query.known ?? []);
}

export async function waitFor(
  gh: Gh,
  query: CiQuery,
  { timeoutMs, pollMs }: WaitLimits,
  clock: Clock = SYSTEM_CLOCK,
): Promise<CiOutcome> {
  const start = clock.now();
  const known = query.known ?? [];

  const read = async () => {
    const runs = await runsOf(gh, query);
    const elapsedMs = clock.now() - start;

    return { decision: decide({ runs, known, elapsedMs }, timeoutMs), elapsedMs };
  };

  let { decision, elapsedMs } = await read();

  while (decision.kind === "wait") {
    await clock.sleep(Math.min(pollMs, timeoutMs - elapsedMs));
    ({ decision, elapsedMs } = await read());
  }

  return decision;
}

export async function ghCli(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], {
    // Either variable makes gh indent and color the JSON its jq prints, which a caller cannot parse.
    env: { ...process.env, CLICOLOR_FORCE: "0", GH_FORCE_TTY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  return stdout;
}
