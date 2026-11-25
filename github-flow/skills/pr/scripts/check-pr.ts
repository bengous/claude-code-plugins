#!/usr/bin/env bun

/**
 * The shape of a pull request body, checked with no model call: what the `pr`
 * skill runs on its body before it publishes, and what
 * `bun check-pr.ts <body.md>...` prints. `SKILL.md` beside this directory says
 * the shape; this file holds its contract: the section set, the caps and the
 * refusals.
 *
 * It imports only `node:` modules, so the skill directory copied whole into
 * another repository runs it there.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CheckId =
  | "section"
  | "open-point"
  | "missing"
  | "order"
  | "question"
  | "not-run"
  | "recap"
  | "prose"
  | "why"
  | "danger"
  | "view"
  | "decided"
  | "clip"
  | "checks"
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

const SECTIONS = ["Why", "Danger", "Start at", "Proof", "Decided", "Checks"] as const;

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

/** What may stand before **Why**: the issue it closes. A line wholly in italics is a host's attribution. */
const PREAMBLE = /^(?:(?:closes|fixes|resolves) #\d+(?:,? #\d+)*\.?|_[^_].*_|\*[^*].*\*)$/iu;

/** The footer opens on who wrote the body: `<sub>Written by <model></sub>`, or a tool's own line. */
const FOOTER =
  /^(?:<sub>\s*(?:[_*]\s*)?(?:\p{Extended_Pictographic}\s*)?|[_*]\s*(?:\p{Extended_Pictographic}\s*)?|\p{Extended_Pictographic}\s*)(?:written|generated|opened) (?:by|with)\b/iu;

/** A section the shape has no place for, whatever its markup. */
const OPEN_POINT =
  /^(?:asks?|left open|not shown|known (?:gaps?|issues?|limits?)|open (?:questions?|points?)|questions?|unresolved|follow[- ]ups?|next steps?|to ?dos?|caveats?|limitations?)(?:\s*[:*_]|\s*$)/iu;

/** A line on what did not run, anywhere: a verification left out, not a behaviour ("not run for subagents"). */
const NOT_RUN: readonly RegExp[] = [
  /\b(?:not|never|could not|couldn['’]t|cannot|can['’]t) (?:yet |be |been )?(?:\w+-)?(?:played|tested|verified|measured|exercised|rendered)\b/iu,
  // A run left out, not a behaviour: "not run for subagents" and "never run by hand" pass.
  /\b(?:not|never|cannot|can['’]t) (?:yet |be |been )?(?:run|ran|executed|checked)\b(?! (?:for|by|when|if|unless|on (?:every|each))\b)/iu,
  /(?<!\p{L})(?:non|pas) (?:été )?(?:lancée?s?|jouée?s?|testée?s?|vérifiée?s?|mesurée?s?)(?!\p{L})/iu,
];

/** Words that say a run was left out only where a body reports runs: **Checks** and the footer. */
const NOT_RUN_WORDS = /\b(?:untested|unverified|unmeasured|unplayed)\b|(?<!\d )\bskipped\b/iu;

/** A recap of the review: the review is on the pull request, not in its body. A lint's "0 findings" is no recap. */
/** A recap anywhere: a reviewer's command, or what a review found. */
const RECAP_FORM =
  /(?<![\w./-])\/code-review(?![\w/.-])|(?<![\w/.-])(?:plugin-dev:)?skill-reviewer(?![\w/.-])|\breview(?:er)?s? (?:found|raised|flagged|reported)\b|\bfindings?,? (?:all |both )?(?:fixed|addressed|resolved)\b/iu;

const RECAP = /\b(?:code-review|skill-reviewer|reviewers?|reviewed|reviews?)\b/iu;

/** A URL, without the stop that may end its sentence. */
const WEB_ADDRESS = /\bhttps?:\/\/\S*[^\s.,;:!?)]/gu;

const DOOR = /\b(?:one|two)-way\b/iu;

const REACH = /\breach(?:es|ed|ing)?\b/iu;

/** A sentence ends on a stop followed by a capital, a digit or the end. */
const SENTENCE_END = /[.!?](?=\s+[\p{Lu}\p{N}]|\s*$)/gu;

/** A stop that ends no sentence: `e.g.`, `i.e.`, `vs.`, `etc.`, `cf.`, `approx.`, `No.`... */
const ABBREVIATION = /(?<![\p{L}.])(?:e\.g|i\.e|vs|etc|cf|approx|ca|fig|no|al)\./giu;

const CLIP = /\.(?:mp4|mov|webm)$/iu;

const LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?[^)]*\)|<video[^>]*\ssrc=["']([^"']+)["']/giu;

