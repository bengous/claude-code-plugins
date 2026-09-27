import { join } from "node:path";

import type {
  Part,
  Reading,
  Route,
  RouteKey,
  ServerContext,
  ServerExtension,
} from "../../core/extension.ts";
import type { Draft, PlanWorkspace } from "../../core/protocol.ts";
import type { ProjectPath } from "../../core/server/domain/paths.ts";
import { parseProjectPath } from "../../core/server/domain/paths.ts";
import type { Actor, EventInput } from "../../core/server/domain/workflow.ts";
import { projectPath } from "../../core/server/domain/workspace.ts";
import {
  grillFile,
  grillFileName,
  grillNumber,
  parseAnswer,
  parseCloseReason,
  parseEvent,
  parseQuestions,
  parseSubject,
  parseWait,
} from "./parse.ts";
import type { Asked, Block, GrillState, Waited } from "./protocol.ts";
import {
  appendReply,
  isClosed,
  nextQuestion,
  phaseOf,
  relaysOf,
  segmentsOf,
  subjectOf,
  unanswered,
} from "./transcript.ts";
import {
  callOf,
  EVENTS,
  GRILL,
  openingOf,
  REACTION,
  regionOf,
  RULES,
  segmentOf,
  TRANSITIONS,
} from "./workflow.ts";

/** A transcript of the plan's directory, read: the one with the highest number is the current one. */
type Transcript = { readonly n: number; readonly file: ProjectPath; readonly doc: string };

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
const GUIDE = join(import.meta.dir, "grilling.md");

/** `null` when the working directory is gone and the server lost its memory: the route answers 409. */
function workspaceIfAny(context: ServerContext): Promise<PlanWorkspace | null> {
  return context.workspace().catch(() => null);
}

