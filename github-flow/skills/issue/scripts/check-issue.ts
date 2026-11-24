#!/usr/bin/env bun

/**
 * The shape of an issue the `issue` skill writes, as far as a script can
 * decide it: what the skill runs on its draft before it publishes, and on the
 * HTML of an issue artifact before it uploads one. The checks and their
 * reasons are in the github-flow README under "Issue check".
 *
 * Self-contained: it imports nothing outside the skill's folder, so the skill
 * and its check copy into another repository together.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CheckId =
  | "heading"
  | "section"
  | "order"
  | "problem"
  | "done-when"
  | "contract"
  | "situations"
  | "regression"
  | "expected"
  | "visual-size"
  | "not-this"
  | "leads"
  | "fix"
  | "plan"
  | "checkbox"
  | "question"
  | "footer"
  | "script";

export interface Finding {
  check: CheckId;
  /** 1-based, as the draft is numbered. */
  line: number;
  message: string;
}

export interface Caps {
  /** Lines of the problem, above Done when. */
  problemLines: number;
  /** Lines of Not this. */
  notThisLines: number;
  /** Lines of one visual, a fenced block or a table, before it moves to an issue artifact. */
  visualLines: number;
}

export const DEFAULT_CAPS: Caps = { problemLines: 2, notThisLines: 3, visualLines: 40 };

/** The file a repository tunes its caps in, shared with the `pr` check under its own key. */
export const SETTINGS_FILE = join(".github", "github-flow.json");

const SETTINGS_KEY = "issue";

interface Line {
  line: number;
  raw: string;
  /** The index of the fenced block the line belongs to, its markers included. */
  fence: number | null;
  /** The line without code spans, HTML comments and URLs; empty inside a fence. */
  prose: string;
}

interface Fence {
  start: number;
  /** Lines between the markers. */
  content: string[];
}

interface Row {
  line: number;
  cells: string[];
}

interface Table {
  start: number;
  size: number;
  /** The rows under the delimiter row. */
  body: Row[];
}

interface Visuals {
  fences: Fence[];
  tables: Table[];
}

