#!/usr/bin/env bun

/**
 * Hold the factory's copy of each skill it installs to the github-flow skill it comes from: the
 * gate `skill-copies`.
 *
 *   bun ./scripts/gates/sync-skills.ts          checks, writes nothing
 *   bun ./scripts/gates/sync-skills.ts --write  writes the copies from their source, then checks
 *
 * `/factory:install` writes `factory/templates/repo/` into a target repository, so a skill under
 * `.claude/skills/` there reaches every repository the factory sets up. The check refuses a file the
 * copy lacks, holds beyond its source or holds with other bytes, and a `{{NAME}}` token in the
 * source, which the factory's renderer would read as one of its parameters. Both sides hold what
 * git lists there: an ignored file is neither compared nor removed.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeAtomic } from "../../tools/platform/fs.ts";
import { workingTreeFiles } from "./working-tree-files.ts";

/** The skills of github-flow that the factory installs, by their directory name. */
export const SKILLS: readonly string[] = ["pr", "issue"];

export const SOURCE_DIR = "github-flow/skills";

export const COPY_DIR = "factory/templates/repo/.claude/skills";

export const WRITE_COMMAND = "bun ./scripts/gates/sync-skills.ts --write";

/** The factory's parameter syntax, as `factory/scripts/render.ts` reads it. */
const PARAMETER = /\{\{[A-Z_]+\}\}/u;

const FIX = `edit ${SOURCE_DIR}/, never the copy, then run ${WRITE_COMMAND}`;

/** The files git sees under `dir`, on disk, relative to it. */
function filesUnder(dir: string, files: readonly string[], root: string): string[] {
  const prefix = `${dir}/`;

  return files
    .flatMap((file) =>
      file.startsWith(prefix) && existsSync(join(root, file)) ? [file.slice(prefix.length)] : [],
    )
    .toSorted();
}

type Pair = { readonly skill: string; readonly source: string[]; readonly copy: string[] };

async function pairsOf(root: string, skills: readonly string[]): Promise<Pair[]> {
  const files = await workingTreeFiles(root);

  return skills.map((skill) => ({
    skill,
    source: filesUnder(`${SOURCE_DIR}/${skill}`, files, root),
    copy: filesUnder(`${COPY_DIR}/${skill}`, files, root),
  }));
}

/** Every refusal of the gate, one line each, the path from the repository's root first. */
export async function problemsIn(root: string, skills: readonly string[]): Promise<string[]> {
  return (await pairsOf(root, skills)).flatMap(({ skill, source, copy }) => {
    const from = `${SOURCE_DIR}/${skill}`;
    const to = `${COPY_DIR}/${skill}`;

    if (source.length === 0) {
      return [
        `${from}: the factory installs this skill, but it holds no file; fix SKILLS in scripts/gates/sync-skills.ts`,
      ];
    }

    const held = new Set(copy);

    return [
      ...source.flatMap((file) => {
        const text = readFileSync(join(root, from, file));
        const problems: string[] = [];

        if (PARAMETER.test(text.toString("utf8"))) {
          problems.push(
            `${from}/${file}: holds a {{NAME}} token, which the factory's install reads as a parameter; write it another way`,
          );
        }

        if (!held.has(file)) {
          problems.push(`${to}/${file}: missing; ${FIX}`);
        } else if (!text.equals(readFileSync(join(root, to, file)))) {
          problems.push(`${to}/${file}: differs from ${from}/${file}; ${FIX}`);
        }

        return problems;
      }),
      ...copy
        .filter((file) => !source.includes(file))
        .map((file) => `${to}/${file}: ${from}/ holds no such file; ${FIX}`),
    ];
  });
}

/** Writes each copy that is missing or differs, and removes what the copy holds beyond its source. */
export async function writeCopies(root: string, skills: readonly string[]): Promise<string[]> {
  const written: string[] = [];

  for (const { skill, source, copy } of await pairsOf(root, skills)) {
    if (source.length === 0) continue;
    const from = `${SOURCE_DIR}/${skill}`;
    const to = `${COPY_DIR}/${skill}`;

    for (const file of source) {
      const bytes = readFileSync(join(root, from, file));
      const dest = join(root, to, file);

      if (existsSync(dest) && bytes.equals(readFileSync(dest))) continue;
      await writeAtomic(dest, bytes, { mkdir: true });
      written.push(`${to}/${file}`);
    }

    for (const file of copy.filter((held) => !source.includes(held))) {
      rmSync(join(root, to, file));
      written.push(`${to}/${file} (removed)`);
    }
  }

  return written;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");

  if (process.argv.includes("--write")) {
    for (const line of await writeCopies(root, SKILLS)) console.log(`wrote ${line}`);
  }

  const problems = await problemsIn(root, SKILLS);

  if (problems.length > 0) {
    console.error(`${problems.length} skill copy problem(s):\n`);

    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}
