/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this module IS the parser of `.claude/agent-hooks.jsonc`: each typeof check validates one key and names its key path in the error, and nothing past `loadConfig` sees the document untyped. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { isRecord, isStringArray, parseJsonc } from "./core/util/json.ts";
import { messageOf } from "./lib/platform/pure.ts";

export const CONFIG_RELATIVE_PATH = path.join(".claude", "agent-hooks.jsonc");

export const DEFAULT_CAP = 3;

const DEFAULT_TIMEOUT_SECONDS = 60;

/** When a fixer runs: before each write, on the session's files at the Stop, or both. */
export type FixerAt = "edit" | "stop" | "both";

/** A `file` fixer rewrites the file it is given; a `stdin` fixer prints the fixed content. */
export type FixerRun = { readonly kind: "file" | "stdin"; readonly command: string };

export type Fixer = {
  readonly name: string;
  readonly on: string;
  readonly exclude: readonly string[];
  readonly run: FixerRun;
  readonly loop: boolean;
  readonly at: FixerAt;
};

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
};

export type Config = {
  readonly file: string;
  /** Generated or vendored files: no fixer touches them, no `files` lane is handed them. */
  readonly exclude: readonly string[];
  readonly cap: number;
  /** In declaration order. */
  readonly fixers: readonly Fixer[];
  readonly lanes: readonly Lane[];
};

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

const DOCUMENT_KEYS = ["exclude", "cap", "fixers", "lanes"] as const;

const FIXER_KEYS = ["on", "exclude", "file", "stdin", "loop", "at"] as const;

const LANE_KEYS = ["on", "exclude", "takes", "cwd", "run", "verdict", "timeout"] as const;

const FIXER_AT: readonly FixerAt[] = ["edit", "stop", "both"];

const FIXER_PLACEHOLDERS = new Set(["{file}", "{path}", "{root}", "{pkg}"]);

const LANE_PLACEHOLDERS = new Set(["{files}", "{root}", "{pkg}"]);

/** One object of the document, with the file and the key path an error names. */
type Entry = {
  readonly file: string;
  readonly record: Record<string, unknown>;
  readonly keyPath: string;
};

/** A reader of one value: the value typed, or undefined when it has another type. */
type Parse<T> = (value: unknown) => T | undefined;

const text: Parse<string> = (value) => (typeof value === "string" ? value : undefined);

const texts: Parse<string[]> = (value) => (isStringArray(value) ? value : undefined);

const flag: Parse<boolean> = (value) => (typeof value === "boolean" ? value : undefined);

const positiveInteger: Parse<number> = (value) =>
  typeof value === "number" && value >= 1 && value % 1 === 0 ? value : undefined;

const seconds: Parse<number> = (value) =>
  typeof value === "number" && value > 0 && value < Number.POSITIVE_INFINITY ? value : undefined;

function oneOf<T extends string>(values: readonly T[]): Parse<T> {
  return (value) => values.find((candidate) => candidate === value);
}

