#!/usr/bin/env bun

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this module IS the boundary parser of what `gh` prints and of the repository's own YAML and JSON files: each reader narrows one field and treats a file of another shape as missing. */

import { parseArgs } from "node:util";

import { run } from "../lib/platform/process.ts";
import { messageOf, shellQuote } from "../lib/platform/pure.ts";
import {
  parseCalibration,
  parseOwners,
  staleness,
} from "../templates/repo/.github/factory/tier.ts";
import { isRepo } from "./render.ts";
import { mergeHooks } from "./settings.ts";
import { readTemplates, REPO_PREFIX, SETTINGS_HOOKS } from "./templates.ts";

const USAGE = `Usage: check.ts --repo <owner/name>

  Reads, through gh, what the factory needs of a repository and prints one line per item:
  ok, or missing with what fixes it. The labels, the files on the default branch, what the
  gate, the review, CODEOWNERS, the verify skill and CLAUDE.md say, the hooks of its
  .claude/settings.json, the CI workflow trunk-red.yml names, the default branch's rulesets
  and their bypass actors, the auto-merge and squash merge settings, whether GitHub Actions
  runs the workflows' actions, and the secret names. Writes nothing; reads secret names
  only, and reports an item not visible when the token cannot read it.
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

export const TIER_PROMPT = ".github/factory/tier-prompt.md";

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

type ContentRule = {
  readonly path: string;
  readonly says: string;
  readonly holds: (text: string) => boolean;
  readonly fix: string;
};

const OWNED_PATHS: readonly string[] = ["/.github/", "/.claude/", "/CLAUDE.md"];

const TEMPLATE_FIX = "run install.ts repo with --force, which writes the template over it";

/** What a required file must say, beyond being on the default branch: a kept older version passes its existence. */
export const CONTENT_RULES: readonly ContentRule[] = [
  {
    path: ".github/workflows/owner-gate.yml",
    says: "runs .github/factory/tier.ts and reads the label human-approved",
    holds: (text) => text.includes(".github/factory/tier.ts") && text.includes("human-approved"),
    fix: TEMPLATE_FIX,
  },
  {
    path: ".github/workflows/review.yml",
    says: "names the label needs-human",
    holds: (text) => text.includes("needs-human"),
    fix: TEMPLATE_FIX,
  },
  ...[".github/workflows/owner-gate.yml", ".github/workflows/review.yml"].map((path) => ({
    path,
    says: "judges a pull request against the default branch only",
    holds: (text: string) => text.includes("github.event.pull_request.base.ref"),
    fix: TEMPLATE_FIX,
  })),
  {
    path: ".github/CODEOWNERS",
    says: `lists ${OWNED_PATHS.join(", ")}, and path prefixes from the root alone`,
    holds: (text) =>
      parseOwners(text).kind === "read" &&
      OWNED_PATHS.every((owned) =>
        lines(text).some((line) => line.trim().split(/\s+/u)[0] === owned),
      ),
    fix: "add a line for each, owned by the owner, and remove every glob line and every path not written from the root: the owner gate reads path prefixes from the root alone, and holds every change for the owner when it meets another line",
  },
  {
    path: VERIFY_SKILL,
    says: "carries no disable-model-invocation: true",
    holds: (text) => !/^disable-model-invocation:\s*true\s*$/mu.test(text),
    fix: "remove disable-model-invocation from its front matter: the session runs the skill by itself",
  },
  {
    path: "CLAUDE.md",
    says: "names the labels needs-human and human-approved",
    holds: (text) => text.includes("needs-human") && text.includes("human-approved"),
    fix: "merge the factory's sections into CLAUDE.md",
  },
];

/** What the rules of every ruleset that targets the default branch require, merged. */
export type BranchRules = {
  readonly checks: ReadonlySet<string>;
  readonly threadsResolved: boolean;
  readonly mergeQueue: boolean;
  /** A repository ruleset among them, which a fix updates in place; `null` for none. */
  readonly rulesetId: string | null;
  /** Every ruleset among them, the organization's included. */
  readonly rulesetIds: ReadonlySet<string>;
};

export interface Workflow {
  readonly events: ReadonlySet<string>;
  /** The branches its `push` trigger names; `null` when it names none, which is every branch. */
  readonly pushBranches: readonly string[] | null;
  readonly checks: ReadonlySet<string>;
  /** The events among `pull_request` and `push` whose trigger has a `paths` or `paths-ignore` filter. */
  readonly pathFiltered: readonly string[];
}

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
  /** `null` when the token may not see the setting. */
  readonly allowSquashMerge: boolean | null;
  readonly labels: ReadonlySet<string>;
  /** Each required file the default branch holds, with its text. */
  readonly files: ReadonlyMap<string, string>;
  readonly hooksInstalled: boolean;
  readonly ci: Ci;
  /** Why the owner gate runs the floor alone, as `tier.ts` decides it; `null` when the classifier judges. */
  readonly tierStale: string | null;
  /** What a workflow's token may do by default: `read`, `write`, or `null` when this token cannot see it. */
  readonly workflowToken: string | null;
  readonly rules: BranchRules;
  readonly bypass: Bypass;
  readonly actions: Actions;
  readonly secrets: Secrets;
};

/** The repository's secret names, or why the token could not list them. */
export type Secrets =
  | { readonly kind: "listed"; readonly names: ReadonlySet<string> }
  | { readonly kind: "hidden"; readonly reason: string };

/** The rulesets of the default branch that have a bypass actor, or why the token could not read them. */
export type Bypass =
  | { readonly kind: "read"; readonly rulesets: readonly string[] }
  | { readonly kind: "hidden"; readonly reason: string };

/** Whether GitHub Actions runs, and which actions it allows: `all`, `selected` or `local_only`. */
export type Actions =
  | { readonly kind: "read"; readonly enabled: boolean; readonly allowed: string }
  | { readonly kind: "hidden"; readonly reason: string };

export type Item = { readonly name: string; readonly ok: boolean; readonly fix: string };

/** One tagged line per fact the rules endpoint holds: `check <context>`, `threads`, `queue`, `ruleset <id>`, `applies <id>`. */
export const RULES_JQ = [
  '.[] | (if .type == "required_status_checks" then "check \\(.parameters.required_status_checks[].context)"',
  'elif .type == "pull_request" and .parameters.required_review_thread_resolution == true then "threads"',
  'elif .type == "merge_queue" then "queue" else empty end),',
  '(if .ruleset_source_type == "Repository" then "ruleset \\(.ruleset_id)" else empty end),',
  '"applies \\(.ruleset_id)"',
].join(" ");

export const REPOSITORY_JQ = [
  '.default_branch, (if has("allow_auto_merge") then .allow_auto_merge else "unknown" end), .private,',
  '(if has("allow_squash_merge") then .allow_squash_merge else "unknown" end)',
].join(" ");

/** GitHub returns a ruleset's `bypass_actors` only to a token that may edit the ruleset. */
export const BYPASS_JQ =
  'if has("bypass_actors") then (.bypass_actors | length) else "unknown" end';

export const ACTIONS_JQ = '"\\(.enabled) \\(.allowed_actions // "none")"';

export const ALLOWED_ACTIONS =
  "actions/checkout, oven-sh/setup-bun and anthropics/claude-code-action";

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

export function parseRuleLines(text: string): BranchRules {
  const checks = new Set<string>();
  const rulesetIds = new Set<string>();
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
    else if (tag === "applies") rulesetIds.add(value);
    else throw new Error(`the rules query printed a line it should not: ${line}`);
  }

  return { checks, threadsResolved, mergeQueue, rulesetId, rulesetIds };
}

const flag = (value: string): boolean | null =>
  value === "true" ? true : value === "false" ? false : null;

export function parseRepositoryLines(
  text: string,
): Pick<Facts, "defaultBranch" | "allowAutoMerge" | "isPrivate" | "allowSquashMerge"> {
  const [defaultBranch, auto, visibility, squash, ...extra] = lines(text);

  if (
    defaultBranch === undefined ||
    auto === undefined ||
    (visibility !== "true" && visibility !== "false") ||
    squash === undefined ||
    extra.length > 0
  ) {
    throw new Error(`the repository query printed ${JSON.stringify(text)}`);
  }

  return {
    defaultBranch,
    allowAutoMerge: flag(auto),
    isPrivate: visibility === "true",
    allowSquashMerge: flag(squash),
  };
}

export type GhAnswer =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "failed"; readonly reason: string };

export function bypassOf(
  answers: readonly { readonly id: string; readonly answer: GhAnswer }[],
): Bypass {
  const withActors: string[] = [];

  for (const { id, answer } of answers) {
    if (answer.kind === "failed") return { kind: "hidden", reason: answer.reason };

    const count = answer.stdout.trim();

    if (count === "unknown") {
      return {
        kind: "hidden",
        reason: `this token may not read the bypass actors of ruleset ${id}`,
      };
    }

    if (!/^\d+$/u.test(count)) {
      throw new Error(`the ruleset ${id} query printed ${JSON.stringify(answer.stdout)}`);
    }

    if (count !== "0") withActors.push(id);
  }

  return { kind: "read", rulesets: withActors };
}

export function actionsOf(answer: GhAnswer): Actions {
  if (answer.kind === "failed") return { kind: "hidden", reason: answer.reason };

  const [enabled, allowed, ...extra] = answer.stdout.trim().split(" ");

  if ((enabled !== "true" && enabled !== "false") || allowed === undefined || extra.length > 0) {
    throw new Error(`the actions permissions query printed ${JSON.stringify(answer.stdout)}`);
  }

  return { kind: "read", enabled: enabled === "true", allowed };
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
    checks: new Set(Object.entries(parsed["jobs"]).flatMap(([id, job]) => checksOf(id, job))),
    pathFiltered: ["pull_request", "push"].filter((event) => {
      const trigger = isRecord(on) ? on[event] : null;

      return isRecord(trigger) && ("paths" in trigger || "paths-ignore" in trigger);
    }),
  };
}

function checksOf(id: string, job: unknown): string[] {
  if (!isRecord(job)) return [id];

  const strategy = job["strategy"];

  // A matrix job reports one check per combination, `<name> (<values>)`, never its bare name.
  if (isRecord(strategy) && "matrix" in strategy) return [];

  const name = job["name"];

  if (name === undefined) return [id];

  return typeof name === "string" ? [name] : [];
}

/** What the owner gate's `staleness` answers for these files; `null` when the classifier judges. */
export function tierStalenessOf(cases: string | null, prompt: string | null): string | null {
  if (cases === null || prompt === null) {
    return `the floor runs alone: ${cases === null ? TIER_CASES : TIER_PROMPT} is not on the default branch`;
  }

  return staleness(parseCalibration(cases), prompt);
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

  const { events, pushBranches, checks, pathFiltered } = ci.workflow;
  const fix = `add it to the workflow "${ci.name}": the ruleset requires its test check, and trunk-red.yml reads its runs on ${branch}`;

  return [
    {
      name: `the CI workflow "${ci.name}" has a job that reports the check test`,
      ok: checks.has("test"),
      fix: `give a job of the workflow "${ci.name}" the id test and no name, or the name test, and no matrix: the ruleset requires a check named test`,
    },
    {
      name: `the CI workflow "${ci.name}" has no paths filter on pull_request or push`,
      ok: pathFiltered.length === 0,
      fix: `remove paths and paths-ignore from on.${pathFiltered.join(" and on.")}: the required check test never reports on a change they filter out`,
    },
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

function bypassItem({ repo, defaultBranch, bypass, rules }: Facts): Item {
  const name = `${defaultBranch}'s rulesets have no bypass actor`;
  const ids = bypass.kind === "read" ? bypass.rulesets : [...rules.rulesetIds];
  const puts = ids.map((id) => `gh api -X PUT repos/${repo}/rulesets/${id} --input ruleset.json`);
  const fix = `write "bypass_actors": [] in ruleset.json, then ${puts.join(" and ")}`;

  return bypass.kind === "hidden"
    ? { name: `${name} (not visible: ${bypass.reason})`, ok: false, fix }
    : { name, ok: bypass.rulesets.length === 0, fix };
}