// Any indent: a fence nested in a list item sits four spaces in or more.
const FENCE = /^\s*(`{3,}|~{3,})/u;

const HEADING = /^ {0,3}#{1,6}\s/u;

const DONE_WHEN = /^\s*\*\*Done when\*\*/u;

const NOT_THIS = /^\s*\*\*Not this\*\*/u;

const LEADS_SUMMARY = /<summary>\s*Author['’]s leads\s*<\/summary>/iu;

const SUMMARY = /<summary>(.*?)<\/summary>/iu;

const FOOTER = /^<sub>Written by [^<]+<\/sub>$/u;

/** A paragraph that opens on a bold label names a section, as `**Done when**` does. */
const BOLD_LABEL = /^\s*\*\*([^*]{1,40}?)\*\*/u;

const ALLOWED_LABELS = new Set(["Done when", "Not this"]);

const CONTRACT = /(?<!\p{L})(?:contract|contrat)(?!\p{L})/iu;

const FREE = /(?<!\p{L})(?:free|libres?)(?!\p{L})/iu;

const REGRESSION = /r[eé]gression/iu;

/** A Done when that hands its situations to an issue artifact names it, by its link or in words. */
const ARTIFACT = /\/issues\/\d+\/artifacts\/\d+|(?<!\p{L})issue artifact(?!\p{L})/iu;

const FIXES: readonly RegExp[] = [
  /(?<!\p{L})(?:(?:suggested|proposed|possible|quick) )?fix(?:es)?\s*:/iu,
  /(?<!\p{L})possible directions?(?!\p{L})/iu,
  /(?<!\p{L})(?:suggested|proposed|possible) (?:fix|solution|approach|change|implementation)s?(?!\p{L})/iu,
  /(?<!\p{L})(?:solution|approach|workaround)\s*:/iu,
];

const ORDERED_ITEM = /^\s*\d+[.)]\s/u;

const TASK_ITEM = /^\s*[-*+]\s+\[[ xX]\]/u;

const TABLE_ROW = /^\s*\|/u;

const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u;

interface Stripped {
  prose: string;
  inComment: boolean;
}

function stripInline(raw: string, inComment: boolean): Stripped {
  let prose = raw.replaceAll(/(`+)[^`]*?\1/gu, "");
  let comment = inComment;

  if (comment) {
    const end = prose.indexOf("-->");
    comment = end === -1;
    prose = comment ? "" : prose.slice(end + 3);
  }

  prose = prose.replaceAll(/<!--.*?-->/gu, "");
  const open = prose.indexOf("<!--");

  if (open !== -1) {
    prose = prose.slice(0, open);
    comment = true;
  }

  prose = prose
    .replaceAll(/\]\([^)]*\)/gu, "]")
    .replaceAll(/<[a-z][\w+.-]*:[^>\s]*>/giu, "")
    .replaceAll(/[a-z][\w+.-]*:\/\/\S+/giu, "");

  return { prose, inComment: comment };
}

function scan(text: string): Line[] {
  const lines: Line[] = [];
  let fence: { char: string; length: number; index: number } | null = null;
  let fences = 0;
  let inComment = false;

  for (const [index, raw] of text.split("\n").entries()) {
    const line = index + 1;
    const marker = FENCE.exec(raw)?.[1];

    if (fence !== null) {
      const closes =
        marker !== undefined &&
        marker[0] === fence.char &&
        marker.length >= fence.length &&
        raw.trim() === marker;

      lines.push({ line, raw, fence: fence.index, prose: "" });

      if (closes) fence = null;
      continue;
    }

    if (marker !== undefined && !inComment) {
      fence = { char: marker.slice(0, 1), length: marker.length, index: fences };
      fences += 1;
      lines.push({ line, raw, fence: fence.index, prose: "" });
      continue;
    }

    const stripped = stripInline(raw, inComment);
    inComment = stripped.inComment;
    lines.push({ line, raw, fence: null, prose: stripped.prose });
  }

  return lines;
}

function cellsOf(raw: string): string[] {
  return raw
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim());
}

function visualsOf(lines: readonly Line[]): Visuals {
  const fences: Fence[] = [];
  const tables: Table[] = [];
  let table: Table | null = null;
  let delimited = false;

  for (const { line, raw, fence } of lines) {
    if (fence !== null) {
      const current = fences[fence];

      if (current === undefined) fences[fence] = { start: line, content: [] };
      else current.content.push(raw);
      table = null;
      continue;
    }

    if (!TABLE_ROW.test(raw)) {
      table = null;
      continue;
    }

    if (table === null) {
      table = { start: line, size: 0, body: [] };
      tables.push(table);
      delimited = false;
    }

    table.size += 1;

    if (delimited) table.body.push({ line, cells: cellsOf(raw) });
    else if (TABLE_DELIMITER.test(raw)) delimited = true;
  }

  // The closing marker of each fence was pushed as content: drop it when it is one.
  for (const fence of fences) {
    const last = fence.content.at(-1);

    if (last !== undefined && FENCE.test(last) && last.trim().replaceAll(/[`~]/gu, "") === "") {
      fence.content.pop();
    }
  }

  return { fences: fences.filter((fence) => fence !== undefined), tables };
}

interface Parts {
  doneWhen: number | null;
  notThis: number | null;
  /** The line of `<details>` that holds the author's leads. */
  leads: number | null;
  footer: number | null;
  /** The last line that holds text. */
  last: number;
  /** The line after the last of the draft. */
  end: number;
}

function partsOf(lines: readonly Line[]): Parts {
  const proseLine = (pattern: RegExp): number | null =>
    lines.find(({ fence, prose }) => fence === null && pattern.test(prose))?.line ?? null;

  const summary = lines.find(({ fence, prose }) => fence === null && LEADS_SUMMARY.test(prose));
  let leads: number | null = null;

  if (summary !== undefined) {
    const opener = lines
      .slice(0, summary.line)
      .findLast(({ fence, prose }) => fence === null && /<details\b/iu.test(prose));

    leads = opener?.line ?? summary.line;
  }

  const last = lines.findLast(({ raw }) => raw.trim().length > 0);
  const footer = last !== undefined && FOOTER.test(last.raw.trim()) ? last.line : null;

  return {
    doneWhen: proseLine(DONE_WHEN),
    notThis: proseLine(NOT_THIS),
    leads,
    footer,
    last: last?.line ?? 1,
    end: lines.length + 1,
  };
}

/** The lines from `start` to the next part that follows it, or to the end. */
function region(lines: readonly Line[], parts: Parts, start: number): Line[] {
  const next = [parts.doneWhen, parts.notThis, parts.leads, parts.footer, parts.end]
    .filter((at): at is number => at !== null && at > start)
    .reduce((a, b) => Math.min(a, b), parts.end);

  return lines.filter(({ line }) => line >= start && line < next);
}

