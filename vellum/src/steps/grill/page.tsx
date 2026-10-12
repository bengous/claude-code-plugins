import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { Typed } from "../../review/contract.ts";
import type { PageHalf, RendererProps, SendShare } from "../../runtime/extension.ts";
import { extensionRequest } from "../../runtime/page/api.ts";
import { Banner, Button, Chip } from "../../runtime/page/kit.tsx";
import {
  fail,
  memoized,
  outOnce,
  pageStore,
  patchStore,
  select,
  selectDocs,
  setTyped,
  succeed,
  usePage,
  writeDraft,
} from "../../runtime/page/state.ts";
import type { ProjectPath } from "../../workshop/paths.ts";
import type { BodyOf, PostOf } from "../../workshop/plugs.ts";
import type { Block, GrillPlugs, GrillState, Phase } from "./contract.ts";
import { answerOf, chipTitle, endedOf, footerOf, phaseText, progressOf } from "./labels.ts";
import { AS_RECOMMENDED, grillNumber } from "./parse.ts";
import { roundNow, roundsOf } from "./rounds.ts";
import type { QuestionBlock, Rounds } from "./rounds.ts";

const ID = "grill";

/**
 * The open grill's blocks, which the band and the panel draw alike, with the write they were read
 * at: a workspace event that did not write the file loads nothing, and any other loads it, a
 * load still out included, since that one may fail. They keep the phase of the state they were
 * loaded for, which the panel draws with them: a phase read before its blocks land would name a
 * round, or take a send away, over blocks that do not show it yet.
 */
type OpenTranscript = {
  readonly path: string;
  readonly write: string;
  readonly blocks: readonly Block[];
  readonly phase: Phase;
};

/** The part's own state: the server's word on the grill, the open transcript, and the grill this page ended. */
type GrillPage = {
  /**
   * The server's last word on the grill, loaded again at every workspace event; `null` before the
   * first answer. A refused read keeps it, so the panel stays as the reviewer left it.
   */
  readonly grill: GrillState | null;
  readonly transcript: OpenTranscript | null;
  /**
   * The grill this page ended with End grill, and how many questions it settled: its notice shows
   * until dismissed or until a new grill opens. `/vellum:stop` and the approval leave none.
   */
  readonly ended: { readonly file: ProjectPath; readonly decisions: number } | null;
};

const grillStore = createStore<GrillPage>(() => ({ grill: null, transcript: null, ended: null }));

function useGrill<T>(pick: (s: GrillPage) => T): T {
  return useStore(grillStore, pick);
}

/** What the band and the panel draw: the state kept, and none once approved, since the approval closed the grill. */
function drawnOf(approved: boolean, grill: GrillState | null): GrillState | null {
  return approved ? null : grill;
}

function useDrawn(): GrillState | null {
  const approved = usePage((s) => s.review?.workspace.kind === "approved");
  const grill = useGrill((s) => s.grill);

  return drawnOf(approved, grill);
}

/** The write of the open transcript last asked for: an older load that lands after it is dropped. */
let transcriptAsked: string | null = null;

function nameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** The typing kept for a transcript no grill is open on has no field left: it goes. */
function forgetClosed(state: GrillState): void {
  const open = state.kind === "open" ? state.file : null;
  const kept = pageStore.getState().typed.grill;
  const closed = Object.keys(kept).filter((path) => path !== open);

  if (closed.length === 0) return;
  setTyped({ grill: Object.fromEntries(Object.entries(kept).filter(([path]) => path === open)) });
}

async function loadState(): Promise<void> {
  const response = await extensionRequest(ID, "state");

  if (!response.ok) return;

  // SAFETY: the server's own `GrillState`, serialized by `Response.json` in grill/server.ts.
  const state = (await response.json()) as GrillState;
  forgetClosed(state);
  const { ended } = grillStore.getState();

  patchStore(grillStore, {
    grill: state,
    ended: state.kind === "open" && state.file !== ended?.file ? null : ended,
  });

  if (state.kind === "open") await loadTranscript(state.file, state.phase);
}

async function loadTranscript(path: string, phase: Phase): Promise<void> {
  const docs = selectDocs(pageStore.getState());
  const write = `${path}@${docs.find((doc) => doc.path === path)?.modified ?? 0}`;

  if (grillStore.getState().transcript?.write === write) return;
  transcriptAsked = write;
  const blocks = await blocksOf(path);

  if (blocks !== null && transcriptAsked === write) {
    grillStore.setState({ transcript: { path, write, blocks, phase } });
  }
}

