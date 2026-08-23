#!/usr/bin/env bun

/**
 * Hold the lint configuration itself to a contract.
 *
 * The other gates watch the code; none of them watched the gates. A lowered
 * category, a fresh ignorePattern, an edited vendored rule or a deleted CI
 * step all used to land with no signal. Each one fails here instead.
 *
 * The severities and options in `oxlint.config.ts` are frozen against the
 * snapshot in `tools/oxlint/lint-contract.json`. A deliberate tweak is landed
 * by regenerating it:
 *
 *   bun ./scripts/check-lint-config.ts --update
 *
 * `--update` never belongs in `lefthook.yml` or `ci.yml`; the parity check
 * below refuses it there.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import config from "../oxlint.config.ts";

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsPluginEntry {
  name: string;
  specifier: string;
}

export interface CommandPair {
  gate: string;
  lefthook: string;
  ci: string;
  difference: string | null;
}

const REQUIRED_CATEGORIES = ["correctness", "suspicious", "pedantic"] as const;

const REQUIRED_JS_PLUGINS: JsPluginEntry[] = [
  { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
];

const ALLOWED_IGNORE_PATTERNS = new Set([
  "archive/**",
  "_docs/**",
  "node_modules/**",
  "tools/oxlint/anti-slop/**",
  "claude-meta-tools/scripts/prompt-extractor/promptExtractor.js",
]);

const ANTI_SLOP_PREFIX = "anti-slop/";

/**
 * The single source of truth for gate parity. A generic diff of the two files
 * would flag the launcher and the documented `--all`; this table states each
 * expected pair instead, and every tolerated difference carries its reason.
 */
export const EXPECTED_COMMANDS: CommandPair[] = [
  {
    gate: "lint-config",
    lefthook: "bun ./scripts/check-lint-config.ts",
    ci: "bun ./scripts/check-lint-config.ts",
    difference: null,
  },
  {
    gate: "typecheck",
    lefthook: "bun x tsgo --noEmit",
    ci: "bun x tsgo --noEmit",
    difference: null,
  },
  {
    gate: "lint-ts",
    lefthook: "bun x oxlint",
    ci: "bun x oxlint",
    difference: null,
  },
  {
    gate: "fmt",
    lefthook: "bun x oxfmt --check '**/*.ts' '**/*.js' '**/*.mjs' '**/*.cjs'",
    ci: "bun x oxfmt --check '**/*.ts' '**/*.js' '**/*.mjs' '**/*.cjs'",
    difference: null,
  },
  {
    gate: "lint-sh",
    lefthook: "bun ./scripts/lint-shell.ts",
    ci: "bun ./scripts/lint-shell.ts",
    difference: null,
  },
  {
    gate: "check-lint-disables",
    lefthook: "bun ./scripts/check-lint-disables.ts",
    ci: "bun ./scripts/check-lint-disables.ts",
    difference: null,
  },
  {
    gate: "validate-marketplace",
    lefthook: "./scripts/validate-marketplace.ts",
    ci: "bun ./scripts/validate-marketplace.ts",
    difference: null,
  },
  {
    gate: "validate-frontmatter",
    lefthook: "bun ./scripts/validate-frontmatter.ts",
    ci: "bun ./scripts/validate-frontmatter.ts --all",
    difference: "staged files locally, the whole repo in CI (scripts/validate-frontmatter.ts)",
  },
];

/** Strip the launcher so `foo.ts` and `bun foo.ts` compare as the same gate. */
function withoutLauncher(command: string): string {
  return command.startsWith("bun ./") ? command.slice("bun ".length) : command;
}

export function checkCategories(categories: JsonObject): string[] {
  const failures: string[] = [];
  for (const category of REQUIRED_CATEGORIES) {
    const severity = categories[category];
    if (severity !== "error") {
      failures.push(`categories.${category} is ${JSON.stringify(severity)}, expected "error"`);
    }
  }
  return failures;
}