function nonEmpty(lines: readonly Line[]): Line[] {
  return lines.filter(({ raw }) => raw.trim().length > 0);
}

function inside(line: number, from: number, to: number): boolean {
  return line >= from && line < to;
}

function structure(lines: readonly Line[], parts: Parts, caps: Caps): Finding[] {
  const findings: Finding[] = [];

  for (const { line, fence, prose } of lines) {
    if (fence !== null) continue;

    if (HEADING.test(prose)) {
      findings.push({
        check: "heading",
        line,
        message:
          "an issue has no heading: the problem, then **Done when**, **Not this**, the folded author's leads and the footer.",
      });
      continue;
    }

    const label = BOLD_LABEL.exec(prose)?.[1]?.replace(/:$/u, "").trim();

    if (label !== undefined && !ALLOWED_LABELS.has(label)) {
      findings.push({
        check: "section",
        line,
        message: `"${label}" opens a section the shape does not have: keep the problem, Done when, Not this, the author's leads and the footer.`,
      });
    }

    const summary = SUMMARY.exec(prose)?.[1]?.trim();

    if (summary !== undefined && !LEADS_SUMMARY.test(prose)) {
      findings.push({
        check: "section",
        line,
        message: `a folded "${summary}" is a section the shape does not have: only the author's leads are folded.`,
      });
    }

    if (/author['’]s leads/iu.test(prose) && !LEADS_SUMMARY.test(prose)) {
      findings.push({
        check: "leads",
        line,
        message:
          "the author's leads are folded: <details><summary>Author's leads</summary> … </details>.",
      });
    }
  }

  if (parts.doneWhen === null) {
    findings.push({
      check: "done-when",
      line: 1,
      message:
        "no **Done when**: the expected result as a visual of its situations, one per row or panel.",
    });
  }

  if (parts.footer === null) {
    findings.push({
      check: "footer",
      line: parts.last,
      message: "the issue ends on the model that wrote it: <sub>Written by <model></sub>.",
    });
  }

  const sequence = [
    ["**Done when**", parts.doneWhen],
    ["**Not this**", parts.notThis],
    ["the author's leads", parts.leads],
    ["the footer", parts.footer],
  ] as const;

  let previous: { name: string; line: number } | null = null;

  for (const [name, line] of sequence) {
    if (line === null) continue;

    if (previous !== null && line < previous.line) {
      findings.push({
        check: "order",
        line,
        message: `${name} comes after ${previous.name}: the problem, Done when, Not this, the author's leads, the footer.`,
      });
    } else {
      previous = { name, line };
    }
  }

  const problem = nonEmpty(lines.filter(({ line }) => line < (parts.doneWhen ?? parts.end)));

  if (problem.length === 0) {
    findings.push({
      check: "problem",
      line: 1,
      message: "the issue opens on its problem: what is observed and what it costs.",
    });
  } else if (problem.length > caps.problemLines) {
    findings.push({
      check: "problem",
      line: problem[0]?.line ?? 1,
      message: `the problem runs ${problem.length} lines, ${caps.problemLines} at most: what is observed and what it costs, no cause in the code.`,
    });
  }

  if (parts.notThis !== null) {
    const notThis = nonEmpty(region(lines, parts, parts.notThis));

    if (notThis.length > caps.notThisLines) {
      findings.push({
        check: "not-this",
        line: parts.notThis,
        message: `Not this runs ${notThis.length} lines, ${caps.notThisLines} at most.`,
      });
    }
  }

  return findings;
}

function doneWhen(lines: readonly Line[], parts: Parts, visuals: Visuals): Finding[] {
  if (parts.doneWhen === null) return [];
  const start = parts.doneWhen;
  const section = region(lines, parts, start);
  const to = (section.at(-1)?.line ?? start) + 1;
  const findings: Finding[] = [];

  const prose = section.filter(({ fence }) => fence === null);

  if (!prose.some(({ prose: text }) => CONTRACT.test(text) && FREE.test(text))) {
    findings.push({
      check: "contract",
      line: start,
      message: "Done when says in one line what is contract and what is free.",
    });
  }

  const rows = visuals.tables
    .filter(({ start: at }) => inside(at, start, to))
    .flatMap(({ body }) => body);

  const panels = visuals.fences.filter(
    ({ start: at, content }) =>
      inside(at, start, to) && content.some((text) => text.trim().length > 0),
  );

  const artifact = section.some(({ raw, fence }) => fence === null && ARTIFACT.test(raw));

  if (rows.length === 0 && panels.length === 0 && !artifact) {
    findings.push({
      check: "situations",
      line: start,
      message:
        "the Done when visual lists no situation: one per table row or panel, or name the issue artifact that holds them.",
    });

    return findings;
  }

  if (!artifact) {
    const texts = [
      ...rows.map(({ cells }) => cells.join(" ")),
      ...panels.map(({ content }) => content.join("\n")),
    ];

    if (!texts.some((text) => REGRESSION.test(text))) {
      findings.push({
        check: "regression",
        line: start,
        message:
          "no situation for no regression: one row or panel shows what keeps working as today.",
      });
    }
  }

  for (const { line, cells } of rows) {
    if (cells.length < 2 || (cells.at(-1) ?? "").length === 0) {
      findings.push({
        check: "expected",
        line,
        message: "a situation with no expected result: each one says what a test observes.",
      });
    }
  }

  return findings;
}

function visualSize(visuals: Visuals, caps: Caps): Finding[] {
  const sizes = [
    ...visuals.fences.map(({ start, content }) => ({ start, size: content.length })),
    ...visuals.tables.map(({ start, size }) => ({ start, size })),
  ];

  return sizes.flatMap(({ start, size }): Finding[] =>
    size > caps.visualLines
      ? [
          {
            check: "visual-size",
            line: start,
            message: `a visual of ${size} lines, ${caps.visualLines} at most: move it to an issue artifact the body names.`,
          },
        ]
      : [],
  );
}

function proseFindings(lines: readonly Line[]): Finding[] {
  return lines.flatMap(({ line, fence, prose: text }): Finding[] => {
    if (fence !== null) return [];
    const found: Finding[] = [];

    const fix = FIXES.map((pattern) => pattern.exec(text)?.[0]).find(
      (match) => match !== undefined,
    );

    if (fix !== undefined) {
      found.push({
        check: "fix",
        line,
        message: `"${fix.trim()}" prescribes the solution: the issue gives the goal and how to tell it is reached; the reader plans.`,
      });
    }

    if (ORDERED_ITEM.test(text)) {
      found.push({
        check: "plan",
        line,
        message: "a numbered list is a plan: the reader plans.",
      });
    }

    if (TASK_ITEM.test(text)) {
      found.push({
        check: "checkbox",
        line,
        message: "Done when is a visual of situations, not checkboxes.",
      });
    }

    if (text.includes("?")) {
      found.push({
        check: "question",
        line,
        message:
          "a question mark: the issue asks nothing; state the fact, or leave it to the reader.",
      });
    }

    return found;
  });
}

/** The findings on the body of an issue, as `gh issue create --body-file` would send it. */
export function checkIssue(text: string, caps: Caps = DEFAULT_CAPS): Finding[] {
  const lines = scan(text);
  const parts = partsOf(lines);
  const visuals = visualsOf(lines);

  return [
    ...structure(lines, parts, caps),
    ...doneWhen(lines, parts, visuals),
    ...visualSize(visuals, caps),
    ...proseFindings(lines),
  ].toSorted((a, b) => a.line - b.line);
}

const SCRIPT_PATTERNS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /<script\b/iu, what: "a <script> element" },
  { pattern: /<[a-z][^>]*\son[a-z]+\s*=/iu, what: "an on-event attribute" },
  { pattern: /javascript\s*:/iu, what: "a javascript: URL" },
];

