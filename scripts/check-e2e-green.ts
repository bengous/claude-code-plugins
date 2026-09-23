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
 * commit, the reason and the command that starts a run; a `gh` failure refuses
 * too. The pre-push hook runs it, outside `EXPECTED_COMMANDS`:
 * `.claude/rules/hook-ladder.md` says why.
 */

const DEV = "refs/heads/dev";

const CHECK = "e2e";

// Until #193 lands, a pull request's run is the only one that executes `e2e`.
const START_A_RUN =
  "git push --force-with-lease origin <branch>, the branch of its pull request, whose CI run executes e2e";

// The local ref is the source as typed, `HEAD@{1 day ago}` included: only the
// last three fields are free of spaces.
const PUSHED_REF_LINE = /^.+ ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+) ([0-9a-f]{40}|[0-9a-f]{64})$/u;

const ZERO_OID = /^0+$/u;

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
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export type CheckRuns =
  | { readonly kind: "listed"; readonly runs: readonly CheckRun[] }
  | { readonly kind: "unreadable"; readonly error: string };

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

/** Why the runs of a commit do not let it reach dev, or null when one of them is green. */
export function refusalReason(checkRuns: CheckRuns): string | null {
  if (checkRuns.kind === "unreadable") {
    return `gh could not list its check runs: ${checkRuns.error}`;
  }

  const runs = checkRuns.runs.filter((run) => run.name === CHECK);

  if (runs.some((run) => run.conclusion === "success")) return null;

  const found = runs.map((run) => run.conclusion ?? run.status).join(", ");

  return `it has no green ${CHECK} check run (found: ${found === "" ? "none" : found})`;
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
      ".check_runs[] | {name, status, conclusion}",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) return { kind: "unreadable", error: result.stderr.toString().trim() };

  // jq writes each of the three keys, null when GitHub left it out, and a run
  // with a field missing can only fail to read as green.
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

  const reason = refusalReason(checkRunsOf(push.local));

  if (reason === null) return null;

  const more = touched.length > 1 ? ` and ${touched.length - 1} more e2e paths` : "";

  return [
    `${DEV} at ${push.local} touches ${first}${more}, and ${reason}.`,
    `Start a run on that commit: ${START_A_RUN}. Push to dev again once it is green.`,
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
