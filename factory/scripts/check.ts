#!/usr/bin/env bun

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this module IS the boundary parser of what `gh` prints and of the repository's own YAML and JSON files: each reader narrows one field and treats a file of another shape as missing. */

import { parseArgs } from "node:util";

import { run } from "../lib/platform/process.ts";
import { messageOf, shellQuote } from "../lib/platform/pure.ts";
import { isRepo } from "./render.ts";
import { mergeHooks } from "./settings.ts";
import { readTemplates, REPO_PREFIX, SETTINGS_HOOKS } from "./templates.ts";

const USAGE = `Usage: check.ts --repo <owner/name>

  Reads, through gh, what the factory needs of a repository and prints one line per item:
  ok, or missing with what fixes it. The labels, the files on the default branch and the
  hooks of its .claude/settings.json, the CI workflow trunk-red.yml names, the default
  branch's ruleset, the auto-merge setting and the secret names. Writes nothing; reads
  secret names only, and reports each secret not visible when the token cannot list them.
  Exit 0 when every item is ok, 1 when one is missing, 2 on an error.`;

export const LABELS: readonly { readonly name: string; readonly description: string }[] = [
  { name: "ready", description: "The owner hands this issue to the factory" },
  { name: "in-progress", description: "A factory session works on this issue" },
  { name: "blocked", description: "Stopped by something outside the issue" },
  { name: "needs-human", description: "A bound was reached: the factory stopped" },
  { name: "trunk-red", description: "The repair issue of a red default branch" },
  { name: "tier:low", description: "The head commit lands once its checks are green" },
  { name: "tier:human", description: "The head commit waits for the owner" },
  { name: "human-approved", description: "The owner approves this pull request's head commit" },
];

export const REQUIRED_CHECKS: readonly string[] = ["test", "review", "owner-gate"];

export const SECRETS: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN", "ROUTINE_FIRE_TOKEN"];

export const VERIFY_SKILL = ".claude/skills/verify/SKILL.md";

export const SETTINGS = ".claude/settings.json";

export const TRUNK_RED = ".github/workflows/trunk-red.yml";

export const TIER_CASES = ".github/factory/tier-cases.json";

/** Every file the factory needs on the default branch: its templates, and the three the install writes per repository. */
export function requiredFiles(): readonly string[] {
  return [
    ...readTemplates()
      .filter(({ path }) => path.startsWith(REPO_PREFIX))
      .map(({ path }) => path.slice(REPO_PREFIX.length)),
    VERIFY_SKILL,
    SETTINGS,
    "CLAUDE.md",
  ];
}

/** What the rules of every ruleset that targets the default branch require, merged. */
export type BranchRules = {
  readonly checks: ReadonlySet<string>;
  readonly threadsResolved: boolean;
  readonly mergeQueue: boolean;
  /** A repository ruleset among them, which a fix updates in place; `null` for none. */
  readonly rulesetId: string | null;
};

/** What a workflow file says of when it runs and which jobs it has. */
export interface Workflow {
  readonly events: ReadonlySet<string>;
  /** The branches its `push` trigger names; `null` when it names none, which is every branch. */
  readonly pushBranches: readonly string[] | null;
  readonly jobs: ReadonlySet<string>;
}

/** The CI workflow `trunk-red.yml` listens to. */
export type Ci =
  | { readonly kind: "unnamed" }
  | { readonly kind: "absent"; readonly name: string }
  | { readonly kind: "read"; readonly name: string; readonly workflow: Workflow };

