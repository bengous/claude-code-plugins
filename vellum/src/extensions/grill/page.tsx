import { batch, computed, signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";

import type { PageExtension, RendererProps } from "../../core/extension.ts";
import { extensionRequest } from "../../core/page/api.ts";
import { Button } from "../../core/page/kit.tsx";
import {
  connection,
  docs,
  editing,
  fail,
  review,
  setTyped,
  succeed,
  typed,
} from "../../core/page/state.ts";
import type { Typed } from "../../core/protocol.ts";
import { declineFailure, footerOf, waitingOf } from "./labels.ts";
import { grillNumber } from "./parse.ts";
import { GrillButton, Proposal } from "./proposal.tsx";
import type { Block, GrillPosts, GrillState } from "./protocol.ts";

const ID = "grill";

/** What "Take it" answers: Claude wrote the recommendation, so its text never goes back to it. */
const TAKEN = "As recommended.";

/**
 * The server's last word on the grill, loaded again at every workspace event; `null` before the
 * first answer. A refused read keeps it, so the panel stays as the reviewer left it.
 */
const grill = signal<GrillState | null>(null);

/** Whether the last read of the state was refused. */
const refused = signal(false);

/** What the Grill button and the modal read: no state past a refused read, which puts the modal on screen off. */
const read = computed(() => (refused.value ? null : grill.value));

/** The open grill's blocks, which the band and the panel draw alike: one load per write of its file. */
const transcript = signal<{ readonly path: string; readonly blocks: readonly Block[] } | null>(
  null,
);

/**
 * The write of the open transcript loaded, or on its way: a workspace event that did not write it
 * loads nothing. A load that failed leaves none, so the next event reads again.
 */
let transcriptAsked: string | null = null;

function nameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** The typing kept for a transcript no grill is open on has no field left: it goes. */
function forgetClosed(state: GrillState): void {
  const open = state.kind === "open" ? state.file : null;
  const kept = typed.peek().grill;
  const closed = Object.keys(kept).filter((path) => path !== open);

  if (closed.length === 0) return;
  setTyped({ grill: Object.fromEntries(Object.entries(kept).filter(([path]) => path === open)) });
}

async function loadState(): Promise<void> {
  const response = await extensionRequest(ID, "state");

  if (!response.ok) {
    refused.value = true;

    return;
  }

  // SAFETY: the server's own `GrillState`, serialized by `Response.json` in grill/server.ts.
  const state = (await response.json()) as GrillState;
  forgetClosed(state);

  batch(() => {
    grill.value = state;
    refused.value = false;
  });

  if (state.kind === "open") await loadTranscript(state.file);
}

async function loadTranscript(path: string): Promise<void> {
  const write = `${path}@${docs.peek().find((doc) => doc.path === path)?.modified ?? 0}`;

  if (write === transcriptAsked) return;
  transcriptAsked = write;
  const blocks = await blocksOf(path);

  if (transcriptAsked !== write) return;

  if (blocks === null) transcriptAsked = null;
  else transcript.value = { path, blocks };
}

/** The blocks of the open transcript at `path`, `null` until they land. */
function blocksOn(path: string): readonly Block[] | null {
  const loaded = transcript.value;

  return loaded?.path === path ? loaded.blocks : null;
}

/** The questions no reply closed yet, by their number. */
function openIn(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) =>
    block.kind === "question" && block.answer === null ? [block.id] : [],
  );
}

/** The transcript's blocks, or `null` with the failure in the notices: the reviewer waits on them. */
async function blocksOf(path: string): Promise<Block[] | null> {
  try {
    const response = await extensionRequest(ID, `blocks?file=${encodeURIComponent(path)}`);

    if (response.ok) {
      succeed("extension");

      // SAFETY: the server's own `Block[]`, serialized by `Response.json` in grill/server.ts.
      return (await response.json()) as Block[];
    }

    fail(
      "extension",
      `${nameOf(path)} could not be loaded: the server answered ${response.status}.`,
    );
  } catch {
    fail("extension", `${nameOf(path)} could not be loaded: the server did not answer.`);
  }

  return null;
}

