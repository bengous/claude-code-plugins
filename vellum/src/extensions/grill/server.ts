import type {
  Part,
  Route,
  RouteKey,
  ServerContext,
  ServerExtension,
} from "../../core/extension.ts";
import type { Draft, PlanWorkspace } from "../../core/protocol.ts";
import type { ParseResult, ProjectPath } from "../../core/server/domain/paths.ts";
import { parseProjectPath } from "../../core/server/domain/paths.ts";
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
  parseSubject,
  parseWait,
} from "./parse.ts";
import type { Asked, Block, GrillState, Waited } from "./protocol.ts";
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
  unanswered,
} from "./transcript.ts";

/** A transcript of the plan's directory, read: the one with the highest number is the current one. */
type Transcript = { readonly n: number; readonly file: ProjectPath; readonly doc: string };

/**
 * What a change makes of the transcript: the file to write, the answer once it is written, and
 * whether Claude hears of the entries it added: the reviewer's gestures alone are told, and a grill
 * the session ended itself is not.
 */
type Written = { readonly doc: string; readonly answer: Response; readonly told: boolean };

/** A round a Send closed, under the entry that carried it: what a waiting `grill_ask` returns. */
type Closed = {
  readonly file: ProjectPath;
  readonly ids: ReadonlySet<string>;
  readonly seq: number;
  readonly text: string;
};

/**
 * What the server keeps of the Sends while it runs, per review: a restarted one keeps nothing,
 * and a wait it cannot answer from the transcript alone reads as ended, so the entry goes to
 * Claude through the channel instead.
 */
type Memory = { readonly closed: Closed[] };

const memories = new WeakMap<ServerContext, Memory>();

