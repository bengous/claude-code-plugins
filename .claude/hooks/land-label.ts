#!/usr/bin/env bun

/**
 * UserPromptExpansion hook: the human's own `/land <n>` puts `land-ok` on each
 * pull request `<n>` lands, before the command reaches the agent. Claude Code
 * fires UserPromptExpansion on a command the human typed, queued ones
 * included, and on no peer message, task notification or call of the model's.
 *
 * The pull requests are the `layers` that `scripts/landing/stack.ts resolve
 * <n> --json` prints. The label is taken off first where it is on, so GitHub
 * dates the ok anew. A number that does not resolve, or a label that does not
 * go on, blocks the command, its reason shown to the human.
 * `guard-land-ok.ts` refuses an agent's own way to the label.
 */

import { isRecord, stringField } from "../../agent-hooks/core/util/json.ts";
import type { Argv, RunOptions, RunResult, TextOutput } from "../../tools/platform/process.ts";
import { run } from "../../tools/platform/process.ts";
import { messageOf } from "../../tools/platform/pure.ts";
import { checkoutRoot } from "./checkout.ts";
import { HOOK_EXIT } from "./hook-io.ts";

export const LABEL = "land-ok";

const COMMAND = "land";

const NUMBER = /^#?(\d+)$/u;

/** Under the hook's 30 s timeout in `.claude/__settings.jsonc`. */
const DEADLINE_MS = 25_000;

export type Runner = (argv: Argv, options: RunOptions & TextOutput) => Promise<RunResult>;

export interface ExpansionInput {
  readonly expansion_type?: string | undefined;
  readonly command_name?: string | undefined;
  readonly command_args?: string | undefined;
  readonly cwd?: string | undefined;
}

export type Answer =
  | { readonly kind: "pass" }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "labelled"; readonly line: string };

type Targets = { readonly prs: readonly number[]; readonly stack: number | null };

/** What the hook prints for an answer, or null for nothing. */
export function encode(answer: Answer): string | null {
  switch (answer.kind) {
    case "pass": {
      return null;
    }

    case "block": {
      return JSON.stringify({ decision: "block", reason: answer.reason });
    }

    case "labelled": {
      // The pull requests the label went on carry the human's ok: the human sees which, not only the agent.
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptExpansion",
          additionalContext: answer.line,
        },
        systemMessage: answer.line,
      });
    }

    default: {
      const unreachable: never = answer;
      throw new Error(`unhandled answer: ${JSON.stringify(unreachable)}`);
    }
  }
}

function block(why: string): Answer {
  return { kind: "block", reason: `land-label: /${COMMAND}: ${why}` };
}

function outputOf(ran: RunResult): string {
  if (ran.kind === "missing") return `command not found: ${ran.program}`;

  return [ran.stderr, ran.stdout]
    .filter((part) => part.trim() !== "")
    .join("\n")
    .trim();
}

function succeeded(ran: RunResult): boolean {
  return ran.kind === "exited" && ran.code === 0;
}

/** What a failed run printed, or how it ended when it printed nothing or timed out. */
function failureOf(argv: Argv, ran: RunResult): string {
  const output = outputOf(ran);
  const label = argv.join(" ");

  switch (ran.kind) {
    case "missing": {
      return `${label}: ${output}`;
    }

    case "timedOut": {
      return `${label} timed out after ${ran.timeoutMs} ms`;
    }

    case "exited": {
      return output === "" ? `${label} exited with code ${ran.code}` : output;
    }

    default: {
      const unreachable: never = ran;
      throw new Error(`unhandled result: ${JSON.stringify(unreachable)}`);
    }
  }
}

interface Context {
  readonly cwd: string;
  readonly runner: Runner;
  readonly deadline: number;
}

function runIn(context: Context, argv: Argv): Promise<RunResult> {
  return context.runner(argv, {
    cwd: context.cwd,
    timeoutMs: Math.max(0, context.deadline - Date.now()),
  });
}