/** What a post that failed says, from the status the server answered; `null` when it did not answer. */
type Failed = (status: number | null) => string;

function sendFailure(status: number | null): string {
  return status === null
    ? "The grill did not reach the server. What you typed is kept."
    : `The grill was refused: the server answered ${status}.`;
}

/** What the reviewer waits on: a refusal or a server that did not answer is a failure the notices show. */
async function post<Name extends keyof GrillPosts>(
  path: Name,
  body: GrillPosts[Name],
  failed: Failed = sendFailure,
): Promise<Response> {
  const response = await extensionRequest(ID, path, {
    method: "POST",
    body: JSON.stringify(body),
  }).catch(() => null);

  if (response === null) {
    fail("send", failed(null));

    return Response.error();
  }

  if (response.ok) succeed("send");
  else fail("send", failed(response.status));

  return response;
}

/** `true` once the proposal no longer waits on the reviewer: declined, or already answered or replaced (409). */
async function decline(id: string): Promise<boolean> {
  const response = await post("decline", { id }, declineFailure);

  return response.ok || response.status === 409;
}

/** `true` once the grill opened; the document pane keeps what it shows, the panel comes beside it. */
async function openGrill(subject: string): Promise<boolean> {
  return (await post("open", { subject })).ok;
}

/** `true` once the server took it: the typing it carried can go. */
async function reply(
  answers: readonly { id: string; text: string }[],
  note: string,
): Promise<boolean> {
  return (await post("reply", { answers, note })).ok;
}

const NOTHING_TYPED: Typed["grill"][string] = { answers: {}, note: "" };

/** The reviewer's typing on a transcript, in the draft: it survives the panel and a reload. */
function typedOn(path: string): Typed["grill"][string] {
  return typed.value.grill[path] ?? NOTHING_TYPED;
}

/** Whether a send writes anything: an open question, which an empty field answers, or a note. */
function sendable(path: string, open: readonly string[]): boolean {
  return open.length > 0 || typedOn(path).note.trim() !== "";
}

/** What is typed goes as a reply, an empty field taking the recommendation; `true` once the server took it. */
async function send(path: string, open: readonly string[]): Promise<boolean> {
  const own = typedOn(path);

  const taken = await reply(
    open.map((id) => ({ id, text: own.answers[id]?.trim() ?? "" })),
    own.note.trim(),
  );

  if (taken) {
    const { [path]: _gone, ...rest } = typed.value.grill;
    setTyped({ grill: rest });
  }

  return taken;
}

/** End grill: what is typed goes first, as a send does, then the close. */
async function end(path: string, open: readonly string[]): Promise<void> {
  if (sendable(path, open) && !(await send(path, open))) return;
  await post("close", { reason: "page" });
}

/** Why the Grill button is greyed, in its title; `null` while a grill can open. It hides while one is. */
function grillWhy(state: GrillState | null): string | null {
  if (connection.value === "down") return "The connection to the review server is lost";

  if (editing.value !== null) return "Finish editing (Done) first";

  if (review.value?.workspace.kind === "changesRequested")
    return "Waiting for Claude's next version";

  return state === null ? "Loading the review" : null;
}

function GrillAction(): preact.JSX.Element | null {
  const view = review.value;
  const state = read.value;

  useEffect(() => {
    void loadState();
  }, [view]);

  return view?.workspace.kind === "approved" || grill.value?.kind === "open" ? null : (
    <GrillButton state={state} why={grillWhy(state)} />
  );
}

/** Above the page while a grill is open: its subject, the questions that wait for the reviewer, and End grill. */
function GrillBand(props: {
  readonly state: Extract<GrillState, { kind: "open" }>;
}): preact.JSX.Element {
  const { file, subject } = props.state;
  const blocks = blocksOn(file);
  const open = openIn(blocks ?? []);
  const waiting = waitingOf(open.length);
  /** An end in flight: a second click would send what is typed again. */
  const [ending, setEnding] = useState(false);

  return (
    <div class="grill-band" role="status">
      <span class="subject" title={subject}>
        Grill · {subject}
      </span>
      {waiting !== null && <span class="count">{waiting}</span>}
      <Button
        size="sm"
        disabled={blocks === null || ending}
        title={blocks === null ? "Loading the grill" : undefined}
        onClick={() => {
          if (ending) return;
          setEnding(true);
          void end(file, open).finally(() => setEnding(false));
        }}
      >
        End grill
      </Button>
    </div>
  );
}

