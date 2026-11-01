#!/usr/bin/env bun
import { basename } from "node:path";

import { gitReadSync } from "../lib/platform/git.ts";
import { messageOf } from "../lib/platform/pure.ts";

const DOC_SET = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "AGENTS.md",
  "AGENTS.override.md",
  ".claude/rules/",
] as const;

export const LARGE_WINDOW = 30;

const KEY_FILE_CAP = 8;

const RECORD = String.fromCodePoint(0x1e);

const UNIT = String.fromCodePoint(0x1f);

const NUL = "\0";

interface Baseline {
  short: string;
  date: string;
  subject: string;
}

export interface Commit {
  hash: string;
  short: string;
  subject: string;
  files: string[];
  removed: string[];
}

export interface Zone {
  zone: string;
  shorts: string[];
  keyFiles: string[];
}

interface Report {
  baseline: Baseline;
  docFiles: string[];
  commits: Commit[];
}

export function classifyPath(path: string): string {
  const directories = path.split("/").slice(0, -1);
  const [top] = directories;

  if (top === undefined) return "(root)";

  if (top === "src") return directories.slice(0, 3).join("/");

  if (top.startsWith(".")) return directories.slice(0, 2).join("/");

  return top;
}

// `git log -z --name-status` record: RECORD, header, NUL, then "\n" and
// status/path pairs, each NUL-terminated. Paths come raw, whatever they hold.
export function parseLog(stdout: string): Commit[] {
  return stdout
    .split(RECORD)
    .filter((record) => record.length > 0)
    .map((record) => {
      const [header = "", ...tokens] = record.split(NUL);
      const [hash, short, subject] = header.split(UNIT);

      if (hash === undefined || short === undefined || subject === undefined) {
        throw new Error(`unexpected git log record: ${header}`);
      }

      const files: string[] = [];
      const removed: string[] = [];

      for (let index = 0; index + 1 < tokens.length; index += 2) {
        const status = tokens[index]?.trim();
        const path = tokens[index + 1] ?? "";
        files.push(path);

        if (status === "D") removed.push(path);
      }

      return { hash, short, subject, files, removed };
    });
}

export function groupByZone(commits: Commit[]): Zone[] {
  const zones = new Map<string, { shorts: Set<string>; keyFiles: Set<string> }>();

  for (const commit of commits) {
    for (const file of commit.files) {
      const name = classifyPath(file);
      const zone = zones.get(name) ?? { shorts: new Set<string>(), keyFiles: new Set<string>() };
      zone.shorts.add(commit.short);
      zone.keyFiles.add(basename(file));
      zones.set(name, zone);
    }
  }

  return [...zones]
    .map(([zone, { shorts, keyFiles }]) => ({
      zone,
      shorts: [...shorts],
      keyFiles: [...keyFiles].toSorted(),
    }))
    .toSorted((a, b) => b.shorts.length - a.shorts.length || (a.zone < b.zone ? -1 : 1));
}

const code = (text: string): string => `\`${text}\``;

function keyFilesCell(keyFiles: string[]): string {
  const shown = keyFiles.slice(0, KEY_FILE_CAP).join(", ");
  const hidden = keyFiles.length - KEY_FILE_CAP;

  return hidden > 0 ? `${shown}, +${hidden} more` : shown;
}

function splitStep(commitCount: number): string {
  if (commitCount > LARGE_WINDOW) {
    return `The window holds ${commitCount} commits, above ${LARGE_WINDOW}. Read no file yet. Group the rows of "Changed zones", then give each group to its own read-only subagent with the whole audit set and the commits of its SHAs column. Every subagent returns a verdict for every doc file; keep the strongest per file (YES over MINOR over NO) with its evidence. Without subagents, work through the groups one at a time.`;
  }

  return "One read-only subagent audits the whole audit set against the commit list. Without subagents, do it yourself.";
}

