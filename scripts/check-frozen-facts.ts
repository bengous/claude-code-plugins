#!/usr/bin/env bun

/**
 * Refuse a fact frozen the day it was written, a Claude Code version or a
 * GitHub Actions run id, in Markdown and in shell comments. Script comments
 * are the `local/no-frozen-facts` lint rule's, which shares its patterns.
 *
 * With no argument it walks the working tree; with paths it checks only
 * those.
 */

import { basename } from "node:path";

import { $ } from "bun";

import { frozenFactsIn } from "../tools/oxlint/local/shared/frozen-facts.ts";
import { workingTreeFiles } from "./lib/working-tree-files.ts";

const EXCLUDED_PREFIXES = [
  "archive/",
  "node_modules/",
  "tools/oxlint/anti-slop/",
  ".claude/worktrees/",
] as const;

const ALLOWLIST = [
  // Release history: each section records its release as it shipped.
  /(?:^|\/)CHANGELOG\.md$/u,
  // Plans and mockups the browser suite renders as its input, one a captured real plan.
  /^vellum\/e2e\/fixtures\//u,
  // Marketplace trees the validator's tests read as their input.
  /^scripts\/__tests__\/fixtures\//u,
] as const;

// lint-shell.ts's own test, so both gates read the same scripts.
const SHELL_SHEBANG_RE = /^#!.*\b(?:ba|z|k|da)?sh\b/u;

export interface Hit {
  path: string;
  line: number;
  text: string;
}

/** A run of text whose first character sits on `line`. */
interface Fragment {
  line: number;
  text: string;
}

/** shfmt's `--to-json` tree, where a comment is the node holding `Hash`, its `#`. */
type ShellJson = string | number | boolean | null | ShellJson[] | ShellNode;

type ShellNode = { [field: string]: ShellJson } & { Hash?: { Line: number }; Text?: string };

export function isCandidate(path: string): boolean {
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;

  if (ALLOWLIST.some((pattern) => pattern.test(path))) return false;

  return path.endsWith(".md") || path.endsWith(".sh") || !basename(path).includes(".");
}

export async function findFrozenFacts(path: string, contents: string): Promise<Hit[]> {
  const fragments = await fragmentsOf(path, contents);

  return fragments.flatMap(({ line, text }) =>
    frozenFactsIn(text).map((fact) => ({
      path,
      line: line + newlines(text.slice(0, fact.index)),
      text: fact.text,
    })),
  );
}

async function fragmentsOf(path: string, contents: string): Promise<Fragment[]> {
  if (path.endsWith(".md")) return [{ line: 1, text: contents }];

  if (path.endsWith(".sh") || SHELL_SHEBANG_RE.test(contents.split("\n", 1)[0] ?? "")) {
    return await shellComments(path, contents);
  }

  return [];
}

function newlines(text: string): number {
  return text.split("\n").length - 1;
}

async function shellComments(path: string, source: string): Promise<Fragment[]> {
  const parsed = await $`shfmt --to-json --filename ${path} < ${new Response(source)}`
    .nothrow()
    .quiet();

  if (parsed.exitCode !== 0) {
    throw new Error(`shfmt could not parse ${path}: ${parsed.stderr.toString().trim()}`);
  }

  const tree: ShellJson = JSON.parse(parsed.stdout.toString());
  const fragments: Fragment[] = [];
  collectShellComments(tree, fragments);

  return fragments.toSorted((left, right) => left.line - right.line);
}

function collectShellComments(node: ShellJson, into: Fragment[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectShellComments(child, into);

    return;
  }

  if (!(node instanceof Object)) return;

  if (node.Hash !== undefined && node.Text !== undefined) {
    into.push({ line: node.Hash.Line, text: node.Text });
  }

  for (const child of Object.values(node)) collectShellComments(child, into);
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  const listed = requested.length > 0 ? requested : await workingTreeFiles();
  const candidates = listed.filter((path) => isCandidate(path));

  const hits: Hit[] = [];

  for (const path of candidates) {
    const file = Bun.file(path);

    if (!(await file.exists())) continue;
    hits.push(...(await findFrozenFacts(path, await file.text())));
  }

  if (hits.length > 0) {
    console.error(`${hits.length} frozen fact(s), a Claude Code version or an Actions run id:\n`);

    for (const hit of hits) {
      console.error(`  ${hit.path}:${hit.line}: ${hit.text}`);
    }

    console.error("\nState the behaviour, and the command or test that checks it, instead.");
    process.exit(1);
  }
}
