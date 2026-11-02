#!/usr/bin/env bun

/**
 * The leads scan (`docs/repo-ops/leads.md`), run by the `leads-scan` skill in a scan task the gate fires:
 *
 *   bun ./scripts/leads/scan.ts claim --tier minor|major [--issue <n>]
 *   bun ./scripts/leads/scan.ts publish --issue <n> --leads .leads/<n>-leads.json
 *   bun ./scripts/leads/scan.ts release --issue <n> --file .leads/<n>-release.json
 *
 * `claim` takes one open scan issue, puts `origin/dev` in a detached worktree at `.leads/<n>`, and writes beside it the
 * update's typed diff and notes for the model to read. `publish` checks the model's leads against that tree, files one
 * `lead` issue per new lead and closes the scan issue with their links. `release` gives the issue up to the human. The
 * model's text reaches GitHub through these files alone, never argv, and only after `sanitizeIssueText`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isRecord, isStringArray, stringField } from "../../agent-hooks/json.ts";
import { messageOf } from "../../tools/platform/pure.ts";
import {
  addLabel,
  announceDryRun,
  baseFacts,
  claimFree,
  clip,
  comment,
  commentsOn,
  commitOf,
  type Context,
  contextOf,
  type Env,
  ensureLabels,
  existingLeads,
  type Facts,
  fetchDev,
  git,
  type Hit,
  hitsOf,
  type Issue,
  issueNumberOf,
  isDryRun,
  issueOf,
  issuesWith,
  isScannable,
  type Json,
  LABEL,
  labelledAt,
  leadMarker,
  LEADS_DIR,
  leadsPath,
  manifestChanges,
  normKey,
  oneLine,
  parseJson,
  parseScanMarker,
  publicFacts,
  removeLabel,
  removeLeadsFile,
  renovatePrOf,
  sanitizeIssueText,
  textBlock,
  scanLabel,
  type Tier,
  TIERS,
  typedDiff,
  writeLeadsFile,
} from "./lib.ts";

const MAX_LEADS = 5;

const MAX_EVIDENCE = 10;

const MAX_DONE_WHEN = 5;

const TITLE_SUMMARY_MAX = 70;

export const CATEGORIES = ["feature", "cleanup", "compatibility", "docs"] as const;

export type Category = (typeof CATEGORIES)[number];

const LEAD_KEYS = new Set([
  "package",
  "api",
  "change",
  "category",
  "key",
  "summary",
  "evidence",
  "done_when",
  "hints",
]);

// ---------------------------------------------------------------------------
// The claim and its files
// ---------------------------------------------------------------------------

function worktreeOf(issue: number): string {
  return `${LEADS_DIR}/${issue}`;
}

/** What `claim` leaves for the commands after it: the issue, the tree the model searches, the update, the claim. */
export interface Claim {
  readonly issue: number;
  /** The commit of `origin/dev` the worktree holds, which the evidence's permalinks point at. */
  readonly tree: string;
  readonly sha: string;
  readonly package: string;
  readonly from: string;
  readonly to: string;
  readonly compare: string | null;
  readonly notesSource: string;
  /** Written in this claim's `claimed by` comment: the scan whose comment comes first holds the issue. */
  readonly token: string;
}

function claimName(issue: number): string {
  return `${issue}-claim.json`;
}

/** The one file each command reads from the model for `issue`, as the guard holds the model to. */
export function scanFile(issue: number, kind: "leads" | "release" | "query"): string {
  return `${LEADS_DIR}/${issue}-${kind}.${kind === "query" ? "txt" : "json"}`;
}

function checkFile(issue: number, kind: "leads" | "release" | "query", file: string): void {
  if (file !== scanFile(issue, kind)) {
    throw new Error(`#${issue}'s ${kind} file is ${scanFile(issue, kind)}, not ${file}`);
  }
}

function readClaim(ctx: Context, issue: number): Claim {
  const file = leadsPath(ctx, claimName(issue));

  if (!existsSync(file))
    throw new Error(`#${issue} has no claim in ${LEADS_DIR}/: run claim first`);

  const parsed = parseJson(readFileSync(file, "utf8"));

  const field = (name: string) => {
    const value = isRecord(parsed) ? stringField(parsed, name) : undefined;

    if (value === undefined) throw new Error(`${file}: no ${name}`);

    return value;
  };

  const compare = isRecord(parsed) ? stringField(parsed, "compare") : undefined;

  return {
    issue,
    tree: field("tree"),
    sha: field("sha"),
    package: field("package"),
    from: field("from"),
    to: field("to"),
    compare: compare ?? null,
    notesSource: field("notesSource"),
    token: field("token"),
  };
}