function memoryOf(context: ServerContext): Memory {
  const known = memories.get(context);

  if (known !== undefined) return known;
  const made: Memory = { closed: [] };
  memories.set(context, made);

  return made;
}

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
  before: string,
  after: string,
): Promise<void> {
  const known = relaysOf(before, name, -1).length - 1;

  for (const relay of relaysOf(after, name, known)) {
    await context.relay({ kind: "text", from: "grill", text: toldOf(relay, false) });
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

/** The reviewer's reply as the transcript writes it: the answers typed, and the note. */
function replied(doc: string, typing: Typing): string | null {
  const answers = Object.entries(typing.answers).map(([id, text]) => ({ id, text }));

  return appendReply(doc, answers, typing.note);
}

/** The questions the typing leaves open, which a Send or an end takes by default. */
function untouched(doc: string, typing: Typing): readonly string[] {
  return unanswered(doc).filter((id) => (typing.answers[id]?.trim() ?? "") === "");
}

/** The last reply of the file as Claude reads it. */
function lastReply(doc: string, name: string): string {
  return relaysOf(doc, name, -1).findLast((relay) => relay.kind === "reply")?.text ?? "";
}

/** What is typed goes as the reply, every question it leaves open by default, then the footer. */
function ended(doc: string, reason: string, typing: Typing = NOTHING_TYPED): string {
  return appendFooter(replied(doc, typing) ?? doc, reason, new Date());
}

async function holds(context: ServerContext): Promise<string | null> {
  const open = await openGrill(context);

  return open === null ? null : `grill ${open.n} is open`;
}

/**
 * Opens a grill on the subject, from `step`'s answer, in that answer's step of the queue, so a
 * grill never opens over another. It tells nothing itself: it answers what Claude is told, the
 * file, the subject and, at the directory's first grill, the guide, which the answer's entry carries.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` comes from `step` through the core; `parseSubject` is the boundary that reads it.
async function start(context: ServerContext, input: unknown): Promise<ParseResult<string>> {
  const subject = parseSubject(input);

  if (subject === null) return { ok: false, error: "a grill's subject is one line, not empty" };
  const workspace = await workspaceIfAny(context);

  if (workspace === null) return { ok: false, error: "the plan's directory is gone" };

  if (workspace.kind === "approved") return { ok: false, error: "the plan is approved" };
  const current = await latest(context, workspace.dir);

  if (current !== null && !isClosed(current.doc)) {
    return { ok: false, error: `${grillFile(current.n)} is open` };
  }

  const name = grillFile((current?.n ?? 0) + 1);
  const session = /wip-([0-9a-f]{8})\/$/u.exec(workspace.dir)?.[1] ?? "";
  await context.writeText(
    projectPath(`${workspace.dir}${name}`),
    header(subject, session, new Date()),
  );
  await context.notify();

  return { ok: true, value: toldOf({ kind: "opened", seq: 0, name, subject }, current === null) };
}

/** Runs inside the review's queue, after the rename: the footer lands in the final directory, module alive or not. */
async function approved(context: ServerContext): Promise<void> {
  const open = await openGrill(context);

  if (open !== null) await context.writeText(open.file, ended(open.doc, "approved"));
  context.wake();
}

const NO_PART: Part = { kind: "none" };

/**
 * The grill's part of the bar's Send, read off the open grill and the draft, writing nothing: the
 * questions no answer takes, unless the reviewer agreed to leave every one to its recommendation;
 * else the reply the draft holds, which closes every open question. Its commit runs once the
 * batch and its entry exist: the Send is kept for the waits on its round first, so a transcript
 * that fails to take the reply still answers them, then the reply closes the round.
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
  const doc = replied(open.doc, typing);

  if (doc === null) return NO_PART;
  const name = grillFile(open.n);
  const reply = lastReply(doc, name);
  const ids = new Set(unanswered(open.doc));

  return {
    kind: "part",
    text: `## Grill\n\n\`${name}\`\n\n${reply}`,
    typed: (typed) => ({
      ...typed,
      grill: Object.fromEntries(Object.entries(typed.grill).filter(([file]) => file !== open.file)),
    }),
    commit: async ({ file, seq, more }) => {
      const memory = memoryOf(context);
      const rest = more ? `\n\nComments and choices: read ${file}.` : "";
      memory.closed.push({ file: open.file, ids, seq, text: `${reply}${rest}` });
      context.wake();
      await context.writeText(open.file, doc);
    },
  };
}

/**
 * Where the round asked in `file` from question `first` stands: answered by a Send the server
 * saw, closed any other way (End grill, the approval, a Send before a restart), or still open.
 */
async function waitedOn(context: ServerContext, file: ProjectPath, first: number): Promise<Waited> {
  const id = `Q${first}`;
  const closed = memoryOf(context).closed.find((one) => one.file === file && one.ids.has(id));

  if (closed !== undefined) return { kind: "answered", seq: closed.seq, text: closed.text };
  const doc = await context.readText(file);

  return doc === null || isClosed(doc) || !unanswered(doc).includes(id)
    ? { kind: "ended" }
    : { kind: "open" };
}

function routes(context: ServerContext): Readonly<Record<RouteKey, Route>> {
  const { inOrder } = context;

  /**
   * Reads the current transcript at write time: after an approval the directory has moved.
   * `apply` answers a refusal to write nothing; with no grill open, `none` is the answer.
   */
  const change = (
    apply: (current: Transcript) => Written | Response | Promise<Written | Response>,
    none: () => Response = () => new Response(null, NO_CONTENT),
  ): Promise<Response> =>
    inOrder(async () => {
      const workspace = await workspaceIfAny(context);

      if (workspace === null) return refused("the plan's directory is gone");
      const current = await latest(context, workspace.dir);

      if (current === null || isClosed(current.doc)) return none();
      const applied = await apply(current);

      if (applied instanceof Response) return applied;
      await context.writeText(current.file, applied.doc);

      if (applied.told) await tell(context, grillFile(current.n), current.doc, applied.doc);
      context.wake();
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

      return Response.json(stateOf(current));
    },

    // End grill: what the page saved for the grill goes as its reply, told before the end. The
    // draft is read in the close's own step: a Send before it took what it sent out of the draft.
    "POST close": async (request) => {
      const reason = parseCloseReason(await request.json().catch(() => null));

      if (reason === null) return badRequest();

      return await change(async ({ doc, file }) => {
        const draft = reason === "page" ? await context.draft() : null;

        return written(ended(doc, reason, typingOn(draft, file)), reason === "page");
      });
    },

    "POST ask": async (request) => {
      const questions = parseQuestions(await request.json().catch(() => null));

      if (questions === null) return badRequest();

      return await change(
        ({ doc, file }) => {
          const first = nextQuestion(doc);
          const asked: Asked = { first, last: first + questions.length - 1, file };

          return {
            doc: appendQuestions(doc, questions),
            answer: Response.json(asked),
            told: false,
          };
        },
        () => refused(NO_GRILL_OPEN),
      );
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

      return event === null
        ? badRequest()
        : await change(({ doc }) => written(appendEvent(doc, event.command)));
    },

    "POST answer": async (request) => {
      const answer = parseAnswer(await request.json().catch(() => null));

      return answer === null
        ? badRequest()
        : await change(({ doc }) => written(appendAnswer(doc, answer)));
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
  holds,
  start,
  approved,
  part,
};
