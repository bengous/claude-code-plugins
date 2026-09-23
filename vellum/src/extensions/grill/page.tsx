import { signal } from "@preact/signals";
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
import { declineFailure, footerOf } from "./labels.ts";
import { grillNumber } from "./parse.ts";
import { GrillButton, Proposal } from "./proposal.tsx";
import type { Block, GrillPosts, GrillState } from "./protocol.ts";

const ID = "grill";

/** What "Take it" answers: Claude wrote the recommendation, so its text never goes back to it. */
const TAKEN = "As recommended.";

/** The server's word on the grill, loaded again at every workspace event; `null` before the first answer. */
const grill = signal<GrillState | null>(null);

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

  // SAFETY: the server's own `GrillState`, serialized by `Response.json` in grill/server.ts.
  const state = response.ok ? ((await response.json()) as GrillState) : null;

  if (state !== null) forgetClosed(state);
  grill.value = state;
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

/** Why the Grill button is greyed, in its title; `null` while a grill can open. */
function grillWhy(state: GrillState | null): string | null {
  if (connection.value === "down") return "The connection to the review server is lost";

  if (editing.value !== null) return "Finish editing (Done) first";

  if (review.value?.workspace.kind === "changesRequested")
    return "Waiting for Claude's next version";

  if (state === null) return "Loading the review";

  return state.kind === "open" ? `${nameOf(state.file)} is already open` : null;
}

function GrillAction(): preact.JSX.Element | null {
  const view = review.value;
  const state = grill.value;

  useEffect(() => {
    void loadState();
  }, [view]);

  return view?.workspace.kind === "approved" ? null : (
    <GrillButton state={state} why={grillWhy(state)} />
  );
}

function GrillNotice(): preact.JSX.Element | null {
  const state = grill.value;

  return (
    <Proposal
      state={state}
      approved={review.value?.workspace.kind === "approved"}
      why={grillWhy(state)}
      onStart={openGrill}
      onDecline={decline}
    />
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

const NOTHING_TYPED: Typed["grill"][string] = { answers: {}, note: "" };

function OpenGrill(props: {
  readonly state: Extract<GrillState, { kind: "open" }>;
}): preact.JSX.Element {
  const { file: path, phase } = props.state;
  const modified = docs.value.find((doc) => doc.path === path)?.modified ?? 0;
  const blocks = useBlocks(path, modified);
  /** The reviewer's typing on this transcript, in the draft: it survives the panel and a reload. */
  const own = typed.value.grill[path] ?? NOTHING_TYPED;

  const answer = (id: string, text: string): void =>
    setTyped({
      grill: { ...typed.value.grill, [path]: { ...own, answers: { ...own.answers, [id]: text } } },
    });

  const note = (text: string): void =>
    setTyped({ grill: { ...typed.value.grill, [path]: { ...own, note: text } } });

  const forget = (): void => {
    const { [path]: _gone, ...rest } = typed.value.grill;
    setTyped({ grill: rest });
  };

  const answered = (id: string): string => own.answers[id]?.trim() ?? "";

  const open = blocks.flatMap((block) =>
    block.kind === "question" && block.answer === null ? [block.id] : [],
  );

  const sendable = open.length > 0 || own.note.trim() !== "";

  const send = async (): Promise<boolean> => {
    const taken = await reply(
      open.map((id) => ({ id, text: answered(id) })),
      own.note.trim(),
    );

    if (taken) forget();

    return taken;
  };

  /** What is typed goes first, as a reply; an empty field takes the recommendation, as a send does. */
  const end = async (): Promise<void> => {
    if (sendable && !(await send())) return;
    await post("close", { reason: "page" });
  };

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
                onSend={sendable ? () => void send() : null}
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
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && sendable) {
                void send();
              }
            }}
          />
          <p class="note">
            {open.length > 0
              ? "An empty field takes the recommendation. Answers go to Claude once its turn ends."
              : "No question is open. A note goes to Claude once its turn ends."}
          </p>
          <div class="row">
            <Button onClick={() => void end()}>End grill</Button>
            <Button variant="send" disabled={!sendable} onClick={() => void send()}>
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