interface HtmlRow {
  line: number;
  text: string;
}

/** The cells of each table row in an HTML artifact, header rows aside. */
function htmlRows(html: string): HtmlRow[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].flatMap((match): HtmlRow[] => {
    const cells = match[1] ?? "";

    return /<td\b/iu.test(cells)
      ? [
          {
            line: html.slice(0, match.index).split("\n").length,
            text: cells.replaceAll(/<[^>]*>/gu, " "),
          },
        ]
      : [];
  });
}

/**
 * The findings on the HTML of an issue artifact: it runs no script, and it
 * holds the situations the body hands to it, one for no regression among them.
 */
export function checkArtifact(text: string): Finding[] {
  const findings: Finding[] = [];

  for (const [index, raw] of text.split("\n").entries()) {
    const hit = SCRIPT_PATTERNS.find(({ pattern }) => pattern.test(raw));

    if (hit !== undefined) {
      findings.push({
        check: "script",
        line: index + 1,
        message: `${hit.what}: an issue artifact holds no script; use <details>, :checked, SVG or a data URI image.`,
      });
    }
  }

  const rows = htmlRows(text);

  if (rows.length === 0) {
    findings.push({
      check: "situations",
      line: 1,
      message: "the artifact lists no situation: one per table row (<tr> with <td>).",
    });
  } else if (!rows.some(({ text: row }) => REGRESSION.test(row))) {
    findings.push({
      check: "regression",
      line: rows[0]?.line ?? 1,
      message: "no situation for no regression: one row shows what keeps working as today.",
    });
  }

  return findings;
}

