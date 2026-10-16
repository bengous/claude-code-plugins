/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this module IS the parser of what `gh` prints and of the cache file read back from disk: each reader narrows one field of a JSON record, and a value of another shape reads as a failed lookup or no cache. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { outputOf, run, succeeded } from "./exec.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import type { Check, PullRequestFacts, RepoFacts } from "./landing.ts";
import { stateDir } from "./state.ts";

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

function writeCache(file: string, cache: Cache): void {
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temporary, JSON.stringify(cache));
  renameSync(temporary, file);
}

function repoFactsFrom(record: Record<string, unknown>): RepoFacts | null {
  const visibility = stringField(record, "visibility");
  const defaultBranch = stringField(record, "defaultBranch");

  return visibility === undefined || defaultBranch === undefined
    ? null
    : { visibility, defaultBranch };
}

async function gh(args: readonly string[], cwd: string): Promise<Lookup<unknown>> {
  const result = await run(["gh", ...args], { cwd, timeoutMs: GH_TIMEOUT_MS });

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
  now = Date.now(),
): Promise<Lookup<RepoFacts>> {
  const file = cachePath(sessionId);
  const cache = readCache(file, now);
  const cached = cache.repos[slug];

  if (cached !== undefined) {
    return { kind: "found", value: cached };
  }

  const lookup = await gh(["repo", "view", slug, "--json", "visibility,defaultBranchRef"], cwd);

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
  writeCache(file, cache);

  return { kind: "found", value: facts };
}

/** The pull request `gh pr merge` would merge, read with the same selector and `--repo`, never cached. */
export async function pullRequestOf(
  cwd: string,
  selector: string | null,
  repo: string | null,
): Promise<Lookup<PullRequestFacts>> {
  const lookup = await gh(
    [
      "pr",
      "view",
      ...(selector === null ? [] : [selector]),
      ...(repo === null ? [] : ["--repo", repo]),
      "--json",
      "number,url,baseRefName,mergeable,statusCheckRollup",
    ],
    cwd,
  );

  if (lookup.kind === "failed") {
    return lookup;
  }

  const record = isRecord(lookup.value) ? lookup.value : {};
  const number = record["number"];
  const url = stringField(record, "url");
  const baseRefName = stringField(record, "baseRefName");
  const mergeable = stringField(record, "mergeable");
  const rollup = record["statusCheckRollup"];

  if (
    typeof number !== "number" ||
    url === undefined ||
    baseRefName === undefined ||
    mergeable === undefined
  ) {
    return { kind: "failed", why: "gh pr view printed no number, url, base or mergeable state" };
  }

  const checks = Array.isArray(rollup) ? rollup.flatMap((entry) => checkOf(entry)) : [];

  return { kind: "found", value: { number, url, baseRefName, mergeable, checks } };
}

/** A check run reads its conclusion once completed, its status before; a commit status reads its state. */
function checkOf(entry: unknown): Check[] {
  if (!isRecord(entry)) {
    return [];
  }

  const name = stringField(entry, "name") ?? stringField(entry, "context");
  const startedAt = stringField(entry, "startedAt") ?? stringField(entry, "createdAt") ?? "";
  const status = stringField(entry, "status");

  const state =
    stringField(entry, "__typename") === "CheckRun"
      ? status === "COMPLETED"
        ? stringField(entry, "conclusion")
        : status
      : stringField(entry, "state");

  return name === undefined || state === undefined ? [] : [{ name, state, startedAt }];
}
