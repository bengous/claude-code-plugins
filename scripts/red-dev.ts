#!/usr/bin/env bun

/**
 * The `red-dev` workflow: while `dev`'s head is red in CI, one open issue labelled `red-dev` says
 * so. Each CI run that completes on `dev` wakes it, but it decides from `dev`'s head alone, read
 * fresh: the newest completed CI push run of that commit. Red opens the issue, or comments on the
 * open one, once per commit, which a marker in the text records; green closes it; no completed run
 * yet changes nothing, since the head's own completion wakes it again. Runs that end out of order
 * therefore reach the verdict of the head, and the workflow's concurrency group runs one at a time.
 *
 * Reads `GITHUB_REPOSITORY` and `CI_WORKFLOW_ID`, the CI workflow's id; calls `gh` with the job's
 * token.
 */

import type { Env } from "./affected.ts";

export const LABEL = "red-dev";

const TITLE = "CI is red on dev";

const RED = new Set(["failure", "timed_out", "startup_failure"]);

export interface HeadRun {
  readonly id: number;
  readonly url: string;
  readonly conclusion: string;
}

export interface OpenIssue {
  readonly number: number;
  /** Its body, then each comment's. */
  readonly texts: readonly string[];
}

/** What red-dev reads of GitHub: dev's head, its newest completed CI push run, the open issues. */
export interface Observed {
  readonly head: string;
  readonly run: HeadRun | null;
  readonly failedJobs: readonly string[];
  /** Newest first. */
  readonly issues: readonly OpenIssue[];
}

export type Action =
  | { readonly kind: "open"; readonly body: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "close"; readonly issues: readonly number[]; readonly comment: string }
  | { readonly kind: "none"; readonly reason: string };

export type Gh = (args: readonly string[]) => Promise<string>;

/** The line a report of `sha` carries, so a commit is never reported twice. */
export function markerOf(sha: string): string {
  return `<!-- red-dev:${sha} -->`;
}

export function decide(observed: Observed): Action {
  const { head, run, failedJobs, issues } = observed;

  if (run === null)
    return { kind: "none", reason: `dev's head ${head} has no completed CI push run yet` };

  if (run.conclusion === "success") {
    return issues.length === 0
      ? { kind: "none", reason: `dev is green at ${head}, and no ${LABEL} issue is open` }
      : {
          kind: "close",
          issues: issues.map((issue) => issue.number),
          comment: `CI's push run on \`dev\` is green at ${head}: ${run.url}`,
        };
  }

  if (!RED.has(run.conclusion)) {
    return {
      kind: "none",
      reason: `dev's head ${head} ended ${run.conclusion}, neither red nor green`,
    };
  }

  if (issues.some((issue) => issue.texts.some((text) => text.includes(markerOf(head))))) {
    return { kind: "none", reason: `dev's head ${head} is reported already` };
  }

  const body = `CI's push run on \`dev\` failed at ${head}: ${run.url}\n\nRed jobs: ${failedJobs.map((job) => `\`${job}\``).join(", ")}.\n\n${markerOf(head)}`;
  const [newest] = issues;

  return newest === undefined
    ? { kind: "open", body }
    : { kind: "comment", issue: newest.number, body };
}

function required(env: Env, name: string): string {
  const value = env[name];

  if (value === undefined || value === "") throw new Error(`${name} is unset`);

  return value;
}

interface RunJson {
  id: number;
  html_url: string;
  conclusion: string;
}

interface JobJson {
  name: string;
  conclusion: string | null;
}

interface IssueJson {
  number: number;
  body: string;
  comments: { body: string }[];
}

async function observe(gh: Gh, repo: string, workflow: string): Promise<Observed> {
  const head = (await gh(["api", `repos/${repo}/commits/dev`, "--jq", ".sha"])).trim();

  const runs: RunJson[] = JSON.parse(
    await gh([
      "api",
      `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${head}&event=push&status=completed&per_page=1`,
      "--jq",
      ".workflow_runs",
    ]),
  );

  const [newest] = runs;

  const run =
    newest === undefined
      ? null
      : { id: newest.id, url: newest.html_url, conclusion: newest.conclusion };

  const jobs: JobJson[] =
    run !== null && RED.has(run.conclusion)
      ? JSON.parse(
          await gh([
            "api",
            `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
            "--jq",
            ".jobs",
          ]),
        )
      : [];

  const listed: IssueJson[] = JSON.parse(
    await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      LABEL,
      "--state",
      "open",
      "--json",
      "number,body,comments",
    ]),
  );

  return {
    head,
    run,
    failedJobs: jobs.flatMap((job) => (job.conclusion === "failure" ? [job.name] : [])),
    issues: listed
      .toSorted((a, b) => b.number - a.number)
      .map((issue) => ({
        number: issue.number,
        texts: [issue.body, ...issue.comments.map((comment) => comment.body)],
      })),
  };
}

/** Reads dev's head, settles what to do, does it with `gh`, and says what it did. */
export async function report(env: Env, gh: Gh): Promise<string> {
  const repo = required(env, "GITHUB_REPOSITORY");
  const action = decide(await observe(gh, repo, required(env, "CI_WORKFLOW_ID")));

  switch (action.kind) {
    case "open": {
      await gh([
        "label",
        "create",
        LABEL,
        "--repo",
        repo,
        "--color",
        "B60205",
        "--description",
        "CI's push run on dev is red",
        "--force",
      ]);

      const url = await gh([
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        TITLE,
        "--body",
        action.body,
        "--label",
        LABEL,
      ]);

      return `opened ${url.trim()}`;
    }

    case "comment":
      await gh(["issue", "comment", String(action.issue), "--repo", repo, "--body", action.body]);

      return `commented on #${action.issue}`;
    case "close":
      for (const issue of action.issues) {
        await gh(["issue", "close", String(issue), "--repo", repo, "--comment", action.comment]);
      }

      return `closed ${action.issues.map((issue) => `#${issue}`).join(", ")}`;
    case "none":
      return action.reason;
  }
}

async function ghCli(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr.trim()}`);
  }

  return stdout;
}

if (import.meta.main) {
  console.log(`red-dev: ${await report(process.env, ghCli)}`);
}
