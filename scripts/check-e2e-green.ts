#!/usr/bin/env bun

/**
 * The e2e gate: a push to `dev` whose range touches the browser suite's paths
 * needs a green `e2e` check run on the exact commit it pushes. One green run is
 * enough, whatever the commit's other `e2e` runs say.
 *
 *   bun ./scripts/check-e2e-green.ts < <git's pushed-ref lines>
 *
 * It checks each line whose remote ref is `refs/heads/dev`, over the diff from
 * its remote oid to its local oid, with no fetch. A push to any other ref, or
 * one that touches no e2e path, passes without calling `gh`. Exit 1 names the
 * commit, the reason and the next command: start a run, wait for one, or re-run
 * a red one. A `gh` failure refuses too. The pre-push hook runs it, outside `EXPECTED_COMMANDS`:
 * `.claude/rules/hook-ladder.md` says why.
 */

const DEV = "refs/heads/dev";

const CHECK = "e2e";

const START_A_RUN =
  "gh pr edit <branch> --add-label e2e, <branch> being the branch of its pull request, or gh workflow run ci.yml --ref <branch> for a branch with none";

// The local ref is the source as typed, `HEAD@{1 day ago}` included: only the
// last three fields are free of spaces.
const PUSHED_REF_LINE = /^.+ ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+) ([0-9a-f]{40}|[0-9a-f]{64})$/u;

const ZERO_OID = /^0+$/u;

const WORKFLOW_RUN = /\/actions\/runs\/(\d+)\/job\//u;

// Decided in #168, and owned here alone: what the browser suite loads. A new
// directory under `vellum/` is inside until it is listed as left out.
const E2E_PATHS = ["vellum/**", "docs/plugin-testing.md", "mise.toml", ".github/workflows/ci.yml"];

const NOT_E2E_PATHS = [
  "vellum/src/core/engine/**",
  "vellum/src/extensions/*/engine.ts",
  "vellum/hooks/**",
  "vellum/skills/**",
  "vellum/agents/**",
  "**/*.spec.ts",
  "**/*.test.ts",
];

const included = E2E_PATHS.map((pattern) => new Bun.Glob(pattern));

const excluded = NOT_E2E_PATHS.map((pattern) => new Bun.Glob(pattern));

/** A pushed-ref line that moves dev; a null `remote` is git's zero oid, a remote without dev. */
export interface PushToDev {
  readonly local: string;
  readonly remote: string | null;
}

/** A check run as `gh api` lists it, reduced to what the gate reads. */
export interface CheckRun {
  /** The Actions job's id: a later job has a larger one. */
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly detailsUrl: string | null;
}

export type CheckRuns =
  | { readonly kind: "listed"; readonly runs: readonly CheckRun[] }
  | { readonly kind: "unreadable"; readonly error: string };

/** Why a commit stays off dev, and the command that moves it on. */
export interface Refusal {
  readonly reason: string;
  readonly next: string;
}

export function isE2ePath(path: string): boolean {
  return included.some((glob) => glob.match(path)) && !excluded.some((glob) => glob.match(path));
}

/** The lines that move `refs/heads/dev` among those git hands a pre-push hook. */
export function parsePushedRefs(lines: string): readonly PushToDev[] {
  return lines
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const [, local, remoteRef, remote] = PUSHED_REF_LINE.exec(line) ?? [];

      if (local === undefined || remoteRef === undefined || remote === undefined) {
        throw new Error(`not a line git hands a pre-push hook: ${JSON.stringify(line)}`);
      }

      if (remoteRef !== DEV || ZERO_OID.test(local)) return [];

      return [{ local, remote: ZERO_OID.test(remote) ? null : remote }];
    });
}

function workflowRunOf(run: CheckRun): string {
  const [, id] = WORKFLOW_RUN.exec(run.detailsUrl ?? "") ?? [];

  if (id === undefined) {
    throw new Error(`check run ${run.id} links no workflow run: ${String(run.detailsUrl)}`);
  }

  return id;
}

