/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- this module reads what `gh` prints of open pull requests and the worker's own memo: each field is narrowed here, and a record of another shape is refused. */
/**
 * The landing worker, `land.ts --worker --once`: what carries `land-ok` or `tier:low` lands without a session. A user
 * systemd timer runs it on the workstation (docs/repo-ops/git.md, Landing worker).
 *
 * A pass reads every open pull request, and lands, by number and one at a time, each stack only whole: a line of open
 * pull requests from `dev` up, each based on the one under it, a single pull request being a line of one, whose every
 * layer is a `feature/` or `fix/` branch that carries `land-ok`, or `tier:low` outside a draft and `needs-human`. It
 * lands through `land.ts <top>`, a run of its own, under the landing lock. A line with any other layer, or that forks,
 * waits for the human's `/land` in a session: landed in part, it would leave a layer based on a merged branch. A
 * target labelled within the last quarter of an hour waits, as do all while a landing holds the lock: the session or
 * the worker that put the label on lands it first.
 *
 * Its memo, `worker.json` beside the landing lock, skips a target whose head, tier labels and `land-ok` are those its
 * last run left, an hour after a new refusal, twice as long after each repeat of it, four hours at most: a red run is
 * not re-run, nor the judge asked, every five minutes, and a target held by what changes no pull request, as a red
 * `dev`, is tried again. A pull request a landing would rebase lands only where commits can be signed; elsewhere a comment
 * asks the human to land it from a session. A run lock keeps one worker at a time.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../../agent-hooks/json.ts";
import { writeAtomicSync } from "../../tools/platform/fs.ts";
import { messageOf } from "../../tools/platform/pure.ts";
import { takeRunLock } from "../headless/headless-run.ts";
import type { Gh } from "./ci-wait.ts";
import { DEV } from "./review-verdict.ts";

const LAND_OK = "land-ok";

const TIER_LOW = "tier:low";

const NEEDS_HUMAN = "needs-human";

const TIER_LABELS: readonly string[] = [LAND_OK, TIER_LOW, "tier:human"];

/** The branches `land.ts` tiers: Renovate's and the types branch land through guards of their own. */
const TIERED_BRANCH = /^(?:feature|fix)\//u;

const FIELDS = "number,headRefOid,headRefName,baseRefName,labels,isDraft";

/** How long a target waits, unchanged, after a new refusal. */
export const RETRY_MS = 60 * 60 * 1000;

/** The longest a target waits, unchanged, refused the same way at each run. */
export const MAX_WAIT_MS = 4 * RETRY_MS;

/** How long a pull request labelled `land-ok` or `tier:low` is left to the landing that labelled it. */
export const GRACE_MS = 15 * 60 * 1000;

export const SIGNING_COMMENT =
  "landing-worker: a rebase needs your signature: land it from a session";

export interface OpenPullRequest {
  readonly number: number;
  readonly head: string;
  readonly branch: string;
  readonly base: string;
  readonly labels: readonly string[];
  readonly draft: boolean;
}

/** A `land.ts <n>` run to its end: its exit code and what it printed on each stream. */
export interface LandRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkerDeps {
  readonly gh: Gh;
  readonly land: (target: number) => LandRun;
  /** Throws when commits cannot be signed here. */
  readonly probeSigning: () => void;
  /** Whether `head` holds `origin/dev`: false when a landing would rebase it. */
  readonly holdsDev: (head: string) => boolean;
  /** Whether a landing holds this repository's landing lock now. */
  readonly landingHeld: () => boolean;
  readonly now: () => number;
  /** Where `worker.json`, `worker.log` and the worker's run lock live, shared by every repository's landing. */
  readonly dir: string;
  /** The repository the pass lands in, as `repositoryOf` spells origin: the memo and the log name it. */
  readonly repository: string;
}

interface Remembered {
  readonly key: string;
  readonly verdict: string;
  readonly at: number;
  /** How long after `at` the target waits while its key stays. */
  readonly wait: number;
}

/** The memo: each pull request's last run, by `<repository>#<number>`. */
type Memo = Map<string, Remembered>;

