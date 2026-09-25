import type {
  Closed,
  Failed,
  Finding,
  Outcome,
  Place,
  ReviewPosts,
  Reviews,
  ReviewState,
  ReviewStatus,
  Run,
  Size,
  Stopping,
  Verdict,
} from "./protocol.ts";

/**
 * The boundary of `review`: the verdict is a text the plan reviewer wrote, a model, read here by
 * its lines, once. Every marker is a whole line at the left margin, so the same words inside a
 * finding or an indented quote are text.
 */

const HEADING = "## Plan review";

const STATUS = {
  "Status: Approved": "approved",
  "Status: Issues found": "issuesFound",
} as const satisfies Record<string, ReviewStatus>;

const SIZE = /^Verdict: (overengineered|underengineered|right) [-–—] (.+)$/u;

const LISTS = { "Issues:": "issues", "Advisory (does not block):": "advisories" } as const;

const ITEM = /^- (?:\[([^\]]+)\] )?(.+)$/u;

const QUOTE = /^\s+> ?(.*)$/u;

/** A wrapped line or a nested point: indented, it belongs to the finding above it. */
const CONTINUED = /^\s+(\S.*)$/u;

/** The format is shown in a fence, and the agent may copy it. */
const FENCE = /^(?:`{3,}|~{3,})\S*$/u;

const LINES = /^lines? (\d+)(?:\s*[-–—]\s*(\d+))?: (.+)$/iu;

type List = (typeof LISTS)[keyof typeof LISTS];

type Item = {
  readonly section: string | null;
  readonly rest: string;
  readonly more: string[];
  readonly quote: string[];
};

function isSize(value: string | undefined): value is Size {
  return value === "overengineered" || value === "underengineered" || value === "right";
}

function isStatus(line: string): line is keyof typeof STATUS {
  return Object.hasOwn(STATUS, line);
}

function isList(line: string): line is keyof typeof LISTS {
  return Object.hasOwn(LISTS, line);
}

/** Anchored when the item names its lines and a quote follows it; otherwise its text as written. */
function findingOf({ section, rest, more, quote }: Item): Finding {
  const [, start, end, text] = LINES.exec(rest) ?? [];
  const first = Number(start);
  const last = end === undefined ? first : Number(end);

  if (quote.length === 0 || text === undefined || first < 1 || last < first) {
    const quoted = quote.map((line) => `\n> ${line}`).join("");

    return { section, text: `${[rest, ...more].join("\n")}${quoted}`, place: null };
  }

  const place: Place = { lines: [first, last], quote: quote.join("\n") };

  return { section, text: [text, ...more].join("\n"), place };
}

/** `null` for a text that is not a whole verdict: no heading, a status or a size missing or twice, a line the format does not name. */
export function parseVerdict(text: string): Verdict | null {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const start = lines.indexOf(HEADING);

  if (start === -1) return null;
  let status: ReviewStatus | null = null;
  let size: Verdict["size"] | null = null;
  let list: List | null = null;
  const items: Record<List, Item[]> = { issues: [], advisories: [] };

  for (const line of lines.slice(start + 1)) {
    const quote = QUOTE.exec(line);
    const continued = CONTINUED.exec(line);
    const item = ITEM.exec(line);
    const [, kind, why] = SIZE.exec(line) ?? [];
    const last = list === null ? undefined : items[list].at(-1);

    if (line === "" || FENCE.test(line)) continue;

    if (isStatus(line) && status === null) status = STATUS[line];
    else if (isSize(kind) && why !== undefined && size === null) size = { kind, why };
    else if (isList(line)) list = LISTS[line];
    else if (quote !== null && last !== undefined) last.quote.push(quote[1] ?? "");
    else if (continued !== null && last !== undefined) last.more.push(continued[1] ?? "");
    else if (item !== null && list !== null) {
      items[list].push({ section: item[1] ?? null, rest: item[2] ?? "", more: [], quote: [] });
    } else return null;
  }

  if (status === null || size === null) return null;

  return {
    status,
    size,
    issues: items.issues.map((item) => findingOf(item)),
    advisories: items.advisories.map((item) => findingOf(item)),
  };
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- the block below IS the boundary parser the rules ask for: it validates the JSON bodies the page and the hooks module post, the server's answers the hooks module reads, and `.review/reviews.json`, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A run's number or a version: an integer from 1. */
function counted(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function filled(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseRun(value: unknown): Run | null {
  if (!isRecord(value)) return null;
  const seq = counted(value.seq);
  const version = counted(value.version);

  if (seq === null || version === null) return null;

  if (value.kind === "requested") return { kind: "requested", seq, version };
  const agentId = filled(value.agentId);
  const model = filled(value.model);

  return value.kind === "running" && agentId !== null && model !== null
    ? { kind: "running", seq, version, agentId, model }
    : null;
}

function parseFailed(value: unknown): Failed | null {
  if (!isRecord(value)) return null;
  const seq = counted(value.seq);
  const version = counted(value.version);
  const model = value.model === null ? null : filled(value.model);
  const why = filled(value.why);

  if (value.model !== null && model === null) return null;

  return seq === null || version === null || why === null ? null : { seq, version, model, why };
}

function parseStopping(value: unknown): Stopping[] | null {
  if (!Array.isArray(value)) return null;
  const stopping: Stopping[] = [];

  for (const item of value) {
    const seq = isRecord(item) ? counted(item.seq) : null;
    const agentId = isRecord(item) ? filled(item.agentId) : null;

    if (seq === null || agentId === null) return null;
    stopping.push({ seq, agentId });
  }

  return stopping;
}

/** `GET state`'s answer; `null` for one that is no state. */
export function parseReviewState(value: unknown): ReviewState | null {
  if (!isRecord(value)) return null;
  const run = value.run === null ? null : parseRun(value.run);
  const failed = value.failed === null ? null : parseFailed(value.failed);
  const stopping = parseStopping(value.stopping);
  const { resubmit } = value;

  if ((value.run !== null && run === null) || (value.failed !== null && failed === null)) {
    return null;
  }

  return stopping === null || typeof resubmit !== "boolean"
    ? null
    : { run, failed, stopping, resubmit };
}

/** `POST close`'s answer; `null` for one that is not it. */
export function parseClosed(value: unknown): Closed | null {
  const stopping = isRecord(value) ? parseStopping(value.stopping) : null;

  return stopping === null ? null : { stopping };
}

/** `.review/reviews.json`: the state and the last number a run took. */
export function parseReviews(value: unknown): Reviews | null {
  const state = parseReviewState(value);

  if (state === null || !isRecord(value)) return null;
  const { seq } = value;

  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? { ...state, seq } : null;
}

function parseOutcome(value: unknown): Outcome | null {
  if (!isRecord(value)) return null;

  if (value.kind === "answer") {
    const answer = filled(value.text);

    return answer === null ? null : { kind: "answer", text: answer };
  }

  const why = filled(value.why);

  return value.kind === "failed" && why !== null ? { kind: "failed", why } : null;
}

function seqOf(value: unknown): { readonly seq: number } | null {
  const seq = isRecord(value) ? counted(value.seq) : null;

  return seq === null ? null : { seq };
}

/** Each route's body; `null` for one that is not it. */
export const parsePosts: {
  readonly [Name in keyof ReviewPosts]: (value: unknown) => ReviewPosts[Name] | null;
} = {
  request: (value) => {
    const version = isRecord(value) ? counted(value.version) : null;

    return version === null ? null : { version };
  },
  launched: (value) => {
    const seq = seqOf(value);
    const agentId = isRecord(value) ? filled(value.agentId) : null;
    const model = isRecord(value) ? filled(value.model) : null;

    return seq === null || agentId === null || model === null ? null : { ...seq, agentId, model };
  },
  ended: (value) => {
    const seq = seqOf(value);
    const outcome = isRecord(value) ? parseOutcome(value.outcome) : null;

    return seq === null || outcome === null ? null : { ...seq, outcome };
  },
  forget: seqOf,
  close: (value) => (isRecord(value) ? {} : null),
  stopped: seqOf,
  resubmitted: (value) => (isRecord(value) ? {} : null),
};

export function parseError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string" ? value.error : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */
