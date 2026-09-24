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
  parseDecline,
  parseEvent,
  parseQuestions,
  parseReply,
  parseSubject,
  parseSuggestion,
} from "./parse.ts";
import type { Asked, Block, GrillState, Opened, Proposal } from "./protocol.ts";
import { ASK_TOOL } from "./protocol.ts";
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
  type Relay,
  relaysOf,
  segmentsOf,
  subjectOf,
} from "./transcript.ts";

/** A transcript of the plan's directory, read: the one with the highest number is the current one. */
type Transcript = { readonly n: number; readonly file: ProjectPath; readonly doc: string };

/**
 * What a change makes of the transcript: the file to write, the answer once it is written, and
 * whether Claude hears of the entries it added: the reviewer's gestures alone are told, and a grill
 * the session ended itself is not.
 */
type Written = { readonly doc: string; readonly answer: Response; readonly told: boolean };

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

/** Every text the page draws is rendered here: the Markdown between the cards, and a card's question and recommendation. */
export function blocksOf(doc: string): Block[] {
  return segmentsOf(doc).map((segment) => {
    if (segment.kind === "markdown") return { kind: "html", html: toHtml(segment.text) };

    if (segment.kind === "question") {
      return { ...segment, ask: toHtml(segment.ask), rec: toHtml(segment.rec) };
    }

    return segment;
  });
}

/** Where Claude learns how to grill, named with the first grill of a working directory alone. */
const GUIDE = `${import.meta.dir}/grilling.md`;

/**
 * An entry as Claude reads it: a prompt names its object and repeats nothing Claude wrote or read,
 * and a reply goes as the transcript worded it, under `Reviewer:`.
 */
function toldOf(relay: Relay, first: boolean): string {
  if (relay.kind === "reply") return relay.text;

  if (relay.kind === "ended") return `The reviewer ended ${relay.name}.`;
  const opened = `The reviewer opened ${relay.name} on: ${relay.subject}.`;

  return first ? `${opened} Read ${GUIDE}, then ask with ${ASK_TOOL}.` : opened;
}

/**
 * Tells Claude the entries a write added to the transcript, in file order. Only what the server
 * itself appended is told: a block written into the file by hand is already in `before`.
 */
async function tell(
  context: ServerContext,
  name: string,
  before: string | null,
  after: string,
  first = false,
): Promise<void> {
  const known = before === null ? -1 : (relaysOf(before, name, -1).at(-1)?.seq ?? -1);

  for (const relay of relaysOf(after, name, known)) {
    await context.relay({ kind: "text", from: "grill", text: toldOf(relay, first) });
  }
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

function stateOf(current: Transcript | null, proposal: Proposal | null): GrillState {
  if (current === null || isClosed(current.doc)) return { kind: "none", proposal };
  const { file, doc } = current;

  return { kind: "open", file, subject: subjectOf(doc), phase: phaseOf(doc) };
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

  return open === null ? null : `grill ${open.n} is open`;
}

/** Runs inside the review's queue, after the rename: the footer lands in the final directory, module alive or not. */
async function approved(context: ServerContext): Promise<void> {
  const open = await openGrill(context);

  if (open !== null) await context.writeText(open.file, ended(open.doc, "approved"));
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  // Kept in memory: a restarted server loses it, and Claude may suggest again. Each proposal
  // takes a random id, so a restarted server never reuses one the engine already relayed.
  let proposal: Proposal | null = null;
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

      if (applied.told) await tell(context, grillFile(current.n), current.doc, applied.doc);
      await context.notify();

      return applied.answer;
    });

  const written = (doc: string, told = false): Written => ({
    doc,
    answer: new Response(null, NO_CONTENT),
    told,
  });

  return {
    "GET state": async () => {
      const workspace = await workspaceIfAny(context);

      if (workspace === null) return refused("the plan's directory is gone");
      const current = await latest(context, workspace.dir);

      return Response.json(stateOf(current, proposal));
    },

    "POST suggest": async (request) => {
      const suggested = parseSuggestion(await request.json().catch(() => null));

      if (suggested === null) return badRequest();

      return await inOrder(async () => {
        const workspace = await workspaceIfAny(context);

        if (workspace === null) return refused("the plan's directory is gone");
        const current = await latest(context, workspace.dir);

        if (current !== null && !isClosed(current.doc)) {
          return refused(`${grillFile(current.n)} is open`);
        }

        proposal = { kind: "pending", suggestion: { id: crypto.randomUUID(), ...suggested } };
        await context.notify();

        return new Response(null, NO_CONTENT);
      });
    },

    "POST decline": async (request) => {
      const decline = parseDecline(await request.json().catch(() => null));

      if (decline === null) return badRequest();

      return await inOrder(async () => {
        if (proposal?.kind !== "pending" || proposal.suggestion.id !== decline.id) {
          return refused("no such proposal");
        }

        const { subject } = proposal.suggestion;
        proposal = { kind: "declined", declined: { id: decline.id, subject } };
        await context.relay({
          kind: "text",
          from: "grill",
          text: `The reviewer declined the grill on: ${subject}.`,
        });
        await context.notify();

        return new Response(null, NO_CONTENT);
      });
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

        const name = grillFile((current?.n ?? 0) + 1);
        const file = projectPath(`${workspace.dir}${name}`);
        const session = /wip-([0-9a-f]{8})\/$/u.exec(workspace.dir)?.[1] ?? "";
        const doc = header(subject, session, new Date());
        await context.writeText(file, doc);
        proposal = null;
        await tell(context, name, null, doc, current === null);
        await context.notify();

        const opened: Opened = { file };

        return Response.json(opened, { status: 201 });
      });
    },

    "POST close": async (request) => {
      const reason = parseCloseReason(await request.json().catch(() => null));

      return reason === null
        ? badRequest()
        : await change((doc) => written(ended(doc, reason), reason === "page"));
    },

    "POST ask": async (request) => {
      const questions = parseQuestions(await request.json().catch(() => null));

      if (questions === null) return badRequest();

      return await change(
        (doc) => {
          const first = nextQuestion(doc);
          const asked: Asked = { first, last: first + questions.length - 1 };

          return {
            doc: appendQuestions(doc, questions),
            answer: Response.json(asked),
            told: false,
          };
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
        : await change((doc) => written(appendAnswer(doc, answer)));
    },

    "POST reply": async (request) => {
      const reply = parseReply(await request.json().catch(() => null));

      if (reply === null) return badRequest();

      return await change(
        (doc) => {
          const replied = appendReply(doc, reply.answers, reply.note);

          return replied === null
            ? refused("no question is open, and the note is empty")
            : written(replied, true);
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