/** The pull requests `stack.ts resolve` prints for `number`, or why they do not read. */
async function targetsOf(
  context: Context,
  number: string,
): Promise<Targets | { readonly why: string }> {
  const argv: Argv = ["bun", "./scripts/landing/stack.ts", "resolve", number, "--json"];
  const ran = await runIn(context, argv);

  if (!succeeded(ran) || ran.kind !== "exited") return { why: failureOf(argv, ran) };

  let printed: unknown;

  try {
    printed = JSON.parse(ran.stdout);
  } catch {
    return { why: `${argv.join(" ")} printed no JSON: ${outputOf(ran)}` };
  }

  const layers = isRecord(printed) ? printed["layers"] : undefined;

  if (!isRecord(printed) || !Array.isArray(layers)) {
    return { why: `${argv.join(" ")} printed no "layers": ${JSON.stringify(printed)}` };
  }

  const prs = layers.flatMap((layer) =>
    isRecord(layer) && Number.isInteger(layer["number"]) ? [Number(layer["number"])] : [],
  );

  if (prs.length === 0 || prs.length !== layers.length) {
    return { why: `${argv.join(" ")} printed a layer with no number: ${JSON.stringify(printed)}` };
  }

  const stack = printed["stack"];

  return { prs, stack: Number.isInteger(stack) ? Number(stack) : null };
}

/** Puts the label on pull request `pr`, taken off first when it is on; null once on, else why it did not go on. */
async function putOn(context: Context, pr: number): Promise<string | null> {
  const view: Argv = ["gh", "pr", "view", String(pr), "--json", "labels", "--jq", ".labels[].name"];
  const labels = await runIn(context, view);

  if (!succeeded(labels) || labels.kind !== "exited") return failureOf(view, labels);

  if (labels.stdout.split("\n").includes(LABEL)) {
    const remove: Argv = ["gh", "pr", "edit", String(pr), "--remove-label", LABEL];
    const removed = await runIn(context, remove);

    if (!succeeded(removed)) return failureOf(remove, removed);
  }

  const add: Argv = ["gh", "pr", "edit", String(pr), "--add-label", LABEL];
  const added = await runIn(context, add);

  return succeeded(added) ? null : failureOf(add, added);
}

/** The hook's answer to one UserPromptExpansion payload, its commands run in `cwd`. */
export async function landLabel(
  input: ExpansionInput,
  cwd: string,
  runner: Runner,
  deadline = Date.now() + DEADLINE_MS,
): Promise<Answer> {
  if (input.expansion_type !== "slash_command" || input.command_name !== COMMAND) {
    return { kind: "pass" };
  }

  const number = NUMBER.exec((input.command_args ?? "").trim())?.[1];

  if (number === undefined) {
    return block(`/${COMMAND} takes one pull request or stack number, as /${COMMAND} 470`);
  }

  const context: Context = { cwd, runner, deadline };
  const targets = await targetsOf(context, number);

  if ("why" in targets) return block(targets.why);

  for (const [index, pr] of targets.prs.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one pull request at a time: a failure names the one it stopped at.
    const failed = await putOn(context, pr);

    if (failed !== null) {
      const labelled = targets.prs.slice(0, index).map((on) => `#${on}`);
      const on = labelled.length === 0 ? "" : `; it is on ${labelled.join(" ")}`;

      return block(`${LABEL} did not go on #${pr}: ${failed}${on}`);
    }
  }

  const prs = targets.prs.map((pr) => `#${pr}`).join(" ");
  const stack = targets.stack === null ? "" : ` (stack #${targets.stack})`;

  return {
    kind: "labelled",
    line: `land-label: ${LABEL} is on ${prs}${stack}, put there by the human's own /${COMMAND} ${number}.`,
  };
}

if (import.meta.main) {
  try {
    const payload: unknown = JSON.parse(await Bun.stdin.text());
    const record = isRecord(payload) ? payload : {};

    const input: ExpansionInput = {
      expansion_type: stringField(record, "expansion_type"),
      command_name: stringField(record, "command_name"),
      command_args: stringField(record, "command_args"),
      cwd: stringField(record, "cwd"),
    };

    const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
    const cwd = await checkoutRoot(input.cwd, projectDir);
    const output = encode(await landLabel(input, cwd, run));

    if (output !== null) console.log(output);
  } catch (error) {
    // Claude Code shows the first stderr line of a failed hook, and an
    // uncaught throw makes that line a Bun source frame.
    console.error(`land-label: ${messageOf(error)}`);
    process.exit(HOOK_EXIT.ERROR);
  }
}