/** The blocks of the open transcript at `path`, `null` until they land. */
function blocksOn(loaded: OpenTranscript | null, path: string): readonly Block[] | null {
  return loaded?.path === path ? loaded.blocks : null;
}

/** The phase the blocks of `path` were loaded with, `null` until they land. */
function phaseOn(loaded: OpenTranscript | null, path: string): Phase | null {
  return loaded?.path === path ? loaded.phase : null;
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
async function post<Route extends PostOf<GrillPlugs["server"]>>(
  route: Route,
  body: BodyOf<GrillPlugs["server"], Route>,
  failed: Failed = sendFailure,
): Promise<Response> {
  const response = await extensionRequest(ID, route.slice("POST ".length), {
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

const NOTHING_TYPED: Typed["grill"][string] = { answers: {}, note: "" };

/**
 * The reviewer's typing on a transcript, in the draft: it survives the panel and a reload.
 * `setTyped` keeps the grill's reference when another field changes, so the band and the panel,
 * reading `typed.grill` alone, are not drawn again at each key typed elsewhere.
 */
function typedOn(grill: Typed["grill"], path: string): Typed["grill"][string] {
  return grill[path] ?? NOTHING_TYPED;
}

/**
 * The grill's part of the one Send, from the open grill's blocks and the draft's typing: the
 * questions answered, the ones a Send would take by default, and a note. Before the blocks land
 * it names none, and the server's own count asks in its place. Computed once per change of the
 * blocks or the typing, not at each render of the bar.
 */
const countedOf = memoized(
  (
    state: GrillState | null,
    transcript: OpenTranscript | null,
    grill: Typed["grill"],
  ): [GrillState | null, OpenTranscript | null, Typed["grill"]] => [state, transcript, grill],
  (state, transcript, grill) => {
    if (state?.kind !== "open") return null;
    const own = typedOn(grill, state.file);
    const { open, waiting } = roundsOf(blocksOn(transcript, state.file) ?? [], own.answers, null);

    return { file: state.file, own, open, waiting };
  },
);

/**
 * The share, snapshotted: once the server took the Send, the grill reads its state and its
 * transcript again, then drops the answers to the questions the Send closed and the note, unless
 * the reviewer changed it since the click.
 */
function useSend(): SendShare {
  const state = useDrawn();
  const transcript = useGrill((s) => s.transcript);
  const grill = usePage((s) => s.typed.grill);
  const now = countedOf(state, transcript, grill);

  if (now === null) return { count: 0, unanswered: [], more: false, sent: () => Promise.resolve() };
  const { file, own, open, waiting } = now;

  return {
    count: open.length - waiting.length,
    unanswered: waiting,
    more: own.note.trim() !== "",
    sent: async () => {
      await loadState();
      const kept = pageStore.getState().typed.grill;
      const current = typedOn(kept, file);
      const closed = new Set(open);
      const answers = Object.entries(current.answers).filter(([id]) => !closed.has(id));
      const note = current.note === own.note ? "" : current.note;

      setTyped({ grill: { ...kept, [file]: { answers: Object.fromEntries(answers), note } } });
    },
  };
}

/**
 * End grill: the draft is written first, since the server ends the grill with what it holds for
 * the round as the reply, a question left untouched by default; the document pane returns to the
 * plan, under a notice that counts the questions the grill settled, every one answered once it is
 * closed.
 */
async function end(path: ProjectPath, blocks: readonly Block[]): Promise<void> {
  if (!(await writeDraft())) {
    fail("send", "The grill was not ended: what you typed is not saved on the server.");

    return;
  }

  if (!(await post("POST close", { reason: "page" })).ok) return;
  const plan = selectDocs(pageStore.getState()).find((doc) => doc.group === "plan");

  grillStore.setState({
    ended: { file: path, decisions: blocks.filter((block) => block.kind === "question").length },
  });

  if (plan !== undefined) select(plan.path);
}

/**
 * End grill, the page's one way to end it, drawn in the band and on the panel once Claude's
 * turn ended: greyed until the transcript loads, so no answer typed is closed unread, and while a
 * Send or an end is out, the one write out that takes from the draft (`outOnce`).
 */
function EndGrill(props: {
  readonly file: ProjectPath;
  readonly look: "band" | "primary" | "secondary";
}): JSX.Element {
  const { file, look } = props;
  const blocks = useGrill((s) => blocksOn(s.transcript, file));
  const sending = usePage((s) => s.sending);

  return (
    <Button
      size={look === "band" ? "sm" : "md"}
      variant={look === "primary" ? "grill" : "default"}
      className={look === "primary" ? "lit" : undefined}
      disabled={blocks === null || sending}
      title={blocks === null ? "Loading the grill" : undefined}
      onClick={() => {
        if (blocks !== null) void outOnce(() => end(file, blocks));
      }}
    >
      {look === "band" ? "End grill" : "End grill and return to plan"}
    </Button>
  );
}

/** Above the page while a grill is open: its subject, its round, the questions the reviewer has not touched, and End grill. */
function GrillBand(props: { readonly state: Extract<GrillState, { kind: "open" }> }): JSX.Element {
  const { file, subject } = props.state;
  const blocks = useGrill((s) => blocksOn(s.transcript, file));
  const own = usePage((s) => typedOn(s.typed.grill, file));
  const { waiting } = roundsOf(blocks ?? [], own.answers, null);
  const progress = progressOf(roundNow(blocks ?? []), waiting.length);

  return (
    <div className="grill-band">
      <span className="subject" title={subject}>
        Grill · {subject}
      </span>
      {/* The band's one live region, drawn empty with nothing to say: a status added with its text is not read out. */}
      <span className="count" role="status">
        {progress}
      </span>
      <EndGrill file={file} look="band" />
    </div>
  );
}

/** What End grill leaves, with the way back to the transcript; gone with the approval, which moved it. */
function EndedNotice(): JSX.Element | null {
  const notice = useGrill((s) => s.ended);
  const approved = usePage((s) => s.review?.workspace.kind === "approved");

  if (notice === null || approved) return null;

  return (
    <Banner
      kind="ok"
      action={{
        label: "Dismiss",
        run: () => {
          patchStore(grillStore, { ended: null });
        },
      }}
    >
      <span>{endedOf(notice.decisions)}</span>
      <Button size="sm" onClick={() => select(notice.file)}>
        Read the transcript
      </Button>
    </Banner>
  );
}

/** Read again at every workspace event: the grill a step opened, a round asked, a grill ended. */
function GrillNotice(): JSX.Element {
  const view = usePage((s) => s.review);
  const shown = useDrawn();

  useEffect(() => {
    void loadState();
  }, [view]);

  return (
    <>
      <EndedNotice />
      {shown?.kind === "open" && <GrillBand state={shown} />}
    </>
  );
}

function QuestionHead(props: { readonly block: QuestionBlock }): JSX.Element {
  const { block } = props;

  return (
    <>
      <h4 className="head">
        <span className="num">{block.id}</span>
        <span className="topic">{block.title}</span>
      </h4>
      {/* oxlint-disable-next-line react/no-danger -- the question arrives rendered, by the same `toHtml` of grill/server.ts as the blocks between the cards. */}
      <div className="ask" dangerouslySetInnerHTML={{ __html: block.ask }} />
    </>
  );
}

/** A question as the transcript holds it: its recommendation, and its answer once a reply gave one. It takes nothing. */
function QuestionCard(props: { readonly block: QuestionBlock }): JSX.Element {
  const { block } = props;
  const answer = answerOf(block.answer);

  return (
    <div className="grill-q">
      <QuestionHead block={block} />
      {block.rec !== "" && (
        <div className="rec">
          <span className="label">Recommended</span>
          {/* oxlint-disable-next-line react/no-danger -- as the question above: rendered by `toHtml` in grill/server.ts. */}
          <div className="text" dangerouslySetInnerHTML={{ __html: block.rec }} />
        </div>
      )}
      {answer !== null && (
        <div className={`answer ${block.answer.kind}`}>
          <span className="label">{answer.label}</span>
          <span className="text">{answer.text}</span>
        </div>
      )}
    </div>
  );
}

type OpenQuestionProps = {
  readonly block: QuestionBlock;
  /** The draft's typing for it: absent is no answer yet, `As recommended.` chooses the recommendation. */
  readonly typing: string | undefined;
  readonly onType: (text: string) => void;
};

/** What the reviewer chose for a question: nothing yet, the recommendation, or words of their own. */
type Choice = "none" | "recommended" | "own";

/** Read off the draft once: a text typed through `As recommended.` is still the reviewer's own. */
function choiceOf(typing: string | undefined): Choice {
  if (typing === undefined) return "none";

  return typing === AS_RECOMMENDED ? "recommended" : "own";
}

/**
 * An open question and its two choices, neither chosen until the reviewer picks one: a
 * recommendation checked in advance ends up accepted unread. A text of the reviewer's own greys
 * Recommended, so a click never throws the typing.
 */
function OpenQuestion(props: OpenQuestionProps): JSX.Element {
  const { block, typing } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const [choice, setChoice] = useState<Choice>(choiceOf(typing));
  const recommended = choice === "recommended";
  const own = recommended ? "" : (typing ?? "");
  const mine = own.trim() !== "";
  const name = `grill-${block.id}`;

  const answerField = (
    <textarea
      ref={field}
      id={`${name}-field`}
      aria-label={`Your answer to ${block.id}`}
      value={own}
      onInput={(event) => {
        setChoice("own");
        props.onType(event.currentTarget.value);
      }}
    />
  );

  // With no recommendation there is nothing to choose: "As recommended." would name none.
  if (block.rec === "") {
    return (
      <div className="grill-q">
        <QuestionHead block={block} />
        <div className="grill-choice alone">
          <label htmlFor={`${name}-field`}>Your answer</label>
          {answerField}
        </div>
      </div>
    );
  }

  return (
    <div className="grill-q">
      <QuestionHead block={block} />
      <div className="grill-choices" role="radiogroup" aria-label={`Answer to ${block.id}`}>
        <div className="grill-choice">
          <input
            type="radio"
            id={`${name}-rec`}
            name={name}
            checked={recommended}
            disabled={mine}
            aria-describedby={`${name}-rec-text`}
            onClick={() => {
              setChoice("recommended");
              props.onType(AS_RECOMMENDED);
            }}
          />
          <label
            htmlFor={`${name}-rec`}
            title={mine ? "Clear your answer to take the recommendation" : undefined}
          >
            Recommended
          </label>
          {/* oxlint-disable-next-line react/no-danger -- as the question: rendered by `toHtml` in grill/server.ts. */}
          <div
            id={`${name}-rec-text`}
            className="text"
            dangerouslySetInnerHTML={{ __html: block.rec }}
          />
        </div>
        <div className="grill-choice">
          <input
            type="radio"
            id={`${name}-own`}
            name={name}
            checked={choice === "own"}
            onClick={() => {
              if (choice !== "own") props.onType("");
              setChoice("own");
              field.current?.focus();
            }}
          />
          <label htmlFor={`${name}-own`}>Your answer</label>
          {answerField}
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
  readonly card: (block: QuestionBlock) => JSX.Element | null;
}): JSX.Element {
  return (
    <>
      {props.blocks.map((block, index) =>
        block.kind === "opened" ? (
          <div key={index}>
            <h1>Grill: {block.subject}</h1>
            <p className="grill-when">Started {block.at}</p>
          </div>
        ) : block.kind === "closed" ? (
          <div key={index}>
            <hr />
            <p className="grill-when">
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
function GrillDoc(props: RendererProps): JSX.Element {
  const blocks = useBlocks(props.doc.path, props.doc.modified);

  return (
    <div className="grill-doc">
      <div className="plan">
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
  readonly question: (block: QuestionBlock) => JSX.Element;
}): JSX.Element {
  const { view } = props;
  const { current, previous, next } = view;

  return (
    <>
      <div className="grill-chips">
        {view.rounds.map((round) => (
          <div key={round.n} className="group">
            {round.n > 0 && <span className="label">Round {round.n}</span>}
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
        <div className="grill-nav">
          {previous !== null && (
            <Button
              size="sm"
              aria-label={`Previous question, ${previous}`}
              onClick={() => props.onPick(previous)}
            >
              ‹ {previous}
            </Button>
          )}
          <span className="spacer" />
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

function OpenGrill(props: { readonly state: Extract<GrillState, { kind: "open" }> }): JSX.Element {
  const { file: path } = props.state;
  const loaded = useGrill((s) => blocksOn(s.transcript, path));
  const phase = useGrill((s) => phaseOn(s.transcript, path));
  const blocks = loaded ?? [];
  const own = usePage((s) => typedOn(s.typed.grill, path));
  const [picked, setPicked] = useState<string | null>(null);
  const view = roundsOf(blocks, own.answers, picked);
  /** Add a note clicked on the idle screen, where the note waits behind End grill. */
  const [noting, setNoting] = useState(false);
  const noteField = useRef<HTMLTextAreaElement>(null);
  // A note in the draft is never hidden: the idle screen shows the foot that holds it.
  const footShown = phase !== "idle" || noting || own.note.trim() !== "";

  const answer = (id: string, text: string): void =>
    setTyped({
      grill: {
        ...pageStore.getState().typed.grill,
        [path]: { ...own, answers: { ...own.answers, [id]: text } },
      },
    });

  const note = (text: string): void =>
    setTyped({ grill: { ...pageStore.getState().typed.grill, [path]: { ...own, note: text } } });

  const { open, waiting } = view;
  /** Bumped by All recommended: the question shown is drawn again, its choice read off the draft. */
  const [chosenAll, setChosenAll] = useState(0);

  /** Every question still untouched takes the recommendation, chosen: the reviewer read them all. */
  const allRecommended = (): void => {
    const untouched = open.filter((id) => (own.answers[id]?.trim() ?? "") === "");
    const chosen = Object.fromEntries(untouched.map((id) => [id, AS_RECOMMENDED]));

    setTyped({
      grill: {
        ...pageStore.getState().typed.grill,
        [path]: { ...own, answers: { ...own.answers, ...chosen } },
      },
    });
    setChosenAll((count) => count + 1);
  };

  const round = useRef<HTMLDivElement>(null);
  const firstOpen = open[0] ?? null;

  // A round that lands, or leaves, moves the first open question: the pick was the last round's.
  useEffect(() => {
    setPicked(null);

    // The reviewer reads at the bottom, under the foot: the round comes into view.
    if (firstOpen !== null) round.current?.scrollIntoView({ block: "start" });
  }, [firstOpen]);

  useEffect(() => {
    if (phase !== "idle") setNoting(false);
  }, [phase]);

  useEffect(() => {
    if (noting) noteField.current?.focus();
  }, [noting]);

  return (
    <aside className="grill-panel" aria-label="Grill">
      <div className="grill-sheet">
        <div className="plan">
          <Transcript blocks={blocks} card={() => null} />
          {/* The panel's one live region, drawn empty while a round waits with Claude: a status added with its text is not read out. */}
          <div className={`grill-phase ${phase ?? ""}`}>
            <p role="status">{phase === null ? "" : phaseText(phase, roundNow(blocks))}</p>
            {phase === "idle" && (
              <div className="row">
                <EndGrill file={path} look="primary" />
                {!footShown && <Button onClick={() => setNoting(true)}>Add a note</Button>}
              </div>
            )}
            {phase === "stopped" && (
              <div className="row">
                <EndGrill file={path} look="secondary" />
              </div>
            )}
          </div>
          {view.rounds.length > 0 && (
            <div className="grill-round" ref={round}>
              <RoundView
                view={view}
                onPick={setPicked}
                question={(block) =>
                  block.answer.kind === "open" ? (
                    <OpenQuestion
                      key={`${block.id}-${chosenAll}`}
                      block={block}
                      typing={own.answers[block.id]}
                      onType={(text) => answer(block.id, text)}
                    />
                  ) : (
                    <QuestionCard key={block.id} block={block} />
                  )
                }
              />
            </div>
          )}
        </div>
        {footShown && (
          <div className="grill-foot">
            <textarea
              ref={noteField}
              aria-label="Anything else for Claude"
              placeholder="Anything else for Claude."
              value={own.note}
              onInput={(event) => note(event.currentTarget.value)}
            />
            <p className="note">
              {open.length > 0
                ? "Your answers and your note leave with Send, in the bar."
                : "No question is open. A note leaves with Send, in the bar."}
            </p>
            {open.length > 0 && (
              <div className="row">
                <Button
                  disabled={loaded === null || waiting.length === 0}
                  title={waiting.length === 0 ? "Every question has an answer" : undefined}
                  onClick={allRecommended}
                >
                  All recommended
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Beside the document pane while a grill is open: its rounds, its fields and its foot. */
function GrillPanel(): JSX.Element | null {
  const state = useDrawn();

  return state?.kind === "open" ? <OpenGrill key={state.file} state={state} /> : null;
}

function usePanelShown(): boolean {
  return useDrawn()?.kind === "open";
}

export const page: PageHalf<GrillPlugs> = {
  id: "grill",
  renderers: [
    {
      accepts: (doc) => doc.mediaType === "text/markdown" && grillNumber(nameOf(doc.path)) !== null,
      component: GrillDoc,
      comments: false,
    },
  ],
  notices: [GrillNotice],
  useSend,
  panel: { useShown: usePanelShown, component: GrillPanel },
};
