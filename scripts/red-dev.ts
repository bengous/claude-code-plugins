#!/usr/bin/env bun

/**
 * CI's `red-dev` job, after a push run on `dev`: while `dev` is red, one open issue labelled
 * `red-dev` says so. A red run opens it, naming the run and its red jobs, or comments on the open
 * one, unless `dev` has moved past its commit to a head with a green run already; only a green
 * run of `dev`'s head closes it, so runs that end out of order leave no stale verdict.
 *
 * Reads `NEEDS`, the workflow's `toJSON(needs)`, and `GITHUB_REPOSITORY`, `GITHUB_SHA`,
 * `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`, `GITHUB_WORKFLOW_REF`; calls `gh` with the job's token.
 */

import type { Env } from "./affected.ts";

export const LABEL = "red-dev";

const TITLE = "CI is red on dev";

export type Verdict =
  | { readonly kind: "red"; readonly jobs: readonly string[] }
  | { readonly kind: "green" }
  | { readonly kind: "unsettled"; readonly jobs: readonly string[] };

export interface Run {
  readonly sha: string;
  readonly url: string;
}

/** `dev`'s head against the run's commit: the same, or newer, with or without a green run. */
export type Head =
  | { readonly kind: "this" }
  | { readonly kind: "newer"; readonly sha: string; readonly green: boolean };

export type Action =
  | { readonly kind: "open"; readonly body: string }
  | { readonly kind: "comment"; readonly issue: number; readonly body: string }
  | { readonly kind: "close"; readonly issues: readonly number[]; readonly comment: string }
  | { readonly kind: "none"; readonly reason: string };

export type Gh = (args: readonly string[]) => Promise<string>;

const SETTLED_GREEN = new Set(["success", "skipped"]);

interface Need {
  result: string;
}

/** The result of each job the workflow's `needs` names, read off `toJSON(needs)`. */
export function parseNeeds(json: string): ReadonlyMap<string, string> {
  const needs: Record<string, Need> = JSON.parse(json);

  return new Map(Object.entries(needs).map(([job, need]) => [job, need.result]));
}

/** Red once a job failed; green when every job passed or was skipped; otherwise unsettled. */
export function verdictOf(results: ReadonlyMap<string, string>): Verdict {
  const failed = [...results].flatMap(([job, result]) => (result === "failure" ? [job] : []));

  if (failed.length > 0) return { kind: "red", jobs: failed };

  const other = [...results].filter(([, result]) => !SETTLED_GREEN.has(result));

  return other.length === 0
    ? { kind: "green" }
    : { kind: "unsettled", jobs: other.map(([job, result]) => `${job} ${result}`) };
}

export function plan(
  verdict: Verdict,
  head: Head,
  openIssues: readonly number[],
  run: Run,
): Action {
  const [newest] = openIssues;

  switch (verdict.kind) {
    case "red": {
      if (head.kind === "newer" && head.green) {
        return {
          kind: "none",
          reason: `dev's head ${head.sha} has a green run already, after this red one at ${run.sha}`,
        };
      }

      const since =
        head.kind === "newer" ? `\n\ndev is at ${head.sha} since, with no green run yet.` : "";

      const body = `CI's push run on \`dev\` failed at ${run.sha}: ${run.url}\n\nRed jobs: ${verdict.jobs.map((job) => `\`${job}\``).join(", ")}.${since}`;

      return newest === undefined
        ? { kind: "open", body }
        : { kind: "comment", issue: newest, body };
    }

    case "green":
      if (head.kind !== "this") {
        return {
          kind: "none",
          reason: `dev has moved past ${run.sha} to ${head.sha}: only a green run of the head closes the issue`,
        };
      }

      return openIssues.length === 0
        ? { kind: "none", reason: `dev is green at ${run.sha}, and no ${LABEL} issue is open` }
        : {
            kind: "close",
            issues: openIssues,
            comment: `CI's push run on \`dev\` is green at ${run.sha}: ${run.url}`,
          };

    case "unsettled":
      return {
        kind: "none",
        reason: `neither red nor green at ${run.sha}: ${verdict.jobs.join(", ")}`,
      };
  }
}

function required(env: Env, name: string): string {
  const value = env[name];

  if (value === undefined || value === "") throw new Error(`${name} is unset`);

  return value;
}

/** The workflow file a run's `GITHUB_WORKFLOW_REF` names: `ci.yml` in `o/r/.github/workflows/ci.yml@ref`. */
export function workflowFileOf(workflowRef: string): string {
  const file = /\/\.github\/workflows\/([^@/]+)@/u.exec(workflowRef)?.[1];

  if (file === undefined)
    throw new Error(`GITHUB_WORKFLOW_REF names no workflow file: ${workflowRef}`);

  return file;
}

async function headOf(gh: Gh, repo: string, workflow: string, sha: string): Promise<Head> {
  const head = (await gh(["api", `repos/${repo}/commits/dev`, "--jq", ".sha"])).trim();

  if (head === sha) return { kind: "this" };

  const greenRuns = await gh([
    "api",
    `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${head}&event=push&status=success&per_page=1`,
    "--jq",
    ".total_count",
  ]);

  return { kind: "newer", sha: head, green: Number(greenRuns) > 0 };
}

/** Reads the run, settles what to do, does it with `gh`, and says what it did. */
export async function report(env: Env, gh: Gh): Promise<string> {
  const repo = required(env, "GITHUB_REPOSITORY");
  const sha = required(env, "GITHUB_SHA");

  const run: Run = {
    sha,
    url: `${required(env, "GITHUB_SERVER_URL")}/${repo}/actions/runs/${required(env, "GITHUB_RUN_ID")}`,
  };

  const verdict = verdictOf(parseNeeds(required(env, "NEEDS")));
  const workflow = workflowFileOf(required(env, "GITHUB_WORKFLOW_REF"));
  const head = await headOf(gh, repo, workflow, sha);

  const listed: { number: number }[] = JSON.parse(
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
      "number",
    ]),
  );

  const action = plan(
    verdict,
    head,
    listed.map((issue) => issue.number).toSorted((a, b) => b - a),
    run,
  );

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

  if (code !== 0)
    throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr.trim()}`);

  return stdout;
}

if (import.meta.main) {
  console.log(`red-dev: ${await report(process.env, ghCli)}`);
}