export function checkJsPlugins(jsPlugins: JsPluginEntry[]): string[] {
  const actual = JSON.stringify(jsPlugins);
  const expected = JSON.stringify(REQUIRED_JS_PLUGINS);
  if (actual === expected) return [];
  return [`jsPlugins is ${actual}, expected ${expected}`];
}

export function checkIgnorePatterns(patterns: string[]): string[] {
  return patterns
    .filter((pattern) => !ALLOWED_IGNORE_PATTERNS.has(pattern))
    .map((pattern) => `ignorePatterns holds ${JSON.stringify(pattern)}, which is not allowlisted`);
}

/**
 * The vendored tree is outside `tsconfig.json`, so its rule registry is read as
 * text rather than imported: importing it would drag files the repo's strict
 * options reject into the typecheck gate.
 */
export function registeredRuleNames(indexSource: string): string[] {
  const matches = indexSource.matchAll(/^\s*"([a-z0-9-]+)":\s*\w+Rule,$/gmu);
  return [...matches].map((match) => match[1] ?? "");
}

export function checkAntiSlopRules(
  files: string[],
  registered: string[],
  configured: JsonObject,
): string[] {
  const failures: string[] = [];
  const fromFiles = new Set(files);
  const fromIndex = new Set(registered);
  const fromConfig = new Set(
    Object.keys(configured)
      .filter((rule) => rule.startsWith(ANTI_SLOP_PREFIX))
      .map((rule) => rule.slice(ANTI_SLOP_PREFIX.length)),
  );

  for (const rule of fromFiles) {
    if (!fromIndex.has(rule)) failures.push(`rules/${rule}.ts is not registered in index.ts`);
    if (!fromConfig.has(rule))
      failures.push(`rules/${rule}.ts is not configured in oxlint.config.ts`);
  }
  for (const rule of fromIndex) {
    if (!fromFiles.has(rule))
      failures.push(`index.ts registers ${rule}, which has no rules/${rule}.ts`);
  }
  for (const rule of fromConfig) {
    if (!fromFiles.has(rule))
      failures.push(`oxlint.config.ts configures ${rule}, which has no rules/${rule}.ts`);
    const severity = configured[`${ANTI_SLOP_PREFIX}${rule}`];
    if (severity !== "error") {
      failures.push(`${ANTI_SLOP_PREFIX}${rule} is ${JSON.stringify(severity)}, expected "error"`);
    }
  }
  return failures;
}

export function checkCommandParity(lefthookRuns: string[], ciRuns: string[]): string[] {
  const failures: string[] = [];
  for (const pair of EXPECTED_COMMANDS) {
    if (!lefthookRuns.includes(pair.lefthook)) {
      failures.push(`lefthook.yml runs no ${JSON.stringify(pair.lefthook)} for gate ${pair.gate}`);
    }
    if (!ciRuns.includes(pair.ci)) {
      failures.push(`ci.yml runs no ${JSON.stringify(pair.ci)} for gate ${pair.gate}`);
    }
    if (pair.difference === null && withoutLauncher(pair.lefthook) !== withoutLauncher(pair.ci)) {
      failures.push(`gate ${pair.gate} declares no difference yet its two commands diverge`);
    }
  }
  for (const command of [...lefthookRuns, ...ciRuns]) {
    if (command.includes("--update")) {
      failures.push(`--update must never run from a hook or from CI: ${JSON.stringify(command)}`);
    }
  }
  return failures;
}

/** Recursively order keys so the snapshot only moves when the config does. */
export function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (!(value instanceof Object)) return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(value).toSorted()) sorted[key] = sortKeys(value[key] ?? null);
  return sorted;
}

export function buildContract(authored: JsonValue): string {
  return `${JSON.stringify(sortKeys(authored), null, 2)}\n`;
}

