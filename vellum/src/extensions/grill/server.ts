import type { Route, RouteKey, ServerContext, ServerExtension } from "../../core/extension.ts";
import type { PlanWorkspace } from "../../core/protocol.ts";
import type { ProjectPath } from "../../core/server/domain/paths.ts";
import { projectPath } from "../../core/server/domain/workspace.ts";
import {
  grillFile,
  grillFileName,
  grillNumber,
  NO_GRILL_OPEN,
  parseAnswer,
  parseCloseReason,
  parseEvent,
  parseQuestions,
  parseReply,
  parseSubject,
  parseSuggestion,
} from "./parse.ts";
import type { Asked, Block, GrillState, Opened, Suggestion } from "./protocol.ts";
import {
  appendAnswer,
  appendFooter,
  appendEvent,
  appendReply,
  appendQuestions,
  header,
  isClosed,
  nextQuestion,
  phaseOf,
  relaysOf,
  segmentsOf,
  subjectOf,
} from "./transcript.ts";

/** A transcript of the plan's directory, read: the one with the highest number is the current one. */
type Transcript = { readonly n: number; readonly file: ProjectPath; readonly doc: string };

/** What a change makes of the transcript: the file to write, and the answer once it is written. */
type Written = { readonly doc: string; readonly answer: Response };

