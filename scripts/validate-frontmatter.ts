#!/usr/bin/env bun
/**
 * YAML frontmatter validation script
 * Validates frontmatter in staged plugin markdown files (commands, skills, agents, hooks)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { validateFrontmatter } from "./lib/frontmatter-validation";

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

// Get staged .md files matching plugin patterns
const stagedResult =
  await $`git diff --cached --name-only --diff-filter=ACMR`.quiet();
const allStaged = stagedResult.text().trim().split("\n").filter(Boolean);

// Filter to plugin markdown files (commands, skills, agents, hooks)
const pluginPatterns = [
  /commands\/.*\.md$/,
  /skills\/.*\.md$/,
  /agents\/.*\.md$/,
  /hooks\/.*\.md$/,
];

const mdFiles = allStaged.filter((f) =>
  pluginPatterns.some((p) => p.test(f))
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
  }
}

if (errors === 0) {
  console.log(
    `${GREEN}✓${RESET} All ${mdFiles.length} file(s) have valid frontmatter`
  );
  process.exit(0);
} else {
  console.log(`\n${RED}${errors} file(s) with invalid YAML frontmatter${RESET}`);
  console.log(`\n${YELLOW}Common fixes:${RESET}`);
  console.log(
    `  - Quote strings with special chars: argument-hint: "[optional]"`
  );
  console.log(`  - Escape colons in values: description: "Note: this works"`);
  process.exit(1);
}
