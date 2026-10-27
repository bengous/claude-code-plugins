import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { expandCommand } from "./command.ts";
import type { Config, Fixer, Lane } from "./config.ts";
import { configPath, loadConfig } from "./config.ts";
import { resolveProgram } from "./exec.ts";
import { isRecord, parseJsonc, recordField, stringField } from "./json.ts";
import type { ReviewProfile } from "./profile.ts";
import { ConfigError } from "./reader.ts";
import { checkoutOf, findRoot, git, takePhoto } from "./scope.ts";
import { latestStateForCheckout, rootRecord } from "./state.ts";
import { runVerify } from "./verify.ts";

export const CODEX_SYSTEM_CONFIG = "/etc/codex/config.toml";

const PLUGIN_ID_PREFIX = "agent-hooks@";

/**
 * The hook a command of the kit runs, called as `agent-hooks <hook>` or `bun ".../agent-hooks.ts" <hook>`: the hook
 * name is a whole word, so `agent-hooks stop-gates` is none.
 */
const KIT_COMMAND =
  /agent-hooks(?:\.ts)?["']?\s+(stop|pre-edit|post-edit|session-start|pre-bash)(?=\s|["']|$)/u;

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
    claudeWiring([
      path.join(home, ".claude", "settings.json"),
      path.join(root, ".claude", "settings.json"),
      path.join(root, ".claude", "settings.local.json"),
    ]),
    codexWiring([CODEX_SYSTEM_CONFIG, path.join(home, ".codex", "config.toml")]),
  ];

  for (const check of checks) {
    print(check.line);
  }

  const checkout = checkoutOf(root);

  if (checkout === null) {
    print(
      `MISSING checkout: ${root} is outside git, so the kit photographs nothing and the Stop checks nothing here`,
    );

    return 1;
  }

  print(`ok      checkout: ${checkout}`);

  const tracked = git(checkout, ["ls-files", "-z"]);

  if (tracked === null) {
    print("WARN    review: git ls-files failed, so no risky glob was checked");
  } else {
    for (const check of reviewGlobs(config.profile.review, tracked.split("\0"))) {
      print(check.line);
    }
  }

  const started = Date.now();
  const photo = takePhoto(checkout);
  print(
    photo === null
      ? "photo: git status failed"
      : `photo: ${Object.keys(photo.files).length} dirty files in ${Date.now() - started} ms`,
  );
  const latest = latestStateForCheckout(checkout);
  const lastRun = latest === null ? null : rootRecord(latest, root).lastRun;
  print(
    lastRun === null
      ? "last stop: none"
      : `last stop: ${lastRun.ms} ms ${JSON.stringify(lastRun.lanes)}`,
  );
  print("verify:");
  const report = await runVerify({ root, cwd: root, config, all: false, files: [], print });

  return checks.some((check) => !check.ok) || report.exitCode !== 0 ? 1 : 0;
}

/** A WARN for each risky glob of `review` that matches none of the `tracked` paths: a typo guards nothing. */
export function reviewGlobs(review: ReviewProfile | null, tracked: readonly string[]): Check[] {
  if (review === null) {
    return [];
  }

  const unmatched = review.risky.filter(
    (glob) => !tracked.some((file) => new Bun.Glob(glob).match(file)),
  );

  if (unmatched.length === 0) {
    const count = review.risky.length;

    return [
      {
        ok: true,
        line: `ok      review: ${count} risky glob${count === 1 ? "" : "s"}, each matching a tracked file`,
      },
    ];
  }

  return unmatched.map((glob) => ({
    ok: true,
    line: `WARN    review: risky glob ${glob} matches no tracked file`,
  }));
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

/** What a settings file says about the kit: the plugins it enables or disables, and the kit hooks it declares. */
type SettingsRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "read";
      readonly plugins: ReadonlyMap<string, boolean>;
      readonly kitHooks: readonly string[];
      /** A kit `stop` hook declared under SubagentStop: the subagents' Stop. */
      readonly subagentStop: boolean;
    };

/** Reads a Claude Code settings file (JSON) or a Codex config (TOML); both shape hooks as `hooks[event][].hooks[]`. */
function readSettings(file: string, format: "json" | "toml"): SettingsRead {
  if (!existsSync(file)) {
    return { kind: "missing" };
  }

  let document: unknown;

  try {
    const text = readFileSync(file, "utf8");
    document = format === "json" ? parseJsonc(text) : Bun.TOML.parse(text);
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

  const declared = Object.entries(recordField(document, "hooks") ?? {}).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : [])
      .flatMap((group) => (isRecord(group) && Array.isArray(group["hooks"]) ? group["hooks"] : []))
      .flatMap((hook) => {
        const command = isRecord(hook) ? stringField(hook, "command") : undefined;
        const kitHook = command === undefined ? undefined : KIT_COMMAND.exec(command)?.[1];

        return kitHook === undefined ? [] : [{ event, kitHook }];
      }),
  );

  return {
    kind: "read",
    plugins,
    kitHooks: declared.map(({ kitHook }) => kitHook),
    subagentStop: declared.some(
      ({ event, kitHook }) => event === "SubagentStop" && kitHook === "stop",
    ),
  };
}

/**
 * Claude Code runs the kit from the enabled plugin's `hooks/hooks.json`, or from a hook a settings file declares; both
 * at once run every hook twice. `files` go from the lowest scope to the highest (user, project, local): the last one
 * that names the plugin decides whether it is enabled. A WARN never fails the doctor.
 */
export function claudeWiring(files: readonly string[]): Check {
  const plugins = new Map<string, boolean>();
  const hookFiles: string[] = [];
  const stopFiles: string[] = [];
  let subagentStop = false;

  for (const file of files) {
    const read = readSettings(file, "json");

    if (read.kind === "unreadable") {
      return { ok: true, line: `WARN    claude wiring: ${file} unreadable` };
    }

    if (read.kind === "missing") {
      continue;
    }

    for (const [id, enabled] of read.plugins) {
      plugins.set(id, enabled);
    }

    if (read.kitHooks.length > 0) {
      hookFiles.push(file);
    }

    if (read.kitHooks.includes("stop")) {
      stopFiles.push(file);
    }

    subagentStop ||= read.subagentStop;
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

  if (stopFiles.length > 0 && !subagentStop) {
    return {
      ok: true,
      line: `WARN    claude wiring: ${stopFiles.join(", ")} wires the Stop but no SubagentStop, so subagents go unchecked: enable the agent-hooks plugin, which wires both`,
    };
  }

  if (stopFiles.length > 0) {
    return { ok: true, line: `ok      claude wiring: ${stopFiles.join(", ")}` };
  }

  return {
    ok: true,
    line: "WARN    claude wiring: no agent-hooks Stop hook: enable the agent-hooks plugin",
  };
}

/** Codex reads its hooks from the system and the user config; the kit's Stop hook belongs in one of them. */
export function codexWiring(files: readonly string[]): Check {
  const wired = files.filter((file) => {
    const read = readSettings(file, "toml");

    return read.kind === "read" && read.kitHooks.includes("stop");
  });

  return wired.length === 0
    ? { ok: true, line: `WARN    codex wiring: no agent-hooks stop hook in ${files.join(" or ")}` }
    : { ok: true, line: `ok      codex wiring: ${wired.join(", ")}` };
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
