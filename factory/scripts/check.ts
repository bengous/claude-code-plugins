#!/usr/bin/env bun

import { parseArgs } from "node:util";

import { run } from "../lib/platform/process.ts";
import { messageOf, shellQuote } from "../lib/platform/pure.ts";
import { isRepo } from "./render.ts";

const USAGE = `Usage: check.ts --repo <owner/name>

  Reads, through gh, the GitHub side the factory needs and prints one line per item:
  ok, or missing with the gh command that would fix it. Writes nothing; reads secret
  names only, and reports each secret not visible when the token cannot list them.
  Exit 0 when every item is ok, 1 when one is missing, 2 on an error.`;

export const LABELS: readonly { readonly name: string; readonly description: string }[] = [
  { name: "ready", description: "The owner hands this issue to the factory" },
  { name: "in-progress", description: "A factory session works on this issue" },
  { name: "blocked", description: "Stopped by something outside the issue" },
  { name: "owner-ok", description: "The owner approves this pull request's owner paths" },
];

export const REQUIRED_CHECKS: readonly string[] = ["test", "review", "owner-gate"];

export const SECRETS: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN", "ROUTINE_FIRE_TOKEN"];

/** What the rules of every ruleset that targets the default branch require, merged. */
export type BranchRules = {
  readonly checks: ReadonlySet<string>;
  readonly threadsResolved: boolean;
  readonly mergeQueue: boolean;
  /** A repository ruleset among them, which a fix updates in place; `null` for none. */
  readonly rulesetId: string | null;
};

export type Facts = {
  readonly repo: string;
  readonly defaultBranch: string;
  /** `null` when the token may not see the setting. */
  readonly allowAutoMerge: boolean | null;
  readonly labels: ReadonlySet<string>;
  readonly rules: BranchRules;
  readonly secrets: Secrets;
};

/** The repository's secret names, or why the token could not list them. */
export type Secrets =
  | { readonly kind: "listed"; readonly names: ReadonlySet<string> }
  | { readonly kind: "hidden"; readonly reason: string };

export type Item = { readonly name: string; readonly ok: boolean; readonly fix: string };

/** One tagged line per fact the rules endpoint holds: `check <context>`, `threads`, `queue`, `ruleset <id>`. */
export const RULES_JQ = [
  '.[] | (if .type == "required_status_checks" then "check \\(.parameters.required_status_checks[].context)"',
  'elif .type == "pull_request" and .parameters.required_review_thread_resolution == true then "threads"',
  'elif .type == "merge_queue" then "queue" else empty end),',
  '(if .ruleset_source_type == "Repository" then "ruleset \\(.ruleset_id)" else empty end)',
].join(" ");

export const REPOSITORY_JQ =
  '.default_branch, (if has("allow_auto_merge") then .allow_auto_merge else "unknown" end)';

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

export function parseRuleLines(text: string): BranchRules {
  const checks = new Set<string>();
  let threadsResolved = false;
  let mergeQueue = false;
  let rulesetId: string | null = null;

  for (const line of lines(text)) {
    const [tag = "", ...rest] = line.split(" ");
    const value = rest.join(" ");

    if (tag === "check") checks.add(value);
    else if (tag === "threads") threadsResolved = true;
    else if (tag === "queue") mergeQueue = true;
    else if (tag === "ruleset") rulesetId ??= value;
    else throw new Error(`the rules query printed a line it should not: ${line}`);
  }

  return { checks, threadsResolved, mergeQueue, rulesetId };
}

export function parseRepositoryLines(
  text: string,
): Pick<Facts, "defaultBranch" | "allowAutoMerge"> {
  const [defaultBranch, auto, ...extra] = lines(text);

  if (defaultBranch === undefined || auto === undefined || extra.length > 0) {
    throw new Error(`the repository query printed ${JSON.stringify(text)}`);
  }

  return {
    defaultBranch,
    allowAutoMerge: auto === "true" ? true : auto === "false" ? false : null,
  };
}

