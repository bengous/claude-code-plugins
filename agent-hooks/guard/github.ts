/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this module IS the parser of what `gh` prints and of the cache file read back from disk: each reader narrows one field of a JSON record, and a value of another shape reads as a failed lookup or no cache. */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Deadline } from "../exec.ts";
import { outputOf, run, succeeded } from "../exec.ts";
import { isRecord, recordField, stringField } from "../json.ts";
import { stateDir, writeAtomically } from "../state.ts";

export type RepoFacts = { readonly visibility: string; readonly defaultBranch: string };

/** One check as `gh pr checks --json` prints it: a commit status has no workflow and no event. */
export type Check = {
  readonly name: string;
  readonly state: string;
  readonly startedAt: string;
  readonly workflow: string;
  readonly event: string;
};

export type PullRequestFacts = {
  readonly number: number;
  readonly url: string;
  readonly baseRefName: string;
  readonly mergeable: string;
  readonly checks: readonly Check[];
};

export type Lookup<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "failed"; readonly why: string };

const GH_TIMEOUT_MS = 8000;

const SCP_URL = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u;

const NETWORK_URL =
  /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u;

type Cache = { updatedAt: number; repos: Record<string, RepoFacts> };

/** `host/owner/name` of a remote URL, the form `gh repo view` takes; null for a local path or a URL of another shape. */
export function githubSlugOf(url: string): string | null {
  const match = SCP_URL.exec(url) ?? NETWORK_URL.exec(url);

  return match === null ? null : `${match[1]}/${match[2]}/${match[3]}`;
}

/** `host/owner/name` of what `gh --repo` takes: `owner/name`, `host/owner/name` or a URL. */
export function slugOfRepoOption(value: string): string | null {
  if (value.includes("://") || value.includes("@")) {
    return githubSlugOf(value);
  }

  const parts = value.split("/");

  return parts.length === 2 ? `github.com/${value}` : parts.length === 3 ? value : null;
}

/** `host/owner/name` of a pull request URL. */
export function slugOfPullRequest(url: string): string | null {
  const match = /^https?:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/u.exec(url);

  return match === null ? null : `${match[1]}/${match[2]}/${match[3]}`;
}

/** The session's cache of repository facts: one file per session, beside the kit's states, pruned with them. */
export function cachePath(sessionId: string): string {
  return path.join(stateDir(), `github__${sessionId.replaceAll(/[^a-zA-Z0-9._-]/gu, "_")}.json`);
}

function readCache(file: string, now: number): Cache {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const repos = isRecord(value) ? recordField(value, "repos") : undefined;

    if (repos !== undefined) {
      const entries = Object.entries(repos).flatMap(([slug, facts]) => {
        const parsed = isRecord(facts) ? repoFactsFrom(facts) : null;

        return parsed === null ? [] : [[slug, parsed] as const];
      });

      return { updatedAt: now, repos: Object.fromEntries(entries) };
    }
  } catch {
    // No cache yet, or one this reader cannot parse: the lookup runs again.
  }

  return { updatedAt: now, repos: {} };
}

function repoFactsFrom(record: Record<string, unknown>): RepoFacts | null {
  const visibility = stringField(record, "visibility");
  const defaultBranch = stringField(record, "defaultBranch");

  return visibility === undefined || defaultBranch === undefined
    ? null
    : { visibility, defaultBranch };
}

async function gh(
  args: readonly string[],
  cwd: string,
  deadline: Deadline,
): Promise<Lookup<unknown>> {
  const timeoutMs = Math.min(GH_TIMEOUT_MS, deadline.remaining());
  const result = await run(["gh", ...args], { cwd, timeoutMs });

  if (!succeeded(result)) {
    const why = outputOf(result).split("\n")[0] ?? "";

    return {
      kind: "failed",
      why: why === "" ? `gh ${args[0] ?? ""} ${args[1] ?? ""} failed` : why,
    };
  }

  try {
    const parsed: unknown = JSON.parse(result.kind === "exited" ? result.stdout : "");

    return { kind: "found", value: parsed };
  } catch {
    return { kind: "failed", why: `gh printed no JSON for ${args.join(" ")}` };
  }
}

