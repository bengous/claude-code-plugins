import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";

import type { PageExtension, RendererProps } from "../../core/extension.ts";
import { extensionRequest } from "../../core/page/api.ts";
import { Banner, Button } from "../../core/page/kit.tsx";
import {
  connection,
  editing,
  fail,
  review,
  select,
  setTyped,
  succeed,
  typed,
} from "../../core/page/state.ts";
import type { Typed } from "../../core/protocol.ts";
import { footerOf } from "./labels.ts";
import { grillNumber } from "./parse.ts";
import type { Block, GrillPosts, GrillState, Opened, Suggestion } from "./protocol.ts";

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

/** What the reviewer waits on: a refusal or a server that did not answer is a failure the notices show. */
async function post<Name extends keyof GrillPosts>(
  path: Name,
  body: GrillPosts[Name],
): Promise<Response> {
  const response = await extensionRequest(ID, path, {
    method: "POST",
    body: JSON.stringify(body),
  }).catch(() => null);

  if (response === null) {
    fail("send", "The grill did not reach the server. What you typed is kept.");

    return Response.error();
  }

  if (response.ok) succeed("send");
  else fail("send", `The grill was refused: the server answered ${response.status}.`);

  return response;
}

async function openGrill(subject: string): Promise<void> {
  const response = await post("open", { subject });

  if (!response.ok) return;
  // SAFETY: the server's own `Opened`, a `ProjectPath` it built, serialized in grill/server.ts.
  const { file } = (await response.json()) as Opened;
  select(file);
}

/** `true` once the server took it: the typing it carried can go. */
async function reply(
  answers: readonly { id: string; text: string }[],
  note: string,
): Promise<boolean> {
  return (await post("reply", { answers, note })).ok;
}

/** What the reviewer did with the banner: `auto` shows it while Claude suggests a grill. */
const banner = signal<"auto" | "open" | "dismissed">("auto");

/** The subject typed over the suggestion's; `null` while the suggestion's stands. */
const subjectTyped = signal<string | null>(null);

function suggestionOf(state: GrillState | null): Suggestion | null {
  return state?.kind === "none" && state.proposal?.kind === "pending"
    ? state.proposal.suggestion
    : null;
}

function bannerShown(state: GrillState | null): boolean {
  return (
    state?.kind === "none" &&
    (banner.value === "open" || (banner.value === "auto" && suggestionOf(state) !== null))
  );
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

  if (view?.workspace.kind === "approved") return null;
  const why = grillWhy(state);

  return (
    <Button
      variant="grill"
      class={suggestionOf(state) === null ? undefined : "lit"}
      disabled={why !== null}
      title={why ?? undefined}
      onClick={() => {
        banner.value = bannerShown(state) ? "dismissed" : "open";
      }}
    >
      Grill
    </Button>
  );
}

/**
 * The suggestion, or the subject asked for: a banner in the flow, its field on a line of its
 * own. The field takes the focus when the Grill button opened the banner, never when a
 * suggestion arrives under a typing. Start grilling is greyed for the Grill button's reasons.
 */
function SuggestionBanner(props: {
  readonly suggestion: Suggestion | null;
  readonly why: string | null;
}): preact.JSX.Element {
  const field = useRef<HTMLInputElement>(null);
  const subject = subjectTyped.value ?? props.suggestion?.subject ?? "";
  const { why } = props;

  useEffect(() => {
    if (banner.peek() === "open") field.current?.focus();
  }, []);

  const start = (): void => {
    if (why !== null || subject.trim() === "") return;
    banner.value = "auto";
    subjectTyped.value = null;
    void openGrill(subject.trim());
  };

  const dismiss = (): void => {
    banner.value = "dismissed";
  };

  return (
    <Banner kind="info">
      {props.suggestion !== null && (
        <span>
          <strong>Claude suggests a grill:</strong> {props.suggestion.reason}
        </span>
      )}
      <div class="grill-subject">
        <input
          ref={field}
          aria-label="Subject of the grill"
          placeholder="What should Claude grill you on?"
          value={subject}
          onInput={(event) => {
            subjectTyped.value = event.currentTarget.value;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") start();

            if (event.key === "Escape") dismiss();
          }}
        />
        <Button
          size="sm"
          variant="send"
          disabled={why !== null || subject.trim() === ""}
          title={why ?? undefined}
          onClick={start}
        >
          Start grilling
        </Button>
        <Button size="sm" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </Banner>
  );
}

function GrillNotice(): preact.JSX.Element | null {
  const state = grill.value;

  return bannerShown(state) ? (
    <SuggestionBanner suggestion={suggestionOf(state)} why={grillWhy(state)} />
  ) : null;
}

type CardProps = {
  readonly block: Extract<Block, { kind: "question" }>;
  readonly answer: string;
  /** `null` once the question is answered, or the grill closed: the card takes nothing. */
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

const NOTHING_TYPED: Typed["grill"][string] = { answers: {}, note: "" };

function GrillDoc(props: RendererProps): preact.JSX.Element {
  const { path, modified } = props.doc;
  const [blocks, setBlocks] = useState<readonly Block[]>([]);
  /** The reviewer's typing on this transcript, in the draft: it survives the pane and a reload. */
  const own = typed.value.grill[path] ?? NOTHING_TYPED;
  const state = grill.value;
  const current = state?.kind === "open" && state.file === path ? state : null;

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

  const sendable = current !== null && (open.length > 0 || own.note.trim() !== "");

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

  useEffect(() => {
    void blocksOf(path).then((loaded) => {
      if (loaded !== null) setBlocks(loaded);
    });
  }, [path, modified]);

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
    <div class="grill-doc" ref={sheet}>
      <div class="plan">
        {blocks.map((block, index) =>
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
            <QuestionCard
              key={block.id}
              block={block}
              answer={own.answers[block.id] ?? ""}
              onAnswer={
                current !== null && block.answer === null ? (text) => answer(block.id, text) : null
              }
              onSend={sendable ? () => void send() : null}
            />
          ),
        )}
        {current?.phase === "working" && (
          <p class="grill-working" role="status">
            Claude is working. The next round appears here.
          </p>
        )}
      </div>
      {current !== null && (
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
          <div class="row">
            <span class="note">
              {open.length > 0
                ? "An empty field takes the recommendation. Answers go to Claude once its turn ends."
                : "No question is open. A note goes to Claude once its turn ends."}
            </span>
            <Button onClick={() => void end()}>End grill</Button>
            <Button variant="send" disabled={!sendable} onClick={() => void send()}>
              Send answers
            </Button>
          </div>
        </div>
      )}
    </div>
  );
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
};
