import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isExcluded } from "./config.ts";
import type { HookContext, Verdict } from "./hook.ts";
import { ALLOW } from "./hook.ts";
import { stringField } from "./json.ts";
import type { FixTarget } from "./lanes.ts";
import { runFixers, sequential } from "./lanes.ts";
import { extractApplyPatchPaths } from "./patch.ts";
import { SCRATCH_PREFIX, nearestDirectory, realPathOf, takePhoto, underRoot } from "./scope.ts";
import type { Photo } from "./state.ts";

type PendingWrite =
  | { readonly kind: "write"; readonly content: string }
  | { readonly kind: "edit"; readonly content: string; readonly current: string };

/**
 * Claude Code's edit hook, before the tool runs: hands the tool the content the fixers would leave, so the file is
 * written once and the agent has no rewrite to re-read. It never blocks: on any failure the tool runs as asked.
 * The first edit in a checkout the agent has no photo of photographs it first: the tree before that write is the
 * agent's baseline there, and the Stop measures that checkout too.
 */
export async function runPreEdit(context: HookContext): Promise<Verdict> {
  const { input, root, config, state } = context;
  const filePath = stringField(input.toolInput, "file_path");

  if (filePath === undefined) {
    return ALLOW;
  }

  const absolute = realPathOf(path.resolve(input.cwd ?? root, filePath));
  const relativePath = underRoot(root, absolute);

  if (relativePath === null) {
    return ALLOW;
  }

  state.photo ??= takePhoto(state.checkout);

  if (isExcluded(config.preEdit.exclude, relativePath)) {
    return ALLOW;
  }

  const pending = pendingWrite(input.toolName, input.toolInput, absolute);

  if (pending === null) {
    return ALLOW;
  }

  // Beside the real file, so a fixer finds the config and matches the overrides and ignores the real file would.
  const scratchDir = mkdtempSync(
    path.join(nearestDirectory(path.dirname(absolute)), SCRATCH_PREFIX),
  );

  const scratch = path.join(scratchDir, path.basename(absolute));

  try {
    writeFileSync(scratch, pending.content);

    const failures = await runFixers(
      config.preEdit.fixers,
      { relativePath, file: scratch },
      context,
    );

    if (failures.length > 0) {
      return { kind: "context", text: failures.join("\n\n") };
    }

    return rewriteOf(
      pending,
      readFileSync(scratch, "utf8"),
      filePath,
      input.toolInput,
      relativePath,
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function rewriteOf(
  pending: PendingWrite,
  styled: string,
  filePath: string,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- tool_input is the harness's per-tool shape, handed back whole as updatedInput: only the fields named here are read.
  toolInput: Record<string, unknown>,
  relativePath: string,
): Verdict {
  // A fix that undoes the edit would yield an Edit whose old_string equals its new_string, which the tool rejects.
  if (styled === pending.content || (pending.kind === "edit" && styled === pending.current)) {
    return ALLOW;
  }

  const updatedInput =
    pending.kind === "write"
      ? { ...toolInput, content: styled }
      : {
          file_path: filePath,
          old_string: pending.current,
          new_string: styled,
          replace_all: false,
        };

  return {
    kind: "rewrite",
    updatedInput,
    text: `agent-hooks: fixed and formatted ${relativePath} before writing`,
  };
}

/** The content the tool is about to leave in the file, applied in memory the way the tool does. */
function pendingWrite(
  toolName: string | undefined,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- tool_input is the harness's per-tool shape: only the fields of the tool named here are read.
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

/**
 * Codex's edit hook, after `apply_patch` ran: fixes and formats the files the patch touched, on disk. The first
 * patch in a checkout the agent has no photo of photographs it, the patched files left out: the hook runs after the
 * write, so the photo would otherwise hold them as the baseline.
 */
export async function runPostEdit(context: HookContext): Promise<Verdict> {
  const { input, root, config, state } = context;
  const command = stringField(input.toolInput, "command");
  const filePath = stringField(input.toolInput, "file_path");

  const candidates = [
    ...(command === undefined ? [] : extractApplyPatchPaths(command)),
    ...(filePath === undefined ? [] : [filePath]),
  ].map((candidate) => realPathOf(path.resolve(input.cwd ?? root, candidate)));

  state.photo ??= photoWithout(state.checkout, candidates);

  const targets = candidates.flatMap((absolute): FixTarget[] => {
    const relativePath = underRoot(root, absolute);

    return relativePath === null ||
      isExcluded(config.preEdit.exclude, relativePath) ||
      !existsSync(absolute)
      ? []
      : [{ relativePath, file: absolute }];
  });

  const failures: string[] = [];
  await sequential(targets, async (target: FixTarget) => {
    failures.push(...(await runFixers(config.preEdit.fixers, target, context)));
  });

  return failures.length === 0 ? ALLOW : { kind: "context", text: failures.join("\n\n") };
}

/** The checkout's photo with `patched` left out of it, so the files a patch already wrote count as changed. */
function photoWithout(checkout: string, patched: readonly string[]): Photo | null {
  const photo = takePhoto(checkout);

  if (photo === null) {
    return null;
  }

  const left = new Set(patched.flatMap((absolute) => underRoot(checkout, absolute) ?? []));

  return {
    ...photo,
    files: Object.fromEntries(
      Object.entries(photo.files).filter(([relativePath]) => !left.has(relativePath)),
    ),
  };
}