function fieldError(what: string, value: unknown): Error {
  return new Error(`${what} does not read: ${JSON.stringify(value)}`);
}

function parsed(out: string, what: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${what} printed no JSON: ${out.trim()}`);
  }
}

function openPullRequest(value: unknown, what: string): OpenPullRequest {
  if (!isRecord(value) || !Array.isArray(value["labels"])) throw fieldError(what, value);

  const { number, headRefOid, headRefName, baseRefName, isDraft } = value;

  if (
    typeof number !== "number" ||
    typeof headRefOid !== "string" ||
    typeof headRefName !== "string" ||
    typeof baseRefName !== "string" ||
    typeof isDraft !== "boolean"
  ) {
    throw fieldError(what, value);
  }

  const labels = value["labels"].map((label: unknown) => {
    if (!isRecord(label) || typeof label["name"] !== "string") throw fieldError(what, value);

    return label["name"];
  });

  return {
    number,
    head: headRefOid,
    branch: headRefName,
    base: baseRefName,
    labels,
    draft: isDraft,
  };
}

/** Every open pull request: the chains the targets stand in name layers no label lists. */
async function openPullRequests(gh: Gh): Promise<readonly OpenPullRequest[]> {
  const what = "gh pr list";
  const out = await gh(["pr", "list", "--state", "open", "--limit", "200", "--json", FIELDS]);
  const listed = parsed(out, what);

  if (!Array.isArray(listed)) throw fieldError(what, listed);

  return listed.map((value: unknown) => openPullRequest(value, `a pull request ${what} printed`));
}

/** Pull request `number` as GitHub holds it now: after a landing, with the labels `land.ts` left on it. */
async function viewed(gh: Gh, number: number): Promise<OpenPullRequest> {
  const what = `gh pr view ${number}`;

  return openPullRequest(
    parsed(await gh(["pr", "view", String(number), "--json", FIELDS]), what),
    what,
  );
}

/** Whether the worker may land `pr` as one layer: approved by the human, or low and ready. */
function landable(pr: OpenPullRequest): boolean {
  return (
    TIERED_BRANCH.test(pr.branch) &&
    (pr.labels.includes(LAND_OK) ||
      (pr.labels.includes(TIER_LOW) && !pr.draft && !pr.labels.includes(NEEDS_HUMAN)))
  );
}

/**
 * The open pull requests from `bottom`, based on `dev`, up: each based on the one under it, the top the one no open
 * pull request is based on; null when two are based on one layer, as a stack that forks.
 */
function lineFrom(
  bottom: OpenPullRequest,
  open: readonly OpenPullRequest[],
): OpenPullRequest[] | null {
  const layers = [bottom];

  for (let top = bottom; ;) {
    const { branch } = top;
    const above = open.filter((pr) => pr.base === branch);
    const [only] = above;

    if (only === undefined) return layers;

    if (above.length > 1 || layers.includes(only)) return null;

    layers.push(only);
    top = only;
  }
}

/**
 * What a pass lands, by number: the top of each line of open pull requests from `dev` up whose every layer is
 * landable, a single pull request being a line of one. A line with any other layer, or a fork, or a branch two open
 * pull requests head, lands only from a session: landed in part, it would leave a layer based on a merged branch.
 */
export function targetsOf(open: readonly OpenPullRequest[]): OpenPullRequest[] {
  const heads = (branch: string) => open.filter((pr) => pr.branch === branch).length;

  return open
    .filter((pr) => pr.base === DEV)
    .flatMap((bottom) => {
      const layers = lineFrom(bottom, open);
      const top = layers?.at(-1);

      return top !== undefined &&
        layers?.every((layer) => landable(layer) && heads(layer.branch) === 1) === true
        ? [top]
        : [];
    })
    .toSorted((a, b) => a.number - b.number);
}

/** When `land-ok` and `tier:low` last went on pull request `number`, as GitHub dates the events. */
async function labelledAt(gh: Gh, number: number): Promise<ReadonlyMap<string, string>> {
  const out = await gh([
    "api",
    `repos/{owner}/{repo}/issues/${number}/events`,
    "--paginate",
    "--jq",
    `.[] | select(.event == "labeled" and (.label.name == "${LAND_OK}" or .label.name == "${TIER_LOW}")) | "\\(.label.name) \\(.created_at)"`,
  ]);

  const dates = new Map<string, string>();

  for (const line of out.split("\n")) {
    const [label, at] = line.split(" ");

    if (label !== undefined && at !== undefined) dates.set(label, at);
  }

  return dates;
}

/** What a memo entry compares: `pr`'s head, its tier labels, and when `land-ok` last went on it. */
function keyOf(pr: OpenPullRequest, labelled: ReadonlyMap<string, string>): string {
  const tiers = TIER_LABELS.filter((label) => pr.labels.includes(label)).join(",");
  const approved = pr.labels.includes(LAND_OK) ? (labelled.get(LAND_OK) ?? "") : "";

  return `${pr.head} ${tiers} ${approved}`;
}

/** When the newest of `pr`'s `land-ok` and `tier:low` went on it, null when GitHub dates neither. */
function freshestLabel(pr: OpenPullRequest, labelled: ReadonlyMap<string, string>): number | null {
  const dates = [LAND_OK, TIER_LOW].flatMap((label) => {
    const at = labelled.get(label);

    return pr.labels.includes(label) && at !== undefined ? [Date.parse(at)] : [];
  });

  return dates.length === 0 ? null : Math.max(...dates);
}

function linesOf(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

/** The verdict a run printed: its `landed` line on stdout, else its last `land:` line on stderr, else its last line. */
export function verdictOf({ stdout, stderr }: LandRun): string {
  const out = linesOf(stdout);
  const err = linesOf(stderr);

  return (
    out.findLast((line) => line.startsWith("landed ")) ??
    err.findLast((line) => line.startsWith("land: ")) ??
    err.at(-1) ??
    out.at(-1) ??
    "land.ts printed nothing"
  );
}

function withoutUrls(text: string): string {
  return text.replaceAll(/https?:\/\/\S+/gu, "<url>");
}

/** Whether two verdicts are one refusal, the URL of the run each started aside. */
function sameRefusal(verdict: string, before: string): boolean {
  return withoutUrls(verdict) === withoutUrls(before);
}

function rememberedOf(value: unknown, file: string): Remembered {
  if (
    !isRecord(value) ||
    typeof value["key"] !== "string" ||
    typeof value["verdict"] !== "string" ||
    typeof value["at"] !== "number" ||
    typeof value["wait"] !== "number"
  ) {
    throw new Error(
      `${file} holds an entry that does not read, ${JSON.stringify(value)}: remove the file`,
    );
  }

  return { key: value["key"], verdict: value["verdict"], at: value["at"], wait: value["wait"] };
}

function readMemo(file: string): Memo {
  if (!existsSync(file)) return new Map();

  let read: unknown;

  try {
    read = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} does not read (${messageOf(error)}): remove the file`, {
      cause: error,
    });
  }

  if (!isRecord(read)) throw new Error(`${file} holds no object: remove the file`);

  return new Map(
    Object.entries(read).map(([target, value]) => [target, rememberedOf(value, file)]),
  );
}