export function unifiedDiff(expected: string, actual: string): string {
  const before = expected.split("\n");
  const after = actual.split("\n");
  const common: number[][] = Array.from({ length: before.length + 1 }, () =>
    Array.from({ length: after.length + 1 }, () => 0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = common[i] ?? [];
      const next = common[i + 1] ?? [];
      row[j] =
        before[i] === after[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    const dropped = common[i + 1]?.[j] ?? 0;
    const added = common[i]?.[j + 1] ?? 0;
    if (dropped >= added) {
      lines.push(`- ${before[i]}`);
      i += 1;
    } else {
      lines.push(`+ ${after[j]}`);
      j += 1;
    }
  }
  for (; i < before.length; i += 1) lines.push(`- ${before[i]}`);
  for (; j < after.length; j += 1) lines.push(`+ ${after[j]}`);
  return trimToHunks(lines).join("\n");
}

const CONTEXT_LINES = 3;

/** Keep the changed lines and their context; elide the untouched stretches. */
function trimToHunks(lines: string[]): string[] {
  const keep = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("  ")) continue;
    for (let offset = -CONTEXT_LINES; offset <= CONTEXT_LINES; offset += 1) {
      if (index + offset >= 0 && index + offset < lines.length) keep.add(index + offset);
    }
  }

  const hunks: string[] = [];
  let previous = -1;
  for (const index of [...keep].toSorted((a, b) => a - b)) {
    if (previous >= 0 && index > previous + 1) hunks.push("  ...");
    hunks.push(lines[index] ?? "");
    previous = index;
  }
  return hunks;
}

interface LefthookJob {
  run?: string;
}

interface LefthookFile {
  "pre-commit"?: { jobs?: LefthookJob[] };
}

interface CiStep {
  run?: string;
}

interface CiFile {
  jobs?: { validate?: { steps?: CiStep[] } };
}

export function lefthookCommands(source: string): string[] {
  const parsed: LefthookFile = parse(source);
  const jobs = parsed["pre-commit"]?.jobs ?? [];
  return jobs.map((job) => job.run?.trim() ?? "");
}

export function ciCommands(source: string): string[] {
  const parsed: CiFile = parse(source);
  const steps = parsed.jobs?.validate?.steps ?? [];
  return steps.map((step) => step.run?.trim() ?? "");
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const snapshotPath = join(repoRoot, "tools/oxlint/lint-contract.json");
  const rulesDir = join(repoRoot, "tools/oxlint/anti-slop/rules");

  const authored: JsonValue = JSON.parse(JSON.stringify(config));
  const contract = buildContract(authored);

  if (process.argv.includes("--update")) {
    await Bun.write(snapshotPath, contract);
    console.log(`Snapshot rewritten: ${snapshotPath}`);
    process.exit(0);
  }

  const ruleFiles = (await readdir(rulesDir))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => entry.slice(0, -".ts".length));
  const indexSource = await Bun.file(join(repoRoot, "tools/oxlint/anti-slop/index.ts")).text();

  const failures = [
    ...checkCategories(config.categories ?? {}),
    ...checkJsPlugins(config.jsPlugins ?? []),
    ...checkIgnorePatterns(config.ignorePatterns ?? []),
    ...checkAntiSlopRules(ruleFiles, registeredRuleNames(indexSource), config.rules ?? {}),
    ...checkCommandParity(
      lefthookCommands(await Bun.file(join(repoRoot, "lefthook.yml")).text()),
      ciCommands(await Bun.file(join(repoRoot, ".github/workflows/ci.yml")).text()),
    ),
  ];

  const snapshot = Bun.file(snapshotPath);
  if (await snapshot.exists()) {
    const recorded = await snapshot.text();
    if (recorded !== contract) {
      failures.push(
        `oxlint.config.ts no longer matches the snapshot:\n${unifiedDiff(recorded, contract)}\n` +
          `Run \`bun ./scripts/check-lint-config.ts --update\` if the change is deliberate.`,
      );
    }
  } else {
    failures.push(
      `${snapshotPath} is missing; regenerate it with \`bun ./scripts/check-lint-config.ts --update\``,
    );
  }

  if (failures.length > 0) {
    console.error(`${failures.length} lint configuration violation(s):\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
}
