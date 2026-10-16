import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { $ } from "bun";

export const PLAN_MARKER = "<!-- plan -->";

const COMMENT_FIELDS = ".[] | {id: .id, login: .user.login, body: .body}";

const PR_CREATE = /\bgh\s+pr\s+create\b/u;

const PULL_URL = /https?:\/\/[^/\s"\\]+\/([^/\s"\\]+\/[^/\s"\\]+)\/pull\/(\d+)/u;

const SESSION_LINE = /^<!-- session_id: [^\s>]+ -->\n?/u;

const SESSION_MARKER = /<!-- session_id: ([^\s>]+) -->/gu;

export const SAFE_ID = /^[a-zA-Z0-9_-]+$/u;

const QUOTED_PLAN_HEADER = /<!-- plan -->(?:\\r|\\n|\s)*<!-- session_id: [^\s>]+ -->/gu;

export interface ToolInput {
  command?: string;
  plan?: string;
  file_path?: string;
  content?: string;
}

export interface HookPayload {
  cwd?: string;
  session_id?: string;
  agent_id?: string;
  transcript_path?: string;
  tool_input?: ToolInput;
  tool_response?: { plan?: string };
}

export interface PlanComment {
  id: number;
  login: string;
  body: string;
}

export function parsePayload(raw: string): HookPayload | null {
  try {
    // SAFETY: the harness owns this shape. Every read is optional, and a payload
    // that does not match yields null, which every caller treats as "nothing to do".
    return JSON.parse(raw) as HookPayload;
  } catch {
    return null;
  }
}

export function planText(payload: HookPayload): string | null {
  const plan = payload.tool_response?.plan ?? payload.tool_input?.plan ?? "";

  return plan.trim().length === 0 ? null : plan;
}

export function isPrCreate(command: string): boolean {
  return PR_CREATE.test(command);
}

export interface PullRequest {
  repo: string;
  number: number;
}

/** The `<owner>/<repo>` and number of the first pull URL in `text`: the PR names its own repository. */
export function prFrom(text: string): PullRequest | null {
  const match = text.match(PULL_URL);

  if (match?.[1] === undefined || match[2] === undefined) return null;

  return { repo: match[1], number: Number(match[2]) };
}

/** `~/.claude/plans/by-session/<session>[/<agent>].md`, the identity known when a plan is approved. */
export function planPath(home: string, session: string, agent?: string): string | null {
  if (!SAFE_ID.test(session)) return null;
  const dir = join(home, ".claude", "plans", "by-session");

  if (agent === undefined) return join(dir, `${session}.md`);

  return SAFE_ID.test(agent) ? join(dir, session, `${agent}.md`) : null;
}

/** Drops a leading `<!-- session_id: … -->` line. */
export function stripSessionLine(text: string): string {
  return text.replace(SESSION_LINE, "");
}

/** Session ids named by markers in `text`, in order of appearance, deduped. */
export function sessionMarkers(text: string): string[] {
  return [...new Set([...text.matchAll(SESSION_MARKER)].flatMap((match) => match[1] ?? []))];
}

/** Replaces any leading session line, so a plan carried A -> B is not tagged twice. */
export function withSessionLine(plan: string, sessionId: string | undefined): string {
  const tagged = sessionId !== undefined && sessionId.length > 0;
  const plain = tagged ? stripSessionLine(plan) : plan;
  const body = plain.endsWith("\n") ? plain : `${plain}\n`;

  return tagged ? `<!-- session_id: ${sessionId} -->\n${body}` : body;
}

/**
 * The Write input that stamps the session line on the harness's own plan file
 * (`~/.claude/plans/<slug>.md`) as the plan is written, or null when the Write
 * targets another file or its content already opens with that line.
 */
export function stampedPlanWrite(payload: HookPayload, home: string): ToolInput | null {
  const { session_id: session, tool_input: input } = payload;
  const file = input?.file_path;

  if (session === undefined || !SAFE_ID.test(session) || input?.content === undefined) return null;

  if (file === undefined || !file.endsWith(".md")) return null;

  if (dirname(resolve(file)) !== join(home, ".claude", "plans")) return null;
  const content = withSessionLine(input.content, session);

  return content === input.content ? null : { ...input, content };
}

/** `executedBy` adds `<!-- executed_by: … -->` under the session line when it names another session. */
export function buildBody(plan: string, executedBy?: string): string {
  const session = plan.match(SESSION_LINE)?.[0].trim() ?? "";
  const wrote = sessionMarkers(session)[0];
  const names = executedBy !== undefined && executedBy.length > 0 && executedBy !== wrote;
  const executed = names ? `<!-- executed_by: ${executedBy} -->` : "";
  const header = [PLAN_MARKER, session, executed].filter((line) => line.length > 0).join("\n");
  const rest = stripSessionLine(plan).trim();

  return `${header}\n<details><summary>Plan</summary>\n\n${rest}\n\n</details>\n`;
}

export function findPlanComment(commentsJsonl: string, login: string): number | null {
  for (const line of commentsJsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    // SAFETY: shaped by COMMENT_FIELDS above; a malformed line throws up to the
    // hook, which reports it on stderr and exits 0.
    const comment = JSON.parse(line) as PlanComment;

    if (comment.login === login && comment.body.startsWith(PLAN_MARKER)) return comment.id;
  }

  return null;
}

/** The stored plan of the planning session named in the transcript; last marker that has a file wins. */
export async function carriedPlan(home: string, transcriptPath: string): Promise<string | null> {
  const transcript = Bun.file(transcriptPath);

  if (!(await transcript.exists())) return null;

  // A PR comment read through gh quotes its own header; a bare quoted marker
  // still counts, guarded only by the store file existing.
  // ponytail: telling a planning handoff from a quoted id means parsing JSONL roles.
  const text = (await transcript.text()).replace(QUOTED_PLAN_HEADER, "");

  for (const id of sessionMarkers(text).toReversed()) {
    const path = planPath(home, id);

    if (path === null) continue;
    const plan = Bun.file(path);

    if (await plan.exists()) return await plan.text();
  }

  return null;
}

/** The harness's own plan file (`~/.claude/plans/<slug>.md`) whose content is `plan`, newest first. */
export async function harnessPlanFile(home: string, plan: string): Promise<string | null> {
  const dir = join(home, ".claude", "plans");
  const files: { path: string; mtimeMs: number }[] = [];

  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(dir, entry.name);
      const { mtimeMs } = await stat(path);
      files.push({ path, mtimeMs });
    }
  } catch {
    return null;
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const wanted = stripSessionLine(plan).trim();

  for (const { path } of files) {
    if (stripSessionLine(await Bun.file(path).text()).trim() === wanted) return path;
  }

  return null;
}

