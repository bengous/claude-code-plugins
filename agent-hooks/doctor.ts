import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { SCRATCH_PREFIX, checkoutOf, takePhoto, trackedFiles } from "./checkout.ts";
import { isExcluded, matchesFilter, pkgOf, resolveArgv } from "./command.ts";
import type { Config, Fixer } from "./config.ts";
import { CONFIG_RELATIVE_PATH, ConfigError, loadConfig } from "./config.ts";
import type { Deadline, RunResult, Runner } from "./core/util/exec.ts";
import { deadlineIn, outputOf, run } from "./core/util/exec.ts";
import { isRecord, parseJsonc, recordField, stringField } from "./core/util/json.ts";
import { runFixer } from "./fixers.ts";
import { PROBE_TIMEOUT_MS } from "./hook.ts";
import { messageOf } from "./lib/platform/pure.ts";
import { latestMainState } from "./state.ts";

const PLUGIN_ID_PREFIX = "agent-hooks@";

/** The files a fixer is tried on: one per file extension, this many at most. */
const PROBES_PER_FIXER = 5;

/** What the whole probe pass may take: the fixers left when it runs out are named, not tried. */
const PROBE_BUDGET_MS = 60_000;

const GIT_TIMEOUT_MS = 30_000;

/**
 * The hook a command of the kit runs, called as `agent-hooks <hook>` or `bun ".../agent-hooks.ts" <hook>`: the hook
 * name is a whole word, so `agent-hooks stop-gates` is none.
 */
const KIT_COMMAND = /agent-hooks(?:\.ts)?["']?\s+(stop|pre-edit|session-start)(?=\s|["']|$)/u;

export type DoctorOptions = {
  readonly cwd: string;
  readonly configFile?: string;
  readonly print?: (line: string) => void;
  readonly home?: string;
  readonly runner?: Runner;
  readonly probeBudgetMs?: number;
};

type Check = { readonly ok: boolean; readonly line: string };

/**
 * The checkout, the config's validity, each fixer's and lane's program, each fixer tried on a few tracked files, the
 * Claude Code wiring, a photo's timing and the last Stop. Returns 1 when a program is missing, a fixer fails or the
 * config does not load.
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const print = options.print ?? console.log;

  try {
    return await diagnose(options, print);
  } catch (error) {
    print(error instanceof ConfigError ? error.message : `agent-hooks: ${messageOf(error)}`);

    return 1;
  }
}

async function diagnose(options: DoctorOptions, print: (line: string) => void): Promise<number> {
  const checkout = checkoutOf(options.cwd);

  if (checkout === null) {
    print(`MISSING checkout: ${options.cwd} lies in no git checkout`);

    return 1;
  }

  print(`checkout: ${checkout}`);

  const file =
    options.configFile === undefined
      ? path.join(checkout, CONFIG_RELATIVE_PATH)
      : path.resolve(options.cwd, options.configFile);

  if (options.configFile === undefined && !existsSync(file)) {
    print(`MISSING config: ${file}, so every hook of the kit exits at once here`);

    return 1;
  }

  const config = loadConfig(file);
  print(`ok      config: ${file}`);
  const home = options.home ?? process.env["HOME"] ?? homedir();
  const runner = options.runner ?? run;
  const tracked = trackedFiles(checkout, deadlineIn(GIT_TIMEOUT_MS));

  const fixers = config.fixers.map((fixer) => {
    const files = probeFiles(fixer, config, tracked);

    return { fixer, files, check: checkFixer(fixer, files, checkout) };
  });

  const checks = [
    ...fixers.map(({ check }) => check),
    ...config.lanes.map((lane) => checkCommand(`lane ${lane.name}`, lane.run, checkout, checkout)),
    ...(await probeFixers(
      fixers.filter(({ check }) => check.ok),
      checkout,
      runner,
      options.probeBudgetMs ?? PROBE_BUDGET_MS,
    )),
    claudeWiring([
      path.join(home, ".claude", "settings.json"),
      path.join(checkout, ".claude", "settings.json"),
      path.join(checkout, ".claude", "settings.local.json"),
    ]),
  ];

  for (const check of checks) {
    print(check.line);
  }

  const started = Date.now();
  const photo = takePhoto(checkout, deadlineIn(GIT_TIMEOUT_MS));
  print(`photo: ${Object.keys(photo.files).length} dirty files in ${Date.now() - started} ms`);
  const lastRun = latestMainState(checkout)?.lastRun ?? null;

  print(
    lastRun === null
      ? "last stop: none"
      : `last stop: ${lastRun.ms} ms ${JSON.stringify(lastRun.lanes)}`,
  );

  return checks.every((check) => check.ok) ? 0 : 1;
}

/**
 * A fixer's program, resolved as the hooks resolve it: from the package of the file being fixed. It is MISSING only
 * when it resolves neither from the checkout nor from the package of any file it would be tried on.
 */
function checkFixer(fixer: Fixer, files: readonly string[], checkout: string): Check {
  const label = `fixer ${fixer.name}`;
  const pkgs = [...new Set([checkout, ...files.map((file) => pkgOf(checkout, file))])];
  const checks = pkgs.map((pkg) => checkCommand(label, fixer.run.command, checkout, pkg, checkout));

  return checks.find((check) => check.ok) ?? checks[0] ?? { ok: false, line: `MISSING ${label}` };
}

/** `runsFrom` is the directory the command runs in, where `bun run` reads its package scripts: a fixer's is the top. */
function checkCommand(
  label: string,
  command: string,
  root: string,
  pkg: string,
  runsFrom = pkg,
): Check {
  const argv = resolveArgv(command, { root, pkg, file: "", path: "", files: [] });

  if (argv.kind === "missing") {
    return {
      ok: false,
      line: `MISSING ${label}: ${argv.program === "" ? "empty command" : argv.program}`,
    };
  }

  const bunRun = bunRunScript(argv.argv, runsFrom);

  if (bunRun !== null && !hasPackageScript(bunRun.dir, bunRun.script)) {
    return {
      ok: false,
      line: `MISSING ${label}: no "${bunRun.script}" script in ${path.join(bunRun.dir, "package.json")}`,
    };
  }

  return { ok: true, line: `ok      ${label}: ${argv.argv[0]}` };
}

type BunRun = { readonly dir: string; readonly script: string };

/** The script and package dir of a `bun run [--cwd dir] <script>` command, or null for any other command. */
function bunRunScript(argv: readonly string[], root: string): BunRun | null {
  if (path.basename(argv[0] ?? "") !== "bun" || argv[1] !== "run") {
    return null;
  }

  const rest = argv.slice(2);
  const cwdIndex = rest.indexOf("--cwd");
  const dir = cwdIndex === -1 ? root : path.resolve(root, rest[cwdIndex + 1] ?? "");
  const script = cwdIndex === -1 ? rest[0] : rest[cwdIndex + 2];

  return script === undefined || script.startsWith("-") ? null : { dir, script };
}

function hasPackageScript(root: string, script: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

    return isRecord(parsed) && script in (recordField(parsed, "scripts") ?? {});
  } catch {
    return false;
  }
}