/** A link the page may follow: http, mailto, a fragment or a relative path; any other scheme runs code. */
const SAFE_HREF = /^(?:https?:|mailto:|[^:]*(?:[/?#]|$))/iu;

const NO_CONTENT = { status: 204 };

function refused(error: string): Response {
  return Response.json({ error }, { status: 409 });
}

function badRequest(): Response {
  return new Response("bad request", { status: 400 });
}

/**
 * The transcript's Markdown as HTML. Raw HTML stays text, and a `javascript:` link is cut: the
 * text is Claude's and the terminal's, and the page that draws it holds the server's token.
 */
export function toHtml(markdown: string): string {
  return Bun.markdown
    .html(markdown, { noHtmlBlocks: true, noHtmlSpans: true })
    .replaceAll(/href="([^"]*)"/gu, (whole, href: string) =>
      SAFE_HREF.test(href) ? whole : 'href="#"',
    );
}

export function blocksOf(doc: string): Block[] {
  return segmentsOf(doc).map((segment) =>
    segment.kind === "markdown" ? { kind: "html", html: toHtml(segment.text) } : segment,
  );
}

/** `null` when the working directory is gone and the server lost its memory: the route answers 409. */
function workspaceIfAny(context: ServerContext): Promise<PlanWorkspace | null> {
  return context.workspace().catch(() => null);
}

async function latest(
  context: ServerContext,
  dir: PlanWorkspace["dir"],
): Promise<Transcript | null> {
  // A directory that is gone holds no transcript: the listing rejects there, and a gate or a
  // route must refuse, not fail.
  const listed = await context.listFiles(dir).catch(() => []);

  const numbers = listed
    .map((doc) => (doc.path.startsWith(dir) ? grillNumber(doc.path.slice(dir.length)) : null))
    .filter((n) => n !== null);

  if (numbers.length === 0) return null;
  const n = Math.max(...numbers);
  const file = projectPath(`${dir}${grillFile(n)}`);
  const doc = await context.readText(file);

  return doc === null ? null : { n, file, doc };
}

/** The engine's cursor, as `GET state?after=<seq>&file=<name>` carries it; the page sends none. */
type Cursor = { readonly name: string | null; readonly after: number };

const NO_CURSOR = -1;

function cursorOf(url: string): Cursor {
  const query = new URL(url).searchParams;
  const after = Number(query.get("after") || NO_CURSOR);

  return { name: query.get("file"), after: Number.isInteger(after) ? after : NO_CURSOR };
}

function stateOf(
  current: Transcript | null,
  suggestion: Suggestion | null,
  cursor: Cursor,
): GrillState {
  if (current === null) return { kind: "none", suggestion, relays: [] };
  const { n, file, doc } = current;
  const name = grillFile(n);
  // A cursor kept for another transcript says nothing of this one.
  const relays = relaysOf(doc, name, cursor.name === name ? cursor.after : NO_CURSOR);

  return isClosed(doc)
    ? { kind: "none", suggestion, relays }
    : { kind: "open", file, subject: subjectOf(doc), phase: phaseOf(doc), relays };
}

/** The grill that is open now, read as `GET state` reads it; `null` with none, or with no directory. */
async function openGrill(context: ServerContext): Promise<Transcript | null> {
  const workspace = await workspaceIfAny(context);
  const current = workspace === null ? null : await latest(context, workspace.dir);

  return current === null || isClosed(current.doc) ? null : current;
}

/** Every open question takes its recommendation by default, then the footer. */
function ended(doc: string, reason: string): string {
  return appendFooter(appendReply(doc, [], "") ?? doc, reason, new Date());
}

async function holds(context: ServerContext): Promise<string | null> {
  const open = await openGrill(context);

  return open === null ? null : `${grillFile(open.n)} is open`;
}

/** Runs inside the review's queue, after the rename: the footer lands in the final directory, module alive or not. */
async function approved(context: ServerContext): Promise<void> {
  const open = await openGrill(context);

  if (open !== null) await context.writeText(open.file, ended(open.doc, "approved"));
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  // Kept in memory: a restarted server loses it, and Claude may suggest again.
  let suggestion: Suggestion | null = null;
  const { inOrder } = context;

  /**
   * Reads the current transcript at write time: after an approval the directory has moved.
   * `apply` answers a refusal to write nothing; with no grill open, `none` is the answer.
   */
  const change = (
    apply: (doc: string) => Written | Response,
    none: () => Response = () => new Response(null, NO_CONTENT),
  ): Promise<Response> =>
    inOrder(async () => {
      const workspace = await workspaceIfAny(context);

      if (workspace === null) return refused("the plan's directory is gone");
      const current = await latest(context, workspace.dir);

      if (current === null || isClosed(current.doc)) return none();
      const applied = apply(current.doc);

      if (applied instanceof Response) return applied;
      await context.writeText(current.file, applied.doc);
      await context.notify();

      return applied.answer;
    });

  const written = (doc: string): Written => ({
    doc,
    answer: new Response(null, NO_CONTENT),
  });

  return {
    "GET state": async (request) => {
      const workspace = await workspaceIfAny(context);

      if (workspace === null) return refused("the plan's directory is gone");
      const current = await latest(context, workspace.dir);

      return Response.json(stateOf(current, suggestion, cursorOf(request.url)));
    },

    "POST suggest": async (request) => {
      const suggested = parseSuggestion(await request.json().catch(() => null));
      const workspace = await workspaceIfAny(context);

      if (suggested === null) return badRequest();

      if (workspace === null) return refused("the plan's directory is gone");
      const current = await latest(context, workspace.dir);

      if (current !== null && !isClosed(current.doc)) {
        return refused(`${grillFile(current.n)} is open`);
      }

      suggestion = suggested;
      await context.notify();

      return new Response(null, NO_CONTENT);
    },

    "POST open": async (request) => {
      const subject = parseSubject(await request.json().catch(() => null));

      if (subject === null) return badRequest();

      return await inOrder(async () => {
        const workspace = await workspaceIfAny(context);

        if (workspace === null) return refused("the plan's directory is gone");

        if (workspace.kind === "approved") return refused("the plan is approved");
        const current = await latest(context, workspace.dir);

        if (current !== null && !isClosed(current.doc)) {
          return refused(`${grillFile(current.n)} is open`);
        }

        const file = projectPath(`${workspace.dir}${grillFile((current?.n ?? 0) + 1)}`);
        const session = /wip-([0-9a-f]{8})\/$/u.exec(workspace.dir)?.[1] ?? "";
        await context.writeText(file, header(subject, session, new Date()));
        suggestion = null;
        await context.notify();

        const opened: Opened = { file };

        return Response.json(opened, { status: 201 });
      });
    },

    "POST close": async (request) => {
      const reason = parseCloseReason(await request.json().catch(() => null));

      return reason === null ? badRequest() : await change((doc) => written(ended(doc, reason)));
    },

    "POST ask": async (request) => {
      const questions = parseQuestions(await request.json().catch(() => null));

      if (questions === null) return badRequest();

      return await change(
        (doc) => {
          const first = nextQuestion(doc);
          const asked: Asked = { first, last: first + questions.length - 1 };

          return { doc: appendQuestions(doc, questions), answer: Response.json(asked) };
        },
        () => refused(NO_GRILL_OPEN),
      );
    },

    "POST event": async (request) => {
      const event = parseEvent(await request.json().catch(() => null));

      return event === null
        ? badRequest()
        : await change((doc) => written(appendEvent(doc, event.command)));
    },

    "POST answer": async (request) => {
      const answer = parseAnswer(await request.json().catch(() => null));

      return answer === null
        ? badRequest()
        : await change((doc) => written(appendAnswer(doc, answer.text, answer.reason, answer.own)));
    },

    "POST reply": async (request) => {
      const reply = parseReply(await request.json().catch(() => null));

      if (reply === null) return badRequest();

      return await change(
        (doc) => {
          const replied = appendReply(doc, reply.answers, reply.note);

          return replied === null
            ? refused("no question is open, and the note is empty")
            : written(replied);
        },
        () => refused(NO_GRILL_OPEN),
      );
    },

    "GET blocks": async (request) => {
      const name = grillFileName(new URL(request.url).searchParams.get("file"));
      const workspace = await workspaceIfAny(context);

      if (name === null || workspace === null) return new Response("not found", { status: 404 });
      const doc = await context.readText(projectPath(`${workspace.dir}${name}`));

      return doc === null
        ? new Response("not found", { status: 404 })
        : Response.json(blocksOf(doc));
    },
  };
}

export const grillServer: ServerExtension = { id: "grill", routes, holds, approved };