/** What keeps a commit off dev given its check runs, or null when one of them is green. */
export function refusalFor(checkRuns: CheckRuns): Refusal | null {
  if (checkRuns.kind === "unreadable") {
    return {
      reason: `gh could not list its check runs: ${checkRuns.error}`,
      next: `If GitHub has never seen that commit, push its branch, then start a run on it: ${START_A_RUN}.`,
    };
  }

  const runs = checkRuns.runs.filter((run) => run.name === CHECK);

  if (runs.some((run) => run.conclusion === "success")) return null;

  const found = runs.map((run) => run.conclusion ?? run.status).join(", ");
  const reason = `it has no green ${CHECK} check run (found: ${found === "" ? "none" : found})`;
  const running = runs.find((run) => run.status !== "completed");

  if (running !== undefined) {
    return {
      reason,
      next: `Wait for the run in progress: gh run watch ${workflowRunOf(running)}.`,
    };
  }

  // A run nobody asked `e2e` of skips it, and its re-run replays the same event: skipped again.
  const [newest] = runs
    .filter((run) => run.conclusion !== "skipped")
    .toSorted((left, right) => right.id - left.id);

  if (newest === undefined) return { reason, next: `Start a run on that commit: ${START_A_RUN}.` };

  // `e2e` only reads the windows' results: re-running it alone would read the same red window.
  return {
    reason,
    next: `Re-run its red windows and the e2e after them: gh run rerun ${workflowRunOf(newest)} --failed.`,
  };
}

function spawnGit(args: readonly string[]) {
  return Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
}

function git(args: readonly string[]): string {
  const result = spawnGit(args);

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

function changedPaths({ local, remote }: PushToDev): readonly string[] {
  if (remote !== null && spawnGit(["cat-file", "-e", `${remote}^{commit}`]).exitCode !== 0) {
    throw new Error(
      `${DEV} is at ${remote} on the remote, a commit this repository does not have: fetch origin first`,
    );
  }

  const listed =
    remote === null
      ? git(["ls-tree", "-r", "-z", "--name-only", local])
      : git(["diff", "--name-only", "--no-renames", "-z", remote, local]);

  return listed.split("\0").filter((path) => path !== "");
}

function checkRunsOf(commit: string): CheckRuns {
  const result = Bun.spawnSync(
    [
      "gh",
      "api",
      "--paginate",
      `repos/{owner}/{repo}/commits/${commit}/check-runs?filter=all&per_page=100`,
      "--jq",
      ".check_runs[] | {id, name, status, conclusion, detailsUrl: .details_url}",
    ],
    {
      // Either variable makes gh indent and color its jq results, one line no longer one run.
      env: { ...process.env, CLICOLOR_FORCE: "0", GH_FORCE_TTY: "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (result.exitCode !== 0) return { kind: "unreadable", error: result.stderr.toString().trim() };

  // jq writes each key, null when GitHub left it out, and a run with a field
  // missing can only fail to read as green.
  return {
    kind: "listed",
    runs: result.stdout
      .toString()
      .split("\n")
      .filter((line) => line !== "")
      .map((line): CheckRun => JSON.parse(line)),
  };
}

function refusalOf(push: PushToDev): string | null {
  const touched = changedPaths(push).filter((path) => isE2ePath(path));
  const [first] = touched;

  if (first === undefined) return null;

  const refusal = refusalFor(checkRunsOf(push.local));

  if (refusal === null) return null;

  const more = touched.length > 1 ? ` and ${touched.length - 1} more e2e paths` : "";

  return [
    `${DEV} at ${push.local} touches ${first}${more}, and ${refusal.reason}.`,
    `${refusal.next} Push to dev again once it is green.`,
  ].join("\n");
}

if (import.meta.main) {
  try {
    const refusals = parsePushedRefs(await Bun.stdin.text()).flatMap((push) => {
      const refusal = refusalOf(push);

      return refusal === null ? [] : [refusal];
    });

    if (refusals.length > 0) {
      console.error(refusals.join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`check-e2e-green: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