/**
 * Each fixer whose program resolves, tried on a copy of a few tracked files it selects, as pre-edit runs it: the copy
 * in a scratch directory beside the real file. A failure here is what the hooks keep silent, a formatter handed a
 * file its own ignore file excludes among them.
 */
async function probeFixers(
  fixers: readonly { readonly fixer: Fixer; readonly files: readonly string[] }[],
  checkout: string,
  runner: Runner,
  budgetMs: number,
): Promise<Check[]> {
  const budget = deadlineIn(budgetMs);
  const checks: Check[] = [];
  const untried: string[] = [];

  for (const { fixer, files } of fixers) {
    if (budget.remaining() === 0) {
      untried.push(fixer.name);
    } else {
      checks.push(...(await probeFixer(fixer, files, checkout, runner, budget)));
    }
  }

  if (untried.length > 0) {
    checks.push({
      ok: true,
      line: `WARN    fixers not tried, the ${budgetMs} ms the probes may take ran out: ${untried.join(", ")}`,
    });
  }

  return checks;
}

/** The first tracked file of each extension the fixer selects, the config's excludes left out. */
function probeFiles(fixer: Fixer, config: Config, tracked: readonly string[]): string[] {
  const byExtension = new Map<string, string>();

  for (const relativePath of tracked) {
    const extension = path.extname(relativePath);

    if (
      !byExtension.has(extension) &&
      matchesFilter(fixer, relativePath) &&
      !isExcluded(config.exclude, relativePath)
    ) {
      byExtension.set(extension, relativePath);
    }
  }

  return [...byExtension.values()].slice(0, PROBES_PER_FIXER);
}

