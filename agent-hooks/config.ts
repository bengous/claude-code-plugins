/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- this module IS the parser of `.claude/agent-hooks.jsonc` and the presets: each typeof check validates one key and names its key path in the error, and nothing past `loadConfig` sees the document untyped. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Argv } from "./exec.ts";
import { isRecord, isStringArray, parseJsonc } from "./json.ts";

export const CONFIG_RELATIVE_PATH = path.join(".claude", "agent-hooks.jsonc");

/** The repo file as git names it in a tree: `/`-separated on every platform. */
export const CONFIG_GIT_PATH = path.posix.join(".claude", "agent-hooks.jsonc");

export const PRESETS_DIR = path.join(import.meta.dir, "presets");

export const DEFAULT_CAP = 3;

const DEFAULT_TIMEOUT_SECONDS = 60;

export type Takes = "files" | "project";

export type LaneCwd = "root" | "pkg";

export type LaneVerdict = "block" | "note";

export type Lane = {
  readonly name: string;
  readonly on: string;
  readonly exclude: readonly string[];
  readonly takes: Takes;
  readonly cwd: LaneCwd;
  readonly run: string;
  readonly verdict: LaneVerdict;
  readonly timeoutMs: number;
  readonly disabled: boolean;
};

export type Fixer = {
  readonly name: string;
  readonly on: string;
  readonly exclude: readonly string[];
  readonly file?: string;
  readonly stdin?: string;
  readonly loop: boolean;
  readonly disabled: boolean;
};

/** The branches a repository lands on: agents push to `trunk`, the human moves `release`. */
export type LandingProfile = { readonly trunk: string; readonly release: string };

/** The paths a change lands through only with a clean review verdict for exactly that change. */
export type ReviewProfile = { readonly risky: readonly string[] };

/** Whether the agents of a repository share its checkout, or each task takes a worktree of its own. */
export type WorktreeMode = "per-task" | "shared";

export type Profile = {
  readonly landing: LandingProfile | null;
  readonly review: ReviewProfile | null;
  readonly worktree: WorktreeMode;
};

export type Config = {
  readonly profile: Profile;
  readonly preEdit: { readonly exclude: readonly string[]; readonly fixers: readonly Fixer[] };
  readonly stop: {
    readonly cap: number;
    readonly fixers: readonly Fixer[];
    readonly lanes: readonly Lane[];
  };
};

export type Placeholders = {
  readonly root: string;
  readonly pkg: string;
  readonly file?: string;
  readonly path?: string;
  readonly files?: readonly string[];
};

export type PathFilter = { readonly on: string; readonly exclude: readonly string[] };

export class ConfigError extends Error {
  constructor(file: string, keyPath: string, message: string) {
    super(
      keyPath === ""
        ? `agent-hooks: ${file}: ${message}`
        : `agent-hooks: ${file}: ${keyPath}: ${message}`,
    );
    this.name = "ConfigError";
  }
}

type RawFixer = {
  on?: string;
  exclude?: string[];
  file?: string;
  stdin?: string;
  loop?: boolean;
  disabled?: boolean;
};

type RawLane = {
  on?: string;
  exclude?: string[];
  takes?: Takes;
  cwd?: LaneCwd;
  run?: string;
  verdict?: LaneVerdict;
  timeout?: number;
  disabled?: boolean;
};

type RawStopFixers = "pre-edit" | "none" | Map<string, RawFixer>;

type RawDocument = {
  readonly file: string;
  readonly presets: readonly string[];
  readonly profile: Profile;
  readonly preEdit: { exclude: string[]; fixers: Map<string, RawFixer> };
  readonly stop: { cap?: number; fixers?: RawStopFixers; lanes: Map<string, RawLane> };
};

type DocumentKind = "repo" | "preset";

type Reader = {
  readonly file: string;
  readonly record: Record<string, unknown>;
  readonly keyPath: string;
};

const DOCUMENT_KEYS = new Set(["presets", "extends", "profile", "pre-edit", "stop"]);

const PRESET_NAME = /^[a-z0-9-]+$/u;

const PROFILE_KEYS = new Set(["landing", "review", "worktree"]);

const LANDING_KEYS = new Set(["trunk", "release"]);

const REVIEW_KEYS = new Set(["risky"]);

const PRE_EDIT_KEYS = new Set(["exclude", "fixers"]);

const STOP_KEYS = new Set(["cap", "fixers", "lanes"]);

const FIXER_KEYS = new Set(["on", "exclude", "file", "stdin", "loop", "disabled"]);