type Run = { stdout: string; exitCode: number };

async function gh(cwd: string, ...args: string[]): Promise<Run> {
  const { stdout, stderr, exitCode } = await $`gh ${args}`.cwd(cwd).quiet().nothrow();

  if (exitCode !== 0) throw new Error(`gh ${args.join(" ")}: ${stderr.toString().trim()}`);

  return { stdout: stdout.toString().trim(), exitCode };
}

export async function openPr(cwd: string): Promise<PullRequest | null> {
  const { stdout, exitCode } = await $`gh pr view --json url --jq .url`.cwd(cwd).quiet().nothrow();

  return exitCode === 0 ? prFrom(stdout.toString()) : null;
}

export async function upsertPlanComment(
  cwd: string,
  pr: PullRequest,
  plan: string,
  executedBy?: string,
): Promise<void> {
  const login = await gh(cwd, "api", "user", "--jq", ".login");

  const comments = await gh(
    cwd,
    "api",
    `repos/${pr.repo}/issues/${pr.number}/comments`,
    "--paginate",
    "--jq",
    COMMENT_FIELDS,
  );

  const existing = findPlanComment(comments.stdout, login.stdout);
  // Outside the repository: a body file inside it would land in the next commit.
  const file = join(tmpdir(), `plan-comment-${pr.number}-${process.pid}.md`);
  await Bun.write(file, buildBody(plan, executedBy));

  try {
    if (existing === null) {
      await gh(cwd, "pr", "comment", String(pr.number), "-R", pr.repo, "--body-file", file);
    } else {
      await gh(
        cwd,
        "api",
        "-X",
        "PATCH",
        `repos/${pr.repo}/issues/comments/${existing}`,
        "-F",
        `body=@${file}`,
      );
    }
  } finally {
    await rm(file, { force: true });
  }
}
