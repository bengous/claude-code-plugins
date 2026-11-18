import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Place } from "./checkout.ts";
import {
  SCRATCH_PREFIX,
  nearestDirectory,
  placeOf,
  realPathOf,
  takePhoto,
  underCheckout,
} from "./checkout.ts";
import type { Config } from "./config.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { Deadline } from "./core/util/exec.ts";
import { stringField } from "./core/util/json.ts";
import { fixersFor, runFixers } from "./fixers.ts";
import type { HookOptions, Input, Verdict } from "./hook.ts";
import { ALLOW, raced } from "./hook.ts";
import { messageOf } from "./lib/platform/pure.ts";
import { loadState, persist, stateKey } from "./state.ts";

type PendingWrite =
  | { readonly kind: "write"; readonly content: string }
  | { readonly kind: "edit"; readonly content: string; readonly current: string };

/**
 * Before an Edit or a Write: hands the tool the content the fixers would leave, so the file is written once and the
 * agent has no rewrite to re-read. The first edit in a checkout the agent has no photo of photographs it first: the
 * tree before that write is the agent's baseline there, and its Stop measures that checkout too. It never blocks and
 * reports nothing of a fixer: on any failure the tool runs as asked.
 */
export async function runPreEdit(input: Input, options: HookOptions): Promise<Verdict | null> {
  const filePath = stringField(input.toolInput, "file_path");

  if (filePath === undefined) {
    return null;
  }

  const absolute = realPathOf(path.resolve(input.cwd ?? process.cwd(), filePath));
  const place = placeOf(path.dirname(absolute));
  const relativePath = place === null ? null : underCheckout(place.checkout, absolute);

  if (place === null || relativePath === null) {
    return null;
  }

  let config: Config;

  try {
    config = loadConfig(place.configFile);
  } catch (error) {
    if (error instanceof ConfigError) {
      return { kind: "note", text: error.message };
    }

    throw error;
  }

  try {
    return await raced("pre-edit", options, async (deadline) => {
      photograph(input, place, deadline, options.now);

      return await fixedWrite(
        input,
        config,
        { place, absolute, relativePath, filePath },
        deadline,
        options,
      );
    });
  } catch (error) {
    console.error(`agent-hooks: pre-edit: ${messageOf(error)}`);

    return ALLOW;
  }
}

/** Photographs the checkout for this agent when it has no photo there yet; a git that fails leaves it without. */
function photograph(input: Input, place: Place, deadline: Deadline, now: number): void {
  const state = loadState(stateKey(input.sessionId, input.agentId), place.checkout, now);

  if (state.photo !== null) {
    return;
  }

  try {
    state.photo = takePhoto(place.checkout, deadline, now);
  } catch (error) {
    console.error(`agent-hooks: no photo of ${place.checkout}: ${messageOf(error)}`);

    return;
  }

  persist(state, now);
}

type Target = {
  readonly place: Place;
  readonly absolute: string;
  readonly relativePath: string;
  readonly filePath: string;
};

async function fixedWrite(
  input: Input,
  config: Config,
  target: Target,
  deadline: Deadline,
  options: HookOptions,
): Promise<Verdict> {
  const fixers = fixersFor(config, "edit", target.relativePath);
  const pending = pendingWrite(input.toolName, input.toolInput, target.absolute);

  if (fixers.length === 0 || pending === null) {
    return ALLOW;
  }

  // Beside the real file, so a fixer finds the config and matches the overrides and ignores the real file would.
  const scratchDir = mkdtempSync(
    path.join(nearestDirectory(path.dirname(target.absolute)), SCRATCH_PREFIX),
  );

  const scratch = path.join(scratchDir, path.basename(target.absolute));

  try {
    // oxlint-disable-next-line local/no-raw-write -- the file is new, in a directory mkdtemp just made for this call alone: no reader can meet it half written
    writeFileSync(scratch, pending.content);

    await runFixers(
      fixers,
      { relativePath: target.relativePath, file: scratch },
      { root: target.place.checkout, runner: options.runner, deadline },
    );

    return rewriteOf(pending, readFileSync(scratch, "utf8"), target, input.toolInput);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function rewriteOf(
  pending: PendingWrite,
  fixed: string,
  target: Target,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- tool_input is the tool's own shape, handed back whole as updatedInput: only the fields named here are read.
  toolInput: Record<string, unknown>,
): Verdict {
  // A fix that undoes the edit would yield an Edit whose old_string equals its new_string, which the tool rejects.
  if (fixed === pending.content || (pending.kind === "edit" && fixed === pending.current)) {
    return ALLOW;
  }

  const updatedInput =
    pending.kind === "write"
      ? { ...toolInput, content: fixed }
      : {
          file_path: target.filePath,
          old_string: pending.current,
          new_string: fixed,
          replace_all: false,
        };

  return {
    kind: "rewrite",
    updatedInput,
    text: `agent-hooks: fixed and formatted ${target.relativePath} before writing`,
  };
}

/** The content the tool is about to leave in the file, applied in memory the way the tool does. */
function pendingWrite(
  toolName: string | undefined,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- tool_input is the tool's own shape: only the fields of the tool named here are read.
  toolInput: Record<string, unknown>,
  absolute: string,
): PendingWrite | null {
  if (toolName === "Write") {
    const content = stringField(toolInput, "content");

    return content === undefined || content === "" ? null : { kind: "write", content };
  }

  if (toolName !== "Edit" || !existsSync(absolute)) {
    return null;
  }

  const oldString = stringField(toolInput, "old_string");
  const newString = stringField(toolInput, "new_string");

  if (oldString === undefined || oldString === "" || newString === undefined) {
    return null;
  }

  const current = readFileSync(absolute, "utf8");
  const parts = current.split(oldString);
  const matches = parts.length - 1;

  if (matches === 0 || (matches > 1 && toolInput["replace_all"] !== true)) {
    return null;
  }

  return { kind: "edit", content: parts.join(newString), current };
}