function writeMemo(file: string, memo: Memo): void {
  writeAtomicSync(file, `${JSON.stringify(Object.fromEntries(memo), null, 2)}\n`);
}

function log(deps: WorkerDeps, pr: OpenPullRequest, text: string): void {
  appendFileSync(
    join(deps.dir, "worker.log"),
    `--- ${new Date(deps.now()).toISOString()} ${deps.repository}#${pr.number} ${pr.head.slice(0, 8)}\n${text.trimEnd()}\n`,
  );
}

/** Lands `pr`, or says why not; `before` is the verdict of its last run when nothing changed since. */
async function landing(
  deps: WorkerDeps,
  pr: OpenPullRequest,
  before: string | null,
): Promise<string> {
  if (pr.base === DEV && !deps.holdsDev(pr.head)) {
    try {
      deps.probeSigning();
    } catch (error) {
      const verdict = `land: a rebase needs a signature this machine cannot make: ${messageOf(error)}`;

      if (before !== verdict)
        await deps.gh(["pr", "comment", String(pr.number), "--body", SIGNING_COMMENT]);

      log(deps, pr, verdict);

      return verdict;
    }
  }

  const run = deps.land(pr.number);

  log(deps, pr, `${run.stdout}${run.stderr}`);

  return verdictOf(run);
}