const LANE_KEYS = new Set([
  "on",
  "exclude",
  "takes",
  "cwd",
  "run",
  "verdict",
  "timeout",
  "disabled",
]);

const LANE_PLACEHOLDERS = new Set(["{files}", "{root}", "{pkg}"]);

const FIXER_PLACEHOLDERS = new Set(["{file}", "{path}", "{root}", "{pkg}"]);

export function configPath(root: string): string {
  return path.join(root, CONFIG_RELATIVE_PATH);
}

export function presetPath(name: string): string {
  return path.join(PRESETS_DIR, `${name}.jsonc`);
}

/** Loads the repo file (or `configFile`), its presets and their `extends`, merges them in order and validates. */
export function loadConfig(root: string, configFile = configPath(root)): Config {
  const repo = readDocument(configFile, "repo");
  const documents: RawDocument[] = [];
  const loaded = new Set<string>();

  for (const preset of repo.presets) {
    collectPreset(preset, documents, loaded, repo.file);
  }

  documents.push(repo);

  return finalize(mergeDocuments(documents, repo), repo.file);
}

/**
 * `profile.landing` of the repo file alone: an error elsewhere in the file, another profile key included, leaves it
 * readable. Throws a ConfigError naming the key when the file does not parse or its landing is invalid.
 */
export function loadLanding(root: string, configFile = configPath(root)): LandingProfile | null {
  return readLanding(profileIn(configFile, readText(configFile)));
}

/**
 * `profile.review` alone, from `text`, the repo file as `file` names it (a path, or a commit's `<rev>:<path>`).
 * Throws a ConfigError naming the key when the text does not parse or its review is invalid.
 */
export function parseReview(file: string, text: string): ReviewProfile | null {
  return readReview(profileIn(file, text));
}

function profileIn(file: string, text: string): Reader {
  return child({ file, record: parseRecord(file, text), keyPath: "" }, "profile");
}

function collectPreset(
  name: string,
  documents: RawDocument[],
  loaded: Set<string>,
  requester: string,
): void {
  if (loaded.has(name)) {
    return;
  }

  loaded.add(name);

  if (!PRESET_NAME.test(name)) {
    throw new ConfigError(requester, "presets", `invalid preset name "${name}"`);
  }

  const file = presetPath(name);

  if (!existsSync(file)) {
    throw new ConfigError(requester, "presets", `unknown preset "${name}"`);
  }

  const document = readDocument(file, "preset");

  for (const parent of document.presets) {
    collectPreset(parent, documents, loaded, file);
  }

  documents.push(document);
}

function readDocument(file: string, kind: DocumentKind): RawDocument {
  const record = parseDocument(file);
  const presetsKey = kind === "repo" ? "presets" : "extends";
  const forbiddenKey = kind === "repo" ? "extends" : "presets";
  const root: Reader = { file, record, keyPath: "" };
  rejectUnknownKeys(root, DOCUMENT_KEYS);

  if (forbiddenKey in record) {
    throw new ConfigError(
      file,
      forbiddenKey,
      `a ${kind} file lists its presets under "${presetsKey}"`,
    );
  }

  return {
    file,
    presets: stringArray(root, presetsKey) ?? [],
    profile: readProfile(child(root, "profile")),
    preEdit: readPreEdit(child(root, "pre-edit")),
    stop: readStop(child(root, "stop")),
  };
}

function parseDocument(file: string): Record<string, unknown> {
  return parseRecord(file, readText(file));
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(
      file,
      "",
      `cannot read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseRecord(file: string, text: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new ConfigError(
      file,
      "",
      `invalid JSONC: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(file, "", "expected an object");
  }

  return parsed;
}

function keyPathOf(reader: Reader, key: string): string {
  return reader.keyPath === "" ? key : `${reader.keyPath}.${key}`;
}

/** The object under `key`, or an empty one when the key is absent. */
function child(reader: Reader, key: string): Reader {
  const value = reader.record[key];
  const keyPath = keyPathOf(reader, key);

  if (value === undefined) {
    return { file: reader.file, record: {}, keyPath };
  }

  if (!isRecord(value)) {
    throw new ConfigError(reader.file, keyPath, "expected an object");
  }

  return { file: reader.file, record: value, keyPath };
}

function rejectUnknownKeys(reader: Reader, known: ReadonlySet<string>): void {
  for (const key of Object.keys(reader.record)) {
    if (!known.has(key)) {
      throw new ConfigError(reader.file, keyPathOf(reader, key), "unknown key");
    }
  }
}