function GrillNotice(): preact.JSX.Element {
  const kept = grill.value;
  const state = read.value;

  return (
    <>
      {kept?.kind === "open" && <GrillBand state={kept} />}
      <Proposal
        state={state}
        approved={review.value?.workspace.kind === "approved"}
        why={grillWhy(state)}
        onStart={openGrill}
        onDecline={decline}
      />
    </>
  );
}

type QuestionBlock = Extract<Block, { kind: "question" }>;

type CardProps = {
  readonly block: QuestionBlock;
  readonly answer: string;
  /** `null` once the question is answered, and in the document pane: the card takes nothing. */
  readonly onAnswer: ((text: string) => void) | null;
  /** Ctrl+Enter in the card's field, as in the foot's; `null` while nothing can be sent. */
  readonly onSend: (() => void) | null;
};

/** Take it fills an empty field: over a typed answer it is greyed, so a click never replaces the typing. */
function QuestionCard(props: CardProps): preact.JSX.Element {
  const { block } = props;

  return (
    <div class="grill-q">
      <h4 class="head">
        <span class="num">{block.id}</span>
        <span class="topic">{block.title}</span>
      </h4>
      {/* oxlint-disable-next-line react/no-danger -- the question arrives rendered, by the same `toHtml` of grill/server.ts as the blocks between the cards. */}
      <div class="ask" dangerouslySetInnerHTML={{ __html: block.ask }} />
      {block.rec !== "" && (
        <div class="rec">
          <span class="label">Recommended</span>
          {/* oxlint-disable-next-line react/no-danger -- as the question above: rendered by `toHtml` in grill/server.ts. */}
          <div class="text" dangerouslySetInnerHTML={{ __html: block.rec }} />
          {props.onAnswer !== null && (
            <Button
              size="sm"
              disabled={props.answer.trim() !== ""}
              onClick={() => props.onAnswer?.(TAKEN)}
            >
              Take it
            </Button>
          )}
        </div>
      )}
      {block.answer !== null && (
        <div class="answer">
          <span class="label">Your answer</span>
          <span class="text">{block.answer}</span>
        </div>
      )}
      {props.onAnswer !== null && (
        <textarea
          aria-label={`Answer to ${block.id}`}
          placeholder={`Answer ${block.id}, or leave empty to take the recommendation`}
          value={props.answer}
          onInput={(event) => props.onAnswer?.(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) props.onSend?.();
          }}
        />
      )}
    </div>
  );
}

/** The transcript's blocks, loaded again at each write of the file: `modified` changes with it. */
function useBlocks(path: string, modified: number): readonly Block[] {
  const [blocks, setBlocks] = useState<readonly Block[]>([]);

  useEffect(() => {
    void blocksOf(path).then((loaded) => {
      if (loaded !== null) setBlocks(loaded);
    });
  }, [path, modified]);

  return blocks;
}

/** The blocks in the file's order; `card` draws a question, read-only in the document pane, answered in the panel. */
function Transcript(props: {
  readonly blocks: readonly Block[];
  readonly card: (block: QuestionBlock) => preact.JSX.Element;
}): preact.JSX.Element {
  return (
    <>
      {props.blocks.map((block, index) =>
        block.kind === "opened" ? (
          <div key={index}>
            <h1>Grill: {block.subject}</h1>
            <p class="grill-when">Started {block.at}</p>
          </div>
        ) : block.kind === "closed" ? (
          <div key={index}>
            <hr />
            <p class="grill-when">
              {footerOf(block.reason)} · {block.at}
            </p>
          </div>
        ) : block.kind === "html" ? (
          // The server rendered it with raw HTML escaped and unsafe links cut: `toHtml`.
          // oxlint-disable-next-line react/no-danger -- the transcript's Markdown arrives rendered, since the page bundles no Markdown parser for it; `toHtml` in grill/server.ts is what makes it safe to insert.
          <div key={index} dangerouslySetInnerHTML={{ __html: block.html }} />
        ) : (
          props.card(block)
        ),
      )}
    </>
  );
}