function protocol(commitCount: number): string {
  return `## Protocol

This report lists candidates. A finding exists only once the current source confirms it.

### 1. Audit set

Every file under "Doc files at HEAD", plus each file of this repository that one of them imports with an \`@path\` reference. Every file in the audit set gets a verdict.

### 2. Split the work

${splitStep(commitCount)}

Give each subagent the baseline, step 3, the audit set and its share of commits. \`git show <sha>\` shows one commit.

### 3. What a subagent checks

For each doc file in the audit set, against the commits in its share:

- a module, file, command or directory the commits added, that the doc should name and does not;
- an API, type, flag, path or command the doc describes, that the commits changed;
- a name the doc still uses, that the commits renamed or removed ("Removed paths" lists the deletions).

Read the changed source before a finding: evidence is a \`path:line\` of the current tree. Also flag each changed zone that no rule covers, by its \`paths:\` frontmatter or by its content: it may need a new rule file.

Return only these lines:

\`\`\`text
VERDICT | <doc file> | YES or MINOR or NO | <path:line evidence>
FINDING | <sha> | <doc file> | <claim the commit outgrew> | <path:line evidence>
UNCOVERED | <zone> | <sha>, <sha>
REMOVED | <doc file> | <stale reference> | <sha that removed its target>
\`\`\`

YES means an update is needed, MINOR an optional tweak, NO that the doc is current.

### 4. Proposal

Every verdict NO, no UNCOVERED and no REMOVED line: say so and stop. Do not pad an empty proposal.

Otherwise present, in this order:

1. A verdict table, one row per file of the audit set.
2. Uncovered zones, then stale references to removed code.
3. Edits. Each edit carries its exact content, a one-line rationale, and \`Motivated by: <sha>\` or \`Motivated by: <A>..<B>\`.

Every SHA of a \`Motivated by:\` line, both ends of a range, appears under "Commits" in this report. Drop an edit without one. General quality improvement of the docs is out of scope. Keep content whose purpose you do not understand.

An edit to a rule follows these conventions:

- One terse paragraph per new concern: rules compete for context.
- Constraints and invariants, not volatile implementation details.
- Source files cited by repo-relative path.
- Nothing the code already says.

### 5. Approval

Ask the user: apply all, cherry-pick, or reject. Apply approved edits only. Never commit. On reject, offer to save the proposal to a file.
`;
}

function render({ baseline, docFiles, commits }: Report): string {
  const lines = [
    "# Agent Docs Drift Audit",
    "",
    "## Context",
    "",
    `- Baseline: ${code(baseline.short)} (${baseline.date}) ${baseline.subject}`,
    `- Commits since baseline: ${commits.length}`,
    `- Doc set: ${DOC_SET.map((path) => code(path)).join(", ")}. The baseline is the newest commit that touched one of them.`,
    "",
    "## Doc files at HEAD",
    "",
    ...docFiles.map((file) => `- ${code(file)}`),
    "",
  ];

  if (docFiles.includes("CLAUDE.md") && docFiles.includes(".claude/CLAUDE.md")) {
    lines.push(
      "> Both `CLAUDE.md` and `.claude/CLAUDE.md` exist. Recommend consolidating into `CLAUDE.md`.",
      "",
    );
  }

  if (commits.length > LARGE_WINDOW) {
    lines.push(
      `> Large window: ${commits.length} commits. Start from "Changed zones" and split the audit by zone before reading any file (Protocol, step 2).`,
      "",
    );
  }

  if (commits.length === 0) {
    lines.push(
      "## Result",
      "",
      "No commit since the baseline. An empty window does not prove the docs are current.",
      "",
    );

    return lines.join("\n");
  }

  lines.push("## Changed zones", "", "| Zone | Commits | SHAs | Key files |", "|---|---:|---|---|");

  for (const { zone, shorts, keyFiles } of groupByZone(commits)) {
    lines.push(`| ${zone} | ${shorts.length} | ${shorts.join(", ")} | ${keyFilesCell(keyFiles)} |`);
  }

  const removed = commits.flatMap((commit) =>
    commit.removed.map((path) => `- ${code(path)} (${commit.short})`),
  );

  if (removed.length > 0) lines.push("", "## Removed paths", "", ...removed);

  lines.push(
    "",
    "## Commits",
    "",
    ...commits.map((commit) => `- ${code(commit.short)} ${commit.subject}`),
    "",
    protocol(commits.length),
  );

  return lines.join("\n");
}

function git(cwd: string, args: string[]): string {
  return gitReadSync(args, { cwd, raw: true });
}

function collect(cwd: string): Report {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();

  const docFiles = git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...DOC_SET])
    .split(NUL)
    .filter(Boolean);

  if (docFiles.length === 0) {
    throw new Error(`no file of the doc set is tracked at HEAD: ${DOC_SET.join(", ")}`);
  }

  const header = git(root, [
    "log",
    "-1",
    "--no-show-signature",
    `--format=%H${UNIT}%h${UNIT}%ai${UNIT}%s`,
    "--",
    ...DOC_SET,
  ]).trim();

  const [hash, short, date, subject] = header.split(UNIT);

  if (hash === undefined || short === undefined || date === undefined || subject === undefined) {
    throw new Error(`no commit touches the doc set: ${DOC_SET.join(", ")}`);
  }

  const log = git(root, [
    "log",
    "-z",
    "--no-show-signature",
    "--no-renames",
    `--format=${RECORD}%H${UNIT}%h${UNIT}%s`,
    "--name-status",
    `${hash}..HEAD`,
  ]);

  return { baseline: { short, date, subject }, docFiles, commits: parseLog(log) };
}

if (import.meta.main) {
  try {
    process.stdout.write(render(collect(process.cwd())));
  } catch (error) {
    console.error(`agent-docs-drift: ${messageOf(error)}`);
    process.exit(1);
  }
}
