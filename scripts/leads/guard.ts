#!/usr/bin/env bun

/**
 * PreToolUse hook of the `leads-gate` and `leads-scan` skills, which Claude Code registers once either is invoked and
 * keeps for the rest of the session: `guard.ts gate` or `guard.ts scan`. In the cloud's auto mode a skill's
 * `allowed-tools` grants without restricting, and the repository already allows `curl`, `sed` or `mv`: a hook's deny
 * holds in every mode, so this is the control. Each skill's hook sets `onFailure: "block"`, so a guard that cannot run
 * blocks the call too.
 *
 * Each mode lets through its skill's commands alone, exactly as the skill writes them; the writes of the files its
 * scripts read from the model; the scan's reads of the tree and files it claimed under `.leads/`; its own skill. It
 * denies everything else, and denies on any input it cannot read.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { isRecord, stringField } from "../../agent-hooks/json.ts";
import { isErrno, isInsideRelative, messageOf } from "../../tools/platform/pure.ts";
import { type Json, parseJson } from "./lib.ts";

export type Mode = "gate" | "scan";

interface Rules {
  readonly commands: readonly RegExp[];
  readonly writable: RegExp;
  /** The paths it may read, relative to the checkout; null when it reads none. */
  readonly readable: RegExp | null;
  readonly skill: string;
}

// The model never chooses the budget: `--max` stays the human's, by hand. The window reaches back 99 days at most.
const RULES: Readonly<Record<Mode, Rules>> = {
  gate: {
    commands: [
      /^bun \.\/scripts\/leads\/gate\.ts collect(?: --since \d{1,2}d| --stats)*$/u,
      /^bun \.\/scripts\/leads\/gate\.ts decide --file \.leads\/verdicts\.json$/u,
    ],
    writable: /^\.leads\/verdicts\.json$/u,
    readable: null,
    skill: "leads-gate",
  },
  scan: {
    commands: [
      /^bun \.\/scripts\/leads\/scan\.ts claim --tier (?:minor|major)(?: --issue \d{1,7})?$/u,
      /^bun \.\/scripts\/leads\/scan\.ts search --issue (\d{1,7}) --query \.leads\/\1-query\.txt$/u,
      /^bun \.\/scripts\/leads\/scan\.ts publish --issue (\d{1,7}) --leads \.leads\/\1-leads\.json$/u,
      /^bun \.\/scripts\/leads\/scan\.ts release --issue (\d{1,7}) --file \.leads\/\1-release\.json$/u,
    ],
    writable: /^\.leads\/\d{1,7}-(?:leads\.json|release\.json|query\.txt)$/u,
    readable:
      /^\.leads\/(?:\d{1,7}(?:\/(?!(?:.*\/)?\.git(?:\/|$)).+)?|\d{1,7}-(?:notes\.md|types\.diff))$/u,
    skill: "leads-scan",
  },
};

/** Anything a shell reads as more than words: a second command, a substitution, a redirection, a quote, a glob. */
const SHELL_SYNTAX = /[;&|`$<>()\\'"*?[\]{}~#!\n\r]/u;

const READERS = new Set(["Read", "Grep", "Glob"]);

const WRITERS = new Set(["Write", "Edit"]);

export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

const ALLOW: Decision = { kind: "allow" };

function deny(reason: string): Decision {
  return { kind: "deny", reason: `leads guard: ${reason}` };
}

/** The path with every link resolved: a file not written yet resolves through its nearest existing directory. */
function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;

    const parent = dirname(path);

    return parent === path ? path : join(realOrSame(parent), basename(path));
  }
}

/** The path relative to the checkout as the file system resolves it, links followed; null when it leaves it. */
function inside(root: string, cwd: string, path: string): string | null {
  const rel = relative(realOrSame(root), realOrSame(resolve(cwd, path)));

  return isInsideRelative(rel, [sep]) ? rel.split(sep).join("/") : null;
}

function decideBash(rules: Rules, command: string): Decision {
  const words = command.trim().replaceAll(/[ \t]+/gu, " ");

  if (SHELL_SYNTAX.test(words)) {
    return deny(
      "one plain command per call: no ;, &&, |, backtick, $(, redirection, quote or glob",
    );
  }

  return rules.commands.some((allowed) => allowed.test(words))
    ? ALLOW
    : deny(`Bash runs only the ${rules.skill} skill's commands, as it writes them`);
}

function decideRead(rules: Rules, root: string, cwd: string, tool: string, input: Json): Decision {
  if (rules.readable === null) return deny(`the ${rules.skill} skill reads no file`);

  const field = (name: string) => (isRecord(input) ? stringField(input, name) : undefined);
  const path = tool === "Read" ? field("file_path") : (field("path") ?? ".");

  if (path === undefined) return deny(`${tool} names no path`);

  const rel = inside(root, cwd, path);
  const pattern = tool === "Glob" ? (field("pattern") ?? "") : "";

  if (rel === null || !rules.readable.test(rel)) {
    return deny(
      `${tool} reads only the claimed tree .leads/<n>/ and its notes and typed diff: ${path}`,
    );
  }

  // `..` anywhere, not as a segment alone: a brace alternative such as `{..,x}` expands to the parent.
  return pattern.startsWith("/") || pattern.includes("..")
    ? deny(`Glob's pattern stays inside its path: ${pattern}`)
    : ALLOW;
}

/** The decision on one tool call, from the hook's input; `root` is the checkout the session works in. */
export function decideTool(mode: Mode, hookInput: Json, root: string): Decision {
  if (!isRecord(hookInput)) return deny("the hook's input is no object");

  const rules = RULES[mode];
  const tool = stringField(hookInput, "tool_name") ?? "";
  const input = hookInput["tool_input"] ?? null;
  const cwd = stringField(hookInput, "cwd") ?? root;
  const field = (name: string) => (isRecord(input) ? stringField(input, name) : undefined);

  if (tool === "Bash") return decideBash(rules, field("command") ?? "");

  if (READERS.has(tool)) return decideRead(rules, root, cwd, tool, input);

  if (WRITERS.has(tool)) {
    const path = field("file_path") ?? "";
    const rel = inside(root, cwd, path);

    return rel !== null && rules.writable.test(rel)
      ? ALLOW
      : deny(`${tool} writes only the files the ${rules.skill} skill names: ${path}`);
  }

  if (tool === "Skill" && field("skill") === rules.skill) return ALLOW;

  return deny(
    `${tool} is not among the ${rules.skill} skill's tools: Bash for its commands, Write for its .leads/ files`,
  );
}

export function hookOutput(decision: Decision): string | null {
  return decision.kind === "allow"
    ? null
    : JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        },
      });
}

/** The hook's stdout for one call: a deny, or null to let the tool through. The checkout is the project's. */
export function guard(
  mode: string | undefined,
  raw: string,
  projectDir: string | undefined,
  processCwd: string,
): string | null {
  if (mode !== "gate" && mode !== "scan") {
    return hookOutput(deny(`the hook names no mode, gate or scan: ${String(mode)}`));
  }

  try {
    const input = parseJson(raw);
    const cwd = isRecord(input) ? stringField(input, "cwd") : undefined;

    return hookOutput(decideTool(mode, input, projectDir ?? cwd ?? processCwd));
  } catch (error) {
    return hookOutput(deny(`unreadable hook input: ${messageOf(error)}`));
  }
}

if (import.meta.main) {
  const output = guard(
    process.argv[2],
    await Bun.stdin.text(),
    process.env["CLAUDE_PROJECT_DIR"],
    process.cwd(),
  );

  if (output !== null) console.log(output);
}
