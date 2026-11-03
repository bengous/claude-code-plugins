import type { LabelCommand } from "../core/config/profile.ts";
import type { HookContext } from "../core/runtime/hook.ts";
import type { Verdict } from "../core/runtime/verdict.ts";
import { ALLOW } from "../core/runtime/verdict.ts";
import type { Argv, RunResult } from "../core/util/exec.ts";
import { formatFailure, outputOf, succeeded } from "../core/util/exec.ts";
import { isRecord } from "../core/util/json.ts";
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this module reads what the profile's `targets` command prints: each field of its JSON is narrowed here, and a value of another shape blocks the command. */
import { splitCommand } from "../lanes/command.ts";

const NUMBER = /^#?(\d+)$/u;

const ARGS_PLACEHOLDER = "{args}";

type Targets = { readonly prs: readonly number[]; readonly stack: number | null };

/**
 * The human's own `/<command> <n>`, which only their typing expands: Claude Code fires UserPromptExpansion on a
 * command the human typed, queued ones included, and on no peer message, task notification or call of the model's.
 * Puts on each pull request `n` names, as the command's `targets` prints them, the label `profile.approvals.labels`
 * gives that command, taken off first when it is on so GitHub dates the ok anew, and tells the agent where. A number
 * that does not resolve, or a label that does not go on, blocks the command, its reason shown to the human.
 */
export async function runUserPromptExpansion(context: HookContext): Promise<Verdict> {
  const { input, config } = context;

  if (input.expansionType !== "slash_command") return ALLOW;

  const label = config.profile.approvals?.labels.find(
    (entry) => entry.command?.name === input.commandName,
  );

  if (label?.command === null || label?.command === undefined) return ALLOW;

  const { command } = label;
  const number = NUMBER.exec((input.commandArgs ?? "").trim())?.[1];

  if (number === undefined) {
    return block(
      command,
      `/${command.name} takes one pull request or stack number, as /${command.name} 470`,
    );
  }

  const targets = await targetsOf(context, command, number);

  if (typeof targets === "string") return block(command, targets);

  for (const pr of targets.prs) {
    // oxlint-disable-next-line no-await-in-loop -- one pull request at a time: a failure names the one it stopped at.
    const failed = await putOn(context, label.name, pr);

    if (failed !== null) {
      const labelled = targets.prs.slice(0, targets.prs.indexOf(pr)).map((on) => `#${on}`);

      return block(
        command,
        `${label.name} did not go on #${pr}: ${failed}${labelled.length === 0 ? "" : `; it is on ${labelled.join(" ")}`}`,
      );
    }
  }

  const stack = targets.stack === null ? "" : ` (stack #${targets.stack})`;

  return {
    kind: "context",
    text: `agent-hooks: ${label.name} is on ${targets.prs.map((pr) => `#${pr}`).join(" ")}${stack}, put there by the human's own /${command.name} ${number}.`,
  };
}

function block(command: LabelCommand, why: string): Verdict {
  return { kind: "block", reason: `agent-hooks: /${command.name}: ${why}` };
}

function run(context: HookContext, argv: Argv): Promise<RunResult> {
  return context.runner(argv, { cwd: context.root, timeoutMs: context.deadline.remaining() });
}

/** What a failed run printed, or how it ended when it printed nothing or timed out. */
function failureOf(argv: Argv, ran: RunResult): string {
  const output = outputOf(ran);

  return ran.kind === "exited" && output !== "" ? output : formatFailure(argv.join(" "), ran);
}

/** The pull requests `targets` prints for `number`, or why they do not read. */
async function targetsOf(
  context: HookContext,
  command: LabelCommand,
  number: string,
): Promise<Targets | string> {
  const [program, ...args] = splitCommand(command.targets).map((word) =>
    word.replaceAll(ARGS_PLACEHOLDER, number),
  );

  if (program === undefined) return `its targets command is empty`;

  const argv: Argv = [program, ...args];
  const ran = await run(context, argv);

  if (!succeeded(ran)) return failureOf(argv, ran);

  let printed: unknown;

  try {
    printed = JSON.parse(ran.kind === "exited" ? ran.stdout : "");
  } catch {
    return `${command.targets} printed no JSON: ${outputOf(ran)}`;
  }

  if (!isRecord(printed) || !Array.isArray(printed["layers"])) {
    return `${command.targets} printed no "layers": ${JSON.stringify(printed)}`;
  }

  const prs = printed["layers"].flatMap((layer: unknown) =>
    isRecord(layer) && typeof layer["number"] === "number" ? [layer["number"]] : [],
  );

  if (prs.length === 0 || prs.length !== printed["layers"].length) {
    return `${command.targets} printed a layer with no number: ${JSON.stringify(printed)}`;
  }

  const stack = printed["stack"];

  return { prs, stack: typeof stack === "number" ? stack : null };
}

/** Puts `label` on pull request `pr`, taken off first when it is on; null once on, else why it did not go on. */
async function putOn(context: HookContext, label: string, pr: number): Promise<string | null> {
  const view: Argv = ["gh", "pr", "view", String(pr), "--json", "labels", "--jq", ".labels[].name"];
  const labels = await run(context, view);

  if (!succeeded(labels)) return failureOf(view, labels);

  const on = labels.kind === "exited" && labels.stdout.split("\n").includes(label);

  if (on) {
    const remove: Argv = ["gh", "pr", "edit", String(pr), "--remove-label", label];
    const removed = await run(context, remove);

    if (!succeeded(removed)) return failureOf(remove, removed);
  }

  const add: Argv = ["gh", "pr", "edit", String(pr), "--add-label", label];
  const added = await run(context, add);

  return succeeded(added) ? null : failureOf(add, added);
}
