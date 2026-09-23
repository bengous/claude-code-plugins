import { batch, computed, signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";

import type { PageExtension, RendererProps } from "../../core/extension.ts";
import { extensionRequest } from "../../core/page/api.ts";
import { Button, Chip } from "../../core/page/kit.tsx";
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
import { answerOf, chipTitle, declineFailure, footerOf, progressOf } from "./labels.ts";
import { grillNumber } from "./parse.ts";
import { GrillButton, Proposal } from "./proposal.tsx";
import { AS_RECOMMENDED } from "./protocol.ts";
import type { Block, GrillPosts, GrillState } from "./protocol.ts";
import { roundNow, roundsOf } from "./rounds.ts";
import type { QuestionBlock, Rounds } from "./rounds.ts";

const ID = "grill";

/**
 * The server's last word on the grill, loaded again at every workspace event; `null` before the
 * first answer. A refused read keeps it, so the panel stays as the reviewer left it.
 */
const grill = signal<GrillState | null>(null);

/** Whether the last read of the state was refused. */
const refused = signal(false);

/** What the Grill button and the modal read: no state past a refused read, which puts the modal on screen off. */
const read = computed(() => (refused.value ? null : grill.value));

/** What the band and the panel draw: the state kept, and none once approved, since the approval closed the grill. */
const drawn = computed(() => (review.value?.workspace.kind === "approved" ? null : grill.value));

/**
 * The open grill's blocks, which the band and the panel draw alike, with the write they were read
 * at: a workspace event that did not write the file loads nothing, and any other loads it, a
 * load still out included, since that one may fail.
 */
const transcript = signal<{
  readonly path: string;
  readonly write: string;
  readonly blocks: readonly Block[];
} | null>(null);

/**
 * The reply out, or sent and not yet read back, with the write of the transcript it was sent
 * over: Send round and End grill wait on it alike, or the one clicked second sends what is typed
 * again, and a send over blocks that do not show the last reply yet closes nothing it sees.
 */
const replying = signal<{ readonly over: string | null; readonly out: boolean } | null>(null);

const replyPending = computed(() => {
  const pending = replying.value;

  return pending !== null && (pending.out || pending.over === transcript.value?.write);
});

/** The write of the open transcript last asked for: an older load that lands after it is dropped. */
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

  if (transcript.peek()?.write === write) return;
  transcriptAsked = write;
  const blocks = await blocksOf(path);

  if (blocks !== null && transcriptAsked === write) transcript.value = { path, write, blocks };
}

/** The blocks of the open transcript at `path`, `null` until they land. */
function blocksOn(path: string): readonly Block[] | null {
  const loaded = transcript.value;

  return loaded?.path === path ? loaded.blocks : null;
}

/** The questions no reply closed yet, by their number. */
function openIn(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block) =>
    block.kind === "question" && block.answer.kind === "open" ? [block.id] : [],
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

/** Whether a send writes anything: an open question, which the recommendation answers by default, or a note. */
function sendable(path: string, open: readonly string[]): boolean {
  return open.length > 0 || typedOn(path).note.trim() !== "";
}

/** The round's choices go as a reply, an untouched question taking the recommendation by default; `true` once the server took it. */
async function send(path: string, open: readonly string[]): Promise<boolean> {
  const own = typedOn(path);
  const over = transcript.peek()?.write ?? null;
  replying.value = { over, out: true };

  const taken = await reply(
    open.map((id) => ({ id, text: own.answers[id]?.trim() ?? "" })),
    own.note.trim(),
  );

  batch(() => {
    replying.value = taken ? { over, out: false } : null;

    if (taken) {
      const { [path]: _gone, ...rest } = typed.value.grill;
      setTyped({ grill: rest });
    }
  });

  return taken;
}

/** Why Send round and End grill wait, in their title; `undefined` while they can go. */
function replyWhy(blocks: readonly Block[] | null): string | undefined {
  if (blocks === null) return "Loading the grill";

  return replyPending.value ? "Waiting for the grill to show your reply" : undefined;
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

  return view?.workspace.kind === "approved" || drawn.value?.kind === "open" ? null : (
    <GrillButton state={state} why={grillWhy(state)} />
  );
}

