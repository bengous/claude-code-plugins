#!/usr/bin/env bun
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, loadConfig } from "./config.ts";
import { initConfig, runDoctor } from "./doctor.ts";
import type { HookKind, HookRun } from "./hook.ts";
import { isHarness, isHookKind, readPayload, runHook } from "./hook.ts";
import { formatNoise, measureNoise } from "./noise.ts";
import { runPreBash } from "./pre-bash.ts";
import { runPostEdit, runPreEdit } from "./pre-edit.ts";
import { findRoot, realPathOf } from "./scope.ts";
import { runSessionStart } from "./session-start.ts";
import { runStop } from "./stop.ts";
import { runVerify } from "./verify.ts";

const USAGE = [
  "usage:",
  "  agent-hooks <session-start|pre-edit|post-edit|stop> [--harness claude|codex]   (payload on stdin)",
  "  agent-hooks pre-bash   (Claude Code PreToolUse Bash payload on stdin)",
  "  agent-hooks verify [--all] [files...]",
  "  agent-hooks doctor [--config <file>]",
  "  agent-hooks init --print",
  "  agent-hooks noise [--days N]",
].join("\n");

const DEFAULT_NOISE_DAYS = 7;

function hookRun(hook: HookKind): HookRun {
  switch (hook) {
    case "session-start": {
      return { hook, handler: runSessionStart };
    }

    case "pre-edit": {
      return { hook, handler: runPreEdit };
    }

    case "post-edit": {
      return { hook, handler: runPostEdit };
    }

    case "stop": {
      return { hook, handler: runStop };
    }

    default: {
      const unreachable: never = hook;
      throw new Error(`unhandled hook: ${String(unreachable)}`);
    }
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      harness: { type: "string", default: "claude" },
      all: { type: "boolean", default: false },
      print: { type: "boolean", default: false },
      config: { type: "string" },
      days: { type: "string" },
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
      ...hookRun(command),
      harness: values.harness,
      payload: await readPayload(),
    });

    if (output !== null) {
      await Bun.write(Bun.stdout, `${output}\n`);
    }

    return 0;
  }

  switch (command) {
    case "pre-bash": {
      const output = await runPreBash(await readPayload());

      if (output !== null) {
        await Bun.write(Bun.stdout, `${output}\n`);
      }

      return 0;
    }

    case "verify": {
      return verify(values.all, rest);
    }

    case "doctor": {
      const cwd = realPathOf(process.cwd());

      return values.config === undefined
        ? runDoctor({ cwd })
        : runDoctor({ cwd, configFile: values.config });
    }

    case "init": {
      return init(values.print);
    }

    case "noise": {
      return noise(values.days);
    }

    default: {
      console.error(USAGE);

      return 2;
    }
  }
}

async function verify(all: boolean, files: readonly string[]): Promise<number> {
  const cwd = realPathOf(process.cwd());
  const root = findRoot(cwd);

  if (root === null) {
    console.error(`agent-hooks: no .claude/agent-hooks.jsonc above ${cwd}`);

    return 1;
  }

  try {
    const report = await runVerify({
      root,
      cwd,
      config: loadConfig(root),
      all,
      files,
    });

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

function noise(days: string | undefined): number {
  if (days !== undefined && !/^[1-9]\d*$/u.test(days)) {
    console.error(`agent-hooks: --days expects a positive whole number, not "${days}"`);

    return 2;
  }

  const configDir = process.env["CLAUDE_CONFIG_DIR"];

  const projectsDir = path.join(
    configDir !== undefined && configDir !== ""
      ? configDir
      : path.join(process.env["HOME"] ?? homedir(), ".claude"),
    "projects",
  );

  const report = measureNoise({
    projectsDir,
    days: days === undefined ? DEFAULT_NOISE_DAYS : Number(days),
  });

  process.stdout.write(formatNoise(report));

  return 0;
}

// A spawn still running past the deadline must not keep the process alive past the harness timeout.
process.exit(await main(process.argv.slice(2)));
