#!/usr/bin/env bun
/**
 * YAML frontmatter validation script
 * Validates frontmatter in component markdown files (commands, skills, agents,
 * hooks, path-scoped rules) — staged files by default, the whole repo with --all
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  checkKeys,
  classifyComponent,
  validateFrontmatter,
} from "./lib/frontmatter-validation";

// Colors (disabled if not a terminal)
const isTTY = process.stdout.isTTY;
const RED = isTTY ? "\x1b[0;31m" : "";
const GREEN = isTTY ? "\x1b[0;32m" : "";
const YELLOW = isTTY ? "\x1b[1;33m" : "";
const BOLD = isTTY ? "\x1b[1m" : "";
const RESET = isTTY ? "\x1b[0m" : "";

// Get repo root
const repoRootResult = await $`git rev-parse --show-toplevel`.nothrow().quiet();
if (repoRootResult.exitCode !== 0) {
  console.error("Error: Not in a git repository");
  process.exit(2);
}
const repoRoot = repoRootResult.text().trim();

// File source: `--all` validates every tracked plugin markdown file (used in
// CI, where nothing is staged); default validates only staged files (pre-commit).
const checkAll = process.argv.includes("--all");
const listResult = checkAll
  ? await $`git ls-files`.quiet()
  : await $`git diff --cached --name-only --diff-filter=ACMR`.quiet();
const candidates = listResult.text().trim().split("\n").filter(Boolean);

// Filter to Claude Code markdown files (commands, skills, agents, hooks,
// path-scoped rules). archive/ holds vendored, frozen plugins — skip it.
const pluginPatterns = [
  /commands\/.*\.md$/,
  /skills\/.*\.md$/,
  /agents\/.*\.md$/,
  /hooks\/.*\.md$/,
  /^\.claude\/rules\/.*\.md$/,
];

const mdFiles = candidates.filter(
  (f: string) =>
    !f.startsWith("archive/") && pluginPatterns.some((p) => p.test(f))
);

if (mdFiles.length === 0) {
  process.exit(0); // No relevant files staged
}

console.log(`${BOLD}Validating YAML frontmatter...${RESET}\n`);

let errors = 0;

for (const file of mdFiles) {
  const fullPath = join(repoRoot, file);
  if (!existsSync(fullPath)) continue;

  const content = await Bun.file(fullPath).text();
  const result = validateFrontmatter(file, content);

  if (!result.valid && result.error) {
    errors++;
    const loc = result.error.line
      ? `:${result.error.line}:${result.error.col}`
      : "";
    console.log(`${RED}✗${RESET} ${file}${loc}`);
    console.log(`  ${result.error.message}`);
    if (result.error.code) {
      console.log(`  ${YELLOW}Code: ${result.error.code}${RESET}`);
    }
    console.log();
    continue;
  }

  // Key validation: Claude Code silently ignores unknown frontmatter keys
  // (verified against CLI v2.1.232 — even `claude plugin validate --strict`
  // passes them), so this pre-commit check is the only gate.
  const type = classifyComponent(file);
  if (!type) continue;

  if (!result.frontmatter) {
    if (type === "agent") {
      errors++;
      console.log(`${RED}✗${RESET} ${file}`);
      console.log(
        `  Agent file has no frontmatter (name and description are required)`
      );
      console.log();
    }
    continue;
  }

  const keys = checkKeys(type, result.frontmatter);
  if (keys.unknown.length === 0 && keys.missing.length === 0) continue;

  errors++;
  console.log(`${RED}✗${RESET} ${file} (${type})`);
  for (const violation of keys.unknown) {
    const hint = violation.suggestion ? ` — ${violation.suggestion}` : "";
    console.log(`  Unknown key \`${violation.key}\`${hint}`);
  }
  for (const key of keys.missing) {
    console.log(`  Missing required key \`${key}\``);
  }
  console.log();
}

if (errors === 0) {
  console.log(
    `${GREEN}✓${RESET} All ${mdFiles.length} file(s) have valid frontmatter`
  );
  process.exit(0);
} else {
  console.log(`\n${RED}${errors} file(s) with invalid frontmatter${RESET}`);
  console.log(`\n${YELLOW}Common fixes:${RESET}`);
  console.log(
    `  - Quote strings with special chars: argument-hint: "[optional]"`
  );
  console.log(`  - Escape colons in values: description: "Note: this works"`);
  console.log(
    `  - Unknown keys are silently ignored by Claude Code; fix the key, do not keep it`
  );
  process.exit(1);
}
