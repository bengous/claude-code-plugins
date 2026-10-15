#!/usr/bin/env bun
import { parseArgs } from "node:util";

import { ConfigError, loadConfig } from "./config.ts";
import { initConfig, runDoctor } from "./doctor.ts";
import type { Handler, HookKind } from "./hook.ts";
import { isHarness, isHookKind, readPayload, runHook } from "./hook.ts";
import { runPostEdit, runPreEdit } from "./pre-edit.ts";
import { findRoot } from "./scope.ts";
import { runSessionStart } from "./session-start.ts";
import { runStop } from "./stop.ts";
import { runVerify } from "./verify.ts";

const USAGE = [
  "usage:",
  "  agent-hooks <session-start|pre-edit|post-edit|stop> [--harness claude|codex]   (payload on stdin)",
  "  agent-hooks verify [--all] [files...]",
  "  agent-hooks doctor [--config <file>]",
  "  agent-hooks init --print",
].join("\n");

const HANDLERS: Readonly<Record<HookKind, Handler>> = {
  "session-start": runSessionStart,
  "pre-edit": runPreEdit,
  "post-edit": runPostEdit,
  stop: runStop,
};

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      harness: { type: "string", default: "claude" },
      all: { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      config: { type: "string" },
    },
    allowPositionals: true,
  });

  const [command = "", ...rest] = positionals;

  if (isHookKind(command)) {
    if (!isHarness(values.harness)) {
      console.error(`agent-hooks: unknown harness "${values.harness}"`);

      return 0;
    }

    const output = await runHook({
      hook: command,
      harness: values.harness,
      payload: await readPayload(),
      handler: HANDLERS[command],
    });

    if (output !== null) {
      await Bun.write(Bun.stdout, `${output}\n`);
    }

    return 0;
  }

  switch (command) {
    case "verify": {
      return verify(values.all, rest);
    }

    case "doctor": {
      return values.config === undefined
        ? runDoctor({ cwd: process.cwd() })
        : runDoctor({ cwd: process.cwd(), configFile: values.config });
    }

    case "init": {
      return init(values.print);
    }

    default: {
      console.error(USAGE);

      return 2;
    }
  }
}

async function verify(all: boolean, files: readonly string[]): Promise<number> {
  const root = findRoot(process.cwd());

  if (root === null) {
    console.error(`agent-hooks: no .claude/agent-hooks.jsonc above ${process.cwd()}`);

    return 1;
  }

  try {
    const report = await runVerify({ root, config: loadConfig(root), all, files });

    return report.exitCode;
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : `agent-hooks: ${String(error)}`);

    return 1;
  }
}

function init(print: boolean): number {
  if (!print) {
    console.error("agent-hooks init prints only: pass --print and write the file yourself");

    return 2;
  }

  process.stdout.write(initConfig(process.cwd()));

  return 0;
}

// A spawn still running past the deadline must not keep the process alive past the harness timeout.
process.exit(await main(process.argv.slice(2)));