/** Reads and validates the config file of a checkout, or one named with `doctor --config`. */
export function loadConfig(file: string): Config {
  let source: string;

  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(file, "", `cannot read: ${messageOf(error)}`);
  }

  let parsed: unknown;

  try {
    parsed = parseJsonc(source);
  } catch (error) {
    throw new ConfigError(file, "", `invalid JSONC: ${messageOf(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(file, "", "expected an object");
  }

  const document: Entry = { file, record: parsed, keyPath: "" };
  rejectUnknownKeys(document, DOCUMENT_KEYS);

  return {
    file,
    exclude: optional(document, "exclude", texts, "an array of strings") ?? [],
    cap: optional(document, "cap", positiveInteger, "a positive integer") ?? DEFAULT_CAP,
    fixers: entriesOf(table(document, "fixers")).map((entry) => readFixer(entry)),
    lanes: entriesOf(table(document, "lanes")).map((entry) => readLane(entry)),
  };
}

function readFixer(entry: Entry): Fixer {
  rejectUnknownKeys(entry, FIXER_KEYS);
  const file = optional(entry, "file", text, "a string");
  const stdin = optional(entry, "stdin", text, "a string");
  let run: FixerRun;

  if (file !== undefined && stdin === undefined) {
    run = { kind: "file", command: file };
  } else if (stdin !== undefined && file === undefined) {
    run = { kind: "stdin", command: stdin };
  } else {
    throw new ConfigError(entry.file, entry.keyPath, 'expected exactly one of "file" and "stdin"');
  }

  checkPlaceholders(entry, run.kind, run.command, FIXER_PLACEHOLDERS);
  checkFixerTarget(entry, run);

  return {
    name: nameOf(entry),
    on: required(entry, "on", text, "a string"),
    exclude: optional(entry, "exclude", texts, "an array of strings") ?? [],
    run,
    loop: optional(entry, "loop", flag, "a boolean") ?? false,
    at: optional(entry, "at", oneOf(FIXER_AT), FIXER_AT.join("|")) ?? "edit",
  };
}

function readLane(entry: Entry): Lane {
  rejectUnknownKeys(entry, LANE_KEYS);
  const run = required(entry, "run", text, "a string");
  checkPlaceholders(entry, "run", run, LANE_PLACEHOLDERS);
  const timeout = optional(entry, "timeout", seconds, "a number of seconds");

  return {
    name: nameOf(entry),
    on: required(entry, "on", text, "a string"),
    exclude: optional(entry, "exclude", texts, "an array of strings") ?? [],
    takes: required(entry, "takes", oneOf<Takes>(["files", "project"]), "files|project"),
    cwd: optional(entry, "cwd", oneOf<LaneCwd>(["root", "pkg"]), "root|pkg") ?? "root",
    run,
    verdict:
      optional(entry, "verdict", oneOf<LaneVerdict>(["block", "note"]), "block|note") ?? "block",
    timeoutMs: Math.round((timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
  };
}

function keyPathOf(entry: Entry, key: string): string {
  return entry.keyPath === "" ? key : `${entry.keyPath}.${key}`;
}

function nameOf(entry: Entry): string {
  return entry.keyPath.slice(entry.keyPath.indexOf(".") + 1);
}

function rejectUnknownKeys(entry: Entry, known: readonly string[]): void {
  for (const key of Object.keys(entry.record)) {
    if (!known.includes(key)) {
      throw new ConfigError(entry.file, keyPathOf(entry, key), "unknown key");
    }
  }
}

/** The object under `key`, or an empty one when the key is absent. */
function table(entry: Entry, key: string): Entry {
  const value = entry.record[key];
  const keyPath = keyPathOf(entry, key);

  if (value === undefined) {
    return { file: entry.file, record: {}, keyPath };
  }

  if (!isRecord(value)) {
    throw new ConfigError(entry.file, keyPath, "expected an object");
  }

  return { file: entry.file, record: value, keyPath };
}

/** Each named object of a table, in declaration order. */
function entriesOf(entry: Entry): Entry[] {
  return Object.keys(entry.record).map((name) => table(entry, name));
}

function optional<T>(entry: Entry, key: string, parse: Parse<T>, expected: string): T | undefined {
  const value = entry.record[key];

  if (value === undefined) {
    return undefined;
  }

  const parsed = parse(value);

  if (parsed === undefined) {
    throw new ConfigError(entry.file, keyPathOf(entry, key), `expected ${expected}`);
  }

  return parsed;
}

function required<T>(entry: Entry, key: string, parse: Parse<T>, expected: string): T {
  const value = optional(entry, key, parse, expected);

  if (value === undefined) {
    throw new ConfigError(entry.file, entry.keyPath, `missing "${key}"`);
  }

  return value;
}

/**
 * A fixer rewrites only what the kit hands it: at an edit that is a scratch copy, so a `file` fixer that names the
 * real path or no path at all would rewrite the user's files behind the hook's back.
 */
function checkFixerTarget(entry: Entry, run: FixerRun): void {
  const fail = (message: string): never => {
    throw new ConfigError(entry.file, keyPathOf(entry, run.kind), message);
  };

  if (run.kind === "file" && !run.command.includes("{file}")) {
    fail("a file fixer must name {file}, the copy it rewrites");
  }

  if (run.kind === "file" && run.command.includes("{path}")) {
    fail("a file fixer may not name {path}, the real file: it rewrites {file}");
  }

  if (run.kind === "stdin" && run.command.includes("{file}")) {
    fail("a stdin fixer may not name {file}: it reads the content on stdin");
  }
}

function checkPlaceholders(
  entry: Entry,
  key: string,
  command: string,
  allowed: ReadonlySet<string>,
): void {
  for (const match of command.matchAll(/\{[a-z]+\}/gu)) {
    if (!allowed.has(match[0])) {
      throw new ConfigError(entry.file, keyPathOf(entry, key), `unknown placeholder ${match[0]}`);
    }
  }
}