/** Any `grill-<n>.md`, open or closed, as a document: the panel is the one place a grill is answered. */
function GrillDoc(props: RendererProps): preact.JSX.Element {
  const blocks = useBlocks(props.doc.path, props.doc.modified);

  return (
    <div class="grill-doc">
      <div class="plan">
        <Transcript
          blocks={blocks}
          card={(block) => (
            <QuestionCard key={block.id} block={block} answer="" onAnswer={null} onSend={null} />
          )}
        />
      </div>
    </div>
  );
}

function OpenGrill(props: {
  readonly state: Extract<GrillState, { kind: "open" }>;
}): preact.JSX.Element {
  const { file: path, phase } = props.state;
  const blocks = blocksOn(path) ?? [];
  const own = typedOn(path);

  const answer = (id: string, text: string): void =>
    setTyped({
      grill: { ...typed.value.grill, [path]: { ...own, answers: { ...own.answers, [id]: text } } },
    });

  const note = (text: string): void =>
    setTyped({ grill: { ...typed.value.grill, [path]: { ...own, note: text } } });

  const open = openIn(blocks);
  const live = sendable(path, open);

  const sheet = useRef<HTMLDivElement>(null);
  const openBefore = useRef(0);
  const firstOpen = open[0] ?? null;

  // A round that lands scrolls to its first card: the reviewer reads at the bottom, under the foot.
  useEffect(() => {
    const landed = openBefore.current === 0 && open.length > 0;
    openBefore.current = open.length;

    if (!landed || firstOpen === null) return;

    for (const card of sheet.current?.querySelectorAll<HTMLElement>(".grill-q") ?? []) {
      if (card.querySelector(".num")?.textContent === firstOpen) {
        card.scrollIntoView({ block: "start" });

        return;
      }
    }
  }, [firstOpen, open.length]);

  return (
    <aside class="grill-panel" aria-label="Grill">
      <div class="grill-sheet" ref={sheet}>
        <div class="plan">
          <Transcript
            blocks={blocks}
            card={(block) => (
              <QuestionCard
                key={block.id}
                block={block}
                answer={own.answers[block.id] ?? ""}
                onAnswer={block.answer === null ? (text) => answer(block.id, text) : null}
                onSend={live ? () => void send(path, open) : null}
              />
            )}
          />
          {phase === "working" && (
            <p class="grill-working" role="status">
              Claude is working. The next round appears here.
            </p>
          )}
        </div>
        <div class="grill-foot">
          <textarea
            aria-label="Anything else for Claude"
            placeholder="Anything else. Ctrl+Enter sends."
            value={own.note}
            onInput={(event) => note(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && live) {
                void send(path, open);
              }
            }}
          />
          <p class="note">
            {open.length > 0
              ? "An empty field takes the recommendation. Answers go to Claude once its turn ends."
              : "No question is open. A note goes to Claude once its turn ends."}
          </p>
          <div class="row">
            <Button variant="send" disabled={!live} onClick={() => void send(path, open)}>
              Send answers
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Beside the document pane while a grill is open: its rounds, its fields and its foot. */
function GrillPanel(): preact.JSX.Element | null {
  const state = grill.value;

  return state?.kind === "open" ? <OpenGrill key={state.file} state={state} /> : null;
}

export const grillPage: PageExtension = {
  id: "grill",
  renderers: [
    {
      accepts: (doc) => doc.mediaType === "text/markdown" && grillNumber(nameOf(doc.path)) !== null,
      component: GrillDoc,
      comments: false,
    },
  ],
  actions: [GrillAction],
  notices: [GrillNotice],
  panel: { shown: () => grill.value?.kind === "open", component: GrillPanel },
};
