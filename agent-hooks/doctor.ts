import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Config, Fixer, Lane } from "./config.ts";
import { ConfigError, configPath, expandCommand, loadConfig } from "./config.ts";
import { resolveProgram } from "./exec.ts";
import { isRecord, recordField } from "./json.ts";
import { findRoot, takePhoto } from "./scope.ts";
import { latestStateForRoot } from "./state.ts";
import { runVerify } from "./verify.ts";

export const CODEX_SYSTEM_CONFIG = "/etc/codex/config.toml";

export type DoctorOptions = {
  readonly cwd: string;
  readonly configFile?: string;
  readonly print?: (line: string) => void;
  readonly home?: string;
};

type Check = { readonly ok: boolean; readonly line: string };

/** Root, merged config, every command resolved, the global wiring, a photo timing, the last Stop, then a verify. */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const print = options.print ?? console.log;
  const home = options.home ?? process.env["HOME"] ?? homedir();
  const root = options.configFile === undefined ? findRoot(options.cwd) : path.resolve(options.cwd);

  if (root === null) {
    print(`MISSING .claude/agent-hooks.jsonc above ${options.cwd}`);

    return 1;
  }

  print(`root: ${root}`);
  let config: Config;

  try {
    config = loadConfig(
      root,
      options.configFile === undefined ? configPath(root) : path.resolve(options.configFile),
    );
  } catch (error) {
    print(error instanceof ConfigError ? error.message : `agent-hooks: ${String(error)}`);

    return 1;
  }

  print("config (merged):");
  print(JSON.stringify(config, null, 2));

  const checks = [
    ...config.preEdit.fixers.map((fixer) => checkFixer(fixer, root)),
    ...config.stop.fixers
      .filter((fixer) => !config.preEdit.fixers.includes(fixer))
      .map((fixer) => checkFixer(fixer, root)),
    ...config.stop.lanes.map((lane) => checkLane(lane, root)),
    checkWiring("claude", path.join(home, ".claude", "settings.json")),
    checkWiring("codex", CODEX_SYSTEM_CONFIG),
  ];

  for (const check of checks) {
    print(check.line);
  }

  const started = Date.now();
  const photo = takePhoto(root);
  print(
    photo === null
      ? "photo: git status failed"
      : `photo: ${Object.keys(photo.files).length} dirty files in ${Date.now() - started} ms`,
  );
  const lastRun = latestStateForRoot(root)?.lastRun ?? null;
  print(
    lastRun === null
      ? "last stop: none"
      : `last stop: ${lastRun.ms} ms ${JSON.stringify(lastRun.lanes)}`,
  );
  print("verify:");
  const report = await runVerify({ root, config, all: false, files: [], print });

  return checks.some((check) => !check.ok) || report.exitCode !== 0 ? 1 : 0;
}

function checkFixer(fixer: Fixer, root: string): Check {
  if (fixer.disabled) {
    return { ok: true, line: `ok      fixer ${fixer.name}: disabled` };
  }

  return checkCommand(`fixer ${fixer.name}`, fixer.file ?? fixer.stdin ?? "", root);
}

function checkLane(lane: Lane, root: string): Check {
  if (lane.disabled) {
    return { ok: true, line: `ok      lane ${lane.name}: disabled` };
  }

  return checkCommand(`lane ${lane.name}`, lane.run, root);
}

function checkCommand(label: string, command: string, root: string): Check {
  const argv = expandCommand(command, { root, pkg: root, file: "", path: "", files: [] });

  if (argv === null) {
    return { ok: false, line: `MISSING ${label}: empty command` };
  }

  const program = resolveProgram(argv[0], root, root);

  if (program === null) {
    return { ok: false, line: `MISSING ${label}: ${argv[0]}` };
  }

  const bunRun = bunRunScript(argv, root);

  if (bunRun !== null && !hasPackageScript(bunRun.dir, bunRun.script)) {
    return {
      ok: false,
      line: `MISSING ${label}: no "${bunRun.script}" script in ${path.join(bunRun.dir, "package.json")}`,
    };
  }

  return { ok: true, line: `ok      ${label}: ${program}` };
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

function checkWiring(harness: "claude" | "codex", file: string): Check {
  try {
    const wired = readFileSync(file, "utf8").includes("agent-hooks stop");

    return {
      ok: true,
      line: wired
        ? `ok      ${harness} wiring: ${file}`
        : `WARN    ${harness} wiring: ${file} has no agent-hooks stop hook`,
    };
  } catch {
    return { ok: true, line: `WARN    ${harness} wiring: ${file} unreadable` };
  }
}

const SKIPPED_DIRS = new Set(["node_modules", "target", ".git"]);

/** The JSONC a repo would start from, read from what its tree holds; printed, never written. */
export function initConfig(root: string): string {
  const presets: string[] = [];
  const lanesOff: string[] = [];

  if (existsSync(path.join(root, "package.json"))) {
    presets.push("ts");

    for (const script of ["typecheck", "test"]) {
      if (!hasPackageScript(root, script)) {
        lanesOff.push(script);
      }
    }
  }

  if (hasFile(root, (name) => name === "Cargo.toml")) {
    presets.push("rust");
  }

  if (hasFile(root, (name) => name.endsWith(".sh"))) {
    presets.push("shell");
  }

  const lanes = lanesOff.map((lane) => `      "${lane}": { "disabled": true },`);

  const stop =
    lanes.length === 0 ? [] : ['  "stop": {', '    "lanes": {', ...lanes, "    },", "  },"];

  const lines = [
    "{",
    `  "presets": ${JSON.stringify(presets)},`,
    ...preEditLines(root),
    ...stop,
    "}",
  ];

  return `${lines.join("\n")}\n`;
}

/** rustfmt reads stdin without a Cargo.toml to tell the edition, so a root manifest's edition is spelled out. */
function preEditLines(root: string): string[] {
  const edition = rustEdition(root);

  if (edition === null) {
    return ['  "pre-edit": { "exclude": [] },'];
  }

  return [
    '  "pre-edit": {',
    '    "exclude": [],',
    `    "fixers": { "rustfmt": { "stdin": "rustfmt --edition ${edition}" } },`,
    "  },",
  ];
}

function rustEdition(root: string): string | null {
  try {
    return (
      /^edition\s*=\s*"(\d{4})"/mu.exec(readFileSync(path.join(root, "Cargo.toml"), "utf8"))?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

function hasFile(dir: string, matches: (name: string) => boolean): boolean {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) {
      continue;
    }

    const entry = path.join(dir, name);

    try {
      if (statSync(entry).isDirectory() ? hasFile(entry, matches) : matches(name)) {
        return true;
      }
    } catch {
      // A broken symlink is not a file.
    }
  }

  return false;
}
