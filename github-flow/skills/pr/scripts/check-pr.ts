#!/usr/bin/env bun

/**
 * The structure of a pull request body, checked with no model call: what the
 * `pr` skill runs on its body before it publishes, and what
 * `bun check-pr.ts <body.md>...` prints. It checks the sections, their order,
 * the caps, and that the body asks nothing; what the prose says is the
 * review's to judge. `SKILL.md` beside this directory says the shape.
 *
 * It imports only `node:` modules, so the skill directory copied whole into
 * another repository runs it there.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CheckId =
  | "section"
  | "missing"
  | "order"
  | "question"
  | "prose"
  | "view"
  | "decided"
  | "clip"
  | "footer";

export interface Finding {
  check: CheckId;
  /** 1-based, as the body file is numbered. */
  line: number;
  message: string;
}

export interface Caps {
  /** Words of prose outside views, tables and code. */
  proseWords: number;
  /** Facts under **Decided**. */
  decided: number;
  /** Clips in the body. */
  clips: number;
}

export const DEFAULT_CAPS: Readonly<Caps> = { proseWords: 120, decided: 3, clips: 3 };

/** Where a repository sets its own caps, under the key `pr`. */
export const SETTINGS_FILE = join(".github", "github-flow.json");

const SECTIONS = ["Why", "Danger", "Start at", "Proof", "Decided"] as const;

type Section = (typeof SECTIONS)[number];

const OPTIONAL: ReadonlySet<Section> = new Set(["Decided"]);

const REQUIRED = SECTIONS.flatMap((s) => (OPTIONAL.has(s) ? [] : [`**${s}**`])).join(", ");

/** Bold labels a section may hold without starting one: the stills of a UI proof and its protocol. */
const LABELS: ReadonlySet<string> = new Set(["before", "after", "protocol"]);

// Any indent: a fence nested in a list item sits four spaces in or more.
const FENCE = /^\s*(`{3,}|~{3,})/u;

const HEADING = /^ {0,3}#{1,6}\s/u;

const TABLE_ROW = /^\s*\|/u;

/** The row under a table's header: `|---|:---:|`. */
const TABLE_RULE = /^\s*\|[\s:|-]+\|?\s*$/u;

const LEAD_IN = /^\*\*([^*]+?)\*\*/u;

const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])\s/u;

/** The footer: `<sub>Written by <model></sub>`, or a host's own line in italics or behind an emoji. */
const FOOTER =
  /^(?:<sub>\s*(?:[_*]\s*)?(?:\p{Extended_Pictographic}\s*)?|[_*]\s*(?:\p{Extended_Pictographic}\s*)?|\p{Extended_Pictographic}\s*)(?:written|generated|opened) (?:by|with)\b/iu;

/** A URL, without the stop that may end its sentence: GitHub leaves a trailing `?`, `.`, `,`, `_` or a quote out of the link, and a table pipe ends it. */
const WEB_ADDRESS = /\bhttps?:\/\/[^\s|]*[^\s|.,;:!?)*_~'"]/gu;

const CLIP = /\.(?:mp4|mov|webm)$/iu;

const LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?[^)]*\)|<video[^>]*\ssrc=["']([^"']+)["']/giu;

const PROTOCOL = /^[\s>*_\-+]*protocol\b/iu;

const E2E_TEST = /`[^`]*(?:e2e|\.spec\.[cm]?[jt]sx?)[^`]*`/iu;

type Kind = "prose" | "code" | "table" | "comment";

interface Line {
  line: number;
  raw: string;
  kind: Kind;
  /** The section a lead-in on this line opens. */
  opens: Section | null;
}

function classify(text: string): Line[] {
  const lines: Line[] = [];
  let fence: { char: string; length: number } | null = null;
  let inComment = false;

  for (const [index, raw] of text.split("\n").entries()) {
    const line = index + 1;
    const marker = FENCE.exec(raw)?.[1];

    if (fence !== null) {
      if (
        marker !== undefined &&
        marker[0] === fence.char &&
        marker.length >= fence.length &&
        raw.trim() === marker
      ) {
        fence = null;
      }

      lines.push({ line, raw, kind: "code", opens: null });
      continue;
    }

    if (inComment) {
      inComment = !raw.includes("-->");
      lines.push({ line, raw, kind: "comment", opens: null });
      continue;
    }

    if (marker !== undefined) {
      fence = { char: marker.slice(0, 1), length: marker.length };
      lines.push({ line, raw, kind: "code", opens: null });
      continue;
    }

    const trimmed = raw.trim();

    if (trimmed.startsWith("<!--")) {
      inComment = !trimmed.includes("-->");
      lines.push({ line, raw, kind: "comment", opens: null });
      continue;
    }

    const kind: Kind = TABLE_ROW.test(raw) ? "table" : "prose";

    lines.push({ line, raw, kind, opens: kind === "prose" ? sectionOf(raw) : null });
  }

  return lines;
}

function labelOf(raw: string): string | null {
  const name = LEAD_IN.exec(raw)?.[1];

  return name === undefined ? null : name.trim().replace(/:$/u, "").trim();
}

function sectionOf(raw: string): Section | null {
  const label = labelOf(raw)?.toLowerCase();

  return SECTIONS.find((section) => section.toLowerCase() === label) ?? null;
}

/** The words a reader reads: no code span, no link target, no URL, no tag, no lead-in label. */
function prose(raw: string): string {
  return raw
    .replace(LEAD_IN, "")
    .replaceAll(/(`+)[\s\S]*?\1/gu, "")
    .replaceAll(/<!--.*?-->/gu, "")
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll(WEB_ADDRESS, "");
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