function actionsItem({ repo, actions }: Facts): Item {
  const fix = `gh api -X PUT repos/${repo}/actions/permissions -F enabled=true -f allowed_actions=all, or allow ${ALLOWED_ACTIONS}`;

  if (actions.kind === "hidden") {
    return {
      name: `GitHub Actions runs the workflows' actions (not visible: ${actions.reason})`,
      ok: false,
      fix,
    };
  }

  if (!actions.enabled) return { name: "GitHub Actions enabled", ok: false, fix };

  if (actions.allowed === "all") return { name: "GitHub Actions runs every action", ok: true, fix };

  return actions.allowed === "selected"
    ? {
        name: `GitHub Actions runs selected actions only: the owner checks that it allows ${ALLOWED_ACTIONS}`,
        ok: true,
        fix,
      }
    : { name: `GitHub Actions runs ${ALLOWED_ACTIONS}`, ok: false, fix };
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
    ...CONTENT_RULES.flatMap(({ path, says, holds, fix }) => {
      const text = facts.files.get(path);

      return text === undefined
        ? []
        : [{ name: `${path} ${says}`, ok: holds(text), fix: `${fix}, then land it on ${branch}` }];
    }),
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
    bypassItem(facts),
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
    {
      name:
        facts.allowSquashMerge === null
          ? "squash merge allowed (not visible to this token)"
          : "squash merge allowed",
      ok: facts.allowSquashMerge === true,
      fix: `gh repo edit ${repo} --enable-squash-merge`,
    },
    actionsItem(facts),
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
      name:
        facts.tierStale === null
          ? "tier cases validated: the classifier judges what passes the floor"
          : `tier cases not validated, every change waits for the owner: ${facts.tierStale}`,
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

/** `null` when the branch has no such file. */
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

  const [labels, ruleLines, secrets, token, actions, texts] = await Promise.all([
    gh(["api", `repos/${repo}/labels`, "--paginate", "--jq", ".[].name"]),
    gh(["api", `repos/${repo}/rules/branches/${branch}`, "--paginate", "--jq", RULES_JQ]),
    ghAnswer(["secret", "list", "--repo", repo, "--json", "name", "--jq", ".[].name"]),
    ghAnswer([
      "api",
      `repos/${repo}/actions/permissions/workflow`,
      "--jq",
      ".default_workflow_permissions",
    ]),
    ghAnswer(["api", `repos/${repo}/actions/permissions`, "--jq", ACTIONS_JQ]),
    Promise.all(required.map((path) => fileOf(repo, branch, path))),
  ]);

  const rules = parseRuleLines(ruleLines);

  const bypass = await Promise.all(
    [...rules.rulesetIds].map(async (id) => ({
      id,
      answer: await ghAnswer(["api", `repos/${repo}/rulesets/${id}`, "--jq", BYPASS_JQ]),
    })),
  );

  const files = new Map(
    required.flatMap((path, index) => {
      const text = texts[index] ?? null;

      return text === null ? [] : [[path, text] as const];
    }),
  );

  const settings = files.get(SETTINGS) ?? null;
  const fragment = readTemplates().find(({ path }) => path === SETTINGS_HOOKS)?.content ?? "{}";

  return {
    repo,
    ...repository,
    labels: new Set(lines(labels)),
    files,
    hooksInstalled: settings !== null && mergeHooks(settings, fragment).kind === "identical",
    ci: await ciOf(repo, branch, files.get(TRUNK_RED) ?? null),
    tierStale: tierStalenessOf(files.get(TIER_CASES) ?? null, files.get(TIER_PROMPT) ?? null),
    workflowToken: token.kind === "ok" ? token.stdout.trim() : null,
    rules,
    bypass: bypassOf(bypass),
    actions: actionsOf(actions),
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