export type Facts = {
  readonly repo: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  /** `null` when the token may not see the setting. */
  readonly allowAutoMerge: boolean | null;
  readonly labels: ReadonlySet<string>;
  /** The required files the default branch holds. */
  readonly files: ReadonlySet<string>;
  /** Whether the default branch's `.claude/settings.json` runs both verify hooks. */
  readonly hooksInstalled: boolean;
  readonly ci: Ci;
  /** Whether `tier-cases.json` names the model and the prompt it was validated with. */
  readonly tierValidated: boolean;
  /** What a workflow's token may do by default: `read`, `write`, or `null` when this token cannot see it. */
  readonly workflowToken: string | null;
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
  '.default_branch, (if has("allow_auto_merge") then .allow_auto_merge else "unknown" end), .private';

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
): Pick<Facts, "defaultBranch" | "allowAutoMerge" | "isPrivate"> {
  const [defaultBranch, auto, visibility, ...extra] = lines(text);

  if (
    defaultBranch === undefined ||
    auto === undefined ||
    (visibility !== "true" && visibility !== "false") ||
    extra.length > 0
  ) {
    throw new Error(`the repository query printed ${JSON.stringify(text)}`);
  }

  return {
    defaultBranch,
    allowAutoMerge: auto === "true" ? true : auto === "false" ? false : null,
    isPrivate: visibility === "true",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The workflow `trunk-red.yml` listens to, as the install wrote it: `workflows: ["<name>"]`. */
export function ciNameOf(trunkRed: string): string | null {
  return /^\s*workflows:\s*\["([^"]+)"\]\s*$/mu.exec(trunkRed)?.[1] ?? null;
}

/** A workflow file's triggers and jobs; `null` when the file is not a workflow. */
export function parseWorkflow(text: string): Workflow | null {
  let parsed: unknown;

  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !isRecord(parsed["jobs"])) return null;

  const on = parsed["on"];

  const events =
    typeof on === "string"
      ? [on]
      : Array.isArray(on)
        ? on.filter((event): event is string => typeof event === "string")
        : isRecord(on)
          ? Object.keys(on)
          : [];

  const push = isRecord(on) ? on["push"] : null;
  const branches = isRecord(push) ? push["branches"] : null;

  return {
    events: new Set(events),
    pushBranches: Array.isArray(branches)
      ? branches.filter((branch): branch is string => typeof branch === "string")
      : null,
    jobs: new Set(
      Object.entries(parsed["jobs"]).flatMap(([id, job]) =>
        isRecord(job) && typeof job["name"] === "string" ? [id, job["name"]] : [id],
      ),
    ),
  };
}

/** Whether `tier-cases.json` names the model and the prompt a replay validated. */
export function isTierValidated(cases: string | null): boolean {
  if (cases === null) return false;

  try {
    const parsed: unknown = JSON.parse(cases);

    return (
      isRecord(parsed) &&
      typeof parsed["model"] === "string" &&
      typeof parsed["prompt"] === "string"
    );
  } catch {
    return false;
  }
}

function ciItems(facts: Facts): Item[] {
  const { ci, rules } = facts;
  const branch = facts.defaultBranch;

  if (ci.kind === "unnamed") {
    return [
      {
        name: "trunk-red.yml names the CI workflow",
        ok: false,
        fix: "run install.ts repo with --ci <the CI workflow's name>, and land the file",
      },
    ];
  }

  if (ci.kind === "absent") {
    return [
      {
        name: `the CI workflow "${ci.name}", which trunk-red.yml listens to, exists`,
        ok: false,
        fix: `name the workflow "${ci.name}", or run install.ts repo with --ci <its name>`,
      },
    ];
  }

  const { events, pushBranches, jobs } = ci.workflow;
  const fix = `add it to the workflow "${ci.name}": the ruleset requires its test check, and trunk-red.yml reads its runs on ${branch}`;

  return [
    { name: `the CI workflow "${ci.name}" has a job named test`, ok: jobs.has("test"), fix },
    {
      name: `the CI workflow "${ci.name}" runs on pull_request`,
      ok: events.has("pull_request"),
      fix,
    },
    {
      name: `the CI workflow "${ci.name}" runs on push to ${branch}`,
      ok: events.has("push") && (pushBranches === null || pushBranches.includes(branch)),
      fix,
    },
    ...(rules.mergeQueue
      ? [
          {
            name: `the CI workflow "${ci.name}" runs on merge_group`,
            ok: events.has("merge_group"),
            fix,
          },
        ]
      : []),
  ];
}