interface Parts {
  /** Each section present, with the lines from its lead-in to the next section or the footer. */
  sections: Map<Section, Line[]>;
  /** Every line but the footer's: GitHub renders the lines under it too. */
  rendered: Line[];
  footer: Line | null;
  findings: Finding[];
}

function split(lines: readonly Line[]): Parts {
  const lastLeadIn = lines.findLastIndex((l) => l.opens !== null);

  const footerAt = lines.findIndex(
    (l, i) => i > lastLeadIn && l.kind === "prose" && FOOTER.test(l.raw.trim()),
  );

  const footer = lines[footerAt] ?? null;
  const sections = new Map<Section, Line[]>();
  const findings: Finding[] = [];
  let current: Line[] | null = null;
  let rank = -1;

  for (const l of footerAt === -1 ? lines : lines.slice(0, footerAt)) {
    if (l.opens !== null) {
      const seen = sections.has(l.opens);
      const at = SECTIONS.indexOf(l.opens);

      if (seen) {
        findings.push({
          check: "section",
          line: l.line,
          message: `a second **${l.opens}**: each section comes once.`,
        });
      } else if (at < rank) {
        findings.push({
          check: "order",
          line: l.line,
          message: `**${l.opens}** comes after **${SECTIONS[rank]}**: the order is ${SECTIONS.join(", ")}.`,
        });
      }

      rank = Math.max(rank, at);
      current = seen ? (current ?? []) : [];

      if (!seen) sections.set(l.opens, current);
    }

    current?.push(l);
  }

  return { sections, rendered: lines.filter((l) => l !== footer), footer, findings };
}

/** A heading, or a bold lead-in that is no section of the shape: the body has no other section. */
function strayLines(lines: readonly Line[]): Finding[] {
  return lines.flatMap((l): Finding[] => {
    if (l.kind !== "prose") return [];

    if (HEADING.test(l.raw)) {
      return [
        {
          check: "section",
          line: l.line,
          message: `a heading: the sections are bold lead-ins, ${SECTIONS.map((s) => `**${s}**`).join(", ")}.`,
        },
      ];
    }

    const label = labelOf(l.raw);

    if (l.opens === null && label !== null && !LABELS.has(label.toLowerCase())) {
      return [
        {
          check: "section",
          line: l.line,
          message: `**${label}** is no section of the shape: ${SECTIONS.join(", ")}.`,
        },
      ];
    }

    return [];
  });
}

function questions(lines: readonly Line[]): Finding[] {
  return lines.flatMap((l): Finding[] =>
    (l.kind === "prose" || l.kind === "table") && prose(l.raw).includes("?")
      ? [
          {
            check: "question",
            line: l.line,
            message:
              "a question: the body asks nothing. Decide and write the fact under **Decided**, or ask the user before publishing.",
          },
        ]
      : [],
  );
}