function claimComment(session: string, token: string): string {
  return `claimed by ${session} (claim ${token})`;
}

const CLAIM_COMMENT = /^claimed by .* \(claim ([0-9a-f-]{36})\)$/u;

/** The token of the claim that holds `issue`: the first `claimed by` comment since `lead:in-progress` was last put on. */
export function claimHolder(ctx: Context, issue: number): string | null {
  const since = labelledAt(ctx, issue, LABEL.inProgress);

  if (since === null) return null;

  // GitHub dates the label and the comment to the second: a comment of the label's second counts.
  const claims = commentsOn(ctx, issue).flatMap((entry) => {
    const match =
      entry.trusted && entry.createdAt >= since ? CLAIM_COMMENT.exec(entry.body.trim()) : null;

    return match === null ? [] : [{ token: match[1] ?? "", at: entry.createdAt, id: entry.id }];
  });

  return claims.toSorted((a, b) => a.at - b.at || a.id - b.id)[0]?.token ?? null;
}

/** Why this scan no longer holds its issue, or null while it does; a dry run posted no claim to hold. */
function claimLost(ctx: Context, claimed: Claim): string | null {
  if (isDryRun(ctx.env)) return null;

  const issue = issueOf(ctx.gh.call("GET", `repos/${ctx.repo}/issues/${claimed.issue}`));

  if (issue === null || !issue.open) return `#${claimed.issue} is no longer open`;

  return claimHolder(ctx, claimed.issue) === claimed.token
    ? null
    : `another scan holds #${claimed.issue} now`;
}

function removeWorktree(ctx: Context, issue: number): void {
  if (existsSync(join(ctx.root, worktreeOf(issue)))) {
    git(ctx, "worktree", "remove", "--force", worktreeOf(issue));
  }

  git(ctx, "worktree", "prune");
}

/** Why `issue` is no scan of `tier` to take now, or null when it is one. */
function refusal(ctx: Context, issue: Issue, tier: Tier, now: number): string | null {
  if (!isScannable(issue, tier)) {
    return `#${issue.number} is no open ${scanLabel(tier)} issue the pipeline wrote, or it is ${LABEL.unsure}`;
  }

  return claimFree(ctx, issue, now) ? null : `a scan holds #${issue.number} already`;
}

