/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- this module IS the boundary parser those rules ask for: JSONC and JSON text arrive here, and the rest of the kit reads them only through these narrowing readers. */
import { lineEnd } from "./text.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}

export function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];

  return isRecord(value) ? value : undefined;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseRecordLine(line: string): Record<string, unknown> | null {
  try {
    const record: unknown = JSON.parse(line);

    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

/** JSON with `//` and `/* *\/` comments outside strings and trailing commas before `}` or `]`. */
export function parseJsonc(text: string): unknown {
  // SAFETY: JSON.parse is typed `any`; the callers narrow the value through isRecord before reading it.
  const parsed: unknown = JSON.parse(stripJsonc(text));

  return parsed;
}

function stripJsonc(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (char === '"') {
      const end = stringEnd(text, index);
      out += text.slice(index, end);
      index = end;
    } else if (char === "/" && next === "/") {
      index = lineEnd(text, index);
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (char === ",") {
      const closing = nextSignificant(text, index + 1);
      out += closing === "}" || closing === "]" ? "" : char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }

  return out;
}

function stringEnd(text: string, start: number): number {
  let index = start + 1;

  while (index < text.length) {
    const char = text[index];

    if (char === "\\") {
      index += 2;
    } else if (char === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }

  return text.length;
}

/** The next character that is neither whitespace nor inside a comment, or "" at the end of the text. */
function nextSignificant(text: string, start: number): string {
  let index = start;

  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (/\s/u.test(char)) {
      index += 1;
    } else if (char === "/" && next === "/") {
      index = lineEnd(text, index);
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      return char;
    }
  }

  return "";
}