const PROTOCOL = /^protocol\b/iu;

const E2E_TEST = /`[^`]*(?:e2e|\.(?:spec|test)\.[cm]?[jt]sx?)[^`]*`/iu;

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

/** The words a reader reads: no code span, no link target, no WEB_ADDRESS, no tag, no lead-in label. */
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
  /** The lines before the footer; the whole body when there is none. */
  body: Line[];
  footer: Line | null;
  findings: Finding[];
}

function split(lines: readonly Line[]): Parts {
  const lastLeadIn = lines.findLastIndex((l) => l.opens !== null);

  const footerAt = lines.findIndex(
    (l, i) => i > lastLeadIn && l.kind === "prose" && FOOTER.test(l.raw.trim()),
  );

  const body = footerAt === -1 ? [...lines] : lines.slice(0, footerAt);
  const sections = new Map<Section, Line[]>();
  const findings: Finding[] = [];
  let current: Line[] | null = null;
  let rank = -1;

  for (const l of body) {
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

  return { sections, body, footer: footerAt === -1 ? null : (lines[footerAt] ?? null), findings };
}

/** A text without its tags and the markup in front of it. */
function bare(text: string): string {
  return text.replaceAll(/<[^>]+>/gu, " ").replace(/^[\s#>*_\-+\d.):]+/u, "");
}

/** A line, or a table cell, that names an open point, its tags and its markup aside. */
function namesOpenPoint(l: Line): boolean {
  if (l.kind === "table") return l.raw.split("|").some((cell) => OPEN_POINT.test(bare(cell)));

  return OPEN_POINT.test(bare(l.raw));
}

function strayLines(body: readonly Line[]): Finding[] {
  return body.flatMap((l): Finding[] => {
    if (l.kind !== "prose" && l.kind !== "table") return [];

    if (namesOpenPoint(l)) {
      return [
        {
          check: "open-point",
          line: l.line,
          message:
            "an open point: the body leaves nothing open. Settle it as a fact under **Decided**, or leave it to an issue.",
        },
      ];
    }

    if (l.kind === "table") return [];

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

function questions(body: readonly Line[]): Finding[] {
  return body.flatMap((l): Finding[] =>
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

function proseCap(body: readonly Line[], cap: number): Finding[] {
  const counts = body.map((l) => (l.kind === "prose" ? wordCount(prose(l.raw)) : 0));
  const total = counts.reduce((sum, n) => sum + n, 0);
  let words = 0;

  for (const [index, l] of body.entries()) {
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

function sectionText(lines: readonly Line[]): string {
  return lines
    .flatMap((l) => (l.kind === "prose" ? [prose(l.raw)] : []))
    .join(" ")
    .trim();
}

function why(lines: readonly Line[]): Finding[] {
  const sentences =
    sectionText(lines).replaceAll(ABBREVIATION, "_").match(SENTENCE_END)?.length ?? 0;

  const at = lines[0]?.line ?? 1;

  return sentences > 1
    ? [
        {
          check: "why",
          line: at,
          message: `**Why** holds ${sentences} sentences: one says why the change exists.`,
        },
      ]
    : [];
}

function danger(lines: readonly Line[]): Finding[] {
  // The door may sit in a code span: `two-way`.
  const said = lines.map((l) => l.raw.replace(LEAD_IN, "").replaceAll("`", "")).join(" ");
  const at = lines[0]?.line ?? 1;
  const findings: Finding[] = [];

  if (!DOOR.test(said)) {
    findings.push({
      check: "danger",
      line: at,
      message: "**Danger** names no door: one-way or two-way, whether the change can be undone.",
    });
  }

  if (!REACH.test(said)) {
    findings.push({
      check: "danger",
      line: at,
      message: "**Danger** names no reach: what breaks if the change is wrong.",
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
            "no view under **Start at**: one pseudocode, call tree or file tree as a diff, a table, or a Mermaid diagram for a topology.",
        },
      ];
}

function decided(lines: readonly Line[], cap: number): Finding[] {
  // A fact is a list item, a table row, or a paragraph: the lead-in's own text included, an intro
  // ending on a colon left out, the lines a paragraph or an item wraps onto counted once.
  const facts = lines.filter((l, i) => {
    if (l.kind === "table") {
      return !TABLE_RULE.test(l.raw) && !TABLE_RULE.test(lines[i + 1]?.raw ?? "");
    }

    const said = l.kind === "prose" ? prose(l.raw).trim() : "";

    if (said === "") return false;

    if (LIST_ITEM.test(l.raw)) return true;

    if (said.endsWith(":")) return false;

    const before = lines[i - 1];

    return before === undefined || before.kind !== "prose" || prose(before.raw).trim() === "";
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

function checks(lines: readonly Line[]): Finding[] {
  const findings: Finding[] = [];

  const counted = lines.some(
    (l) =>
      l.kind !== "comment" &&
      /\d/u.test(
        (l.kind === "prose" ? prose(l.raw) : l.raw)
          .replaceAll(WEB_ADDRESS, "")
          .replaceAll(/#\d+/gu, ""),
      ),
  );

  if (!counted) {
    findings.push({
      check: "checks",
      line: lines[0]?.line ?? 1,
      message: "**Checks** gives no number: what ran, with its counts.",
    });
  }

  return findings;
}

/** `broad`: the lines where any word of a review is a recap, **Checks** and the footer; elsewhere only its forms. */
function recaps(lines: readonly Line[], broad: readonly Line[]): Finding[] {
  const recap = (l: Line): boolean =>
    RECAP_FORM.test(l.raw.replaceAll("`", "")) || (broad.includes(l) && RECAP.test(prose(l.raw)));

  return lines.flatMap((l): Finding[] =>
    (l.kind === "prose" || l.kind === "table") && recap(l)
      ? [
          {
            check: "recap",
            line: l.line,
            message:
              "a review recap: the review lives on the pull request. **Checks** names what ran, with its numbers.",
          },
        ]
      : [],
  );
}

/** Prose before the first section other than the issue it closes: the shape opens on **Why**. */
function preamble(lines: readonly Line[]): Finding[] {
  const first = lines.findIndex((l) => l.opens !== null);

  return lines.slice(0, Math.max(first, 0)).flatMap((l): Finding[] =>
    l.kind === "prose" && prose(l.raw).trim() !== "" && !PREAMBLE.test(l.raw.trim())
      ? [
          {
            check: "section",
            line: l.line,
            message: "prose before **Why**: the body opens on `Closes #N.`, then **Why**.",
          },
        ]
      : [],
  );
}

/** The footer and the lines under it: GitHub renders them, and the shape gives them no section. */
function underFooter(lines: readonly Line[], parts: Parts): Line[] {
  return parts.footer === null ? [] : lines.slice(lines.indexOf(parts.footer));
}

/** `reports`: the lines that report runs, where a word alone such as skipped says a run was left out. */
function notRun(lines: readonly Line[], reports: readonly Line[]): Finding[] {
  const leftOut = (l: Line): boolean => {
    const said = prose(l.raw);

    return NOT_RUN.some((p) => p.test(said)) || (reports.includes(l) && NOT_RUN_WORDS.test(said));
  };

  return lines.flatMap((l): Finding[] =>
    (l.kind === "prose" || l.kind === "table") && leftOut(l)
      ? [
          {
            check: "not-run",
            line: l.line,
            message:
              "a line on what did not run: the body names what ran. Run it, or leave the line out.",
          },
        ]
      : [],
  );
}

/** A protocol line, or a table cell that opens on one. */
function protocolLine(l: Line): boolean {
  if (l.kind === "prose") return PROTOCOL.test(unmarked(l.raw));

  return l.kind === "table" && l.raw.split("|").some((cell) => PROTOCOL.test(unmarked(cell)));
}

/** A line without its list marker, quote or emphasis in front. */
function unmarked(raw: string): string {
  return raw.replace(/^[\s>*_\-+]+/u, "");
}

/** Every line GitHub renders as the body's, the footer line aside. */
function rendered(lines: readonly Line[], parts: Parts): Line[] {
  return lines.filter((l) => l !== parts.footer);
}

function clips(lines: readonly Line[], cap: number): Finding[] {
  const found = lines.flatMap((l, at) => {
    if (l.kind === "code" || l.kind === "comment") return [];

    return [...l.raw.matchAll(LINK_TARGET)].flatMap((m) =>
      CLIP.test(m[1] ?? m[2] ?? "") ? [{ l, at }] : [],
    );
  });

  const findings: Finding[] = [];

  for (const { l, at } of found) {
    // Each clip owns the lines from it to the next clip on a later line or the next section,
    // whichever comes first: two clips of one table row share their lines.
    const nextSection = lines.findIndex((x, i) => i > at && x.opens !== null);

    const end = Math.min(
      found.find((f) => f.at > at)?.at ?? lines.length,
      nextSection === -1 ? lines.length : nextSection,
    );

    const own = lines.slice(at, end);

    if (!own.some((x) => protocolLine(x))) {
      findings.push({
        check: "clip",
        line: l.line,
        message:
          "a clip with no protocol line: under it, before the next clip, `Protocol: <build>, <viewport>, <page>, <action>`.",
      });
    }

    if (!own.some((x) => E2E_TEST.test(x.raw))) {
      findings.push({
        check: "clip",
        line: l.line,
        message:
          "a clip with no e2e test named: under it, before the next clip, the test that asserts what it shows.",
      });
    }
  }

  const over = found[cap];

  if (over !== undefined) {
    findings.push({
      check: "clip",
      line: over.l.line,
      message: `${found.length} clips, past the cap of ${cap}: a still proves a state, a clip only a transition.`,
    });
  }

  return findings;
}

export function checkBody(body: string, caps: Readonly<Caps> = DEFAULT_CAPS): Finding[] {
  const lines = classify(body);
  const parts = split(lines);
  const section = (name: Section): Line[] => parts.sections.get(name) ?? [];
  const has = (name: Section): boolean => parts.sections.has(name);

  return [
    ...parts.findings,
    ...strayLines(rendered(lines, parts)),
    ...questions(rendered(lines, parts)),
    ...proseCap(rendered(lines, parts), caps.proseWords),
    ...missing(parts, lines),
    ...(has("Why") ? why(section("Why")) : []),
    ...(has("Danger") ? danger(section("Danger")) : []),
    ...(has("Start at") ? view(section("Start at")) : []),
    ...(has("Decided") ? decided(section("Decided"), caps.decided) : []),
    ...(has("Checks") ? checks(section("Checks")) : []),
    ...recaps(lines, [...section("Checks"), ...underFooter(lines, parts)]),
    ...notRun(lines, [...section("Checks"), ...underFooter(lines, parts)]),
    ...preamble(lines),
    ...clips(rendered(lines, parts), caps.clips),
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
