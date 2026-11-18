#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { writeAtomicSync } from "../lib/platform/fs.ts";
import { messageOf } from "../lib/platform/pure.ts";
import { render, type TemplateFile } from "./render.ts";
import { readTemplates, REPO_PREFIX, ROUTINE_PROMPT } from "./templates.ts";

const USAGE = `Usage: install.ts repo --owner <login> --repo <owner/name> --routine <trig_id>
                       [--target <dir>] [--force]
       install.ts prompt --owner <login> --repo <owner/name> --dir <routine dir> [--force]

  repo    writes the factory's workflows, CODEOWNERS, deep-review-paths and review
          command into the working tree of --target, this directory by default.
  prompt  writes the routine's prompt.md into --dir, created when missing.

  A file whose content differs is refused unless --force. Touches no GitHub state,
  commits nothing. Exit 0 when nothing was refused, 1 when a file was refused or a
  write failed, 2 on a bad argument.`;

export type Subject =
  | { readonly kind: "repo"; readonly target: string }
  | { readonly kind: "prompt"; readonly dir: string };

export type Placement = { readonly dest: string; readonly shown: string; readonly content: string };

export type Outcome = "wrote" | "identical" | "overwrote" | "refused";

export type Decision = { readonly placement: Placement; readonly outcome: Outcome };

export function belongsTo(path: string, kind: Subject["kind"]): boolean {
  return kind === "repo" ? path.startsWith(REPO_PREFIX) : path === ROUTINE_PROMPT;
}

/** Where each rendered file of the subject goes: `repo/` files under the target, the prompt in its directory. */
export function placements(files: readonly TemplateFile[], subject: Subject): Placement[] {
  return files.flatMap(({ path, content }): Placement[] => {
    if (!belongsTo(path, subject.kind)) return [];

    if (subject.kind === "repo") {
      const rel = path.slice(REPO_PREFIX.length);

      return [{ dest: join(subject.target, rel), shown: rel, content }];
    }

    const dest = join(subject.dir, "prompt.md");

    return [{ dest, shown: dest, content }];
  });
}

/** What happens to each placement, given what the file holds now (`null`: no file). */
export function decide(
  items: readonly Placement[],
  current: (dest: string) => string | null,
  force: boolean,
): Decision[] {
  return items.map((placement) => {
    const now = current(placement.dest);

    if (now === null) return { placement, outcome: "wrote" };

    if (now === placement.content) return { placement, outcome: "identical" };

    return { placement, outcome: force ? "overwrote" : "refused" };
  });
}

export function report(decisions: readonly Decision[]): string {
  return decisions
    .map(({ placement, outcome }) =>
      outcome === "refused"
        ? `refused    ${placement.shown}: its content differs; --force overwrites it`
        : `${outcome.padEnd(10)} ${placement.shown}`,
    )
    .join("\n");
}

function currentContent(dest: string): string | null {
  return existsSync(dest) ? readFileSync(dest, "utf8") : null;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

const OPTIONS = {
  owner: { type: "string" },
  repo: { type: "string" },
  routine: { type: "string" },
  target: { type: "string" },
  dir: { type: "string" },
  force: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;

function parse(argv: readonly string[]): Parsed | { readonly error: string } {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: true });
  } catch (error) {
    return { error: messageOf(error) };
  }
}

function subjectOf({ values, positionals }: Parsed): Subject | { readonly error: string } {
  const [kind, ...extra] = positionals;

  if (extra.length > 0) return { error: `unexpected argument: ${extra.join(" ")}` };

  if (kind === "repo") {
    if (values.dir !== undefined) return { error: "--dir belongs to install.ts prompt" };
    const target = resolve(values.target ?? process.cwd());

    return existsSync(join(target, ".git"))
      ? { kind, target }
      : { error: `${target} is not the root of a git working tree` };
  }

  if (kind === "prompt") {
    if (values.target !== undefined) return { error: "--target belongs to install.ts repo" };

    if (values.dir === undefined) return { error: "install.ts prompt needs --dir" };
    const dir = resolve(values.dir);

    return !existsSync(dir) || isDirectory(dir)
      ? { kind, dir }
      : { error: `--dir ${dir} is not a directory` };
  }

  return {
    error: kind === undefined ? "name what to install: repo or prompt" : `unknown: ${kind}`,
  };
}

function main(argv: readonly string[]): number {
  const parsed = parse(argv);

  if ("error" in parsed) {
    console.error(`install: ${parsed.error}\n\n${USAGE}`);

    return 2;
  }

  if (parsed.values.help) {
    console.log(USAGE);

    return 0;
  }

  const subject = subjectOf(parsed);

  if ("error" in subject) {
    console.error(`install: ${subject.error}\n\n${USAGE}`);

    return 2;
  }

  const { values } = parsed;

  const rendered = render(
    readTemplates().filter(({ path }) => belongsTo(path, subject.kind)),
    { OWNER: values.owner, REPO: values.repo, ROUTINE_ID: values.routine },
  );

  if (rendered.kind === "refused") {
    console.error(`${rendered.errors.map((error) => `install: ${error}`).join("\n")}\n\n${USAGE}`);

    return 2;
  }

  const decisions = decide(placements(rendered.files, subject), currentContent, values.force);

  for (const { placement, outcome } of decisions) {
    if (outcome === "wrote" || outcome === "overwrote") {
      writeAtomicSync(placement.dest, placement.content, { mkdir: true });
    }
  }

  console.log(report(decisions));

  return decisions.some(({ outcome }) => outcome === "refused") ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(main(Bun.argv.slice(2)));
  } catch (error) {
    console.error(`install: ${messageOf(error)}`);
    process.exit(1);
  }
}
