import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";

import type { PageExtension, RendererProps } from "../../core/extension.ts";
import { extensionRequest } from "../../core/page/api.ts";
import { error, review, select } from "../../core/page/state.ts";
import { grillNumber } from "./parse.ts";
import type { Block, GrillPosts, GrillState } from "./protocol.ts";

const ID = "grill";

/** The server's word on the grill, loaded again at every workspace event; `null` before the first answer. */
const grill = signal<GrillState | null>(null);

function nameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

async function loadState(): Promise<void> {
  const response = await extensionRequest(ID, "state");

  // SAFETY: the server's own `GrillState`, serialized by `Response.json` in grill/server.ts.
  grill.value = response.ok ? ((await response.json()) as GrillState) : null;
}

async function post<Name extends keyof GrillPosts>(
  path: Name,
  body: GrillPosts[Name],
): Promise<Response> {
  const response = await extensionRequest(ID, path, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!response.ok) error.value = `POST ${ID}/${path} failed: ${response.status}`;

  return response;
}

async function openGrill(subject: string): Promise<void> {
  const response = await post("open", { subject });

  if (!response.ok) return;
  // SAFETY: the server's own `{ file }`, a `ProjectPath` it built, serialized in grill/server.ts.
  const { file } = (await response.json()) as Extract<GrillState, { kind: "open" }>;
  select(file);
}

function closeGrill(): void {
  void post("close", { reason: "page" });
}

/** What the reviewer did with the banner: `auto` shows it while Claude suggests a grill. */
type Banner = "auto" | "open" | "dismissed";

function GrillAction(): preact.JSX.Element {
  const view = review.value;
  const state = grill.value;
  const [banner, setBanner] = useState<Banner>("auto");
  const [typed, setTyped] = useState<string | null>(null);
  const suggestion = state?.kind === "none" ? state.suggestion : null;
  const subject = typed ?? suggestion?.subject ?? "";

  const shown =
    state?.kind === "none" && (banner === "open" || (banner === "auto" && suggestion !== null));

  useEffect(() => {
    void loadState();
  }, [view]);

  const start = (): void => {
    setBanner("auto");
    setTyped(null);
    void openGrill(subject.trim());
  };

  return (
    <>
      {state?.kind === "open" && (
        <span class="status">
          Grill open · {state.phase === "working" ? "Claude is working" : nameOf(state.file)}
        </span>
      )}
      <button
        class={suggestion === null ? "btn grill" : "btn grill lit"}
        type="button"
        disabled={state?.kind !== "none" || view?.workspace.kind === "approved"}
        onClick={() => setBanner(shown ? "dismissed" : "open")}
      >
        Grill
      </button>
      {shown && (
        <div class="grill-banner">
          {suggestion !== null && (
            <span>
              <strong>Claude suggests a grill:</strong> {suggestion.reason}
            </span>
          )}
          <input
            aria-label="Subject of the grill"
            placeholder="What should Claude grill you on?"
            value={subject}
            onInput={(event) => setTyped(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && subject.trim() !== "") start();
            }}
          />
          <button
            class="btn small send"
            type="button"
            disabled={subject.trim() === ""}
            onClick={start}
          >
            Start grilling
          </button>
          <button class="btn small" type="button" onClick={() => setBanner("dismissed")}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

type CardProps = {
  readonly block: Extract<Block, { kind: "question" }>;
  readonly answer: string;
  readonly onAnswer: (text: string) => void;
};

function QuestionCard(props: CardProps): preact.JSX.Element {
  const { block } = props;

  return (
    <div class="grill-q">
      <div class="head">
        <span class="num">{block.id}</span>
        <span class="topic">{block.title}</span>
      </div>
      <p class="ask">{block.ask}</p>
      {block.rec !== "" && (
        <div class="rec">
          <span class="label">Recommended</span>
          <span class="text">{block.rec}</span>
          {block.open && (
            <button class="btn small" type="button" onClick={() => props.onAnswer(block.rec)}>
              Take it
            </button>
          )}
        </div>
      )}
      {block.open && (
        <textarea
          aria-label={`Answer to ${block.id}`}
          placeholder={`Answer ${block.id}`}
          value={props.answer}
          onInput={(event) => props.onAnswer(event.currentTarget.value)}
        />
      )}
    </div>
  );
}

function GrillDoc(props: RendererProps): preact.JSX.Element {
  const { path, modified } = props.doc;
  const [blocks, setBlocks] = useState<readonly Block[]>([]);
  /** The reviewer's typing, by question id; `""` keys what goes beside the questions. */
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(new Map());
  const state = grill.value;
  const current = state?.kind === "open" && state.file === path ? state : null;
  const answer = (id: string, text: string): void => setAnswers(new Map(answers).set(id, text));

  const typed = (id: string): string => answers.get(id)?.trim() ?? "";

  const round = [
    ...blocks.flatMap((block) =>
      block.kind === "question" && block.open && typed(block.id) !== ""
        ? [`${block.id}: ${typed(block.id)}`]
        : [],
    ),
    ...(typed("") === "" ? [] : [typed("")]),
  ].join("\n\n");

  const send = async (): Promise<void> => {
    const response = await post("reply", { text: round });

    if (response.ok) setAnswers(new Map());
  };

  useEffect(() => {
    void extensionRequest(ID, `blocks?file=${encodeURIComponent(path)}`).then(async (response) => {
      if (!response.ok) return;
      // SAFETY: the server's own `Block[]`, serialized by `Response.json` in grill/server.ts.
      setBlocks((await response.json()) as Block[]);
    });
  }, [path, modified]);

  return (
    <div class="grill">
      <div class="plan">
        {blocks.map((block, index) =>
          block.kind === "html" ? (
            // The server rendered it with raw HTML escaped and unsafe links cut: `toHtml`.
            // oxlint-disable-next-line react/no-danger -- the transcript's Markdown arrives rendered, since the page bundles no Markdown parser for it; `toHtml` in grill/server.ts is what makes it safe to insert.
            <div key={index} dangerouslySetInnerHTML={{ __html: block.html }} />
          ) : (
            <QuestionCard
              key={block.id}
              block={block}
              answer={answers.get(block.id) ?? ""}
              onAnswer={(text) => answer(block.id, text)}
            />
          ),
        )}
      </div>
      {current !== null && (
        <div class="grill-foot">
          {current.phase === "waiting" && (
            <textarea
              aria-label="Anything else for Claude"
              placeholder="Anything else. Ctrl+Enter sends."
              value={answers.get("") ?? ""}
              onInput={(event) => answer("", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && round !== "") {
                  void send();
                }
              }}
            />
          )}
          <div class="row">
            <span class="note">
              {current.phase === "waiting"
                ? "Answers go to Claude once the current turn ends."
                : "Claude is working. Fields come back with its next round."}
            </span>
            <button class="btn" type="button" onClick={closeGrill}>
              End grill
            </button>
            <button
              class="btn send"
              type="button"
              disabled={current.phase !== "waiting" || round === ""}
              onClick={() => void send()}
            >
              Send answers
            </button>
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
    },
  ],
  actions: [GrillAction],
};
