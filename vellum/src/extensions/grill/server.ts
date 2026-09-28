import { join } from "node:path";

import type {
  Refusal,
  Reply,
  SendPart,
  ServerContext,
  ServerHalf,
  SliceContext,
  SliceDispatched,
} from "../../core/extension.ts";
import type { Draft, PlanWorkspace } from "../../core/protocol.ts";
import type { ProjectPath } from "../../core/server/domain/paths.ts";
import { parseProjectPath } from "../../core/server/domain/paths.ts";
import { projectPath } from "../../core/server/domain/workspace.ts";
import type { Block, GrillPlugs, GrillState, Typing, Waited } from "./contract.ts";
import { RULES, SLICE } from "./contract.ts";
import {
  callOf,
  GRILL,
  lineOf,
  openingOf,
  REACTIONS,
  regionOf,
  SAMPLES,
  segmentOf,
  TRANSITIONS,
  WALK,
} from "./grill.ts";
import { BODIES, grillFile, grillFileName, grillNumber, parseOpened } from "./parse.ts";
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

type Context = SliceContext<GrillPlugs>;

/** A transcript of the plan's directory, read: the one with the highest number is the current one. */
type Transcript = { readonly n: number; readonly file: ProjectPath; readonly doc: string };

/** A link the page may follow: http, mailto, a fragment or a relative path; any other scheme runs code. */
const SAFE_HREF = /^(?:https?:|mailto:|[^:]*(?:[/?#]|$))/iu;

/** Before any event: no row judges a directory the server lost. */
const DIRECTORY_GONE: Refusal = { status: 409, reason: "the plan's directory is gone" };

const NOT_FOUND: Reply<never> = { refused: { status: 404, reason: "not found" } };

/** A transcript's path outside the project: `parseWait` reads the shape, the domain the path. */
const BAD_REQUEST: Reply<never> = { refused: { status: 400, reason: "bad request" } };

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
function workspaceIfAny(context: Pick<ServerContext, "workspace">): Promise<PlanWorkspace | null> {
  return context.workspace().catch(() => null);
}

async function latest(
  context: Pick<ServerContext, "listFiles" | "readText">,
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
async function openGrill(context: Context): Promise<Transcript | null> {
  const workspace = await workspaceIfAny(context);
  const current = workspace === null ? null : await latest(context, workspace.dir);

  return current === null || isClosed(current.doc) ? null : current;
}

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
async function start(context: Context, { subject }: GrillPlugs["opened"]): Promise<string> {
  const workspace = await workspaceIfAny(context);

  if (workspace === null) return "";
  const current = await latest(context, workspace.dir);
  const name = grillFile((current?.n ?? 0) + 1);

  return openingOf(name, subject, current === null ? GUIDE : null);
}

const NO_PART: SendPart<Typing> = { kind: "none" };

/**
 * The grill's part of the bar's Send, read off the open grill and the draft, writing nothing: the
 * questions no answer takes, unless the reviewer agreed to leave every one to its recommendation;
 * else the reply the draft holds, which closes every open question, and the typing the Send's
 * event carries for the grill's reaction to write it.
 */
async function part(
  context: Context,
  draft: Draft,
  takeDefaults: readonly string[],
): Promise<SendPart<Typing>> {
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
    input: typing,
  };
}

/**
 * Where the round asked in `file` from question `first` stands: answered by a Send the server
 * saw, closed any other way (End grill, the approval, a Send before a restart), or still open.
 */
async function waitedOn(context: Context, file: ProjectPath, first: number): Promise<Waited> {
  const id = `Q${first}`;
  const name = file.split("/").at(-1) ?? "";
  const returned = context.returned(callOf(name, id));

  if (returned !== null) return { kind: "answered", seq: returned.seq, text: returned.text };
  const doc = await context.readText(file);

  return doc === null || isClosed(doc) || !unanswered(doc).includes(id)
    ? { kind: "ended" }
    : { kind: "open" };
}

/** Every event of the grill's own, once the directory is known to be there (F6). */
async function stepped(
  context: Context,
  step: () => Promise<SliceDispatched>,
): Promise<Reply<null>> {
  if ((await workspaceIfAny(context)) === null) return { refused: DIRECTORY_GONE };
  const { verdict } = await step();

  return verdict.kind === "allow" ? { answer: null } : { refused: verdict };
}

export const server: ServerHalf<GrillPlugs> = {
  id: "grill",
  bodies: BODIES,
  routes: {
    "GET state": async (context) => {
      const workspace = await workspaceIfAny(context);

      if (workspace === null) return { refused: DIRECTORY_GONE };

      return { answer: stateOf(await latest(context, workspace.dir)) };
    },

    // End grill: what the page saved for the grill goes as its reply, told before the end. The
    // draft is read in the close's own step: a Send before it took what it sent out of the draft.
    "POST close": (context, { reason }) =>
      stepped(context, () =>
        context.dispatch(
          "endGrill",
          async (w) => {
            const region = w.regions.find(({ id }) => id === GRILL);
            const file = projectPath(`${w.workspace.dir}${grillFile(Number(region?.data.n ?? 0))}`);

            const typing =
              reason === "page" ? typingOn(await context.draft(), file) : NOTHING_TYPED;

            return { reason, grill: JSON.stringify(typing) };
          },
          reason === "page" ? "reviewer" : "engine",
        ),
      ),

    "POST ask": async (context, { q }) => {
      if ((await workspaceIfAny(context)) === null) return { refused: DIRECTORY_GONE };
      const { verdict, workflow } = await context.dispatch("askQuestion", { q: JSON.stringify(q) });

      if (verdict.kind !== "allow") return { refused: verdict };
      const region = workflow.regions.find(({ id }) => id === GRILL);
      const n = Number(region?.data.n ?? 0);
      const last = nextQuestion(String(region?.data.doc ?? "")) - 1;
      const file = projectPath(`${workflow.workspace.dir}${grillFile(n)}`);

      return { answer: { first: last - q.length + 1, last, file } };
    },

    // Read in the queue, so a Send's step is seen whole: its reply and the entry that carried it.
    "POST wait": async (context, { file, first }) => {
      const path = parseProjectPath(file);

      if (!path.ok) return BAD_REQUEST;

      return {
        answer: await context.hold(
          () => context.inOrder(() => waitedOn(context, path.value, first)),
          ({ kind }) => kind === "open",
        ),
      };
    },

    "POST event": (context, { command }) =>
      stepped(context, () => context.dispatch("sessionEvent", { command })),

    "POST answer": (context, answer) =>
      stepped(context, () =>
        context.dispatch("turnAnswered", {
          text: answer.text,
          reason: answer.reason,
          own: String(answer.own),
          asked: String(answer.asked),
        }),
      ),

    "GET blocks": async (context, query) => {
      const name = grillFileName(query.file);
      const workspace = await workspaceIfAny(context);

      if (name === null || workspace === null) return NOT_FOUND;
      const doc = await context.readText(projectPath(`${workspace.dir}${name}`));

      return doc === null ? NOT_FOUND : { answer: blocksOf(doc) };
    },
  },
  opened: parseOpened,
  start,
  part,
  workflow: {
    events: SLICE.events,
    rules: RULES,
    samples: SAMPLES,
    transitions: TRANSITIONS,
    reactions: REACTIONS,
    region: async (context) => {
      const { dir } = await context.workspace();
      const current = await latest(context, dir);

      return regionOf(current === null ? null : { n: current.n, doc: current.doc });
    },
    segment: segmentOf,
    line: lineOf,
    walk: WALK,
  },
};
