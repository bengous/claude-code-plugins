#!/usr/bin/env bun

/**
 * Hold each rule of the root `AGENTS.md` and of `.claude/rules/` to its entry
 * in `.claude/rule-registry.ts`: the controls that enforce it, or why none can.
 * A rule is a text block, headings and code aside: a paragraph, a top-level
 * list item, a table row. It is keyed by a fingerprint of its text; a
 * paragraph's entry with `covers: "list"` holds the list that follows it.
 *
 * A held control must run: a `gate` among `expectedCommands`, whose pre-commit
 * job and CI step `lint-config` demands; a `hook` file a command of the
 * settings, of the agent-hooks config, of a catalog plugin's `hooks/hooks.json`
 * or of lefthook runs; a `lint` rule the
 * repo-wide config sets to error; a `test` file a bun run or a hooks module's
 * kit runs.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";
import { parse } from "yaml";

import { REGISTRY } from "../.claude/rule-registry.ts";
import config from "../oxlint.config.ts";
import { testRuns } from "./affected.ts";
import { expectedCommands, type JsonObject, type JsonValue } from "./check-lint-config.ts";

export type Control = `${"gate" | "hook" | "lint" | "test"} ${string}`;

export type Holding = { readonly held: readonly Control[] } | { readonly prose: string };

export type Entry = Holding & { readonly quote: string; readonly covers?: "list" };

export type RuleEntries = Readonly<Record<string, Entry>>;

export type Registry = Readonly<Record<string, RuleEntries>>;

export type BlockKind = "paragraph" | "item" | "row" | "other";

export interface Block {
  readonly kind: BlockKind;
  readonly line: number;
  readonly text: string;
}

export interface RuleFile {
  readonly path: string;
  readonly source: string;
}

export interface LintConfig {
  readonly rules: JsonObject;
  readonly overrides: readonly JsonObject[];
}

export interface TestPlan {
  readonly ignorePatterns: readonly string[];
  readonly extraRoots: readonly string[];
  readonly kitDirs: readonly string[];
}

export interface Controls {
  readonly gates: ReadonlySet<string>;
  readonly wired: ReadonlySet<string>;
  readonly lintHeld: (rule: string) => boolean;
  readonly runsTest: (path: string) => boolean;
  readonly exists: (path: string) => boolean;
}

interface Fence {
  readonly mark: string;
  readonly length: number;
}

interface OpenBlock {
  kind: BlockKind;
  line: number;
  contentIndent: number;
  parts: string[];
}

interface SettingsFile {
  readonly hooks?: JsonValue;
}

interface LefthookJob {
  readonly run?: string;
  readonly script?: string;
  readonly group?: { readonly jobs?: readonly LefthookJob[] };
}

interface LefthookHook {
  readonly jobs?: readonly LefthookJob[];
  readonly commands?: Readonly<Record<string, { readonly run?: string }>>;
  readonly scripts?: Readonly<Record<string, { readonly runner?: string }>>;
}

type LefthookFile = Readonly<Record<string, LefthookHook | null>>;

interface LefthookRuns {
  readonly commands: readonly string[];
  readonly scripts: readonly string[];
}

interface Catalog {
  readonly plugins: readonly { readonly source: string }[];
}

interface Bunfig {
  readonly test?: { readonly pathIgnorePatterns?: readonly string[] };
}

interface PrintedConfig {
  readonly rules?: JsonObject;
}

const REGISTRY_PATH = ".claude/rule-registry.ts";

const RULES_DIR = ".claude/rules";

const SETTINGS_PATH = ".claude/__settings.jsonc";

const KIT_CONFIG_PATH = ".claude/agent-hooks.jsonc";

const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/u;

const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/u;

const ITEM_RE = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4}|$)/u;

const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/u;

const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/u;

const ROW_RE = /^ {0,3}\|/u;

const DELIMITER_ROW_RE = /^ {0,3}\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?$/u;

const CONTROL_RE = /^(\S+) (\S+)$/u;

const KIT_COMMAND_RE = /^claude plugin test (\S+)$/u;

const BUN_TEST_RE = /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/u;

const KIT_TEST_RE = /\.test\.tsx?$/u;

const PATH_TOKEN_RE = /[\w$@{}./+-]+/gu;

const PROJECT_DIR_RE = /"?\$\{?CLAUDE_PROJECT_DIR\}?"?\//gu;

const PLUGIN_ROOT_RE = /"?\$\{?CLAUDE_PLUGIN_ROOT\}?"?\//gu;

const ERROR_SEVERITIES = new Set<JsonValue>(["error", "deny", 2]);

const QUOTE_LENGTH = 60;

const RECLASSIFY = `Name the control that holds the rule now in ${REGISTRY_PATH}, or give prose: "<why no tool can hold it>"`;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function fenceOpening(line: string): Fence | null {
  const [, , marks, info] = FENCE_OPEN_RE.exec(line) ?? [];

  if (marks === undefined || (marks.startsWith("`") && (info ?? "").includes("`"))) return null;

  return { mark: marks.slice(0, 1), length: marks.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const marks = FENCE_CLOSE_RE.exec(line)?.[1];

  return marks !== undefined && marks.startsWith(fence.mark) && marks.length >= fence.length;
}

function opens(kind: BlockKind, line: number, contentIndent: number, text: string): OpenBlock {
  return { kind, line, contentIndent, parts: [text] };
}

export function blocksOf(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: OpenBlock[] = [];
  let open: OpenBlock | null = null;
  let fence: Fence | null = null;
  let afterBlank = false;
  const frontmatterEnd = lines[0] === "---" ? lines.indexOf("---", 1) : -1;

  for (const [index, line] of lines.entries()) {
    if (index <= frontmatterEnd) continue;

    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    if (line.trim() === "") {
      if (open?.kind !== "item") open = null;
      afterBlank = true;
      continue;
    }

    const indent = indentOf(line);
    const opening = fenceOpening(line);
    const wasAfterBlank = afterBlank;
    afterBlank = false;

    if (open?.kind === "item" && indent >= open.contentIndent) {
      if (opening === null) open.parts.push(line.trim());
      else fence = opening;
      continue;
    }

    const item = THEMATIC_BREAK_RE.test(line) ? null : ITEM_RE.exec(line);
    const startsBlock = opening !== null || HEADING_RE.test(line) || ROW_RE.test(line);

    if (open !== null && item === null && !startsBlock && !wasAfterBlank) {
      open.parts.push(line.trim());
      continue;
    }

    if (item !== null) {
      const marker = item[0];
      open = opens("item", index + 1, marker.length, line.slice(marker.length).trim());
      blocks.push(open);
    } else if (ROW_RE.test(line) && !DELIMITER_ROW_RE.test(line)) {
      open = null;
      blocks.push(opens("row", index + 1, 0, line.trim()));
    } else if (startsBlock || indent >= 4 || THEMATIC_BREAK_RE.test(line) || ROW_RE.test(line)) {
      open = null;
      fence = opening;
      blocks.push(opens("other", index + 1, 0, ""));
    } else {
      open = opens("paragraph", index + 1, 0, line.trim());
      blocks.push(open);
    }
  }

  return blocks.map((block) => ({
    kind: block.kind,
    line: block.line,
    text: block.parts.join(" ").replaceAll(/\s+/gu, " ").trim(),
  }));
}

export function fingerprint(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 8);
}

export function quoteOf(text: string): string {
  const words = text.split(" ");
  let quote = words[0] ?? "";

  for (const word of words.slice(1)) {
    if (quote.length + 1 + word.length > QUOTE_LENGTH) break;
    quote = `${quote} ${word}`;
  }

  return quote;
}

export function projectPath(path: string): string {
  return path.replaceAll(PROJECT_DIR_RE, "").replace(/^\.\//u, "");
}

export function wiredPaths(commands: readonly string[]): Set<string> {
  return new Set(
    commands.flatMap((command) =>
      [...command.replaceAll(PROJECT_DIR_RE, "").matchAll(PATH_TOKEN_RE)].map(([token]) =>
        projectPath(token),
      ),
    ),
  );
}

export function runsTestFile(path: string, plan: TestPlan): boolean {
  const segments = path.split("/");

  if (segments.includes("node_modules")) return false;

  const inPlainRun =
    !segments.some((segment) => segment.startsWith(".")) &&
    !plan.ignorePatterns.some((pattern) => new Bun.Glob(pattern).match(path));

  const bunRuns =
    BUN_TEST_RE.test(path) && (inPlainRun || plan.extraRoots.some((root) => path.startsWith(root)));

  return bunRuns || (KIT_TEST_RE.test(path) && plan.kitDirs.some((dir) => path.startsWith(dir)));
}

function severityOf(setting: JsonValue | undefined): JsonValue | undefined {
  return Array.isArray(setting) ? setting[0] : setting;
}

export function lintHeld(rule: string, lint: LintConfig): boolean {
  const name = rule.replace(/^eslint\//u, "");

  return (
    ERROR_SEVERITIES.has(severityOf(lint.rules[name]) ?? null) &&
    lint.overrides.every((rules) => {
      const severity = severityOf(rules[name]);

      return severity === undefined || ERROR_SEVERITIES.has(severity);
    })
  );
}

function checkControl(control: string, controls: Controls): string | null {
  const [, kind, name] = CONTROL_RE.exec(control.replaceAll("`", "")) ?? [];

  if (name === undefined) return `${JSON.stringify(control)} is no "<gate|hook|lint|test> <name>"`;

  switch (kind) {
    case "gate":
      return controls.gates.has(name)
        ? null
        : `no gate ${name} among the gates of scripts/check-lint-config.ts`;

    case "hook": {
      const path = projectPath(name);

      if (!controls.exists(path)) return `no file ${path}`;

      return controls.wired.has(path)
        ? null
        : `no hook runs ${path} (${SETTINGS_PATH}, ${KIT_CONFIG_PATH}, a catalog plugin's hooks/hooks.json, lefthook.yml and its scripts)`;
    }

    case "lint":
      return controls.lintHeld(name)
        ? null
        : `oxlint does not set ${name} to error repo-wide, at top level or through a category`;

    case "test":
      if (!controls.exists(name)) return `no test file ${name}`;

      return controls.runsTest(name) ? null : `no suite runs ${name}`;

    default:
      return `${JSON.stringify(control)} is no "<gate|hook|lint|test> <name>"`;
  }
}

function checkEntry(entry: Entry, block: Block, controls: Controls): string[] {
  const failures: string[] = [];

  if (!block.text.startsWith(entry.quote) || entry.quote === "") {
    failures.push(
      `its quote does not open the rule; write quote: ${JSON.stringify(quoteOf(block.text))}`,
    );
  }

  if ("prose" in entry) {
    if (entry.prose.trim() === "") {
      failures.push("prose gives no reason; say why no tool can hold the rule");
    }

    return failures;
  }

  if (entry.held.length === 0) failures.push(`held names no control. ${RECLASSIFY}`);

  for (const control of entry.held) {
    const failure = checkControl(control, controls);

    if (failure !== null) failures.push(`${failure}. ${RECLASSIFY}`);
  }

  return failures;
}

function entryTemplate(path: string, block: Block): string {
  return (
    `under ${JSON.stringify(path)} in ${REGISTRY_PATH}, add ${JSON.stringify(fingerprint(block.text))}: ` +
    `{ quote: ${JSON.stringify(quoteOf(block.text))}, held: ["<gate|hook|lint|test> <name>"] } ` +
    `naming what enforces it, or prose: "<why no tool can hold it>" in place of held`
  );
}

export function checkRuleFile(file: RuleFile, entries: RuleEntries, controls: Controls): string[] {
  const blocks = blocksOf(file.source);
  const failures: string[] = [];
  const unregistered: Block[] = [];
  const matched = new Set<string>();
  let covered = false;

  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "item") covered = false;

    if (block.kind === "other") continue;
    const key = fingerprint(block.text);
    const entry = entries[key];
    const at = `${file.path}:${block.line} (${JSON.stringify(key)})`;

    if (entry === undefined) {
      if (!covered) unregistered.push(block);
      continue;
    }

    matched.add(key);
    failures.push(...checkEntry(entry, block, controls).map((failure) => `${at}: ${failure}`));

    if (entry.covers === undefined) continue;

    if (block.kind === "paragraph" && blocks[index + 1]?.kind === "item") {
      covered = true;
    } else {
      failures.push(`${at}: covers: "list" on a rule that opens no list; drop covers`);
    }
  }

  for (const block of unregistered) {
    failures.push(
      `${file.path}:${block.line}: a rule with no entry: ${entryTemplate(file.path, block)}`,
    );
  }

  const edited = unregistered.map(
    (block) => `${file.path}:${block.line} ${JSON.stringify(fingerprint(block.text))}`,
  );

  for (const [key, entry] of Object.entries(entries)) {
    if (matched.has(key)) continue;

    failures.push(
      `${REGISTRY_PATH}: ${JSON.stringify(file.path)} entry ${JSON.stringify(key)} (${JSON.stringify(entry.quote)}) matches no rule. ` +
        (edited.length > 0
          ? `If its rule was edited, move the entry to the edited rule's key (${edited.join(", ")}) with its new quote and reclassify it; else delete it`
          : "Delete it, or restore the rule it held"),
    );
  }

  return failures;
}

export function checkRegistry(
  files: readonly RuleFile[],
  registry: Registry,
  controls: Controls,
): string[] {
  const known = new Set(files.map((file) => file.path));

  return [
    ...Object.keys(registry)
      .filter((path) => !known.has(path))
      .map(
        (path) =>
          `${REGISTRY_PATH}: ${JSON.stringify(path)} is no rule file (AGENTS.md, ${RULES_DIR}/*.md); move its entries or delete them`,
      ),
    ...files.flatMap((file) => checkRuleFile(file, registry[file.path] ?? {}, controls)),
  ];
}

export function ruleFiles(repoRoot: string): string[] {
  const rules = readdirSync(join(repoRoot, RULES_DIR))
    .filter((entry) => entry.endsWith(".md"))
    .toSorted()
    .map((entry) => `${RULES_DIR}/${entry}`);

  return ["AGENTS.md", ...rules];
}

function leavesAt(value: JsonValue, key: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => leavesAt(item, key));

  if (!(value instanceof Object)) return [];

  return Object.entries(value).flatMap(([name, child]) =>
    name === key && !(child instanceof Object) ? [String(child)] : leavesAt(child, key),
  );
}

function lefthookRuns(file: LefthookFile): LefthookRuns {
  const commands: string[] = [];
  const scripts: string[] = [];

  const walk = (hook: string, jobs: readonly LefthookJob[]): void => {
    for (const job of jobs) {
      if (job.run !== undefined) commands.push(job.run);

      if (job.script !== undefined) scripts.push(`.lefthook/${hook}/${job.script}`);
      walk(hook, job.group?.jobs ?? []);
    }
  };

  for (const [hook, body] of Object.entries(file)) {
    walk(hook, body?.jobs ?? []);

    for (const command of Object.values(body?.commands ?? {})) {
      if (command.run !== undefined) commands.push(command.run);
    }

    for (const name of Object.keys(body?.scripts ?? {})) scripts.push(`.lefthook/${hook}/${name}`);
  }

  return { commands, scripts };
}

async function importData<T>(path: string): Promise<T> {
  const module: { default: T } = await import(path);

  return module.default;
}

async function pluginCommands(repoRoot: string): Promise<string[]> {
  const catalog: Catalog = await Bun.file(join(repoRoot, ".claude-plugin/marketplace.json")).json();

  const commands = await Promise.all(
    catalog.plugins.map(async ({ source }) => {
      const directory = source.replace(/^\.\//u, "");
      const hooks = Bun.file(join(repoRoot, directory, "hooks/hooks.json"));

      if (!(await hooks.exists())) return [];
      const wiring: JsonValue = await hooks.json();

      return leavesAt(wiring, "command").map((command) =>
        command.replaceAll(PLUGIN_ROOT_RE, `${directory}/`),
      );
    }),
  );

  return commands.flat();
}

async function hookPaths(repoRoot: string): Promise<Set<string>> {
  const [settings, kit, lefthookSource, plugins] = await Promise.all([
    importData<SettingsFile>(join(repoRoot, SETTINGS_PATH)),
    importData<JsonValue>(join(repoRoot, KIT_CONFIG_PATH)),
    Bun.file(join(repoRoot, "lefthook.yml")).text(),
    pluginCommands(repoRoot),
  ]);

  const lefthook = lefthookRuns(parse(lefthookSource));

  const scriptCode = await Promise.all(
    lefthook.scripts.map(async (path) => await $`shfmt --minify ${join(repoRoot, path)}`.text()),
  );

  return wiredPaths([
    ...leavesAt(settings.hooks ?? null, "command"),
    ...leavesAt(kit, "run"),
    ...plugins,
    ...lefthook.commands,
    ...lefthook.scripts,
    ...scriptCode,
  ]);
}

function loadLint(repoRoot: string): LintConfig {
  const printed = Bun.spawnSync(["bun", "x", "oxlint", "--print-config"], { cwd: repoRoot });

  if (printed.exitCode !== 0) {
    throw new Error(`oxlint --print-config failed: ${printed.stderr.toString().trim()}`);
  }

  const resolved: PrintedConfig = JSON.parse(printed.stdout.toString());

  return {
    rules: { ...resolved.rules, ...config.rules },
    overrides: (config.overrides ?? []).map((override) => override.rules ?? {}),
  };
}

function namesHook(registry: Registry): boolean {
  return Object.values(registry).some((entries) =>
    Object.values(entries).some(
      (entry) => "held" in entry && entry.held.some((control) => control.startsWith("hook ")),
    ),
  );
}

export async function controlsOf(repoRoot: string, registry: Registry): Promise<Controls> {
  const [pairs, bunfig, wired] = await Promise.all([
    expectedCommands(repoRoot),
    importData<Bunfig>(join(repoRoot, "bunfig.toml")),
    namesHook(registry) ? hookPaths(repoRoot) : new Set<string>(),
  ]);

  const plan: TestPlan = {
    ignorePatterns: bunfig.test?.pathIgnorePatterns ?? [],
    extraRoots: testRuns(
      { kind: "all", reason: "every suite" },
      { ignored: bunfig.test?.pathIgnorePatterns ?? [], integration: [], workers: 2 },
    )
      .flat()
      .filter((argument) => argument.startsWith("./"))
      .map((root) => root.slice("./".length)),
    kitDirs: pairs.flatMap((pair) => {
      const plugin = KIT_COMMAND_RE.exec(pair.ci)?.[1];

      return plugin === undefined ? [] : [`${plugin}/`];
    }),
  };

  let lint: LintConfig | null = null;

  return {
    gates: new Set(pairs.map((pair) => pair.gate)),
    wired,
    lintHeld: (rule) => {
      lint ??= loadLint(repoRoot);

      return lintHeld(rule, lint);
    },
    runsTest: (path) => runsTestFile(path, plan),
    exists: (path) => existsSync(join(repoRoot, path)),
  };
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");

  const files = await Promise.all(
    ruleFiles(repoRoot).map(async (path) => ({
      path,
      source: await Bun.file(join(repoRoot, path)).text(),
    })),
  );

  const failures = checkRegistry(files, REGISTRY, await controlsOf(repoRoot, REGISTRY));

  if (failures.length > 0) {
    console.error(`${failures.length} rule registry violation(s):\n`);

    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
}