/** Every item the factory needs, in a fixed order, each judged from the facts read. */
export function evaluate(facts: Facts): Item[] {
  const { repo, rules } = facts;
  const branch = facts.defaultBranch;

  const ruleset =
    rules.rulesetId === null
      ? `gh api -X POST repos/${repo}/rulesets --input ruleset.json`
      : `gh api -X PUT repos/${repo}/rulesets/${rules.rulesetId} --input ruleset.json`;

  const fileFix = (path: string): string => {
    if (path === VERIFY_SKILL) return "record the verify recipe, step 4 of /factory:install";

    if (path === "CLAUDE.md") return "merge the factory's sections into CLAUDE.md";

    return path === SETTINGS
      ? "run install.ts repo, which merges the hooks into it"
      : "run install.ts repo";
  };

  return [
    ...LABELS.map(({ name, description }) => ({
      name: `label ${name}`,
      ok: facts.labels.has(name),
      fix: `gh label create ${name} --repo ${repo} --description ${shellQuote(description)}`,
    })),
    ...requiredFiles().map((path) => ({
      name: `${path} on ${branch}`,
      ok: facts.files.has(path),
      fix: `${fileFix(path)}, then land it on ${branch}`,
    })),
    {
      name: `${SETTINGS} runs the two verify hooks`,
      ok: facts.hooksInstalled,
      fix: `run install.ts repo, which merges the hooks into it, then land it on ${branch}`,
    },
    ...ciItems(facts),
    ...REQUIRED_CHECKS.map((check) => ({
      name: `${branch} requires the check ${check}`,
      ok: rules.checks.has(check),
      fix: ruleset,
    })),
    { name: `${branch} requires resolved review threads`, ok: rules.threadsResolved, fix: ruleset },
    {
      name: rules.mergeQueue
        ? `${branch} has a merge queue`
        : `${branch} has no merge queue: a pull request merges once its checks pass; conflict.yml marks one that conflicts, and trunk-red.yml has a red ${branch} repaired`,
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
    ...(facts.isPrivate
      ? [
          {
            name: `private repository: a workflow's token defaults to ${facts.workflowToken ?? "a level this token cannot see"}. The factory's workflows declare what they need; a job of your own that reads more than the code, pull requests included, declares its permissions too`,
            ok: true,
            fix: "",
          },
        ]
      : []),
    {
      name: facts.tierValidated
        ? "tier cases validated: the classifier judges what passes the floor"
        : "tier cases not validated: the floor runs alone, and every change waits for the owner",
      ok: true,
      fix: "",
    },
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

/** A file of the branch as text; `null` when the branch has no such file. */
async function fileOf(repo: string, branch: string, path: string): Promise<string | null> {
  const answer = await ghAnswer([
    "api",
    `repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);

  if (answer.kind === "ok") return answer.stdout;

  if (answer.reason.includes("HTTP 404")) return null;

  throw new Error(`gh api repos/${repo}/contents/${path} failed: ${answer.reason}`);
}

async function ciOf(repo: string, branch: string, trunkRed: string | null): Promise<Ci> {
  const name = trunkRed === null ? null : ciNameOf(trunkRed);

  if (name === null) return { kind: "unnamed" };

  const workflows = lines(
    await gh([
      "api",
      `repos/${repo}/actions/workflows`,
      "--paginate",
      "--jq",
      '.workflows[] | "\\(.path)\\t\\(.name)"',
    ]),
  ).map((line) => line.split("\t"));

  const path = workflows.find(([, known]) => known === name)?.[0];
  const text = path === undefined ? null : await fileOf(repo, branch, path);
  const workflow = text === null ? null : parseWorkflow(text);

  return workflow === null ? { kind: "absent", name } : { kind: "read", name, workflow };
}

async function readFacts(repo: string): Promise<Facts> {
  const repository = parseRepositoryLines(
    await gh(["api", `repos/${repo}`, "--jq", REPOSITORY_JQ]),
  );

  const branch = repository.defaultBranch;
  const required = requiredFiles();

  const [labels, rules, secrets, token, texts] = await Promise.all([
    gh(["api", `repos/${repo}/labels`, "--paginate", "--jq", ".[].name"]),
    gh(["api", `repos/${repo}/rules/branches/${branch}`, "--paginate", "--jq", RULES_JQ]),
    ghAnswer(["secret", "list", "--repo", repo, "--json", "name", "--jq", ".[].name"]),
    ghAnswer([
      "api",
      `repos/${repo}/actions/permissions/workflow`,
      "--jq",
      ".default_workflow_permissions",
    ]),
    Promise.all(required.map((path) => fileOf(repo, branch, path))),
  ]);

  const held = new Map(required.flatMap((path, index) => [[path, texts[index] ?? null] as const]));
  const settings = held.get(SETTINGS) ?? null;
  const fragment = readTemplates().find(({ path }) => path === SETTINGS_HOOKS)?.content ?? "{}";

  return {
    repo,
    ...repository,
    labels: new Set(lines(labels)),
    files: new Set(required.filter((path) => (held.get(path) ?? null) !== null)),
    hooksInstalled: settings !== null && mergeHooks(settings, fragment).kind === "identical",
    ci: await ciOf(repo, branch, held.get(TRUNK_RED) ?? null),
    tierValidated: isTierValidated(held.get(TIER_CASES) ?? null),
    workflowToken: token.kind === "ok" ? token.stdout.trim() : null,
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
