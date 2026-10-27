/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- this module IS the reader of `.claude/agent-hooks.jsonc` and the presets: each typeof check validates one key and names its key path in the error, and nothing past `loadConfig` and the profile readers sees the document untyped. */
import { readFileSync } from "node:fs";

import { messageOf } from "./errors.ts";
import { isRecord, isStringArray, parseJsonc } from "./json.ts";

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

export type Reader = {
  readonly file: string;
  readonly record: Record<string, unknown>;
  readonly keyPath: string;
};

export function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(file, "", `cannot read: ${messageOf(error)}`);
  }
}

export function parseRecord(file: string, text: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new ConfigError(file, "", `invalid JSONC: ${messageOf(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(file, "", "expected an object");
  }

  return parsed;
}

export function keyPathOf(reader: Reader, key: string): string {
  return reader.keyPath === "" ? key : `${reader.keyPath}.${key}`;
}

/** The object under `key`, or an empty one when the key is absent. */
export function child(reader: Reader, key: string): Reader {
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

export function rejectUnknownKeys(reader: Reader, known: ReadonlySet<string>): void {
  for (const key of Object.keys(reader.record)) {
    if (!known.has(key)) {
      throw new ConfigError(reader.file, keyPathOf(reader, key), "unknown key");
    }
  }
}

export function stringArray(reader: Reader, key: string): string[] | undefined {
  const value = reader.record[key];

  if (value === undefined) {
    return undefined;
  }

  if (!isStringArray(value)) {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected an array of strings");
  }

  return value;
}

export function string(reader: Reader, key: string): string | undefined {
  const value = reader.record[key];

  if (value !== undefined && typeof value !== "string") {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a string");
  }

  return value;
}

export function boolean(reader: Reader, key: string): boolean | undefined {
  const value = reader.record[key];

  if (value !== undefined && typeof value !== "boolean") {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a boolean");
  }

  return value;
}

export function seconds(reader: Reader, key: string): number | undefined {
  const value = reader.record[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a number of seconds");
  }

  return value;
}

export function oneOf<T extends string>(
  reader: Reader,
  key: string,
  values: readonly T[],
): T | undefined {
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