/** A value, or why there is none. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly why: string };

function issueToScan(ctx: Context, tier: Tier, wanted: number | null, now: number): Outcome<Issue> {
  if (wanted !== null) {
    const issue = issueOf(ctx.gh.call("GET", `repos/${ctx.repo}/issues/${wanted}`));

    if (issue === null) return { ok: false, why: `#${wanted} is a pull request` };

    const why = refusal(ctx, issue, tier, now);

    return why === null ? { ok: true, value: issue } : { ok: false, why };
  }

  const free = issuesWith(ctx, scanLabel(tier), "open").find(
    (issue) => refusal(ctx, issue, tier, now) === null,
  );

  return free === undefined
    ? { ok: false, why: `no open ${scanLabel(tier)} issue is free` }
    : { ok: true, value: free };
}

function factsTag(facts: Facts): string {
  return `<scan-facts>${JSON.stringify(publicFacts(facts)).replaceAll("<", "\\u003c")}</scan-facts>`;
}

export async function claim(
  ctx: Context,
  tier: Tier,
  wanted: number | null,
  now: number,
): Promise<number> {
  announceDryRun(ctx);

  const outcome = issueToScan(ctx, tier, wanted, now);

  if (!outcome.ok) {
    ctx.print(`nothing to scan: ${outcome.why}`);

    return 0;
  }

  const found = outcome.value;
  const ref = parseScanMarker(found.body);

  // A fresh clone may hold no origin/dev, or one older than the marker's commit.
  fetchDev(ctx);

  const change =
    ref === null
      ? undefined
      : manifestChanges(ctx, ref.sha).find((known) => known.package === ref.package);

  if (ref === null || change === undefined) {
    throw new Error(`#${found.number}: its marker names no version change git holds`);
  }

  ensureLabels(ctx);

  // A label added twice dates no new event: a stale claim's label comes off first, so this claim's time is the label's.
  if (found.labels.includes(LABEL.inProgress)) removeLabel(ctx, found.number, LABEL.inProgress);

  const token = crypto.randomUUID();
  const session = ctx.env["CLAUDE_CODE_REMOTE_SESSION_ID"] ?? "a local session";

  addLabel(ctx, found.number, LABEL.inProgress);
  comment(ctx, found.number, claimComment(session, token));

  // Two scans fired at once both get this far: the one whose comment came first holds the issue.
  if (!isDryRun(ctx.env) && claimHolder(ctx, found.number) !== token) {
    ctx.print(`nothing to scan: another scan claimed #${found.number} first`);

    return 0;
  }

  const tree = git(ctx, "rev-parse", "origin/dev");

  removeWorktree(ctx, found.number);
  git(ctx, "worktree", "add", "--detach", worktreeOf(found.number), tree);

  // The model writes these afresh: Claude Code's Write refuses to overwrite a file the session never read.
  for (const kind of ["query", "leads", "release"] as const) {
    removeLeadsFile(ctx, scanFile(found.number, kind).slice(`${LEADS_DIR}/`.length));
  }

  const base = await baseFacts(ctx, commitOf(ctx, ref.sha), change, renovatePrOf(ctx, ref.sha));
  const typed = typedDiff(ctx, change);
  const facts: Facts = { ...base, types: typed.types };
  const prefix = `${LEADS_DIR}/${found.number}`;

  writeLeadsFile(
    ctx,
    `${found.number}-types.diff`,
    typed.diff === "" ? "unavailable\n" : typed.diff,
  );
  writeLeadsFile(
    ctx,
    `${found.number}-notes.md`,
    facts.notes.text === "" ? "none\n" : `${facts.notes.text}\n`,
  );

  writeLeadsFile(
    ctx,
    claimName(found.number),
    `${JSON.stringify(
      {
        tree,
        sha: facts.sha,
        package: facts.package,
        from: facts.from,
        to: facts.to,
        compare: facts.notes.compare,
        notesSource: facts.notes.source,
        token,
      },
      null,
      2,
    )}\n`,
  );

  const leads = existingLeads(issuesWith(ctx, LABEL.lead, "all"), change.package);

  for (const line of [
    factsTag(facts),
    `issue: #${found.number}`,
    `tree: ${prefix}`,
    `types: ${prefix}-types.diff`,
    `notes: ${prefix}-notes.md (source ${facts.notes.source})`,
    `compare: ${facts.notes.compare ?? "none"}`,
    leads.length === 0 ? "existing leads: none" : "existing leads:",
    ...leads.map((lead) => `- ${lead.key} — ${lead.title} (${lead.open ? "open" : "closed"})`),
    `search with: ${scanFile(found.number, "query")}`,
    `write leads to: ${scanFile(found.number, "leads")}`,
  ]) {
    ctx.print(line);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const PATTERNS_MAX = 20;

const PATTERN_MAX = 200;

const SHOWN_MAX = 200;

const SHOWN_LINE_MAX = 240;

export interface Query {
  readonly patterns: readonly string[];
  readonly paths: readonly string[];
}

/** A query file: fixed strings to find, one a line, and `in: <path>` lines that narrow the search to paths of the tree. */
export function parseQuery(text: string, issue: number): Outcome<Query> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const paths = lines.flatMap((line) =>
    line.startsWith("in: ")
      ? [
          line
            .slice(4)
            .trim()
            .replace(new RegExp(`^(?:\\./)?${LEADS_DIR}/${issue}/`, "u"), ""),
        ]
      : [],
  );

  const patterns = lines.filter((line) => !line.startsWith("in: "));

  if (paths.some((path) => path.startsWith("/") || path.split("/").includes(".."))) {
    return { ok: false, why: "an in: path stays inside the tree: relative, with no .." };
  }

  if (patterns.length > PATTERNS_MAX || patterns.some((pattern) => pattern.length > PATTERN_MAX)) {
    return { ok: false, why: `at most ${PATTERNS_MAX} strings of ${PATTERN_MAX} characters each` };
  }

  return patterns.length === 0 && paths.length === 0
    ? { ok: false, why: "the query holds no string to find and no in: path to list" }
    : { ok: true, value: { patterns, paths } };
}