function stringArray(reader: Reader, key: string): string[] | undefined {
  const value = reader.record[key];

  if (value === undefined) {
    return undefined;
  }

  if (!isStringArray(value)) {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected an array of strings");
  }

  return value;
}

function string(reader: Reader, key: string): string | undefined {
  const value = reader.record[key];

  if (value !== undefined && typeof value !== "string") {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a string");
  }

  return value;
}

function boolean(reader: Reader, key: string): boolean | undefined {
  const value = reader.record[key];

  if (value !== undefined && typeof value !== "boolean") {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a boolean");
  }

  return value;
}

function seconds(reader: Reader, key: string): number | undefined {
  const value = reader.record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a number of seconds");
  }

  return value;
}

function oneOf<T extends string>(reader: Reader, key: string, values: readonly T[]): T | undefined {
  const value = reader.record[key];

  if (value === undefined) {
    return undefined;
  }

  const found = values.find((candidate) => candidate === value);

  if (found === undefined) {
    throw new ConfigError(reader.file, keyPathOf(reader, key), `expected ${values.join("|")}`);
  }

  return found;
}

function readProfile(reader: Reader): Profile {
  rejectUnknownKeys(reader, PROFILE_KEYS);

  return {
    landing: readLanding(reader),
    review: readReview(reader),
    worktree: oneOf(reader, "worktree", ["per-task", "shared"]) ?? "shared",
  };
}

function readLanding(profile: Reader): LandingProfile | null {
  if (profile.record["landing"] === undefined) {
    return null;
  }

  const landing = child(profile, "landing");
  rejectUnknownKeys(landing, LANDING_KEYS);
  const trunk = branch(landing, "trunk");
  const release = branch(landing, "release");

  if (trunk === release) {
    throw new ConfigError(profile.file, landing.keyPath, "trunk and release name one branch");
  }

  return { trunk, release };
}

function readReview(profile: Reader): ReviewProfile | null {
  if (profile.record["review"] === undefined) {
    return null;
  }

  const review = child(profile, "review");
  rejectUnknownKeys(review, REVIEW_KEYS);
  const risky = stringArray(review, "risky");

  const keyPath = keyPathOf(review, "risky");

  if (risky === undefined || risky.length === 0) {
    throw new ConfigError(review.file, keyPath, "expected a list of globs");
  }

  for (const glob of risky) {
    const anchor = ["./", "/"].find((prefix) => glob.startsWith(prefix));

    if (anchor !== undefined) {
      throw new ConfigError(
        review.file,
        keyPath,
        `"${glob}" starts with ${anchor}; a glob is relative to the repository root`,
      );
    }
  }

  return { risky };
}

function branch(reader: Reader, key: string): string {
  const value = string(reader, key);

  if (value === undefined || !/^[^\s:~^?*[\\]+$/u.test(value)) {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a branch name");
  }

  return value;
}

function readPreEdit(reader: Reader): RawDocument["preEdit"] {
  rejectUnknownKeys(reader, PRE_EDIT_KEYS);

  return {
    exclude: stringArray(reader, "exclude") ?? [],
    fixers: readFixers(child(reader, "fixers")),
  };
}

function readStop(reader: Reader): RawDocument["stop"] {
  rejectUnknownKeys(reader, STOP_KEYS);
  const stop: RawDocument["stop"] = { lanes: readLanes(child(reader, "lanes")) };
  const cap = reader.record["cap"];

  if (cap !== undefined) {
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) {
      throw new ConfigError(reader.file, keyPathOf(reader, "cap"), "expected a positive integer");
    }

    stop.cap = cap;
  }

  const fixers = reader.record["fixers"];

  if (fixers === "pre-edit" || fixers === "none") {
    stop.fixers = fixers;
  } else if (isRecord(fixers)) {
    stop.fixers = readFixers(child(reader, "fixers"));
  } else if (fixers !== undefined) {
    throw new ConfigError(
      reader.file,
      keyPathOf(reader, "fixers"),
      'expected "pre-edit", "none" or a table of fixers',
    );
  }

  return stop;
}