/** Every item the factory needs, in a fixed order, each judged from the facts read. */
export function evaluate(facts: Facts): Item[] {
  const { repo, rules } = facts;
  const branch = facts.defaultBranch;

  const ruleset =
    rules.rulesetId === null
      ? `gh api -X POST repos/${repo}/rulesets --input ruleset.json`
      : `gh api -X PUT repos/${repo}/rulesets/${rules.rulesetId} --input ruleset.json`;

  return [
    ...LABELS.map(({ name, description }) => ({
      name: `label ${name}`,
      ok: facts.labels.has(name),
      fix: `gh label create ${name} --repo ${repo} --description ${shellQuote(description)}`,
    })),
    ...REQUIRED_CHECKS.map((check) => ({
      name: `${branch} requires the check ${check}`,
      ok: rules.checks.has(check),
      fix: ruleset,
    })),
    { name: `${branch} requires resolved review threads`, ok: rules.threadsResolved, fix: ruleset },
    {
      name: rules.mergeQueue
        ? `${branch} has a merge queue`
        : `${branch} has no merge queue: a pull request merges once its checks pass, and the lead handles a conflict and a red ${branch}`,
      ok: true,
      fix: ruleset,
    },
    {
      name:
        facts.allowAutoMerge === null
          ? "auto-merge allowed (not visible to this token)"
          : "auto-merge allowed",
      ok: facts.allowAutoMerge === true,
      fix: `gh repo edit ${repo} --enable-auto-merge`,
    },
    ...SECRETS.map((secret) => ({
      name:
        facts.secrets.kind === "hidden"
          ? `secret ${secret} (not visible: ${facts.secrets.reason})`
          : `secret ${secret}`,
      ok: facts.secrets.kind === "listed" && facts.secrets.names.has(secret),
      fix: `gh secret set ${secret} --repo ${repo}`,
    })),
  ];
}

export function format(items: readonly Item[]): string {
  return items
    .map((item) => (item.ok ? `ok       ${item.name}` : `missing  ${item.name}: ${item.fix}`))
    .join("\n");
}

type GhAnswer =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "failed"; readonly reason: string };

async function ghAnswer(args: readonly string[]): Promise<GhAnswer> {
  const result = await run(["gh", ...args]);

  if (result.kind === "missing") throw new Error("gh is not on the PATH");

  if (result.kind === "timedOut" || result.code !== 0 || result.outputLost === true) {
    const [first = "no output"] = lines(result.stderr.trim());

    return { kind: "failed", reason: first };
  }

  return { kind: "ok", stdout: result.stdout };
}

async function gh(args: readonly string[]): Promise<string> {
  const answer = await ghAnswer(args);

  if (answer.kind === "failed") throw new Error(`gh ${args.join(" ")} failed: ${answer.reason}`);

  return answer.stdout;
}

async function readFacts(repo: string): Promise<Facts> {
  const repository = parseRepositoryLines(
    await gh(["api", `repos/${repo}`, "--jq", REPOSITORY_JQ]),
  );

  const [labels, rules, secrets] = await Promise.all([
    gh(["api", `repos/${repo}/labels`, "--paginate", "--jq", ".[].name"]),
    gh([
      "api",
      `repos/${repo}/rules/branches/${repository.defaultBranch}`,
      "--paginate",
      "--jq",
      RULES_JQ,
    ]),
    ghAnswer(["secret", "list", "--repo", repo, "--json", "name", "--jq", ".[].name"]),
  ]);

  return {
    repo,
    ...repository,
    labels: new Set(lines(labels)),
    rules: parseRuleLines(rules),
    secrets:
      secrets.kind === "ok"
        ? { kind: "listed", names: new Set(lines(secrets.stdout)) }
        : { kind: "hidden", reason: secrets.reason },
  };
}

const OPTIONS = {
  repo: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

/** The repository to check, or the reason the arguments name none. */
export function repoArgument(argv: readonly string[]): { repo: string } | { error: string } | null {
  let values: { repo?: string | undefined; help: boolean };

  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, strict: true }));
  } catch (error) {
    return { error: messageOf(error) };
  }

  if (values.help) return null;

  if (values.repo === undefined) return { error: "--repo is missing" };

  return isRepo(values.repo)
    ? { repo: values.repo }
    : { error: `--repo is not owner/name: ${JSON.stringify(values.repo)}` };
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = repoArgument(argv);

  if (parsed === null) {
    console.log(USAGE);

    return 0;
  }

  if ("error" in parsed) {
    console.error(`check: ${parsed.error}\n\n${USAGE}`);

    return 2;
  }

  const items = evaluate(await readFacts(parsed.repo));
  console.log(format(items));

  return items.every((item) => item.ok) ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (error) {
    console.error(`check: ${messageOf(error)}`);
    process.exit(2);
  }
}
