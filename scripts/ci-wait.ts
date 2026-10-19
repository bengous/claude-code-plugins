/**
 * Whether CI is done and green on one commit, read from its `ci.yml` workflow runs of one event,
 * and a wait on that verdict for a script that must not move on before it.
 *
 * A commit carries several runs of one event: a pull request's head gets one when it is opened or
 * pushed and one more per label added (`types: labeled`), a commit gets one per push to `dev` and
 * to `main`. The verdict reads every such run, each as the REST listing gives it, at its latest
 * attempt, and judges on the run's `status` and `conclusion` alone: never on the check runs
 * `gh pr checks` shows, whose skipped jobs stayed `in_progress` for minutes after their run had
 * concluded on #361. Whether a commit may reach `dev` past the e2e gate is
 * `refusalFor(checkRunsOf(sha))` in `check-e2e-green.ts`, the pre-push hook's own predicate.
 */

const WORKFLOW = "ci.yml";

/** How long a commit with no run is waited on: a push registers its run within seconds. */
export const REGISTRATION_MS = 60_000;

export type Gh = (args: readonly string[]) => Promise<string>;

export type CiEvent = "push" | "pull_request";

export interface CiQuery {
  readonly sha: string;
  readonly event: CiEvent;
}

/** A `ci.yml` run as the REST listing gives it, at its latest attempt. */
export interface CiRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
}

/**
 * What a commit's runs of one event say at one read. A red run decides before the others end, and
 * stays red until it is re-run: a new run beside it, a label added again, does not clear it.
 */
export type CiVerdict =
  | { readonly kind: "green"; readonly runs: readonly CiRun[] }
  | { readonly kind: "red"; readonly red: readonly CiRun[] }
  | { readonly kind: "running"; readonly running: readonly CiRun[] }
  | { readonly kind: "none" };

/** What a wait ends on: a verdict, or the runs still going when its time ran out. */
export type CiOutcome =
  | Exclude<CiVerdict, { readonly kind: "running" }>
  | { readonly kind: "timeout"; readonly running: readonly CiRun[] };

export type Decision = CiOutcome | { readonly kind: "wait" };

/** What a wait has read: the runs of its latest read, and the time since it began. */
export interface Observed {
  readonly runs: readonly CiRun[];
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

function verdictOf(runs: readonly CiRun[]): CiVerdict {
  if (runs.length === 0) return { kind: "none" };

  const red = runs.filter((run) => run.status === "completed" && run.conclusion !== "success");

  if (red.length > 0) return { kind: "red", red };

  const running = runs.filter((run) => run.status !== "completed");

  if (running.length > 0) return { kind: "running", running };

  return { kind: "green", runs };
}

/** Whether a wait goes on after a read, or what it ends on. */
export function decide({ runs, elapsedMs }: Observed, timeoutMs: number): Decision {
  const verdict = verdictOf(runs);

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

async function runsOf(gh: Gh, { sha, event }: CiQuery): Promise<readonly CiRun[]> {
  const listed = await gh([
    "api",
    "--paginate",
    `repos/{owner}/{repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&event=${event}&per_page=100`,
    "--jq",
    ".workflow_runs[] | {id, status, conclusion, url: .html_url}",
  ]);

  return listed
    .split("\n")
    .filter((line) => line !== "")
    .map((line): CiRun => JSON.parse(line));
}

/** The verdict of one read of the commit's runs. */
export async function ciVerdict(gh: Gh, query: CiQuery): Promise<CiVerdict> {
  return verdictOf(await runsOf(gh, query));
}

/** Reads the commit's runs every `pollMs` until they decide, no run registers, or `timeoutMs` passes. */
export async function waitFor(
  gh: Gh,
  query: CiQuery,
  { timeoutMs, pollMs }: WaitLimits,
  clock: Clock = SYSTEM_CLOCK,
): Promise<CiOutcome> {
  const start = clock.now();

  const read = async (): Promise<Decision> => {
    const runs = await runsOf(gh, query);

    return decide({ runs, elapsedMs: clock.now() - start }, timeoutMs);
  };

  let decision = await read();

  while (decision.kind === "wait") {
    await clock.sleep(pollMs);
    decision = await read();
  }

  return decision;
}

/** `gh` as a child process, each jq result on a line of its own. */
export async function ghCli(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], {
    // Either variable makes gh indent and color its jq results, one line no longer one run.
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