function readFixers(reader: Reader): Map<string, RawFixer> {
  const fixers = new Map<string, RawFixer>();

  for (const name of Object.keys(reader.record)) {
    const entry = child(reader, name);
    rejectUnknownKeys(entry, FIXER_KEYS);
    const fixer: RawFixer = {};
    const on = string(entry, "on");
    const exclude = stringArray(entry, "exclude");
    const file = string(entry, "file");
    const stdin = string(entry, "stdin");
    const loop = boolean(entry, "loop");
    const disabled = boolean(entry, "disabled");

    if (on !== undefined) {
      fixer.on = on;
    }

    if (exclude !== undefined) {
      fixer.exclude = exclude;
    }

    if (file !== undefined) {
      fixer.file = file;
    }

    if (stdin !== undefined) {
      fixer.stdin = stdin;
    }

    if (loop !== undefined) {
      fixer.loop = loop;
    }

    if (disabled !== undefined) {
      fixer.disabled = disabled;
    }

    fixers.set(name, fixer);
  }

  return fixers;
}

function readLanes(reader: Reader): Map<string, RawLane> {
  const lanes = new Map<string, RawLane>();

  for (const name of Object.keys(reader.record)) {
    const entry = child(reader, name);
    rejectUnknownKeys(entry, LANE_KEYS);
    const lane: RawLane = {};
    const on = string(entry, "on");
    const exclude = stringArray(entry, "exclude");
    const takes = oneOf(entry, "takes", ["files", "project"]);
    const cwd = oneOf(entry, "cwd", ["root", "pkg"]);
    const run = string(entry, "run");
    const verdict = oneOf(entry, "verdict", ["block", "note"]);
    const timeout = seconds(entry, "timeout");
    const disabled = boolean(entry, "disabled");

    if (on !== undefined) {
      lane.on = on;
    }

    if (exclude !== undefined) {
      lane.exclude = exclude;
    }

    if (takes !== undefined) {
      lane.takes = takes;
    }

    if (cwd !== undefined) {
      lane.cwd = cwd;
    }

    if (run !== undefined) {
      lane.run = run;
    }

    if (verdict !== undefined) {
      lane.verdict = verdict;
    }

    if (timeout !== undefined) {
      lane.timeout = timeout;
    }

    if (disabled !== undefined) {
      lane.disabled = disabled;
    }

    lanes.set(name, lane);
  }

  return lanes;
}

function mergeDocuments(documents: readonly RawDocument[], repo: RawDocument): RawDocument {
  const merged: RawDocument = {
    file: repo.file,
    presets: [],
    // A profile describes the repository, never a preset's language.
    profile: repo.profile,
    preEdit: { exclude: [], fixers: new Map() },
    stop: { lanes: new Map() },
  };

  for (const document of documents) {
    merged.preEdit.exclude = [...new Set([...merged.preEdit.exclude, ...document.preEdit.exclude])];
    mergeNamed(merged.preEdit.fixers, document.preEdit.fixers);
    mergeNamed(merged.stop.lanes, document.stop.lanes);

    if (document.stop.cap !== undefined) {
      merged.stop.cap = document.stop.cap;
    }

    if (document.stop.fixers !== undefined) {
      merged.stop.fixers = mergeStopFixers(merged.stop.fixers, document.stop.fixers);
    }
  }

  return merged;
}

function mergeNamed<T extends object>(
  target: Map<string, T>,
  source: ReadonlyMap<string, T>,
): void {
  for (const [name, entry] of source) {
    target.set(name, { ...target.get(name), ...entry });
  }
}

function mergeStopFixers(
  current: RawStopFixers | undefined,
  incoming: RawStopFixers,
): RawStopFixers {
  if (typeof incoming === "string" || current === undefined || typeof current === "string") {
    return incoming;
  }

  mergeNamed(current, incoming);

  return current;
}

function finalize(raw: RawDocument, file: string): Config {
  const preEditFixers = finalizeFixers(raw.preEdit.fixers, file, "pre-edit.fixers");

  return {
    profile: raw.profile,
    preEdit: { exclude: raw.preEdit.exclude, fixers: preEditFixers },
    stop: {
      cap: raw.stop.cap ?? DEFAULT_CAP,
      fixers: finalizeStopFixers(raw.stop.fixers, preEditFixers, file),
      lanes: finalizeLanes(raw.stop.lanes, file),
    },
  };
}

function finalizeStopFixers(
  raw: RawStopFixers | undefined,
  preEditFixers: Fixer[],
  file: string,
): Fixer[] {
  if (raw === undefined || raw === "pre-edit") {
    return preEditFixers;
  }

  if (raw === "none") {
    return [];
  }

  return finalizeFixers(raw, file, "stop.fixers");
}