/** One finding per line: `<file>:<line>: <check>: <message>`. */
export function formatFindings(findings: readonly Finding[], file: string): string {
  return findings
    .map(({ check, line, message }) => `${file}:${line}: ${check}: ${message}`)
    .join("\n");
}

export class SettingsError extends Error {}

/** The settings file as JSON gives it: every value is checked by `capsOf` before it is used. */
interface SettingsJson {
  [key: string]: SettingsJson | number | string | boolean | null | SettingsJson[];
}

function isObject(value: SettingsJson[string] | undefined): value is SettingsJson {
  return value instanceof Object && !Array.isArray(value);
}

/** The caps a settings file sets under `issue`, the defaults for those it leaves out. */
export function capsOf(raw: string, file: string): Caps {
  let settings: SettingsJson[string];

  try {
    // SAFETY: JSON.parse yields JSON values only, the union this type names; each is narrowed below.
    settings = JSON.parse(raw) as SettingsJson[string];
  } catch (error) {
    throw new SettingsError(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  if (!isObject(settings)) throw new SettingsError(`${file}: not a JSON object`);
  const own = settings[SETTINGS_KEY];

  if (own === undefined) return DEFAULT_CAPS;

  if (!isObject(own)) throw new SettingsError(`${file}: "${SETTINGS_KEY}" is not an object`);

  const caps: Caps = { ...DEFAULT_CAPS };
  const names = Object.keys(DEFAULT_CAPS);

  for (const [key, value] of Object.entries(own)) {
    if (!names.includes(key)) {
      throw new SettingsError(
        `${file}: "${SETTINGS_KEY}.${key}" is no cap; the caps are ${names.join(", ")}`,
      );
    }

    if (!Number.isInteger(value) || Number(value) <= 0) {
      throw new SettingsError(`${file}: "${SETTINGS_KEY}.${key}" is not a positive integer`);
    }

    const cap = Number(value);

    if (key === "problemLines") caps.problemLines = cap;

    if (key === "notThisLines") caps.notThisLines = cap;

    if (key === "visualLines") caps.visualLines = cap;
  }

  return caps;
}

/** The settings file of the repository that holds `from`: searched upward, up to the first directory with `.git`. */
export function settingsFile(from: string): string | null {
  let dir = resolve(from);

  for (;;) {
    const file = join(dir, SETTINGS_FILE);

    if (existsSync(file)) return file;

    if (existsSync(join(dir, ".git"))) return null;
    const parent = dirname(dir);

    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadCaps(from: string): Promise<Caps> {
  const file = settingsFile(from);

  if (file === null) return DEFAULT_CAPS;
  let raw: string;

  try {
    raw = await Bun.file(file).text();
  } catch (error) {
    throw new SettingsError(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  return capsOf(raw, file);
}

const USAGE = "usage: bun check-issue.ts <issue.md | artifact.html | ->...";

if (import.meta.main) {
  const files = Bun.argv.slice(2);

  if (files.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }

  let caps: Caps;

  try {
    caps = await loadCaps(process.cwd());
  } catch (error) {
    console.error(`check-issue: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  let found = 0;

  for (const file of files) {
    let text: string;

    try {
      text = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
    } catch (error) {
      console.error(
        `check-issue: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    }

    const findings = /\.html?$/iu.test(file) ? checkArtifact(text) : checkIssue(text, caps);
    found += findings.length;

    if (findings.length > 0) console.log(formatFindings(findings, file));
  }

  process.exit(found > 0 ? 1 : 0);
}
