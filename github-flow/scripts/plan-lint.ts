#!/usr/bin/env bun

/**
 * The checks a script can decide on a plan, with no model call: what the
 * ExitPlanMode gate (`gate-plan.ts`) refuses, and what `bun plan-lint.ts
 * <plan.md>` prints. The checks measured and left out, and why, are in the
 * github-flow README under "Plan lint".
 */

export type CheckId = "placeholder" | "open-question";

export interface Finding {
  check: CheckId;
  /** 1-based, as the plan file is numbered. */
  line: number;
  message: string;
}

interface ProseLine {
  line: number;
  /** The line without code spans, then HTML comments and link targets; empty inside a fence. */
  prose: string;
  heading: { level: number; title: string } | null;
}

// Any indent: a fence nested in a list item sits four spaces in or more.
const FENCE = /^\s*(`{3,}|~{3,})/u;

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/u;

// `\b` is ASCII-only even with the `u` flag: a word that starts or ends on an
// accented letter is bounded by a `\p{L}` lookaround instead.
const PLACEHOLDERS: readonly RegExp[] = [
  /\b(?:TBD|TBC)\b/u,
  /\?{3,}/u,
  /\bto be (?:decided|determined|defined)\b/iu,
  /(?<!\p{L})(?:(?:reste|restent) )?à (?:décider|définir|trancher|déterminer|préciser)\b/iu,
  /\bdecided? (?:at implementation|during implementation|when implementing)\b/iu,
  /\bdécider? (?:à l'implémentation|pendant l'implémentation)\b/iu,
];

/** A choice the plan hands to another piece of work is no hole in this one. */
const OUT_OF_PLAN =
  /out of (?:scope|this plan)|separately|hors (?:de ce plan|périmètre|scope)|séparément/iu;

/** A choice deferred to a later phase or milestone: a phased plan details only its current phase. */
const LATER: readonly RegExp[] = [
  /(?<!\p{L})(?:plus tard|later)(?!\p{L})/iu,
  /(?<!\p{L})(?:en|in|at|during|pendant|au|à la|for|pour la|pour le) (?:phase|tranche|slice|stage|étape|jalon|milestone|lot) [\w.-]+/iu,
  /(?<!\p{L})(?:jalon|milestone) [A-Z]?\d+(?!\p{L})/iu,
  /(?<!\p{L})(?:(?:next|following) (?:phase|slice|stage|milestone|step)|(?:prochaine?|suivante?) (?:phase|tranche|étape|jalon)|(?:phase|tranche|étape|jalon) (?:suivante?|ultérieure?))(?!\p{L})/iu,
];

const OPEN_QUESTIONS =
  /^(?:\d+[.)]?\s*)?(?:open questions?|questions? (?:ouvertes?|restantes?|en suspens)|unresolved questions?|questions? still open|points? (?:ouverts?|à trancher|en suspens)|à trancher)\b/iu;

/** A heading that marks its questions answered, the word after a comma, a bracket, a colon or a dash. */
const SETTLED_HEADING =
  /[,(:—–-]\s*(?:all |toutes )?(?:answered|resolved|settled|closed|résolues?|tranchées?|répondues?|fermées?)(?!\p{L})/iu;

/** A line that says its choice is settled in the plan itself. */
const SETTLED_HERE =
  /(?<!\p{L})(?:tranch(?:é|ée|és|ées)|settled|decided|answered|resolved|résolu(?:e|s|es)?)\s+(?:ici|here|below|ci-dessous|plus bas|in this plan|dans ce plan)(?!\p{L})/iu;

/** Words that state the option the author would take; one match settles a question. */
const STATED_OPTION: readonly RegExp[] = [
  /recommend|propos|default|\bassum|\blean|\blikely\b|\bfallback\b|\bchosen\b|\bchallenge/iu,
  /\bmy (?:option|pick|choice)\b|\boption (?:I|taken)\b|\bI(?:['’]d| would)\b/iu,
  /\bI(?:['’]ll| will) (?:take|pick|go|choose|keep|use)\b|\bdecision\s*:/iu,
  /recommand|défaut|\bsuppos|\bretenu|\bchoisi(?:e|s|es)?(?!\p{L})|\bcontest|\brepli\b|\bprobablement\b|plutôt(?!\p{L})/iu,
  /\bmon (?:choix|option)\b|\boption (?:prise|que je)\b|\bdécision\s*:|\bchoix\s*:/iu,
  /\bje (?:prendrais|partirais|garderais|laisserais|choisirais|pars|retiens|garde|choisis)\b/iu,
  /→|⇒/u,
];

/** A section that says it holds no question, not a question that opens on "Nothing" or "Rien". */
const NONE: readonly RegExp[] = [
  /^\W*(?:none|aucune?|n\/a)(?:\s*(?:[.,;:!—–-]|$)|\s+(?:pour|for|à part|apart|besides|yet|so far)(?!\p{L}))/iu,
  /^\W*(?:no|aucune?) (?:open )?(?:questions?|points?)(?!\p{L})/iu,
  /^\W*(?:rien à (?:trancher|décider)|nothing (?:open|left|to decide))(?!\p{L})/iu,
];

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/u;

function scan(text: string): ProseLine[] {
  const lines: ProseLine[] = [];
  let fence: { char: string; length: number } | null = null;
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

      if (closes) fence = null;
      lines.push({ line, prose: "", heading: null });
      continue;
    }

    if (marker !== undefined && !inComment) {
      fence = { char: marker.slice(0, 1), length: marker.length };
      lines.push({ line, prose: "", heading: null });
      continue;
    }

    let prose = raw.replaceAll(/(`+)[^`]*?\1/gu, "");

    if (inComment) {
      const end = prose.indexOf("-->");
      inComment = end === -1;
      prose = inComment ? "" : prose.slice(end + 3);
    }

    prose = prose.replaceAll(/<!--.*?-->/gu, "");
    const open = prose.indexOf("<!--");

    if (open !== -1) {
      prose = prose.slice(0, open);
      inComment = true;
    }

    prose = prose.replaceAll(/\]\([^)]*\)/gu, "]");
    const heading = HEADING.exec(prose);
    const level = heading?.[1]?.length;
    const title = heading?.[2]?.replaceAll(/[*_]/gu, "").trim();

    lines.push({
      line,
      prose,
      heading: level !== undefined && title !== undefined ? { level, title } : null,
    });
  }

  return lines;
}

function placeholders(lines: readonly ProseLine[]): Finding[] {
  return lines.flatMap(({ line, prose, heading }) => {
    const skipped =
      heading !== null ||
      OUT_OF_PLAN.test(prose) ||
      SETTLED_HERE.test(prose) ||
      LATER.some((pattern) => pattern.test(prose));

    if (skipped) return [];

    const found = PLACEHOLDERS.map((pattern) => pattern.exec(prose)?.[0]).find(
      (match) => match !== undefined,
    );

    return found === undefined
      ? []
      : [
          {
            check: "placeholder" as const,
            line,
            message: `"${found}" leaves a choice to the implementer: settle it in the plan, or ask the user before ExitPlanMode.`,
          },
        ];
  });
}

/**
 * The questions of a section: its top-level list items when it opens on a list.
 * A section written in paragraphs is one question: its options and the pick
 * often sit in separate paragraphs under the question.
 */
function questions(section: readonly ProseLine[]): { line: number; text: string }[] {
  const content = section.filter(({ prose }) => prose.trim().length > 0);
  const first = content[0];

  if (first === undefined || NONE.some((pattern) => pattern.test(first.prose))) return [];
  const base = LIST_ITEM.exec(first.prose)?.[1]?.length;

  if (base === undefined) {
    return [{ line: first.line, text: content.map(({ prose }) => prose.trim()).join(" ") }];
  }

  const found: { line: number; text: string }[] = [];

  for (const { line, prose } of content) {
    const last = found.at(-1);

    if (LIST_ITEM.exec(prose)?.[1]?.length === base) found.push({ line, text: prose });
    else if (last !== undefined) last.text += ` ${prose.trim()}`;
  }

  return found;
}

/** The option is read outside the question's own sentences: "Which default …?" takes none. */
function takesOption(text: string): boolean {
  const answer = text.replaceAll(/[^.?!]*\?/gu, "");

  return STATED_OPTION.some((pattern) => pattern.test(answer));
}

function openQuestions(lines: readonly ProseLine[]): Finding[] {
  return lines.flatMap(({ heading }, start) => {
    if (
      heading === null ||
      !OPEN_QUESTIONS.test(heading.title) ||
      SETTLED_HEADING.test(heading.title)
    ) {
      return [];
    }

    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.heading !== null && l.heading.level <= heading.level);

    return questions(end === -1 ? rest : rest.slice(0, end))
      .filter(({ text }) => !takesOption(text))
      .map(({ line }) => ({
        check: "open-question" as const,
        line,
        message:
          'an open question with no option taken: write the option you would take and why ("Default: ..."), or ask the user before ExitPlanMode.',
      }));
  });
}

export function lintPlan(text: string): Finding[] {
  const lines = scan(text);

  return [...placeholders(lines), ...openQuestions(lines)].toSorted((a, b) => a.line - b.line);
}

/** One finding per line: `line N: <check>: <message>`, or `<file>:N: ...` when a file is named. */
export function formatFindings(findings: readonly Finding[], file?: string): string {
  return findings
    .map(({ check, line, message }) => {
      const at = file === undefined ? `line ${line}` : `${file}:${line}`;

      return `${at}: ${check}: ${message}`;
    })
    .join("\n");
}

if (import.meta.main) {
  const files = Bun.argv.slice(2);

  if (files.length === 0) {
    console.error("usage: bun plan-lint.ts <plan.md> [<plan.md>...]");
    process.exit(2);
  }

  let found = 0;

  for (const file of files) {
    let text: string;

    try {
      text = await Bun.file(file).text();
    } catch (error) {
      console.error(
        `plan-lint: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    }

    const findings = lintPlan(text);
    found += findings.length;

    if (findings.length > 0) console.log(formatFindings(findings, file));
  }

  process.exit(found > 0 ? 1 : 0);
}