async function probeFixer(
  fixer: Fixer,
  files: readonly string[],
  checkout: string,
  runner: Runner,
  budget: Deadline,
): Promise<Check[]> {
  if (files.length === 0) {
    return [{ ok: true, line: `ok      fixer ${fixer.name}: no tracked file to try it on` }];
  }

  const failures: Check[] = [];
  const tried: string[] = [];

  for (const relativePath of files) {
    if (budget.remaining() === 0) {
      break;
    }

    tried.push(relativePath);
    const absolute = path.join(checkout, relativePath);
    const scratchDir = mkdtempSync(path.join(path.dirname(absolute), SCRATCH_PREFIX));
    const scratch = path.join(scratchDir, path.basename(absolute));

    try {
      copyFileSync(absolute, scratch);

      const result = await runFixer(
        fixer,
        { relativePath, file: scratch },
        {
          root: checkout,
          runner,
          deadline: deadlineIn(Math.min(PROBE_TIMEOUT_MS, budget.remaining())),
        },
      );

      if (!(result.kind === "exited" && result.code === 0)) {
        failures.push(
          // A `loop` fixer is a linter that fixes what it can: it exits non-zero on a finding it leaves in the file.
          // One that runs out of time is no finding: it would stall every edit.
          fixer.loop && result.kind === "exited"
            ? {
                ok: true,
                line: `WARN    fixer ${fixer.name} leaves a finding or fails on ${relativePath}: ${probeFailure(result)}`,
              }
            : {
                ok: false,
                line: `FAIL    fixer ${fixer.name} fails on ${relativePath}: ${probeFailure(result)}`,
              },
        );
      }
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    return failures;
  }

  return [
    {
      ok: true,
      line:
        tried.length === 0
          ? `WARN    fixer ${fixer.name} not tried, the time the probes may take ran out`
          : `ok      fixer ${fixer.name} runs on ${tried.join(", ")}`,
    },
  ];
}

/**
 * The first line of a failed run's output and how it ended. `bun run` first echoes the script it runs, `$ <command>`:
 * that line says nothing of the failure.
 */
function probeFailure(result: RunResult): string {
  const firstLine =
    outputOf(result)
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith("$ ")) ?? "(no output)";

  switch (result.kind) {
    case "exited": {
      return `${firstLine} (exit ${result.code})`;
    }

    case "timedOut": {
      return `${firstLine} (timed out after ${result.timeoutMs} ms)`;
    }

    case "missing": {
      return firstLine;
    }

    default: {
      const unreachable: never = result;
      throw new Error(`unhandled result: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** What a settings file says about the kit: the plugins it enables or disables, and the kit hooks it declares. */
type SettingsRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "read";
      readonly plugins: ReadonlyMap<string, boolean>;
      readonly declaresKitHook: boolean;
    };

function readSettings(file: string): SettingsRead {
  if (!existsSync(file)) {
    return { kind: "missing" };
  }

  let document: unknown;

  try {
    document = parseJsonc(readFileSync(file, "utf8"));
  } catch {
    return { kind: "unreadable" };
  }

  if (!isRecord(document)) {
    return { kind: "unreadable" };
  }

  const plugins = new Map<string, boolean>();

  for (const [id, enabled] of Object.entries(recordField(document, "enabledPlugins") ?? {})) {
    if (enabled === true || enabled === false) {
      plugins.set(id, enabled);
    }
  }

  const declaresKitHook = Object.values(recordField(document, "hooks") ?? {}).some((groups) =>
    (Array.isArray(groups) ? groups : [])
      .flatMap((group) => (isRecord(group) && Array.isArray(group["hooks"]) ? group["hooks"] : []))
      .some((hook) => KIT_COMMAND.test((isRecord(hook) ? stringField(hook, "command") : "") ?? "")),
  );

  return { kind: "read", plugins, declaresKitHook };
}

/**
 * Claude Code runs the kit from the enabled plugin's `hooks/hooks.json`; a hook a settings file also declares runs
 * twice. `files` go from the lowest scope to the highest (user, project, local): the last one that names the plugin
 * decides whether it is enabled. A WARN never fails the doctor.
 */
export function claudeWiring(files: readonly string[]): Check {
  const plugins = new Map<string, boolean>();
  const hookFiles: string[] = [];

  for (const file of files) {
    const read = readSettings(file);

    if (read.kind === "unreadable") {
      return { ok: true, line: `WARN    claude wiring: ${file} unreadable` };
    }

    if (read.kind === "read") {
      for (const [id, enabled] of read.plugins) {
        plugins.set(id, enabled);
      }

      if (read.declaresKitHook) {
        hookFiles.push(file);
      }
    }
  }

  const plugin = [...plugins].find(
    ([id, enabled]) => id.startsWith(PLUGIN_ID_PREFIX) && enabled,
  )?.[0];

  if (plugin !== undefined && hookFiles.length > 0) {
    return {
      ok: true,
      line: `WARN    claude wiring: plugin ${plugin} and a hook in ${hookFiles.join(", ")} both run the kit, so each hook runs twice: remove the one in ${hookFiles.join(", ")}`,
    };
  }

  if (plugin !== undefined) {
    return { ok: true, line: `ok      claude wiring: plugin ${plugin}` };
  }

  return {
    ok: true,
    line:
      hookFiles.length > 0
        ? `WARN    claude wiring: ${hookFiles.join(", ")} runs the kit without its plugin: enable the agent-hooks plugin and remove those hooks`
        : "WARN    claude wiring: the agent-hooks plugin is not enabled",
  };
}