function proseCap(lines: readonly Line[], cap: number): Finding[] {
  const counts = lines.map((l) => (l.kind === "prose" ? wordCount(prose(l.raw)) : 0));
  const total = counts.reduce((sum, n) => sum + n, 0);
  let words = 0;

  for (const [index, l] of lines.entries()) {
    words += counts[index] ?? 0;

    if (words > cap) {
      return [
        {
          check: "prose",
          line: l.line,
          message: `${total} words of prose outside views, tables and code, past the cap of ${cap} here: show it in a view or a table, or cut it.`,
        },
      ];
    }
  }

  return [];
}

function missing(parts: Parts, lines: readonly Line[]): Finding[] {
  const last = lines.findLast((l) => l.raw.trim() !== "")?.line ?? 1;
  const findings: Finding[] = [];

  for (const [at, section] of SECTIONS.entries()) {
    if (OPTIONAL.has(section) || parts.sections.has(section)) continue;

    const next = SECTIONS.slice(at + 1)
      .map((s) => parts.sections.get(s)?.[0]?.line)
      .find((line) => line !== undefined);

    findings.push({
      check: "missing",
      line: next ?? parts.footer?.line ?? last,
      message: `no **${section}**: the body holds ${REQUIRED}.`,
    });
  }

  if (parts.footer === null) {
    findings.push({
      check: "footer",
      line: last,
      message:
        "no footer: the body ends on the model that wrote it, `<sub>Written by <model></sub>`.",
    });
  }

  return findings;
}

function view(lines: readonly Line[]): Finding[] {
  // Every view is text: a still is proof, not the view.
  const shown = lines.some((l) => l.kind === "code" || l.kind === "table");

  return shown
    ? []
    : [
        {
          check: "view",
          line: lines[0]?.line ?? 1,
          message:
            "no view under **Start at**: pseudocode, a call tree or a file tree as a diff, a table, or a Mermaid diagram for a topology.",
        },
      ];
}

/** A fact is a list item, a table row or a paragraph; a lead-in that ends on a colon only announces them. */
function decided(lines: readonly Line[], cap: number): Finding[] {
  const said = (l: Line | undefined): boolean =>
    l !== undefined && l.kind === "prose" && prose(l.raw).trim() !== "";

  const facts = lines.filter((l, i) => {
    if (l.kind === "table")
      return !TABLE_RULE.test(l.raw) && !TABLE_RULE.test(lines[i + 1]?.raw ?? "");

    if (LIST_ITEM.test(l.raw)) return l.kind === "prose";

    const text = prose(l.raw).trim();

    return said(l) && (i === 0 || !said(lines[i - 1])) && !(l.opens !== null && text.endsWith(":"));
  });

  const over = facts[cap];

  return over === undefined
    ? []
    : [
        {
          check: "decided",
          line: over.line,
          message: `**Decided** holds ${facts.length} facts, past the cap of ${cap}: keep the ones a reader would ask about.`,
        },
      ];
}

function isClip(l: Line): boolean {
  return (
    l.kind !== "code" &&
    l.kind !== "comment" &&
    [...l.raw.matchAll(LINK_TARGET)].some((m) => CLIP.test(m[1] ?? m[2] ?? ""))
  );
}

/**
 * At most `cap` clips. Each clip comes with its own protocol line and the e2e
 * test that asserts it, in the lines from the clip to the next clip or section.
 */
function clips(parts: Parts, cap: number): Finding[] {
  const lines = parts.rendered;
  const findings: Finding[] = [];
  let count = 0;

  for (const [index, l] of lines.entries()) {
    if (!isClip(l)) continue;

    count += 1;

    if (count === cap + 1) {
      findings.push({
        check: "clip",
        line: l.line,
        message: `more than ${cap} clips: a still proves a state, a clip only a transition.`,
      });
    }

    const rest = lines.slice(index + 1);
    const stop = rest.findIndex((next) => next.opens !== null || isClip(next));
    const own = [l, ...(stop === -1 ? rest : rest.slice(0, stop))].filter((o) => o.kind !== "code");

    if (!own.some((o) => PROTOCOL.test(o.raw))) {
      findings.push({
        check: "clip",
        line: l.line,
        message:
          "a clip with no protocol line of its own: under it, `Protocol: <build>, <viewport>, <page>, <action>`.",
      });
    }

    if (!own.some((o) => E2E_TEST.test(o.raw))) {
      findings.push({
        check: "clip",
        line: l.line,
        message:
          "a clip with no e2e test named under it: the test that asserts what the clip shows.",
      });
    }
  }

  return findings;
}

