#!/usr/bin/env bun

/**
 * CI's `red-dev` job, after a push run on `dev`: while `dev`'s head is red, one open issue
 * labelled `red-dev` says so. A red run opens it, naming the run and its red jobs, or comments
 * on the open one; a green run closes it. A run on a commit `dev` has moved past does nothing,
 * since the newer push's run reports, so runs that end out of order leave no stale issue.
 *
 * Reads `NEEDS`, the workflow's `toJSON(needs)`, and `GITHUB_REPOSITORY`, `GITHUB_SHA`,
 * `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`; calls `gh` with the job's token.
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

export function plan(verdict: Verdict, openIssues: readonly number[], run: Run): Action {
  const [newest] = openIssues;

  switch (verdict.kind) {
    case "red": {
      const body = `CI's push run on \`dev\` failed at ${run.sha}: ${run.url}\n\nRed jobs: ${verdict.jobs.map((job) => `\`${job}\``).join(", ")}.`;

      return newest === undefined
        ? { kind: "open", body }
        : { kind: "comment", issue: newest, body };
    }

    case "green":
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

/** Reads the run, settles what to do, does it with `gh`, and says what it did. */
export async function report(env: Env, gh: Gh): Promise<string> {
  const repo = required(env, "GITHUB_REPOSITORY");
  const sha = required(env, "GITHUB_SHA");

  const run: Run = {
    sha,
    url: `${required(env, "GITHUB_SERVER_URL")}/${repo}/actions/runs/${required(env, "GITHUB_RUN_ID")}`,
  };

  const verdict = verdictOf(parseNeeds(required(env, "NEEDS")));
  const head = (await gh(["api", `repos/${repo}/commits/dev`, "--jq", ".sha"])).trim();

  if (head !== sha) return `dev has moved past ${sha} to ${head}: that push's run reports`;

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