/** One target's turn: the line it prints, and its memo entry once it ran. */
async function turn(
  deps: WorkerDeps,
  pr: OpenPullRequest,
  prior: Remembered | undefined,
): Promise<{ readonly line: string; readonly remembered: Remembered | null }> {
  const labelled = await labelledAt(deps.gh, pr.number);
  const fresh = freshestLabel(pr, labelled);
  const now = deps.now();

  if (fresh !== null && now - fresh < GRACE_MS) {
    const minutes = Math.floor((now - fresh) / 60_000);

    return {
      line: `landing-worker: #${pr.number} waits: labelled ${minutes} min ago, for the landing that labelled it`,
      remembered: null,
    };
  }

  const key = keyOf(pr, labelled);
  const unchanged = prior !== undefined && prior.key === key;

  if (unchanged && now < prior.at + prior.wait) {
    return {
      line: `landing-worker: #${pr.number} skipped, unchanged since: ${prior.verdict}`,
      remembered: null,
    };
  }

  const verdict = await landing(deps, pr, unchanged ? prior.verdict : null);

  // The pull request as the run left it: the tier label a landing puts on is no change to run again on.
  const left = await viewed(deps.gh, pr.number);
  const repeated = unchanged && sameRefusal(verdict, prior.verdict);

  return {
    line: `landing-worker: #${pr.number}: ${verdict}`,
    remembered: {
      key: keyOf(left, await labelledAt(deps.gh, pr.number)),
      verdict,
      at: deps.now(),
      wait: repeated ? Math.min(prior.wait * 2, MAX_WAIT_MS) : RETRY_MS,
    },
  };
}

async function pass(deps: WorkerDeps): Promise<readonly string[]> {
  const open = await openPullRequests(deps.gh);
  const memoFile = join(deps.dir, "worker.json");
  const targetOf = (pr: OpenPullRequest) => `${deps.repository}#${pr.number}`;
  const openTargets = new Set(open.map((pr) => targetOf(pr)));
  const ours = `${deps.repository}#`;

  // What a closed pull request of this repository left in the memo goes: its number never comes back.
  const memo = new Map(
    [...readMemo(memoFile)].filter(
      ([target]) => !target.startsWith(ours) || openTargets.has(target),
    ),
  );

  const targets = targetsOf(open);
  const lines: string[] = [];

  for (const pr of targets) {
    if (deps.landingHeld()) {
      lines.push(
        `landing-worker: a landing holds dev: #${pr.number} and the rest wait for the next pass`,
      );
      break;
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- one landing at a time: each holds the landing lock to its end.
      const { line, remembered } = await turn(deps, pr, memo.get(targetOf(pr)));

      if (remembered !== null) {
        memo.set(targetOf(pr), remembered);
        writeMemo(memoFile, memo);
      }

      lines.push(line);
    } catch (error) {
      lines.push(`landing-worker: #${pr.number}: ${messageOf(error)}`);
    }
  }

  writeMemo(memoFile, memo);

  if (targets.length === 0) lines.push(`landing-worker: nothing carries ${LAND_OK} or ${TIER_LOW}`);

  return lines;
}

/** One pass of the worker, the lines it prints; one line alone when another worker runs. */
export async function runWorkerOnce(deps: WorkerDeps): Promise<readonly string[]> {
  mkdirSync(deps.dir, { recursive: true });

  const lock = takeRunLock(
    { lock: join(deps.dir, "worker.lock"), holder: join(deps.dir, "worker-holder.json") },
    { pid: process.pid, since: new Date(deps.now()).toISOString() },
  );

  if (lock === null) return ["landing-worker: another worker runs: this pass ends"];

  try {
    return await pass(deps);
  } finally {
    closeSync(lock);
  }
}