async function latest(
  context: ServerContext,
  dir: PlanWorkspace["dir"],
): Promise<Transcript | null> {
  // A directory that is gone holds no transcript: the listing rejects there, and a route must
  // refuse, not fail.
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

function stateOf(current: Transcript | null): GrillState {
  if (current === null || isClosed(current.doc)) return { kind: "none" };
  const { file, doc } = current;

  return { kind: "open", file, subject: subjectOf(doc), phase: phaseOf(doc) };
}

/** The grill that is open now, read as `GET state` reads it; `null` with none, or with no directory. */
async function openGrill(context: ServerContext): Promise<Transcript | null> {
  const workspace = await workspaceIfAny(context);
  const current = workspace === null ? null : await latest(context, workspace.dir);

  return current === null || isClosed(current.doc) ? null : current;
}

type Typing = Draft["typed"]["grill"][string];

const NOTHING_TYPED: Typing = { answers: {}, note: "" };

/** What the reviewer typed on a transcript, as the draft keeps it by the transcript's path. */
function typingOn(draft: Draft | null, file: ProjectPath): Typing {
  return draft?.typed.grill[file] ?? NOTHING_TYPED;
}

/** The questions the typing leaves open, which a Send or an end takes by default. */
function untouched(doc: string, typing: Typing): readonly string[] {
  return unanswered(doc).filter((id) => (typing.answers[id]?.trim() ?? "") === "");
}

/**
 * What Claude is told of a grill `step`'s answer opens on the subject: the file it will be, and
 * at the directory's first grill, the guide. The rows judge whether it opens; the reaction writes it.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` comes from `step` through the core; `parseSubject` is the boundary that reads it.
async function start(context: ServerContext, input: unknown): Promise<string> {
  const subject = parseSubject(input);
  const workspace = await workspaceIfAny(context);

  if (subject === null || workspace === null) return "";
  const current = await latest(context, workspace.dir);
  const name = grillFile((current?.n ?? 0) + 1);

  return openingOf(name, subject, current === null ? GUIDE : null);
}

const NO_PART: Part = { kind: "none" };

/**
 * The grill's part of the bar's Send, read off the open grill and the draft, writing nothing: the
 * questions no answer takes, unless the reviewer agreed to leave every one to its recommendation;
 * else the reply the draft holds, which closes every open question, and the typing the Send's
 * event carries for the grill's reaction to write it.
 */
async function part(
  context: ServerContext,
  draft: Draft,
  takeDefaults: readonly string[],
): Promise<Part> {
  const open = await openGrill(context);

  if (open === null) return NO_PART;
  const typing = typingOn(draft, open.file);
  const untyped = untouched(open.doc, typing);

  if (!untyped.every((id) => takeDefaults.includes(id)))
    return { kind: "unanswered", ids: untyped };
  const answers = Object.entries(typing.answers).map(([id, text]) => ({ id, text }));
  const doc = appendReply(open.doc, answers, typing.note);

  if (doc === null) return NO_PART;
  const name = grillFile(open.n);
  const reply = relaysOf(doc, name, -1).findLast((relay) => relay.kind === "reply")?.text ?? "";

  return {
    kind: "part",
    text: `## Grill\n\n\`${name}\`\n\n${reply}`,
    typed: (typed) => ({
      ...typed,
      grill: Object.fromEntries(Object.entries(typed.grill).filter(([file]) => file !== open.file)),
    }),
    input: JSON.stringify(typing),
  };
}

/**
 * Where the round asked in `file` from question `first` stands: answered by a Send the server
 * saw, closed any other way (End grill, the approval, a Send before a restart), or still open.
 */
async function waitedOn(context: ServerContext, file: ProjectPath, first: number): Promise<Waited> {
  const id = `Q${first}`;
  const name = file.split("/").at(-1) ?? "";
  const returned = context.returned(callOf(name, id));

  if (returned !== null) return { kind: "answered", seq: returned.seq, text: returned.text };
  const doc = await context.readText(file);

  return doc === null || isClosed(doc) || !unanswered(doc).includes(id)
    ? { kind: "ended" }
    : { kind: "open" };
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  const { dispatch, inOrder } = context;

  /** Every event of the grill's own, once the directory is known to be there (F6). */
  const stepped = async (
    event: string,
    input: EventInput | Reading,
    actor: Actor,
  ): Promise<Response | null> => {
    if ((await workspaceIfAny(context)) === null) return refused("the plan's directory is gone");
    const { verdict } = await dispatch(event, input, actor);

    return verdict.kind === "allow" ? null : refused(verdict.reason);
  };

  return {
    "GET state": async () => {
      const workspace = await workspaceIfAny(context);

      if (workspace === null) return refused("the plan's directory is gone");
      const current = await latest(context, workspace.dir);

      return Response.json(stateOf(current));
    },

    // End grill: what the page saved for the grill goes as its reply, told before the end. The
    // draft is read in the close's own step: a Send before it took what it sent out of the draft.
    "POST close": async (request) => {
      const reason = parseCloseReason(await request.json().catch(() => null));

      if (reason === null) return badRequest();

      const answer = await stepped(
        "endGrill",
        async (w) => {
          const region = w.regions.find(({ id }) => id === GRILL);
          const file = projectPath(`${w.workspace.dir}${grillFile(Number(region?.data.n ?? 0))}`);
          const typing = reason === "page" ? typingOn(await context.draft(), file) : NOTHING_TYPED;

          return { reason, grill: JSON.stringify(typing) };
        },
        reason === "page" ? "reviewer" : "engine",
      );

      return answer ?? new Response(null, NO_CONTENT);
    },

    "POST ask": async (request) => {
      const questions = parseQuestions(await request.json().catch(() => null));

      if (questions === null) return badRequest();

      if ((await workspaceIfAny(context)) === null) return refused("the plan's directory is gone");
      const q = JSON.stringify(questions.map(({ title, ask, rec }) => [title, ask, rec]));
      const { verdict, workflow } = await dispatch("askQuestion", { q }, "claude");

      if (verdict.kind !== "allow") return refused(verdict.reason);
      const region = workflow.regions.find(({ id }) => id === GRILL);
      const n = Number(region?.data.n ?? 0);
      const last = nextQuestion(String(region?.data.doc ?? "")) - 1;
      const file = projectPath(`${workflow.workspace.dir}${grillFile(n)}`);
      const asked: Asked = { first: last - questions.length + 1, last, file };

      return Response.json(asked);
    },

    // Read in the queue, so a Send's step is seen whole: its reply and the entry that carried it.
    "POST wait": async (request) => {
      const body = parseWait(await request.json().catch(() => null));
      const file = body === null ? null : parseProjectPath(body.file);

      if (body === null || file?.ok !== true) return badRequest();

      const waited = await context.hold(
        () => inOrder(() => waitedOn(context, file.value, body.first)),
        ({ kind }) => kind === "open",
      );

      return Response.json(waited);
    },

    "POST event": async (request) => {
      const event = parseEvent(await request.json().catch(() => null));

      if (event === null) return badRequest();

      return (
        (await stepped("sessionEvent", { command: event.command }, "engine")) ??
        new Response(null, NO_CONTENT)
      );
    },

    "POST answer": async (request) => {
      const answer = parseAnswer(await request.json().catch(() => null));

      if (answer === null) return badRequest();

      const input = {
        text: answer.text,
        reason: answer.reason,
        own: String(answer.own),
        asked: String(answer.asked),
      };

      return (await stepped("turnAnswered", input, "engine")) ?? new Response(null, NO_CONTENT);
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

export const grillServer: ServerExtension = {
  id: "grill",
  routes,
  start,
  part,
  workflow: {
    events: EVENTS,
    rules: RULES,
    transitions: TRANSITIONS,
    reaction: REACTION,
    region: async (context) => {
      const { dir } = await context.workspace();
      const current = await latest(context, dir);

      return regionOf(current === null ? null : { n: current.n, doc: current.doc });
    },
    segment: segmentOf,
  },
};
