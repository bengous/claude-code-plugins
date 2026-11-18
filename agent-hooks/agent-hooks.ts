#!/usr/bin/env bun
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { placeOf, realPathOf } from "./checkout.ts";
import { ConfigError } from "./config.ts";
import { run } from "./core/util/exec.ts";
import { runDoctor } from "./doctor.ts";
import type { Handler, HookKind, HookOptions, Input } from "./hook.ts";
import { encode, isHookKind, parseInput, readPayload } from "./hook.ts";
import { messageOf } from "./lib/platform/pure.ts";
import { formatNoise, measureNoise } from "./noise.ts";
import { runPreEdit } from "./pre-edit.ts";
import { runSessionStart } from "./session-start.ts";
import { runStop } from "./stop.ts";
import { runVerify } from "./verify.ts";

const USAGE = [
  "usage:",
  "  agent-hooks <session-start|pre-edit|stop>   (payload on stdin)",
  "  agent-hooks verify [--all] [files...]",
  "  agent-hooks doctor [--config <file>]",
  "  agent-hooks noise [--days N]",
].join("\n");

const DEFAULT_NOISE_DAYS = 7;

/** Never 2: a harness reads that exit from a hook as a block, and a wiring that names an unknown command must not block. */
const USAGE_ERROR = 1;

const HANDLERS: Readonly<Record<HookKind, Handler>> = {
  "session-start": runSessionStart,
  "pre-edit": runPreEdit,
  stop: runStop,
};

/**
 * One hook: its handler run on the payload, its verdict encoded. Returns the line to print, or null for none. Never
 * throws: a hook's own failure goes to stderr and lets Claude Code carry on.
 */
export async function runHook(
  hook: HookKind,
  input: Input,
  options: HookOptions,
): Promise<string | null> {
  try {
    const verdict = await HANDLERS[hook](input, options);

    return verdict === null ? null : encode(verdict);
  } catch (error) {
    console.error(`agent-hooks: ${hook}: ${messageOf(error)}`);

    return null;
  }
}

function parsedArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      all: { type: "boolean", default: false },
      config: { type: "string" },
      days: { type: "string" },
    },
    allowPositionals: true,
  });
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parsedArgs>;

  try {
    parsed = parsedArgs(argv);
  } catch (error) {
    console.error(`agent-hooks: ${messageOf(error)}\n${USAGE}`);

    return USAGE_ERROR;
  }

  const { values, positionals } = parsed;

  const [command = "", ...rest] = positionals;

  if (isHookKind(command)) {
    const input = parseInput(await readPayload());

    if (input === null) {
      console.error("agent-hooks: the payload on stdin is no JSON object with a session_id");

      return 0;
    }

    const output = await runHook(command, input, { runner: run, now: Date.now() });

    if (output !== null) {
      await Bun.write(Bun.stdout, `${output}\n`);
    }

    return 0;
  }

  const cwd = realPathOf(process.cwd());

  switch (command) {
    case "verify": {
      return verify(cwd, values.all, rest);
    }

    case "doctor": {
      return runDoctor(values.config === undefined ? { cwd } : { cwd, configFile: values.config });
    }

    case "noise": {
      return noise(values.days);
    }

    default: {
      console.error(USAGE);

      return USAGE_ERROR;
    }
  }
}

async function verify(cwd: string, all: boolean, files: readonly string[]): Promise<number> {
  const place = placeOf(cwd);

  if (place === null) {
    console.error(`agent-hooks: no .claude/agent-hooks.jsonc at the top of the checkout of ${cwd}`);

    return 1;
  }

  try {
    return await runVerify({ place, cwd, all, files });
  } catch (error) {
    console.error(
      error instanceof ConfigError ? error.message : `agent-hooks: ${messageOf(error)}`,
    );

    return 1;
  }
}

async function noise(days: string | undefined): Promise<number> {
  if (days !== undefined && !/^[1-9]\d*$/u.test(days)) {
    console.error(`agent-hooks: --days expects a positive whole number, not "${days}"`);

    return USAGE_ERROR;
  }

  const configDir = process.env["CLAUDE_CONFIG_DIR"];

  const projectsDir = path.join(
    configDir !== undefined && configDir !== ""
      ? configDir
      : path.join(process.env["HOME"] ?? homedir(), ".claude"),
    "projects",
  );

  const report = await measureNoise({
    projectsDir,
    days: days === undefined ? DEFAULT_NOISE_DAYS : Number(days),
  });

  process.stdout.write(formatNoise(report));

  return 0;
}

if (import.meta.main) {
  // A spawn still running past the deadline must not keep the process alive past Claude Code's timeout.
  process.exit(await main(process.argv.slice(2)));
}