export function checkBody(body: string, caps: Readonly<Caps> = DEFAULT_CAPS): Finding[] {
  const lines = classify(body);
  const parts = split(lines);
  const section = (name: Section): Line[] | undefined => parts.sections.get(name);
  const startAt = section("Start at");
  const facts = section("Decided");

  return [
    ...parts.findings,
    ...strayLines(parts.rendered),
    ...questions(parts.rendered),
    ...proseCap(parts.rendered, caps.proseWords),
    ...missing(parts, lines),
    ...(startAt === undefined ? [] : view(startAt)),
    ...(facts === undefined ? [] : decided(facts, caps.decided)),
    ...clips(parts, caps.clips),
  ].toSorted((a, b) => a.line - b.line);
}

/**
 * The caps of the repository around `start`: `.github/github-flow.json`, looked
 * for from `start` up to the first directory holding `.git`, its key `pr`
 * merged over the defaults. Throws on a file that is no JSON object or a cap
 * that is no positive integer.
 */
export function readCaps(start: string): Caps {
  let dir = resolve(start);

  for (;;) {
    const file = join(dir, SETTINGS_FILE);

    if (existsSync(file)) return capsFrom(file, readFileSync(file, "utf8"));

    const parent = dirname(dir);

    if (existsSync(join(dir, ".git")) || parent === dir) return { ...DEFAULT_CAPS };

    dir = parent;
  }
}

/** The settings file as JSON gives it, checked key by key before a cap is used. */
interface Settings {
  readonly pr?: Readonly<Partial<Caps>> | null;
}

function capsFrom(file: string, source: string): Caps {
  let settings: Settings | null;

  try {
    // SAFETY: every cap is checked below before it is used; an unknown key or a value that is no positive integer throws.
    settings = JSON.parse(source) as Settings | null;
  } catch (error) {
    throw new Error(
      `${file}: not JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (Array.isArray(settings) || Object(settings) !== settings) {
    throw new Error(`${file}: not a JSON object`);
  }

  const own = settings?.pr;

  if (own === undefined || own === null) return { ...DEFAULT_CAPS };

  if (Array.isArray(own) || Object(own) !== own) throw new Error(`${file}: "pr" is not an object`);

  for (const [key, value] of Object.entries(own)) {
    if (!Object.hasOwn(DEFAULT_CAPS, key)) {
      throw new Error(
        `${file}: "pr.${key}" is no cap; the caps are ${Object.keys(DEFAULT_CAPS).join(", ")}`,
      );
    }

    if (!Number.isInteger(value) || (value ?? 0) < 1) {
      throw new Error(`${file}: "pr.${key}" is not a positive integer`);
    }
  }

  return { ...DEFAULT_CAPS, ...own };
}

/** One finding per line: `<file>:<line>: <check>: <message>`. */
export function formatFindings(findings: readonly Finding[], file: string): string {
  return findings
    .map(({ check, line, message }) => `${file}:${line}: ${check}: ${message}`)
    .join("\n");
}

if (import.meta.main) {
  const files = Bun.argv.slice(2);

  if (files.length === 0) {
    console.error("usage: bun check-pr.ts <body.md|-> [<body.md>...]");
    process.exit(2);
  }

  let caps: Caps;

  try {
    caps = readCaps(process.cwd());
  } catch (error) {
    console.error(`check-pr: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  let found = 0;

  for (const file of files) {
    let body: string;

    try {
      body = file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8");
    } catch (error) {
      console.error(
        `check-pr: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    }

    const findings = checkBody(body, caps);
    found += findings.length;

    if (findings.length > 0) console.log(formatFindings(findings, file));
  }

  process.exit(found > 0 ? 1 : 0);
}