/** Above the page while a grill is open: its subject, its round, the questions the reviewer has not touched, and End grill. */
function GrillBand(props: {
  readonly state: Extract<GrillState, { kind: "open" }>;
}): preact.JSX.Element {
  const { file, subject } = props.state;
  const blocks = blocksOn(file);
  const open = openIn(blocks ?? []);
  const { waiting } = roundsOf(blocks ?? [], typedOn(file).answers, null);
  const progress = progressOf(roundNow(blocks ?? []), waiting);
  /** An end in flight: a second click would send what is typed again. */
  const [ending, setEnding] = useState(false);

  return (
    <div class="grill-band">
      <span class="subject" title={subject}>
        Grill · {subject}
      </span>
      {/* The band's one live region, drawn empty with nothing to say: a status added with its text is not read out. */}
      <span class="count" role="status">
        {progress}
      </span>
      <Button
        size="sm"
        disabled={blocks === null || ending || replyPending.value}
        title={replyWhy(blocks)}
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
  const shown = drawn.value;
  const state = read.value;

  return (
    <>
      {shown?.kind === "open" && <GrillBand state={shown} />}
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

function QuestionHead(props: { readonly block: QuestionBlock }): preact.JSX.Element {
  const { block } = props;

  return (
    <>
      <h4 class="head">
        <span class="num">{block.id}</span>
        <span class="topic">{block.title}</span>
      </h4>
      {/* oxlint-disable-next-line react/no-danger -- the question arrives rendered, by the same `toHtml` of grill/server.ts as the blocks between the cards. */}
      <div class="ask" dangerouslySetInnerHTML={{ __html: block.ask }} />
    </>
  );
}

/** A question as the transcript holds it: its recommendation, and its answer once a reply gave one. It takes nothing. */
function QuestionCard(props: { readonly block: QuestionBlock }): preact.JSX.Element {
  const { block } = props;
  const answer = answerOf(block.answer);

  return (
    <div class="grill-q">
      <QuestionHead block={block} />
      {block.rec !== "" && (
        <div class="rec">
          <span class="label">Recommended</span>
          {/* oxlint-disable-next-line react/no-danger -- as the question above: rendered by `toHtml` in grill/server.ts. */}
          <div class="text" dangerouslySetInnerHTML={{ __html: block.rec }} />
        </div>
      )}
      {answer !== null && (
        <div class={`answer ${block.answer.kind}`}>
          <span class="label">{answer.label}</span>
          <span class="text">{answer.text}</span>
        </div>
      )}
    </div>
  );
}

type OpenQuestionProps = {
  readonly block: QuestionBlock;
  /** The draft's typing for it: absent takes the recommendation by default, `As recommended.` chooses it. */
  readonly typing: string | undefined;
  readonly onType: (text: string) => void;
  /** Ctrl+Enter in the field, as in the foot's. */
  readonly onSend: () => void;
};

/**
 * An open question and its two choices. Recommended is chosen by default; a text of the
 * reviewer's own greys it, so a click never throws the typing.
 */
function OpenQuestion(props: OpenQuestionProps): preact.JSX.Element {
  const { block, typing } = props;
  const field = useRef<HTMLTextAreaElement>(null);

  // Read off the draft once: a text typed through `As recommended.` is still the reviewer's own.
  const [choice, setChoice] = useState<"recommended" | "own">(
    typing === undefined || typing === AS_RECOMMENDED ? "recommended" : "own",
  );

  const recommended = choice === "recommended";
  const own = recommended ? "" : (typing ?? "");
  const mine = own.trim() !== "";
  const name = `grill-${block.id}`;

  return (
    <div class="grill-q">
      <QuestionHead block={block} />
      <div class="grill-choices" role="radiogroup" aria-label={`Answer to ${block.id}`}>
        <div class="grill-choice">
          <input
            type="radio"
            id={`${name}-rec`}
            name={name}
            checked={recommended}
            disabled={mine}
            aria-describedby={block.rec === "" ? undefined : `${name}-rec-text`}
            onClick={() => {
              setChoice("recommended");
              props.onType(AS_RECOMMENDED);
            }}
          />
          <label
            for={`${name}-rec`}
            title={mine ? "Clear your answer to take the recommendation" : undefined}
          >
            Recommended
          </label>
          {block.rec !== "" && (
            // oxlint-disable-next-line react/no-danger -- as the question: rendered by `toHtml` in grill/server.ts.
            <div
              id={`${name}-rec-text`}
              class="text"
              dangerouslySetInnerHTML={{ __html: block.rec }}
            />
          )}
        </div>
        <div class="grill-choice">
          <input
            type="radio"
            id={`${name}-own`}
            name={name}
            checked={!recommended}
            onClick={() => {
              if (recommended) props.onType("");
              setChoice("own");
              field.current?.focus();
            }}
          />
          <label for={`${name}-own`}>Your answer</label>
          <textarea
            ref={field}
            aria-label={`Your answer to ${block.id}`}
            value={own}
            onInput={(event) => {
              setChoice("own");
              props.onType(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) props.onSend();
            }}
          />
        </div>
      </div>
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

/** The blocks in the file's order; `card` draws a question, or `null` where the questions are drawn apart. */
function Transcript(props: {
  readonly blocks: readonly Block[];
  readonly card: (block: QuestionBlock) => preact.JSX.Element | null;
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
          card={(block) => <QuestionCard key={block.id} block={block} />}
        />
      </div>
    </div>
  );
}

/** The chips of every round, and the one question they pick, with its neighbours. */
function RoundView(props: {
  readonly view: Rounds;
  readonly onPick: (id: string) => void;
  readonly question: (block: QuestionBlock) => preact.JSX.Element;
}): preact.JSX.Element {
  const { view } = props;
  const { current, previous, next } = view;

  return (
    <>
      <div class="grill-chips">
        {view.rounds.map((round) => (
          <div key={round.n} class="group">
            {round.n > 0 && <span class="label">Round {round.n}</span>}
            {round.chips.map((chip) => (
              <Chip
                key={chip.id}
                data-state={chip.state}
                title={chipTitle(chip.state)}
                aria-current={chip.id === current?.id ? "true" : undefined}
                onClick={() => props.onPick(chip.id)}
              >
                {chip.id}
              </Chip>
            ))}
          </div>
        ))}
      </div>
      {current !== null && props.question(current)}
      {current !== null && (
        <div class="grill-nav">
          {previous !== null && (
            <Button
              size="sm"
              aria-label={`Previous question, ${previous}`}
              onClick={() => props.onPick(previous)}
            >
              ‹ {previous}
            </Button>
          )}
          <span class="spacer" />
          {next !== null && (
            <Button
              size="sm"
              aria-label={`Next question, ${next}`}
              onClick={() => props.onPick(next)}
            >
              {next} ›
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function OpenGrill(props: {
  readonly state: Extract<GrillState, { kind: "open" }>;
}): preact.JSX.Element {
  const { file: path, phase } = props.state;
  const loaded = blocksOn(path);
  const blocks = loaded ?? [];
  const own = typedOn(path);
  const [picked, setPicked] = useState<string | null>(null);
  const view = roundsOf(blocks, own.answers, picked);

  const answer = (id: string, text: string): void =>
    setTyped({
      grill: { ...typed.value.grill, [path]: { ...own, answers: { ...own.answers, [id]: text } } },
    });

  const note = (text: string): void =>
    setTyped({ grill: { ...typed.value.grill, [path]: { ...own, note: text } } });

  const open = openIn(blocks);
  // Before the blocks land, no question reads as open, and a send would close the answers typed by default.
  const live = loaded !== null && !replyPending.value && sendable(path, open);

  const sendNow = (): void => {
    if (live && !replyPending.peek()) void send(path, open);
  };

  const round = useRef<HTMLDivElement>(null);
  const openBefore = useRef(0);

  // A round that lands, or leaves, shows its first open question again: the pick was the last round's.
  useEffect(() => {
    const landed = openBefore.current === 0 && open.length > 0;
    const left = openBefore.current > 0 && open.length === 0;
    openBefore.current = open.length;

    if (landed || left) setPicked(null);

    // The reviewer reads at the bottom, under the foot: the round comes into view.
    if (landed) round.current?.scrollIntoView({ block: "start" });
  }, [open.length]);

  return (
    <aside class="grill-panel" aria-label="Grill">
      <div class="grill-sheet">
        <div class="plan">
          <Transcript blocks={blocks} card={() => null} />
          {view.rounds.length > 0 && (
            <div class="grill-round" ref={round}>
              <RoundView
                view={view}
                onPick={setPicked}
                question={(block) =>
                  block.answer.kind === "open" ? (
                    <OpenQuestion
                      key={block.id}
                      block={block}
                      typing={own.answers[block.id]}
                      onType={(text) => answer(block.id, text)}
                      onSend={sendNow}
                    />
                  ) : (
                    <QuestionCard key={block.id} block={block} />
                  )
                }
              />
            </div>
          )}
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
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) sendNow();
            }}
          />
          <p class="note">
            {open.length > 0
              ? "Answers go to Claude once its turn ends."
              : "No question is open. A note goes to Claude once its turn ends."}
          </p>
          <div class="row">
            <Button variant="send" disabled={!live} title={replyWhy(loaded)} onClick={sendNow}>
              {view.send}
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** Beside the document pane while a grill is open: its rounds, its fields and its foot. */
function GrillPanel(): preact.JSX.Element | null {
  const state = drawn.value;

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
  panel: { shown: () => drawn.value?.kind === "open", component: GrillPanel },
};