/**
 * Searches the claimed tree, since a session on Linux has no Grep or Glob tool and the guard allows no `grep`: the
 * lines that hold a query's strings, or with `in:` paths alone, the files there. Paths come prefixed with the tree's
 * directory, ready for Read.
 */
export function search(ctx: Context, issue: number, file: string): number {
  checkFile(issue, "query", file);

  const claimed = readClaim(ctx, issue);
  const query = parseQuery(readFileSync(resolve(ctx.root, file), "utf8"), issue);

  if (!query.ok) {
    ctx.print(`leads: ${query.why}`);

    return 1;
  }

  const prefix = `${worktreeOf(issue)}/`;
  const { patterns, paths } = query.value;
  const scope = ["--", ...(paths.length === 0 ? ["."] : paths)];

  // Literal pathspecs: an in: path is a path, never pathspec magic such as `:(exclude)`.
  const shown =
    patterns.length === 0
      ? git(ctx, "--literal-pathspecs", "ls-tree", "-r", "--name-only", claimed.tree, ...scope)
          .split("\n")
          .flatMap((path) => (path === "" ? [] : [`${prefix}${path}`]))
      : hitsIn(ctx, claimed.tree, patterns, scope).map(
          (hit) => `${prefix}${hit.path}:${hit.line}:${clip(hit.text, SHOWN_LINE_MAX)}`,
        );

  for (const line of shown.slice(0, SHOWN_MAX)) ctx.print(line);

  ctx.print(
    shown.length > SHOWN_MAX
      ? `${shown.length} found, the first ${SHOWN_MAX} shown: narrow the query`
      : `${shown.length} found`,
  );

  return 0;
}

function hitsIn(
  ctx: Context,
  tree: string,
  patterns: readonly string[],
  scope: readonly string[],
): Hit[] {
  const result = ctx.git([
    "--literal-pathspecs",
    "grep",
    "-n",
    "-I",
    "-F",
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    tree,
    ...scope,
  ]);

  if (result.code === 1) return [];

  if (result.code !== 0) throw new Error(`git grep in ${tree}: ${result.err.trim()}`);

  return hitsOf(result.out, tree);
}

// ---------------------------------------------------------------------------
// The model's leads
// ---------------------------------------------------------------------------

export interface Anchor {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export interface Lead {
  readonly api: string | null;
  readonly change: string | null;
  readonly category: Category;
  readonly key: string;
  readonly summary: string;
  readonly evidence: readonly Anchor[];
  readonly doneWhen: readonly string[];
  readonly hints: string;
}

/** The number of lines of a file at the claimed tree, null when the tree holds no such file. */
export type LineCount = (path: string) => number | null;

/** A `path:line[-line]` anchor in the claimed tree, its `.leads/<n>/` prefix dropped. */
export function parseAnchor(raw: string, issue: number, lineCount: LineCount): Outcome<Anchor> {
  const anchor = raw.trim().replace(new RegExp(`^(?:\\./)?${LEADS_DIR}/${issue}/`, "u"), "");
  const match = /^([^:\s]+):(\d+)(?:-(\d+))?$/u.exec(anchor);

  if (match === null) return { ok: false, why: `${raw} is no path:line or path:line-line` };

  const path = (match[1] ?? "").replace(/^\.\//u, "");
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);

  if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) {
    return { ok: false, why: `${raw} leaves the tree` };
  }

  const lines = lineCount(path);

  if (lines === null) return { ok: false, why: `${raw}: ${path} is not in the scanned tree` };

  if (start < 1 || end < start || end > lines) {
    return { ok: false, why: `${raw}: ${path} has ${lines} lines` };
  }

  return { ok: true, value: { path, start, end } };
}

function trimmedField(item: Json, name: string): string | null {
  const value = isRecord(item) ? stringField(item, name) : undefined;

  return value === undefined ? null : value.trim();
}

function trimmedList(item: Json, name: string): readonly string[] | null {
  const value = isRecord(item) ? item[name] : undefined;

  return isStringArray(value) ? value.map((entry) => entry.trim()) : null;
}

function within(value: string | null, min: number, max: number): value is string {
  return value !== null && value.length >= min && value.length <= max;
}

