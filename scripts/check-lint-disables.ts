#!/usr/bin/env bun

/**
 * Refuse any lint suppression that does not say why, on the same line.
 *
 * The accepted form is oxlint's own: the rule list, then ` -- `, then a reason.
 *   // oxlint-disable-next-line some-rule -- the reason this one is unavoidable
 *
 * With no argument it walks the whole repo; with paths it checks only those
 * (used by the lefthook pre-commit job).
 */

import { $ } from "bun";

const EXCLUDED_PREFIXES = [
  "archive/",
  "_docs/",
  "node_modules/",
  "tools/oxlint/anti-slop/",
] as const;

// oxlint honours the eslint- spelling too, so both have to be gated.
const DIRECTIVE_RE = /\b(?:ox|es)lint-disable(?:-next-line|-line)?\b/u;
const JUSTIFIED_RE = /\s--\s+\S/u;

export interface Offence {
  path: string;
  line: number;
  text: string;
}

export function findOffences(path: string, contents: string): Offence[] {
  const offences: Offence[] = [];
  for (const [index, text] of contents.split("\n").entries()) {
    if (!DIRECTIVE_RE.test(text)) continue;
    if (JUSTIFIED_RE.test(text)) continue;
    offences.push({ path, line: index + 1, text: text.trim() });
  }
  return offences;
}

function isCandidate(path: string): boolean {
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return path.endsWith(".ts") || path.endsWith(".js");
}

async function trackedFiles(): Promise<string[]> {
  const listed = await $`git ls-files -z`.quiet().text();
  return listed.split("\0").filter(Boolean);
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  const listed = requested.length > 0 ? requested : await trackedFiles();
  const candidates = listed.filter((path) => isCandidate(path));

  const offences: Offence[] = [];
  for (const path of candidates) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    offences.push(...findOffences(path, await file.text()));
  }

  if (offences.length > 0) {
    console.error(`${offences.length} lint suppression(s) without a justification:\n`);
    for (const offence of offences) {
      console.error(`  ${offence.path}:${offence.line}: ${offence.text}`);
    }
    console.error("\nAdd ` -- <why this one is unavoidable>` on the same line.");
    process.exit(1);
  }
}