/** Visibility and default branch of `slug`, read once per session and repository: a failed lookup is not cached. */
export async function repoFactsOf(
  slug: string,
  sessionId: string,
  cwd: string,
  deadline: Deadline,
  now = Date.now(),
): Promise<Lookup<RepoFacts>> {
  const file = cachePath(sessionId);
  const cache = readCache(file, now);
  const cached = cache.repos[slug];

  if (cached !== undefined) {
    return { kind: "found", value: cached };
  }

  const lookup = await gh(
    ["repo", "view", slug, "--json", "visibility,defaultBranchRef"],
    cwd,
    deadline,
  );

  if (lookup.kind === "failed") {
    return lookup;
  }

  const record = isRecord(lookup.value) ? lookup.value : {};
  const visibility = stringField(record, "visibility");
  const defaultBranch = stringField(recordField(record, "defaultBranchRef") ?? {}, "name");

  if (visibility === undefined || defaultBranch === undefined) {
    return { kind: "failed", why: `gh repo view ${slug} printed no visibility or default branch` };
  }

  const facts = { visibility, defaultBranch };
  cache.repos[slug] = facts;

  try {
    writeAtomically(file, JSON.stringify(cache));
  } catch (error) {
    // The cache only saves a lookup: a state dir that cannot be written leaves the verdict as it is.
    console.error(`agent-hooks: ${file}: cache not written: ${String(error)}`);
  }

  return { kind: "found", value: facts };
}

const NO_CHECKS = /^no (?:required )?checks reported/u;

/**
 * The pull request `gh pr merge` would merge, read with the same selector and `--repo`, never cached. Its checks come
 * from `gh pr checks`, the one read that carries each run's event; "no checks reported" reads as none.
 */
export async function pullRequestOf(
  cwd: string,
  selector: string | null,
  repo: string | null,
  deadline: Deadline,
): Promise<Lookup<PullRequestFacts>> {
  const target = [
    ...(selector === null ? [] : [selector]),
    ...(repo === null ? [] : ["--repo", repo]),
  ];

  const [view, listed] = await Promise.all([
    gh(["pr", "view", ...target, "--json", "number,url,baseRefName,mergeable"], cwd, deadline),
    gh(["pr", "checks", ...target, "--json", "name,state,workflow,event,startedAt"], cwd, deadline),
  ]);

  if (view.kind === "failed") {
    return view;
  }

  if (listed.kind === "failed" && !NO_CHECKS.test(listed.why)) {
    return listed;
  }

  const record = isRecord(view.value) ? view.value : {};
  const number = record["number"];
  const url = stringField(record, "url");
  const baseRefName = stringField(record, "baseRefName");
  const mergeable = stringField(record, "mergeable");

  if (
    typeof number !== "number" ||
    url === undefined ||
    baseRefName === undefined ||
    mergeable === undefined
  ) {
    return { kind: "failed", why: "gh pr view printed no number, url, base or mergeable state" };
  }

  const entries = listed.kind === "found" && Array.isArray(listed.value) ? listed.value : [];

  return {
    kind: "found",
    value: {
      number,
      url,
      baseRefName,
      mergeable,
      checks: entries.flatMap((entry) => checkOf(entry)),
    },
  };
}

function checkOf(entry: unknown): Check[] {
  if (!isRecord(entry)) {
    return [];
  }

  const name = stringField(entry, "name");
  const state = stringField(entry, "state");

  return name === undefined || state === undefined
    ? []
    : [
        {
          name,
          state,
          startedAt: stringField(entry, "startedAt") ?? "",
          workflow: stringField(entry, "workflow") ?? "",
          event: stringField(entry, "event") ?? "",
        },
      ];
}