function finalizeFixers(
  fixers: ReadonlyMap<string, RawFixer>,
  file: string,
  keyPath: string,
): Fixer[] {
  const result: Fixer[] = [];

  for (const [name, fixer] of fixers) {
    const fixerPath = `${keyPath}.${name}`;
    const disabled = fixer.disabled ?? false;

    if (!disabled && fixer.on === undefined) {
      throw new ConfigError(file, fixerPath, 'missing "on"');
    }

    if (!disabled && (fixer.file === undefined) === (fixer.stdin === undefined)) {
      throw new ConfigError(file, fixerPath, 'expected exactly one of "file" and "stdin"');
    }

    for (const command of [fixer.file, fixer.stdin]) {
      if (command !== undefined) {
        checkPlaceholders(command, FIXER_PLACEHOLDERS, file, fixerPath);
      }
    }

    const final: Fixer = {
      name,
      on: fixer.on ?? "",
      exclude: fixer.exclude ?? [],
      loop: fixer.loop ?? false,
      disabled,
    };

    result.push(withCommand(final, fixer));
  }

  return result;
}

function withCommand(fixer: Fixer, raw: RawFixer): Fixer {
  if (raw.file !== undefined) {
    return { ...fixer, file: raw.file };
  }

  if (raw.stdin !== undefined) {
    return { ...fixer, stdin: raw.stdin };
  }

  return fixer;
}

function finalizeLanes(lanes: ReadonlyMap<string, RawLane>, file: string): Lane[] {
  const result: Lane[] = [];

  for (const [name, lane] of lanes) {
    const lanePath = `stop.lanes.${name}`;
    const disabled = lane.disabled ?? false;

    for (const key of ["on", "takes", "run"] as const) {
      if (!disabled && lane[key] === undefined) {
        throw new ConfigError(file, lanePath, `missing "${key}"`);
      }
    }

    if (lane.run !== undefined) {
      checkPlaceholders(lane.run, LANE_PLACEHOLDERS, file, `${lanePath}.run`);
    }

    result.push({
      name,
      on: lane.on ?? "",
      exclude: lane.exclude ?? [],
      takes: lane.takes ?? "project",
      cwd: lane.cwd ?? "root",
      run: lane.run ?? "",
      verdict: lane.verdict ?? "block",
      timeoutMs: Math.round((lane.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
      disabled,
    });
  }

  return result;
}

function checkPlaceholders(
  command: string,
  allowed: ReadonlySet<string>,
  file: string,
  keyPath: string,
): void {
  for (const match of command.matchAll(/\{[a-z]+\}/gu)) {
    if (!allowed.has(match[0])) {
      throw new ConfigError(file, keyPath, `unknown placeholder ${match[0]}`);
    }
  }
}

/** Splits on whitespace outside single or double quotes; no shell runs, so no escapes or expansions. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let inWord = false;

  for (const char of command) {
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      inWord = true;
    } else if (char === quote) {
      quote = null;
    } else if (quote === null && /\s/u.test(char)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += char;
      inWord = true;
    }
  }

  if (inWord) {
    words.push(current);
  }

  return words;
}

/** The argv of a command with its placeholders filled; `{files}` yields one argument per file. */
export function expandCommand(command: string, vars: Placeholders): Argv | null {
  const words = splitCommand(command).flatMap((word): readonly string[] => {
    if (word === "{files}") {
      return vars.files ?? [];
    }

    return [
      word
        .replaceAll("{root}", vars.root)
        .replaceAll("{pkg}", vars.pkg)
        .replaceAll("{file}", vars.file ?? "")
        .replaceAll("{path}", vars.path ?? ""),
    ];
  });

  const [program, ...args] = words;

  return program === undefined ? null : [program, ...args];
}

/** The nearest ancestor of `relativePath` under `root` that holds a package.json or a Cargo.toml, else the root. */
export function pkgOf(root: string, relativePath: string): string {
  let dir = path.dirname(path.resolve(root, relativePath));
  const stop = path.resolve(root);

  while (dir.startsWith(stop)) {
    if (existsSync(path.join(dir, "package.json")) || existsSync(path.join(dir, "Cargo.toml"))) {
      return dir;
    }

    if (dir === stop) {
      break;
    }

    dir = path.dirname(dir);
  }

  return stop;
}

export function matchesFilter(filter: PathFilter, relativePath: string): boolean {
  return new Bun.Glob(filter.on).match(relativePath) && !isExcluded(filter.exclude, relativePath);
}

export function isExcluded(exclude: readonly string[], relativePath: string): boolean {
  return exclude.some((pattern) => new Bun.Glob(pattern).match(relativePath));
}