export interface LeadsCheck {
  readonly leads: readonly Lead[];
  readonly errors: readonly string[];
}

/** The leads file's leads, each checked against the claim and its tree; every error at once. */
export function validateLeads(input: Json, claimed: Claim, lineCount: LineCount): LeadsCheck {
  const list = isRecord(input) ? input["leads"] : undefined;

  if (!Array.isArray(list)) return { leads: [], errors: ['the file holds no {"leads": [...]}'] };

  const items: readonly Json[] = list;

  if (items.length > MAX_LEADS) {
    return { leads: [], errors: [`${items.length} leads: at most ${MAX_LEADS}, the surest`] };
  }

  const leads: Lead[] = [];
  const errors: string[] = [];
  const keys = new Set<string>();

  for (const [index, item] of items.entries()) {
    const where = `lead ${index + 1}`;
    const problems: string[] = [];

    if (!isRecord(item)) {
      errors.push(`${where} is no object`);
      continue;
    }

    for (const name of Object.keys(item))
      if (!LEAD_KEYS.has(name)) problems.push(`unknown field ${name}`);

    if (trimmedField(item, "package") !== claimed.package) {
      problems.push(`package is ${claimed.package}`);
    }

    const api = trimmedField(item, "api");
    const change = trimmedField(item, "change");

    if ((api === null) === (change === null)) problems.push("exactly one of api or change");
    else if (!within(api ?? change, 1, 80)) problems.push("api or change is 1 to 80 characters");
    else if (/[\r\n<`]/u.test(api ?? change ?? "")) {
      problems.push("api or change is one line with no < or backtick");
    }

    const category = CATEGORIES.find((known) => known === trimmedField(item, "category"));

    if (category === undefined) problems.push(`category is one of ${CATEGORIES.join(", ")}`);

    const key = trimmedField(item, "key") ?? "";

    if (normKey(key) === "") problems.push("key names the idea in a few words");

    const summary = trimmedField(item, "summary");

    if (!within(summary, 1, 200)) problems.push("summary is 1 to 200 characters");

    const rawEvidence = trimmedList(item, "evidence");
    const evidence: Anchor[] = [];

    if (rawEvidence === null || rawEvidence.length === 0 || rawEvidence.length > MAX_EVIDENCE) {
      problems.push(`evidence is 1 to ${MAX_EVIDENCE} path:line anchors`);
    } else {
      for (const raw of rawEvidence) {
        const anchor = parseAnchor(raw, claimed.issue, lineCount);

        if (anchor.ok) evidence.push(anchor.value);
        else problems.push(`evidence ${anchor.why}`);
      }
    }

    const doneWhen = trimmedList(item, "done_when");

    if (
      doneWhen === null ||
      doneWhen.length === 0 ||
      doneWhen.length > MAX_DONE_WHEN ||
      doneWhen.some((line) => !within(line, 1, 200))
    ) {
      problems.push(`done_when is 1 to ${MAX_DONE_WHEN} observable checks of 1 to 200 characters`);
    }

    const hints = item["hints"] === undefined ? "" : trimmedField(item, "hints");

    if (hints === null || hints.length > 600)
      problems.push("hints is a text of at most 600 characters");

    if (keys.has(normKey(key))) problems.push(`a second lead keyed ${normKey(key)}`);

    keys.add(normKey(key));

    if (
      problems.length > 0 ||
      category === undefined ||
      summary === null ||
      doneWhen === null ||
      hints === null
    ) {
      errors.push(...problems.map((problem) => `${where}: ${problem}`));
      continue;
    }

    leads.push({ api, change, category, key, summary, evidence, doneWhen, hints });
  }

  return { leads, errors };
}

// ---------------------------------------------------------------------------
// The lead issue
// ---------------------------------------------------------------------------

function permalink(repo: string, tree: string, anchor: Anchor): string {
  const lines =
    anchor.end === anchor.start ? `L${anchor.start}` : `L${anchor.start}-L${anchor.end}`;

  return `https://github.com/${repo}/blob/${tree}/${encodeURI(anchor.path)}#${lines}`;
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "")}\``;
}

export function leadTitle(lead: Lead, claimed: Claim): string {
  const summary =
    lead.summary.length > TITLE_SUMMARY_MAX
      ? `${lead.summary.slice(0, TITLE_SUMMARY_MAX - 1)}…`
      : lead.summary;

  return oneLine(sanitizeIssueText(`lead(${claimed.package}): ${summary}`));
}

/** Free text for a fenced block: no HTML comment, which could forge a marker, and no invisible character. */
function blockText(text: string): string {
  return text
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
}

/**
 * A lead as the `github-flow:issue` skill writes an issue: links and the model's words, no upstream text. A worker
 * reads the raw body as its brief while the human reads it rendered, so the model's words render all they hold: one
 * sanitized line each, the hints in a fenced block.
 */
export function leadBody(
  lead: Lead,
  claimed: Claim,
  repo: string,
  validate: readonly string[],
): string {
  const allowUrl = (url: string) =>
    url.startsWith(`https://github.com/${repo}/blob/`) ||
    url === claimed.compare ||
    url.startsWith("https://renovatebot.com/diffs/");

  const line = (value: string) => oneLine(sanitizeIssueText(value, allowUrl));

  const subject =
    lead.api === null ? `- Change: ${line(lead.change ?? "")}` : `- API: ${inlineCode(lead.api)}`;

  return [
    "## Problem",
    `Renovate updated ${inlineCode(claimed.package)} from ${inlineCode(claimed.from)} to ${inlineCode(claimed.to)} in ${claimed.sha.slice(0, 7)}; the leads scan of #${claimed.issue} found this.`,
    [`- Category: ${lead.category}`, subject, `- Summary: ${line(lead.summary)}`].join("\n"),
    "## Evidence",
    [
      ...lead.evidence.map(
        (anchor) =>
          `- [${anchor.path}:${anchor.start}${anchor.end === anchor.start ? "" : `-${anchor.end}`}](${permalink(repo, claimed.tree, anchor)})`,
      ),
      `- Upstream changes: ${claimed.compare ?? "no compare link"}`,
      `- Release notes read from: ${claimed.notesSource}`,
    ].join("\n"),
    "## Hints",
    lead.hints === "" ? "None." : textBlock(blockText(lead.hints)),
    "## Done when",
    [
      ...lead.doneWhen.map((check) => `- [ ] ${line(check)}`),
      ...validate.map((command) => `- [ ] ${inlineCode(command)} passes`),
    ].join("\n"),
    "## Out of scope",
    `- The version bump itself, which Renovate landed in ${claimed.sha.slice(0, 7)}, and any other dependency update.`,
    leadMarker(claimed.package, lead.key),
  ].join("\n\n");
}

/** The repository's validation commands, from `.claude/github-flow.json`; none when it has no such file. */
function validateCommands(ctx: Context): readonly string[] {
  const file = join(ctx.root, ".claude", "github-flow.json");

  if (!existsSync(file)) return [];

  const parsed = parseJson(readFileSync(file, "utf8"));
  const validate = isRecord(parsed) ? parsed["validate"] : undefined;

  return isStringArray(validate) ? validate : [];
}

function lineCountAt(ctx: Context, tree: string): LineCount {
  return (path) => {
    const shown = ctx.git(["show", `${tree}:${path}`]);

    return shown.code === 0
      ? shown.out.split("\n").length - (shown.out.endsWith("\n") ? 1 : 0)
      : null;
  };
}

export function publish(ctx: Context, issue: number, file: string): number {
  announceDryRun(ctx);
  checkFile(issue, "leads", file);

  const claimed = readClaim(ctx, issue);
  const lost = claimLost(ctx, claimed);

  if (lost !== null) {
    ctx.print(`leads: ${lost}; nothing published`);

    return 1;
  }

  let input: Json;

  try {
    input = parseJson(readFileSync(resolve(ctx.root, file), "utf8"));
  } catch (error) {
    ctx.print(`leads: ${file}: ${messageOf(error)}`);
    ctx.print("leads: nothing published");

    return 1;
  }

  const { leads, errors } = validateLeads(input, claimed, lineCountAt(ctx, claimed.tree));

  if (errors.length > 0) {
    for (const error of errors) ctx.print(`leads: ${error}`);
    ctx.print("leads: nothing published; fix the file and run publish again");

    return 1;
  }

  ensureLabels(ctx);

  const filed = new Map(
    existingLeads(issuesWith(ctx, LABEL.lead, "all"), claimed.package).map((lead) => [
      lead.key,
      lead.number,
    ]),
  );

  const validate = validateCommands(ctx);
  const lines: string[] = [];

  for (const lead of leads) {
    const key = normKey(lead.key);
    const duplicate = filed.get(key);
    const title = leadTitle(lead, claimed);

    if (duplicate === undefined) {
      const number = issueNumberOf(
        ctx.gh.call("POST", `repos/${ctx.repo}/issues`, {
          title,
          body: leadBody(lead, claimed, ctx.repo, validate),
          labels: [LABEL.lead, LABEL.needsHuman],
        }),
      );

      filed.set(key, number);
      lines.push(`- #${number} ${title}`);
    } else {
      lines.push(`- duplicate of #${duplicate}: ${title}`);
    }
  }

  comment(
    ctx,
    issue,
    lines.length === 0 ? "no lead" : `Leads of this update:\n\n${lines.join("\n")}`,
  );
  ctx.gh.call("PATCH", `repos/${ctx.repo}/issues/${issue}`, {
    state: "closed",
    state_reason: "completed",
  });
  removeLabel(ctx, issue, LABEL.inProgress);
  removeWorktree(ctx, issue);

  for (const line of lines.length === 0 ? ["no lead"] : lines) ctx.print(line);

  ctx.print(`closed #${issue}`);

  return 0;
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

export function release(ctx: Context, issue: number, file: string): number {
  announceDryRun(ctx);
  checkFile(issue, "release", file);

  // Only the scan that holds a scan issue gives it back: no other issue or pull request gets the label or the comment.
  const lost = claimLost(ctx, readClaim(ctx, issue));

  if (lost !== null) {
    ctx.print(`leads: ${lost}; nothing released`);

    return 1;
  }

  const parsed = parseJson(readFileSync(resolve(ctx.root, file), "utf8"));

  const reason = oneLine(
    sanitizeIssueText(isRecord(parsed) ? (stringField(parsed, "reason") ?? "") : ""),
  );

  if (reason === "" || reason.length > 200) {
    ctx.print('leads: the file holds {"reason": "<1 to 200 characters>"}');

    return 1;
  }

  ensureLabels(ctx);
  removeLabel(ctx, issue, LABEL.inProgress);
  addLabel(ctx, issue, LABEL.unsure);
  comment(ctx, issue, `scan released: ${reason}`);
  removeWorktree(ctx, issue);
  ctx.print(`released #${issue} to the human: ${reason}`);

  return 0;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

const USAGE =
  "usage: bun ./scripts/leads/scan.ts claim --tier minor|major [--issue <n>] | search --issue <n> --query .leads/<n>-query.txt | publish --issue <n> --leads .leads/<n>-leads.json | release --issue <n> --file .leads/<n>-release.json";

function issueNumber(value: string | undefined): number {
  if (value === undefined || !/^\d{1,7}$/u.test(value)) throw new Error(USAGE);

  return Number(value);
}

export function main(
  argv: readonly string[],
  ctxOf: () => Context,
  now: number,
): Promise<number> | number {
  const [command, ...rest] = argv;

  const { values } = parseArgs({
    args: rest,
    options: {
      tier: { type: "string" },
      issue: { type: "string" },
      query: { type: "string" },
      leads: { type: "string" },
      file: { type: "string" },
    },
  });

  if (command === "claim") {
    const tier = TIERS.find((known) => known === values.tier);

    if (tier === undefined) throw new Error(USAGE);

    return claim(ctxOf(), tier, values.issue === undefined ? null : issueNumber(values.issue), now);
  }

  if (command === "search" && values.query !== undefined) {
    return search(ctxOf(), issueNumber(values.issue), values.query);
  }

  if (command === "publish" && values.leads !== undefined) {
    return publish(ctxOf(), issueNumber(values.issue), values.leads);
  }

  if (command === "release" && values.file !== undefined) {
    return release(ctxOf(), issueNumber(values.issue), values.file);
  }

  throw new Error(USAGE);
}

export async function run(argv: readonly string[], env: Env, cwd: string): Promise<number> {
  try {
    return await main(argv, () => contextOf(env, cwd), Date.now());
  } catch (error) {
    console.error(`leads: ${oneLine(messageOf(error))}`);

    return 1;
  }
}

if (import.meta.main)
  process.exitCode = await run(process.argv.slice(2), process.env, process.cwd());
