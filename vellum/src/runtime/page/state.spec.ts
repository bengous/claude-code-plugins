/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures are branded values (ProjectPath, Version, WipDir) written as literals, and fakes stand where a browser global does: the brand is the parser's to grant, the global's type the browser's, and nothing here parses or runs in one. */
import { afterEach, describe, expect, test } from "bun:test";

import type {
  Annotation,
  Decision,
  Draft,
  Edit,
  RecordAnswer,
  SendAnswer,
  SendRequest,
} from "../../review/contract.ts";
import { lineDiff } from "../../review/diff.ts";
import { choicesIn, EMPTY_TYPED, refOf } from "../../review/review.ts";
import type { SendShare } from "../extension.ts";
import type { DocGroup, GroupedDoc, ReviewView, VellumBuild, WorkflowView } from "../protocol.ts";
import type { PageModule } from "./state.ts";
import {
  createPage,
  selectCommenting,
  selectCurrentDoc,
  selectDocs,
  selectLocked,
  selectPlanChanges,
  selectPlanDoc,
  selectStrayTyped,
  selectUnsentTyped,
} from "./state.ts";
import type { WorkflowModule } from "./workflow.ts";
import { workflowOf } from "./workflow.ts";

/** A store of its own for each test: no state, and no saving subscription `start` leaves behind, reaches another. */
function freshStore(): PageModule {
  return createPage();
}

type Flow = PageModule & WorkflowModule;

/** A store of its own and the workflow read over it, whose `send` is the bar's and `selectNotices` the column. */
function freshFlow(): Flow {
  const module = freshStore();

  return { ...module, ...workflowOf(module) };
}

/** The column as the flow derives it now, off both stores. */
function noticed(flow: Flow) {
  return flow.selectNotices(flow.store.getState(), flow.flowStore.getState());
}

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const MOCKUP = `${WIP}layout.html` as never;

const ARTICLE = { heading: "Layout", role: "article", name: "", openingTag: "<article>" };

function chose(option: string) {
  return { option, label: option, description: ARTICLE };
}

function doc(path: string, group: DocGroup): GroupedDoc {
  return { path, mediaType: "text/markdown", modified: 0, group } as never;
}

/** The workflow as the server sends it, of which the page reads what holds the review. */
function workflowView(held: string | null): WorkflowView {
  return {
    planText: "none",
    held,
    regions: [],
    refused: [],
    pill: { text: "", tone: "neutral" },
  };
}

function drafting(docs: readonly GroupedDoc[]): ReviewView {
  return {
    workspace: { kind: "drafting", dir: WIP, batches: 0 },
    plan: null,
    docs,
    workflow: workflowView(null),
  } as never;
}

type Version = {
  readonly version: number;
  readonly text?: string;
  readonly previous?: string;
  readonly docs?: readonly GroupedDoc[];
  readonly kind?: "inReview" | "approved";
  readonly held?: string | null;
};

/** A view past `drafting`: the plan is `.review/v<version>.md`, as the server names it. */
function versioned({
  version,
  text = "",
  previous,
  docs = [],
  kind = "inReview",
  held = null,
}: Version): ReviewView {
  return {
    workspace: { kind, dir: WIP, version, batches: 0, finalizeError: null, notes: false },
    plan: {
      doc: `${WIP}.review/v${version}.md`,
      text,
      workingCopy: `${WIP}plan.md`,
      previous: previous === undefined ? null : { version: version - 1, text: previous },
    },
    docs,
    workflow: workflowView(held),
  } as never;
}

function edit(version: number, text: string): Edit {
  return { version, text } as never;
}

function comment(id: string, path: string): Annotation {
  return {
    id,
    doc: path,
    anchor: { kind: "global" },
    mark: { kind: "comment", body: id },
  } as never;
}

function onLine(id: string, path: string, line: number): Annotation {
  const passage = {
    quote: "q",
    prefix: "",
    suffix: "",
    lines: [line, line],
    removed: false,
    kind: "prose",
  };

  return { ...comment(id, path), anchor: { kind: "text", passages: [passage] } } as never;
}

const restores: (() => void)[] = [];

type MediaList = {
  readonly matches: boolean;
  readonly addEventListener: (
    type: string,
    listener: (event: { readonly matches: boolean }) => void,
  ) => void;
};

type Listening = {
  readonly addEventListener: (event: string, listener: () => void) => void;
};

/** What the page reads of a browser, each as small as the page's use of it. */
type Ports = {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly EventSource: new (url: string) => Listening;
  readonly location: { readonly pathname: string; readonly reload: () => void };
  /** The window as each of its two readers sees it: `readWindow` its media queries, `start` the page hiding. */
  readonly window: { readonly matchMedia: (query: string) => MediaList } | Listening;
  readonly document: Listening & { readonly visibilityState: DocumentVisibilityState };
};

/** A fake where the browser has a global, taken away after the test: Bun has none of `location`, `window`, `EventSource`. */
function port<Name extends keyof Ports>(name: Name, fake: Ports[Name]): void {
  const real = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value: fake, configurable: true, writable: true });

  restores.push(() => {
    if (real === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, real);
  });
}

// Last in, first out: a test that fakes a port twice puts the real one back, not the first fake.
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
});

type Served = {
  /** `refused` is what the server answers a draft it cannot read with: a 409 and its reason. */
  readonly draft: Draft | null | "unreadable" | { readonly refused: string };
  readonly review: ReviewView | "unreadable";
  readonly decision?: number;
  /** The row a 409 of `POST /api/decision` names, and its reason; none unless said. */
  readonly refusal?: { readonly rule: string; readonly reason: string };
  /** What `POST /api/record` answers: its status and body, 200 and v2 unless said. */
  readonly record?: { readonly status: number; readonly answer: RecordAnswer };
  /** What `POST /api/send` answers: its status and body, 200 and a batch unless said. */
  readonly send?: { readonly status: number; readonly answer: SendAnswer };
  /** What `POST /api/send` waits on before its answer. */
  readonly sending?: () => Promise<void>;
  /** What `GET /api/review` waits on before its answer. */
  readonly load?: () => Promise<void>;
  /** What a `PUT /api/draft` waits on before its answer, and how it fails when this rejects. */
  readonly put?: () => Promise<void>;
  readonly putStatus?: number;
  /** What `GET /api/vellum-build` answers: the build, or a 500 when the server could not read it; `BUILD` unless said. */
  readonly build?: VellumBuild | "unreadable";
};

type Server = {
  /** Every request and every stream, in the order the page opened them. */
  readonly calls: string[];
  readonly puts: Draft[];
  /** Whether each of `puts` asked for `keepalive`, in the same order. */
  readonly keepalive: boolean[];
  readonly decisions: Decision[];
  readonly sends: SendRequest[];
  readonly tokens: Set<string | undefined>;
  /** What the server pushes on the event stream: `message`, or the stream's own `error` and `open`. */
  readonly push: (event: "message" | "error" | "open") => void;
  /**
   * The page hidden, the document's `visibilitychange` once it reads `hidden`, or the window's
   * `pagehide`, the document still `visible` as at a reload: each calls the listeners left there.
   */
  readonly leave: (event: "visibilitychange" | "pagehide") => void;
  /** The page shown again: the document's `visibilitychange` once it reads `visible`. */
  readonly show: () => void;
  /** How many times the page reloaded itself, `location.reload()`. */
  reloads: number;
  answer: Served;
};

function answerOf(value: Draft | ReviewView | "unreadable"): Response {
  return value === "unreadable" ? new Response("", { status: 500 }) : Response.json(value);
}

const BATCH = { file: `${WIP}.review/v1.feedback-1.md`, seq: 1 } as never;

const BUILD = {
  version: "0.13.0",
  commit: "0f9634d417d4307b2b8e3f63829899ea691bdd6e",
} as VellumBuild;

/** The server as the page's ports see it: `fetch`, `EventSource`, and the token in the page's URL. */
function serve(answer: Served): Server {
  const listeners: { readonly event: string; readonly listener: () => void }[] = [];
  const onDocument: { readonly event: string; readonly listener: () => void }[] = [];
  const onWindow: { readonly event: string; readonly listener: () => void }[] = [];

  const shown: { visibilityState: DocumentVisibilityState } & Listening = {
    visibilityState: "visible",
    addEventListener: (event, listener) => onDocument.push({ event, listener }),
  };

  const server: Server = {
    calls: [],
    puts: [],
    keepalive: [],
    decisions: [],
    sends: [],
    tokens: new Set(),
    push: (event) => {
      for (const entry of listeners) if (entry.event === event) entry.listener();
    },
    leave: (event) => {
      if (event === "visibilitychange") shown.visibilityState = "hidden";

      for (const entry of event === "pagehide" ? onWindow : onDocument) {
        if (entry.event === event) entry.listener();
      }
    },
    show: () => {
      shown.visibilityState = "visible";

      for (const entry of onDocument) if (entry.event === "visibilitychange") entry.listener();
    },
    reloads: 0,
    answer,
  };

  port("location", {
    pathname: "/t/tok/",
    reload: () => {
      server.reloads += 1;
    },
  });
  port("document", shown);
  port("window", { addEventListener: (event, listener) => onWindow.push({ event, listener }) });

  port("fetch", async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    server.calls.push(`${method} ${url}`);
    server.tokens.add(new Headers(init.headers).get("x-vellum-token") ?? undefined);

    if (url === "/api/review") {
      await server.answer.load?.();

      return answerOf(server.answer.review);
    }

    if (url === "/api/decision") {
      if (init.body === undefined || init.body === null) {
        return new Response("", { status: 400 });
      }

      server.decisions.push(JSON.parse(String(init.body)) as Decision);

      const { refusal } = server.answer;

      return refusal === undefined
        ? new Response("", { status: server.answer.decision ?? 200 })
        : Response.json(refusal, { status: 409 });
    }

    if (url === "/api/vellum-build") {
      const build = server.answer.build ?? BUILD;

      return build === "unreadable"
        ? Response.json({ error: "no commit" }, { status: 500 })
        : Response.json(build);
    }

    if (url === "/api/record") {
      const recorded = server.answer.record ?? { status: 200, answer: { version: 2 } as never };

      return Response.json(recorded.answer, { status: recorded.status });
    }

    if (url === "/api/send") {
      server.sends.push(JSON.parse(String(init.body)) as SendRequest);
      await server.answer.sending?.();
      const sent = server.answer.send ?? { status: 200, answer: BATCH };

      return Response.json(sent.answer, { status: sent.status });
    }

    if (method === "GET") {
      const { draft } = server.answer;

      if (draft === null) return new Response(null, { status: 204 });

      return draft !== "unreadable" && "refused" in draft
        ? Response.json({ error: draft.refused }, { status: 409 })
        : answerOf(draft);
    }

    server.puts.push(JSON.parse(String(init.body)) as Draft);
    server.keepalive.push(init.keepalive === true);
    await server.answer.put?.();

    return new Response(null, { status: server.answer.putStatus ?? 204 });
  });

  port(
    "EventSource",
    class {
      constructor(url: string) {
        server.calls.push(`EventSource ${url}`);
      }

      addEventListener(event: string, listener: () => void): void {
        listeners.push({ event, listener });
      }
    },
  );

  return server;
}

/** Lets the saves chained so far reach the fake, and the loads an event started finish. */
async function settled(): Promise<void> {
  await Bun.sleep(0);
}

describe("the store of each test", () => {
  test("is its own: what one sets, the next never sees", () => {
    const one = freshStore();
    const other = freshStore();
    one.store.setState({ split: true });

    expect(other.store.getState().split).toBe(false);
    expect(other.store).not.toBe(one.store);
  });
});

describe("docs", () => {
  test("before the first load the list is empty", () => {
    const { store } = freshStore();

    expect(selectDocs(store.getState())).toEqual([]);
  });

  test("while drafting the list is the server's, the working copy at its head as the plan", () => {
    const { store } = freshStore();
    const listed = [doc(`${WIP}plan.md`, "plan"), doc(`${WIP}mockup.md`, "artifact")];
    store.setState({ review: drafting(listed) });

    expect(selectPlanDoc(store.getState())).toBeNull();
    expect(selectDocs(store.getState())).toEqual(listed);
    expect(selectDocs(store.getState())[0]?.group).toBe("plan");
  });

  test("once a version exists its file heads the list as the plan, before what the server lists", () => {
    const { store } = freshStore();
    const mockup = doc(`${WIP}mockup.md`, "artifact");
    store.setState({ review: versioned({ version: 2, docs: [mockup] }) });

    expect(selectPlanDoc(store.getState())).toEqual(doc(`${WIP}.review/v2.md`, "plan"));
    expect(selectDocs(store.getState())).toEqual([doc(`${WIP}.review/v2.md`, "plan"), mockup]);
  });

  test("the same inputs give the same list: a render and a handler read one object", () => {
    const { store } = freshStore();
    store.setState({ review: versioned({ version: 2 }) });
    const once = selectDocs(store.getState());
    store.setState({ split: true });

    expect(selectDocs(store.getState())).toBe(once);
    expect(selectCurrentDoc(store.getState())).toBe(selectCurrentDoc(store.getState()));
  });
});

describe("currentDoc", () => {
  const mockup = doc(`${WIP}mockup.md`, "artifact");
  const cited = doc("vellum/AGENTS.md", "cited");

  test("with nothing selected the plan shows", () => {
    const { store } = freshStore();
    store.setState({ review: versioned({ version: 1, docs: [mockup, cited] }) });

    expect(selectCurrentDoc(store.getState())?.path).toBe(`${WIP}.review/v1.md` as never);
  });

  test("a selected document shows", () => {
    const { store, select } = freshStore();
    store.setState({ review: versioned({ version: 1, docs: [mockup, cited] }) });
    select(cited.path);

    expect(selectCurrentDoc(store.getState())).toEqual(cited);
  });

  test("a selected version that went stale when the next one landed falls back on the plan", () => {
    const { store, select } = freshStore();
    store.setState({ review: versioned({ version: 1, docs: [mockup, cited] }) });
    select(`${WIP}.review/v1.md` as never);
    store.setState({ review: versioned({ version: 2, docs: [mockup, cited] }) });

    expect(selectCurrentDoc(store.getState())?.path).toBe(`${WIP}.review/v2.md` as never);
  });

  test("while drafting a selection that left the list falls back on the first document", () => {
    const { store, select } = freshStore();
    store.setState({ review: drafting([doc(`${WIP}plan.md`, "plan"), mockup, cited]) });
    select(mockup.path);
    store.setState({ review: drafting([doc(`${WIP}plan.md`, "plan"), cited]) });

    expect(selectCurrentDoc(store.getState())?.path).toBe(`${WIP}plan.md` as never);
  });

  test("an empty list shows nothing", () => {
    const { store } = freshStore();
    store.setState({ review: drafting([]) });

    expect(selectCurrentDoc(store.getState())).toBeNull();
  });
});

describe("select", () => {
  const mockup = doc(`${WIP}mockup.md`, "artifact");

  test("on the plan's path clears split", () => {
    const { store, select } = freshStore();
    store.setState({ review: versioned({ version: 1, docs: [mockup] }), split: true });
    select(`${WIP}.review/v1.md` as never);

    expect(store.getState().split).toBe(false);
    expect(store.getState().current).toBe(`${WIP}.review/v1.md` as never);
  });

  test("on another document keeps split", () => {
    const { store, select } = freshStore();
    store.setState({ review: versioned({ version: 1, docs: [mockup] }), split: true });
    select(mockup.path);

    expect(store.getState().split).toBe(true);
    expect(store.getState().current).toBe(mockup.path);
  });

  test("while the editor is open moves nothing", () => {
    const { store, openEditor, select } = freshStore();
    store.setState({ review: versioned({ version: 1, docs: [mockup] }) });
    openEditor(1);
    select(mockup.path);

    expect(store.getState().current).toBeNull();
  });
});

describe("locked", () => {
  test("before the first load the page is locked", () => {
    const { store } = freshStore();

    expect(selectLocked(store.getState())).toBe(true);
  });

  test("while drafting it takes comments", () => {
    const { store } = freshStore();
    store.setState({ review: drafting([]) });

    expect(selectLocked(store.getState())).toBe(false);
  });

  test.each([
    ["inReview", false],
    ["approved", true],
  ] as const)("a version %s: locked is %p", (kind, expected) => {
    const { store } = freshStore();
    store.setState({ review: versioned({ version: 1, kind }) });

    expect(selectLocked(store.getState())).toBe(expected);
  });

  test("a locked page takes no comment", () => {
    const { addAnnotation, store } = freshStore();
    store.setState({ review: versioned({ version: 1, kind: "approved" }) });
    addAnnotation(comment("", `${WIP}.review/v1.md`));

    expect(store.getState().annotations).toEqual([]);
  });
});

describe("the comment switch", () => {
  test("a fresh store has the switch off, so an open page does not comment", () => {
    const { store } = freshStore();
    store.setState({ review: versioned({ version: 1 }) });

    expect(store.getState().commentSwitch).toBe(false);
    expect(selectCommenting(store.getState())).toBe(false);
  });

  test("a locked page does not comment, whatever the switch", () => {
    const { store } = freshStore();
    store.setState({ review: versioned({ version: 1, kind: "approved" }), commentSwitch: true });

    expect(selectCommenting(store.getState())).toBe(false);
  });

  test("an open page comments once the switch is flipped on", () => {
    const { store, flipCommentSwitch } = freshStore();
    store.setState({ review: versioned({ version: 1 }) });
    flipCommentSwitch();

    expect(selectCommenting(store.getState())).toBe(true);
  });

  test("a flip on a locked page leaves the switch as it was", () => {
    const { store, flipCommentSwitch } = freshStore();
    store.setState({ review: versioned({ version: 1, kind: "approved" }) });
    flipCommentSwitch();

    expect(store.getState().commentSwitch).toBe(false);
  });
});

describe("an equal write", () => {
  test("wakes nobody: a Ctrl held down is one change, not one per event", () => {
    const { store, setHolding } = freshStore();
    const changes: boolean[] = [];
    store.subscribe((s) => changes.push(s.holding));
    setHolding(true);
    setHolding(true);
    setHolding(false);
    setHolding(false);

    expect(changes).toEqual([true, false]);
  });
});

describe("the comments", () => {
  test("a comment joins the others under an id of its own", () => {
    const { addAnnotation, store } = freshStore();
    store.setState({
      review: versioned({ version: 1 }),
      annotations: [comment("first", `${WIP}.review/v1.md`)],
    });
    addAnnotation(comment("the caller's", `${WIP}.review/v1.md`));

    expect(store.getState().annotations.map((annotation) => annotation.mark)).toEqual([
      { kind: "comment", body: "first" },
      { kind: "comment", body: "the caller's" },
    ]);
    expect(store.getState().annotations[1]?.id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test("a removed comment leaves the others", () => {
    const { store, removeAnnotation } = freshStore();
    store.setState({
      annotations: [comment("kept", `${WIP}plan.md`), comment("gone", `${WIP}plan.md`)],
    });
    removeAnnotation("gone");

    expect(store.getState().annotations.map((annotation) => annotation.id)).toEqual(["kept"]);
  });
});

describe("choose", () => {
  test("a choice is one draft write, and another option of the same decision replaces it", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    server.puts.length = 0;
    page.choose(MOCKUP, "layout", chose("d"));
    page.choose(MOCKUP, "layout", chose("e"));
    await settled();

    expect(server.puts.map(({ choices }) => choices)).toEqual([
      { [MOCKUP]: { layout: chose("d") } },
      { [MOCKUP]: { layout: chose("e") } },
    ]);
  });

  test("an approved page takes no choice", async () => {
    const page = freshStore();
    serve({ draft: null, review: versioned({ version: 1, kind: "approved" }) });
    await page.start();
    page.choose(MOCKUP, "layout", chose("d"));

    expect(page.store.getState().choices).toEqual({});
  });

  test("the option already chosen, chosen again, withdraws the choice: one draft write", async () => {
    const page = freshStore();
    const choices = { [MOCKUP]: { layout: chose("d"), nav: chose("tabs") } };
    const draft = { annotations: [], edit: null, choices, typed: EMPTY_TYPED };
    const server = serve({ draft, review: versioned({ version: 1 }) });
    await page.start();
    server.puts.length = 0;
    page.choose(MOCKUP, "layout", chose("d"));
    await settled();

    expect(server.puts.map((put) => put.choices)).toEqual([{ [MOCKUP]: { nav: chose("tabs") } }]);
  });

  test("a card's Delete withdraws its choice, and the mockup's last one leaves the draft", async () => {
    const page = freshStore();
    const choices = { [MOCKUP]: { layout: chose("d") } };
    serve({
      draft: { annotations: [], edit: null, choices, typed: EMPTY_TYPED },
      review: versioned({ version: 1 }),
    });
    await page.start();
    page.unchoose({ doc: MOCKUP, decision: "layout", option: "d" });

    expect(page.store.getState().choices).toEqual({});
  });
});

describe("what is typed", () => {
  test("setTyped is a patch: the rest stays", () => {
    const { setTyped, store } = freshStore();
    setTyped({ general: "Overall" });
    setTyped({ editor: { version: 1, text: "mine\n" } as never });

    expect(store.getState().typed).toEqual({
      ...EMPTY_TYPED,
      general: "Overall",
      editor: edit(1, "mine\n"),
    });
  });

  test("strayTyped is what a Send leaves unsent: the grill's answers leave with it", () => {
    const { setTyped, store } = freshStore();
    setTyped({
      general: "Overall",
      grill: { [`${WIP}grill-1.md`]: { answers: { Q2: "The inspector." }, note: "Go." } },
    });

    expect(selectStrayTyped(store.getState())).toEqual([
      { where: "the general box", text: "Overall" },
    ]);
  });

  test("unsentTyped names each place holding a text, and skips the blank ones", () => {
    const { setTyped, store } = freshStore();
    setTyped({
      general: "  ",
      composer: { [`${WIP}mockup.html`]: "Bigger", [`${WIP}plan.md`]: "" },
      grill: {
        [`${WIP}grill-1.md`]: { answers: { Q1: "", Q2: "The inspector." }, note: "" },
        [`${WIP}grill-2.md`]: { answers: {}, note: " " },
      },
      editor: { version: 1, text: "mine\n" } as never,
    });

    expect(selectUnsentTyped(store.getState())).toEqual([
      { where: "a comment on mockup.html", text: "Bigger" },
      { where: "the answers in grill-1.md", text: "The inspector." },
      { where: "the editor", text: "mine\n" },
    ]);
  });

  test("the same typing gives the same lists: what the bar compared at the warning still holds", () => {
    const { setTyped, store } = freshStore();
    setTyped({ general: "Overall" });
    const stray = selectStrayTyped(store.getState());
    const unsent = selectUnsentTyped(store.getState());
    store.setState({ split: true });

    expect(selectStrayTyped(store.getState())).toBe(stray);
    expect(selectUnsentTyped(store.getState())).toBe(unsent);
  });

  test("a card's edit changes the mark and keeps the place", () => {
    const { store, updateAnnotation } = freshStore();
    store.setState({
      annotations: [onLine("c1", `${WIP}plan.md`, 3), comment("c2", `${WIP}plan.md`)],
    });
    updateAnnotation("c1", { kind: "comment", body: "fixed" });

    expect(store.getState().annotations).toEqual([
      { ...onLine("c1", `${WIP}plan.md`, 3), mark: { kind: "comment", body: "fixed" } },
      comment("c2", `${WIP}plan.md`),
    ]);
  });
});

describe("planChanges", () => {
  test("at v1 there is nothing to compare with", () => {
    const { store } = freshStore();
    store.setState({ review: versioned({ version: 1, text: "a\n" }) });

    expect(selectPlanChanges(store.getState())).toBeNull();
  });

  test("a version is compared with the one before, in that direction", () => {
    const { store } = freshStore();
    store.setState({ review: versioned({ version: 2, previous: "a\n", text: "a\nb\n" }) });

    expect(selectPlanChanges(store.getState())).toEqual(lineDiff("a\n", "a\nb\n"));
  });

  test("the reviewer's unsent edit is the text compared, not the version's", () => {
    const { store } = freshStore();
    store.setState({
      review: versioned({ version: 2, previous: "a\n", text: "a\nb\n" }),
      edited: edit(2, "a\nc\nd\n"),
    });

    expect(selectPlanChanges(store.getState())).toEqual(lineDiff("a\n", "a\nc\nd\n"));
  });

  test("the same two texts keep the same diff through a load: the sheet is not drawn again", () => {
    const { store } = freshStore();
    store.setState({ review: versioned({ version: 2, previous: "a\n", text: "a\nb\n" }) });
    const once = selectPlanChanges(store.getState());
    store.setState({ review: versioned({ version: 2, previous: "a\n", text: "a\nb\n" }) });

    expect(selectPlanChanges(store.getState())).toBe(once);
  });
});

describe("the editor", () => {
  test("opens on the version under review, at the line asked", () => {
    const { store, openEditor } = freshStore();
    store.setState({ review: versioned({ version: 2, text: "a\n" }) });
    openEditor(7);

    expect(store.getState().editing).toEqual({ version: 2, base: "a\n", line: 7 } as never);
  });

  test("opens on the unsent edit when there is one", () => {
    const { store, openEditor } = freshStore();
    store.setState({ review: versioned({ version: 2, text: "a\n" }), edited: edit(2, "mine\n") });
    openEditor(1);

    expect(store.getState().editing?.base).toBe("mine\n");
  });

  test("stays shut on a version approved", () => {
    const { store, openEditor } = freshStore();
    store.setState({ review: versioned({ version: 2, text: "a\n", kind: "approved" }) });
    openEditor(1);

    expect(store.getState().editing).toBeNull();
  });

  test("stays shut while drafting", () => {
    const { store, openEditor } = freshStore();
    store.setState({ review: drafting([doc(`${WIP}plan.md`, "plan")]) });
    openEditor(1);

    expect(store.getState().editing).toBeNull();
  });

  test("Done records the typed text with its version, and moves the plan's comments down with their lines; closeEditor closes on a line", () => {
    const { store, closeEditor, finishEdit, openEditor } = freshStore();

    store.setState({
      review: versioned({ version: 2, text: "a\nb\n" }),
      annotations: [onLine("c1", `${WIP}.review/v2.md`, 2), onLine("c2", `${WIP}mockup.md`, 2)],
    });
    openEditor(1);
    finishEdit({ version: 2, base: "a\nb\n", line: 1 } as never, "new\na\nb\n");
    const recorded = store.getState().editing !== null;
    closeEditor(2);

    expect(store.getState().edited).toEqual(edit(2, "new\na\nb\n"));
    expect([recorded, store.getState().editing, store.getState().resume]).toEqual([true, null, 2]);
    expect(store.getState().annotations).toEqual([
      onLine("c1", `${WIP}.review/v2.md`, 3),
      onLine("c2", `${WIP}mockup.md`, 2),
    ]);
  });

  test("Done on a second edit shifts from the text the editor opened on, not from the version's", () => {
    const { store, finishEdit } = freshStore();
    store.setState({
      review: versioned({ version: 2, text: "a\nb\nc\n" }),
      annotations: [onLine("c1", `${WIP}.review/v2.md`, 3)],
    });
    finishEdit({ version: 2, base: "new\na\nb\nc\n", line: 1 } as never, "new\na\nb\nc\n");

    expect(store.getState().annotations).toEqual([onLine("c1", `${WIP}.review/v2.md`, 3)]);
  });

  test("Done on a second edit that removes a commented line gives the comment the version's lines", () => {
    const { store, finishEdit } = freshStore();
    store.setState({
      review: versioned({ version: 2, text: "a\nb\nc\n" }),
      annotations: [onLine("c1", `${WIP}.review/v2.md`, 3)],
    });
    finishEdit({ version: 2, base: "new\na\nb\nc\n", line: 1 } as never, "new\na\nc\n");

    expect(store.getState().annotations).toEqual([
      {
        ...onLine("c1", `${WIP}.review/v2.md`, 2),
        anchor: {
          kind: "text",
          passages: [
            { quote: "q", prefix: "", suffix: "", lines: [2, 2], removed: true, kind: "prose" },
          ],
        },
      },
    ]);
  });

  test("Done on the version's own text is no edit", () => {
    const { store, finishEdit } = freshStore();
    store.setState({ review: versioned({ version: 2, text: "a\n" }), edited: edit(2, "mine\n") });
    finishEdit({ version: 2, base: "mine\n", line: 1 } as never, "a\n");

    expect(store.getState().edited).toBeNull();
  });

  test("Discard edit is the reverse of Done: the version's text, the comments back on its lines, a removed one removed no more", () => {
    const { store, discardEdit, finishEdit } = freshStore();
    store.setState({
      review: versioned({ version: 2, text: "a\nb\nc\n" }),
      annotations: [
        onLine("kept", `${WIP}.review/v2.md`, 3),
        onLine("gone", `${WIP}.review/v2.md`, 2),
      ],
    });
    finishEdit({ version: 2, base: "a\nb\nc\n", line: 1 } as never, "new\na\nc\n");

    const shifted = store
      .getState()
      .annotations.map((a) => [
        a.id,
        a.anchor.kind === "text" ? a.anchor.passages[0].lines[0] : 0,
        a.anchor.kind === "text" && a.anchor.passages[0].removed,
      ]);

    discardEdit();

    expect(shifted).toEqual([
      ["kept", 3, false],
      ["gone", 2, true],
    ]);
    expect(store.getState().edited).toBeNull();
    expect(store.getState().annotations).toEqual([
      onLine("kept", `${WIP}.review/v2.md`, 3),
      onLine("gone", `${WIP}.review/v2.md`, 2),
    ]);
  });

  test("Done once another version arrived keeps the editor open, and the notices say why", () => {
    const flow = freshFlow();
    const { store, finishEdit, openEditor } = flow;
    store.setState({ review: versioned({ version: 1, text: "a\n" }) });
    openEditor(1);
    store.setState({ review: versioned({ version: 2, text: "b\n" }) });
    finishEdit({ version: 1, base: "a\n", line: 1 } as never, "mine\n");

    expect(store.getState().editing).not.toBeNull();
    expect(store.getState().edited).toBeNull();
    expect(noticed(flow).map((notice) => notice.text.join(""))).toEqual([
      "v2 arrived while you were editing v1. Copy what you need, then Cancel.",
    ]);
  });

  test("Done once the version was decided elsewhere keeps the editor open, and the notices say so", () => {
    const flow = freshFlow();
    const { store, finishEdit, openEditor } = flow;
    store.setState({ review: versioned({ version: 1, text: "a\n" }) });
    openEditor(1);
    store.setState({ review: versioned({ version: 1, text: "a\n", kind: "approved" }) });
    finishEdit({ version: 1, base: "a\n", line: 1 } as never, "mine\n");

    expect(store.getState().editing).not.toBeNull();
    expect(noticed(flow).map(({ key }) => key)).toEqual(["stale-editor", "workspace"]);
    expect(noticed(flow)[0]?.text).toEqual([
      "v1 is no longer under review. Copy what you need, then Cancel.",
    ]);
  });
});

describe("a server revived on another build", () => {
  test("reloads the page once its stream opens again: the page's code may call routes the new build no longer has", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    server.push("open");
    await settled();
    server.push("error");
    server.answer = { ...server.answer, build: { ...BUILD, version: "0.14.0" } as VellumBuild };
    server.push("open");
    await settled();

    expect(server.reloads).toBe(1);
  });

  test("leaves the page as it is when the server revived is the same build", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    server.push("open");
    await settled();
    server.push("error");
    await settled();
    server.push("open");
    await settled();

    expect(server.reloads).toBe(0);
  });

  test("leaves the page as it is when the server cannot read its build", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    server.push("open");
    await settled();
    server.answer = { ...server.answer, build: "unreadable" };
    server.push("open");
    await settled();

    expect(server.reloads).toBe(0);
  });
});

describe("start", () => {
  test("restores the saved draft before anything is written: the first PUT carries it, after both reads and the stream", async () => {
    const page = freshStore();

    const saved: Draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: null,
      choices: {},
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft: saved, review: versioned({ version: 1 }) });
    await page.start();
    await settled();

    expect(server.calls).toEqual([
      "GET /api/draft",
      "GET /api/review",
      "EventSource /t/tok/events",
      "PUT /api/draft",
    ]);
    expect(server.puts).toEqual([saved]);
    expect(page.store.getState().annotations).toEqual(saved.annotations);
  });

  test("nothing is written while the first load is still out", async () => {
    const page = freshStore();
    const loaded = Promise.withResolvers<void>();

    const saved: Draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: null,
      choices: {},
      typed: EMPTY_TYPED,
    };

    const server = serve({
      draft: saved,
      review: versioned({ version: 1 }),
      load: () => loaded.promise,
    });

    const started = page.start();
    await settled();
    const whileLoading = [...server.calls];
    loaded.resolve();
    await started;
    await settled();

    expect(whileLoading).toEqual(["GET /api/draft", "GET /api/review"]);
    expect(server.puts).toEqual([saved]);
  });

  test("a write asked while the first load is out waits for it, then writes the draft restored", async () => {
    const page = freshStore();
    const loaded = Promise.withResolvers<void>();
    const annotations = [comment("c1", `${WIP}.review/v1.md`)];
    const saved: Draft = { annotations, edit: null, choices: {}, typed: EMPTY_TYPED };

    const server = serve({
      draft: saved,
      review: versioned({ version: 1 }),
      load: () => loaded.promise,
    });

    const started = page.start();
    await settled();
    const written = page.writeDraft();
    await settled();
    const whileLoading = [...server.calls];
    loaded.resolve();
    await started;

    expect([whileLoading, await written, server.puts.at(-1)]).toEqual([
      ["GET /api/draft", "GET /api/review"],
      true,
      saved,
    ]);
  });

  test("with no saved draft the first write is the empty one, still after both reads", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    await settled();

    expect(server.calls.indexOf("PUT /api/draft")).toBeGreaterThan(
      server.calls.indexOf("GET /api/review"),
    );
    expect(server.puts).toEqual([{ annotations: [], edit: null, choices: {}, typed: EMPTY_TYPED }]);
  });

  test("a restored edit meets the first load: another version arrived, so it is dropped with a banner and the comments stay", async () => {
    const page = freshStore();
    const kept = [comment("c1", `${WIP}.review/v1.md`)];
    serve({
      draft: {
        annotations: kept,
        edit: edit(1, "mine\n"),
        choices: {},
        typed: EMPTY_TYPED,
      } as never,
      review: versioned({ version: 3 }),
    });
    await page.start();

    expect(page.store.getState().edited).toBeNull();
    expect(page.store.getState().failures).toEqual([
      {
        op: "edit",
        text: "Your unsent edit of v1 was dropped: another version of the plan arrived. Your comments are kept.",
      },
    ]);
    expect(page.store.getState().annotations).toEqual(kept);
  });

  test("a restored editor typing of a version no longer under review is dropped: its field is gone", async () => {
    const page = freshStore();

    serve({
      draft: {
        annotations: [],
        edit: null,
        choices: {},
        typed: { ...EMPTY_TYPED, editor: edit(1, "mine\n") },
      },
      review: versioned({ version: 3 }),
    });

    await page.start();

    expect(page.store.getState().typed.editor).toBeNull();
    expect(selectUnsentTyped(page.store.getState())).toEqual([]);
  });

  test("a restored edit of the version loaded stays pending", async () => {
    const page = freshStore();
    serve({
      draft: { annotations: [], edit: edit(1, "mine\n"), choices: {}, typed: EMPTY_TYPED } as never,
      review: versioned({ version: 1 }),
    });
    await page.start();

    expect(page.store.getState().edited).toEqual(edit(1, "mine\n"));
    expect(page.store.getState().failures).toEqual([]);
  });

  test("a restored edit that landed as the next version is cleared, and its comments become that version's", async () => {
    const page = freshStore();

    const draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: edit(1, "mine\n"),
      choices: {},
      typed: EMPTY_TYPED,
    };

    serve({ draft: draft as never, review: versioned({ version: 2, text: "mine\n" }) });
    await page.start();

    expect(page.store.getState().edited).toBeNull();
    expect(page.store.getState().failures).toEqual([]);
    expect(page.store.getState().annotations).toEqual([comment("c1", `${WIP}.review/v2.md`)]);
  });

  test("a draft that cannot be read starts no saving, and says so", async () => {
    const page = freshStore();
    const server = serve({ draft: "unreadable", review: versioned({ version: 1 }) });
    await page.start();
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();

    expect(server.puts).toEqual([]);
    expect(page.store.getState().failures).toEqual([
      {
        op: "draft",
        text: "The saved draft could not be read: the server answered 500. Nothing is saved until the page reads it again, at a reload or a Send.",
      },
    ]);
  });

  test("after it each change is one write, and the next waits for the one before", async () => {
    const page = freshStore();
    const held = Promise.withResolvers<void>();

    const server = serve({
      draft: null,
      review: versioned({ version: 1 }),
      put: () => held.promise,
    });

    await page.start();
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    page.store.setState({ edited: edit(1, "mine\n") });
    await settled();
    const inFlight = server.puts.length;
    held.resolve();
    await settled();

    expect(inFlight).toBe(1);
    expect(server.puts.map((put) => [put.annotations.length, put.edit?.text ?? null])).toEqual([
      [0, null],
      [1, null],
      [1, "mine\n"],
    ]);
  });

  test("an edit that lands is one write: the edit cleared and its comments moved, together", async () => {
    const page = freshStore();

    const draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: edit(1, "mine\n"),
      choices: {},
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft, review: versioned({ version: 1 }) });
    await page.start();
    server.answer = { ...server.answer, review: versioned({ version: 2, text: "mine\n" }) };
    server.push("message");
    await settled();

    expect(server.puts).toEqual([
      draft,
      {
        annotations: [comment("c1", `${WIP}.review/v2.md`)],
        edit: null,
        choices: {},
        typed: EMPTY_TYPED,
      },
    ]);
  });

  test("Done is one write: the shifted comments and the edit, together", async () => {
    const page = freshStore();

    const draft = {
      annotations: [onLine("c1", `${WIP}.review/v1.md`, 1)],
      edit: null,
      choices: {},
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft, review: versioned({ version: 1, text: "a\n" }) });
    await page.start();
    page.finishEdit({ version: 1, base: "a\n", line: 1 } as never, "new\na\n");
    await settled();

    expect(server.puts).toEqual([
      draft,
      {
        annotations: [onLine("c1", `${WIP}.review/v1.md`, 2)],
        edit: edit(1, "new\na\n"),
        choices: {},
        typed: EMPTY_TYPED,
      },
    ]);
  });

  test("a decision the server took is one write: no comment and no edit, together", async () => {
    const page = freshStore();

    const draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: edit(1, "mine\n"),
      choices: {},
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft, review: versioned({ version: 1 }) });
    await page.start();
    await page.decide({ kind: "approve", edit: edit(1, "mine\n"), notes: "" });
    await settled();

    expect(server.puts).toEqual([
      draft,
      { annotations: [], edit: null, choices: {}, typed: EMPTY_TYPED },
    ]);
  });

  test("a load that succeeds after a failed one, with an edit that went stale, is one write and one failure", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: "unreadable" });
    await page.start();
    page.store.setState({ edited: edit(1, "mine\n") });
    await settled();
    server.answer = { ...server.answer, review: versioned({ version: 3 }) };
    server.push("message");
    await settled();

    expect(page.store.getState().failures.map(({ op }) => op)).toEqual(["edit"]);
    expect(server.puts.map((put) => put.edit?.text ?? null)).toEqual([null, "mine\n", null]);
  });

  test("a draft the server refuses to read says the server's reason, and starts no saving", async () => {
    const page = freshStore();
    const refused = "draft.json was saved by an older version of vellum and cannot be read.";
    const server = serve({ draft: { refused }, review: versioned({ version: 1 }) });
    await page.start();
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();

    expect(server.puts).toEqual([]);
    expect(page.store.getState().failures).toEqual([{ op: "draft", text: refused }]);
  });

  test("what is typed is restored before the first load, with the comments", async () => {
    const page = freshStore();
    const typed = { ...EMPTY_TYPED, general: "Overall: no." };

    const server = serve({
      draft: { annotations: [], edit: null, choices: {}, typed },
      review: versioned({ version: 1 }),
    });

    await page.start();
    await settled();

    expect(page.store.getState().typed).toEqual(typed);
    expect(server.puts).toEqual([{ annotations: [], edit: null, choices: {}, typed }]);
  });

  test("a continuous typing is one write, once it pauses", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.setTyped({ general: "O" });
    page.setTyped({ general: "Ov" });
    page.setTyped({ general: "Ove" });
    await settled();
    const whileTyping = server.puts.length;
    await Bun.sleep(400);

    expect(whileTyping).toBe(1);
    expect(server.puts.map((put) => put.typed.general)).toEqual(["", "Ove"]);
  });

  test("a comment added while a typing pauses carries the typing, in one write", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.setTyped({ general: "Overall" });
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();
    await Bun.sleep(400);

    expect(server.puts.map((put) => [put.annotations.length, put.typed.general])).toEqual([
      [0, ""],
      [1, "Overall"],
    ]);
  });

  test("a decision the server took clears what is typed, in the same write", async () => {
    const page = freshStore();
    const typed = { ...EMPTY_TYPED, general: "Overall: no." };

    const server = serve({
      draft: { annotations: [], edit: null, choices: {}, typed },
      review: versioned({ version: 1 }),
    });

    await page.start();
    await page.decide({ kind: "approve", edit: null, notes: "" });
    await settled();

    expect(page.store.getState().typed).toEqual(EMPTY_TYPED);
    expect(server.puts.at(-1)).toEqual({
      annotations: [],
      edit: null,
      choices: {},
      typed: EMPTY_TYPED,
    });
  });

  test("a write that never reaches the server says so, and the next change is still written", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    server.answer = { ...server.answer, put: () => Promise.reject(new Error("offline")) };
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();
    server.answer = { ...server.answer, put: () => Promise.resolve() };
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();

    expect(page.store.getState().failures).toEqual([]);
    expect(server.puts.map((put) => put.annotations.length)).toEqual([0, 1, 2]);
  });

  test("a write the server refuses names its status", async () => {
    const page = freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), putStatus: 500 });
    await page.start();
    await settled();

    expect(page.store.getState().failures).toEqual([
      {
        op: "draft",
        text: "Your comments are kept in this tab, not saved: the server answered 500.",
      },
    ]);
  });

  test("the event stream opens once the first load is in, on the token's path", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();

    const opened = server.calls.indexOf("EventSource /t/tok/events");
    expect(opened).toBeGreaterThan(server.calls.indexOf("GET /api/review"));
    expect([...server.tokens]).toEqual(["tok"]);
  });

  test("a workspace event loads the review again", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    server.answer = { ...server.answer, review: versioned({ version: 2 }) };
    server.push("message");
    await settled();

    expect(selectPlanDoc(page.store.getState())?.path).toBe(`${WIP}.review/v2.md` as never);
  });

  test("a stream that fails says the connection is down, and up once it opens again", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    server.push("error");
    const afterError = page.store.getState().connection;
    server.push("open");

    expect([afterError, page.store.getState().connection]).toEqual(["down", "up"]);
  });

  test("a review that cannot be read reaches the banner", async () => {
    const page = freshStore();
    serve({ draft: null, review: "unreadable" });
    await page.start();

    expect(page.store.getState().review).toBeNull();
    expect(page.store.getState().failures).toEqual([
      { op: "review", text: "The review could not be loaded: the server answered 500." },
    ]);
  });

  test("a version that lands under an open editor says so, over the dropped edit's own banner", async () => {
    const flow = freshFlow();
    const server = serve({ draft: null, review: versioned({ version: 1, text: "a\n" }) });
    await flow.start();
    flow.store.setState({ edited: edit(1, "mine\n") });
    flow.openEditor(1);
    server.answer = { ...server.answer, review: versioned({ version: 3, text: "c\n" }) };
    server.push("message");
    await settled();

    expect(flow.store.getState().edited).toBeNull();
    expect(flow.store.getState().editing).not.toBeNull();
    expect(noticed(flow).map((notice) => [notice.key, notice.text.join("")])).toEqual([
      [
        "failure:edit",
        "Your unsent edit of v1 was dropped: another version of the plan arrived. Your comments are kept.",
      ],
      ["stale-editor", "v3 arrived while you were editing v1. Copy what you need, then Cancel."],
    ]);
  });
});

describe("a page hidden or closed", () => {
  test("sends the typing still pausing within the event, with keepalive", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.setTyped({ general: "Which forms?" });
    server.leave("visibilitychange");

    expect(server.puts.map((put) => put.typed.general)).toEqual(["", "Which forms?"]);
    expect(server.keepalive).toEqual([true, true]);
  });

  test("sends it at pagehide as well, the document still visible", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.setTyped({ general: "Which forms?" });
    server.leave("pagehide");

    expect(server.puts.map((put) => put.typed.general)).toEqual(["", "Which forms?"]);
  });

  test("sends a write still queued behind a slow one, within the event", async () => {
    const page = freshStore();
    const held = Promise.withResolvers<void>();

    const server = serve({
      draft: null,
      review: versioned({ version: 1 }),
      put: () => held.promise,
    });

    await page.start();
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    server.leave("visibilitychange");

    expect(server.puts.map((put) => put.annotations.length)).toEqual([0, 1]);
  });

  test("never sends the older writes it overtook: the newer draft stays", async () => {
    const page = freshStore();
    const held = Promise.withResolvers<void>();

    const server = serve({
      draft: null,
      review: versioned({ version: 1 }),
      put: () => held.promise,
    });

    await page.start();
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    page.setTyped({ general: "Which forms?" });
    server.leave("visibilitychange");
    held.resolve();
    await settled();

    expect(server.puts.map((put) => [put.annotations.length, put.typed.general])).toEqual([
      [0, ""],
      [1, "Which forms?"],
    ]);
  });

  test("with nothing waiting, writes nothing", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();
    server.leave("visibilitychange");
    server.leave("pagehide");

    expect(server.puts.map((put) => put.annotations.length)).toEqual([0, 1]);
  });

  test("hidden then pagehide is one write", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.setTyped({ general: "Which forms?" });
    server.leave("visibilitychange");
    server.leave("pagehide");

    expect(server.puts.map((put) => put.typed.general)).toEqual(["", "Which forms?"]);
  });

  test("shown again, it sends nothing: the typing waits for its pause", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.setTyped({ general: "Which forms?" });
    server.show();

    expect(server.puts.map((put) => put.typed.general)).toEqual([""]);
  });
});

describe("keepalive", () => {
  test("a draft over 65 536 bytes goes without it, though under 65 536 characters", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.setTyped({ general: "é".repeat(33_000) });
    server.leave("visibilitychange");

    expect(server.puts.at(-1)?.typed.general).toHaveLength(33_000);
    expect(server.keepalive).toEqual([true, false]);
  });

  test("a write in flight takes its share: the next one past 65 536 bytes together goes without it", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    server.answer = { ...server.answer, put: () => Promise.withResolvers<void>().promise };
    page.setTyped({ general: "x".repeat(40_000) });
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();
    page.setTyped({ general: "y".repeat(40_000) });
    server.leave("visibilitychange");

    expect(server.keepalive).toEqual([true, true, false]);
  });

  test("a write answered gives its share back: the next one of the same size keeps it", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    page.setTyped({ general: "x".repeat(40_000) });
    page.addAnnotation(comment("a", `${WIP}.review/v1.md`));
    await settled();
    page.setTyped({ general: "y".repeat(40_000) });
    page.addAnnotation(comment("b", `${WIP}.review/v1.md`));
    await settled();

    expect(server.keepalive).toEqual([true, true, true]);
  });
});

describe("decide", () => {
  const unsent = [comment("c1", `${WIP}.review/v1.md`)];

  test("a decision the server took clears the comments and the edit, then loads the review again", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }), decision: 200 });
    page.store.setState({ annotations: unsent, edited: edit(1, "mine\n") });
    await page.decide({ kind: "approve", edit: null, notes: "" });

    expect(page.store.getState().annotations).toEqual([]);
    expect(page.store.getState().edited).toBeNull();
    expect(page.store.getState().failures).toEqual([]);
    expect(server.calls).toEqual(["POST /api/decision", "GET /api/review"]);
  });

  test("the decision reaches the server as it was taken", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    const approve: Decision = { kind: "approve", edit: edit(1, "mine\n"), notes: "Go." };
    await page.decide(approve);

    expect(server.decisions).toEqual([approve]);
  });

  test("a redirect is a refusal as well: the comments stay, and the status is named", async () => {
    const page = freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), decision: 300 });
    page.store.setState({ annotations: unsent });
    await page.decide({ kind: "approve", edit: null, notes: "" });

    expect(page.store.getState().annotations).toEqual(unsent);
    expect(page.store.getState().failures).toEqual([
      { op: "decision", text: "Not sent: the server answered 300. Your comments are kept." },
    ]);
  });

  test("a refusal keeps the comments and answers the row that refused it, for its caller to say", async () => {
    const page = freshStore();
    const reason = "v2 is under review, not v1";
    serve({
      draft: null,
      review: versioned({ version: 2 }),
      refusal: { rule: "approve-stale", reason },
    });
    page.store.setState({ annotations: unsent });

    expect(await page.decide({ kind: "approve", edit: edit(1, "mine\n"), notes: "" })).toEqual({
      kind: "refused",
      rule: "approve-stale",
      reason,
    });
    expect(page.store.getState().annotations).toEqual(unsent);
    expect(page.store.getState().failures).toEqual([]);
  });

  test("any other refusal keeps the comments and names the status", async () => {
    const page = freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), decision: 500 });
    page.store.setState({ annotations: unsent });
    await page.decide({ kind: "approve", edit: null, notes: "" });

    expect(page.store.getState().annotations).toEqual(unsent);
    expect(page.store.getState().failures).toEqual([
      { op: "decision", text: "Not sent: the server answered 500. Your comments are kept." },
    ]);
  });

  test("a server that does not answer is a failure too, the comments kept, and the decision answers so", async () => {
    const page = freshStore();
    serve({ draft: null, review: versioned({ version: 1 }) });
    page.store.setState({ annotations: unsent });
    port("fetch", () => Promise.reject(new Error("offline")));
    const decided = await page.decide({ kind: "approve", edit: null, notes: "" });

    expect(decided).toEqual({ kind: "failed" });
    expect(page.store.getState().annotations).toEqual(unsent);
    expect(page.store.getState().failures.map((failure) => failure.op)).toEqual(["decision"]);
  });

  test("a decision the server took answers taken, and clears the failure of the one before", async () => {
    const page = freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }), decision: 500 });
    await page.decide({ kind: "approve", edit: null, notes: "" });
    server.answer = { ...server.answer, decision: 200 };
    const decided = await page.decide({ kind: "approve", edit: null, notes: "" });

    expect(decided).toEqual({ kind: "taken" });
    expect(page.store.getState().failures).toEqual([]);
  });
});

function texts(flow: Flow): readonly string[] {
  return noticed(flow).map((notice) => notice.text.join(""));
}

describe("the approval", () => {
  const unsent = [comment("c1", `${WIP}.review/v1.md`)];
  const approval: Decision = { kind: "approve", edit: null, notes: "Ship it." };
  const DRAFT = "plan.md changed since v1: record it before approving";

  test("a version already decided keeps the comments and says so", async () => {
    const flow = freshFlow();
    serve({ draft: null, review: versioned({ version: 1 }), decision: 409 });
    flow.store.setState({ annotations: unsent });

    expect(await flow.approve(approval)).toEqual({ kind: "refused" });
    expect(flow.store.getState().annotations).toEqual(unsent);
    expect(texts(flow)).toEqual(["This version was already decided."]);
  });

  test("a refusal that names its row says its reason, and keeps the comments", async () => {
    const flow = freshFlow();
    const reason = "v2 is under review, not v1";
    serve({
      draft: null,
      review: versioned({ version: 2 }),
      refusal: { rule: "approve-stale", reason },
    });
    flow.store.setState({ annotations: unsent });
    await flow.approve({ ...approval, edit: edit(1, "mine\n") });

    expect(flow.store.getState().annotations).toEqual(unsent);
    expect(flow.store.getState().failures).toEqual([{ op: "decision", text: reason }]);
  });

  test("plan.md changed since the version offers Record, then approve, which records it, then approves as decided", async () => {
    const flow = freshFlow();

    const server = serve({
      draft: null,
      review: versioned({ version: 1 }),
      refusal: { rule: "approve-draft", reason: DRAFT },
    });

    await flow.approve(approval);
    const [notice] = noticed(flow);

    expect([notice?.text, notice?.action?.label]).toEqual([[DRAFT], "Record, then approve"]);
    server.answer = { draft: null, review: versioned({ version: 2 }), decision: 200 };
    server.calls.length = 0;
    notice?.action?.run();
    await settled();
    await settled();

    expect(server.calls).toEqual(["POST /api/record", "POST /api/decision", "GET /api/review"]);
    expect(server.decisions).toEqual([approval, approval]);
    expect(texts(flow)).toEqual([]);
  });

  test("under a hold plan.md changed offers no Record: its row says to end the hold first", async () => {
    const flow = freshFlow();

    const reason =
      "plan.md changed since v1 while grill 1 is open: end it, then record plan.md before approving";

    const held = "grill 1 is open";
    serve({
      draft: null,
      review: versioned({ version: 1, held }),
      refusal: { rule: "approve-draft", reason },
    });
    await flow.approve({ ...approval, confirmed: held });

    expect(noticed(flow)).toEqual([{ key: "failure:decision", kind: "err", text: [reason] }]);
  });

  test("with an edit plan.md changed offers no Record: the version recorded would leave the edit stale", async () => {
    const flow = freshFlow();
    serve({
      draft: null,
      review: versioned({ version: 1 }),
      refusal: { rule: "approve-draft", reason: DRAFT },
    });
    await flow.approve({ ...approval, edit: edit(1, "mine\n") });

    expect(noticed(flow)).toEqual([{ key: "failure:decision", kind: "err", text: [DRAFT] }]);
  });

  test("a Record refused says its row, and approves nothing", async () => {
    const flow = freshFlow();
    const reason = "grill 1 is open: plan.md waits; you are told when it ends";

    const server = serve({
      draft: null,
      review: versioned({ version: 1 }),
      refusal: { rule: "approve-draft", reason: DRAFT },
      record: { status: 409, answer: { rule: "held", reason } },
    });

    await flow.approve(approval);
    noticed(flow)[0]?.action?.run();
    await settled();

    expect(server.decisions).toEqual([approval]);
    expect(texts(flow)).toEqual([`Not recorded: ${reason}.`]);
  });

  test("a hold other than the one confirmed answers held, and writes no failure: the bar asks again", async () => {
    const flow = freshFlow();
    const reason = "The review is held: grill 2 is open.";
    serve({
      draft: null,
      review: versioned({ version: 1, held: "grill 2 is open" }),
      refusal: { rule: "held", reason },
    });

    expect(await flow.approve({ ...approval, confirmed: "grill 1 is open" })).toEqual({
      kind: "held",
      reason,
    });
    expect(flow.store.getState().failures).toEqual([]);
  });

  test("the notices read the same while nothing they read changed: a hover redraws no column", () => {
    const flow = freshFlow();
    flow.store.setState({ review: versioned({ version: 1 }) });
    const once = noticed(flow);
    flow.focusCard("c1", false);
    flow.setHolding(true);

    expect(noticed(flow)).toBe(once);
  });
});

describe("writeDraft", () => {
  test("a draft the first load could not read is read again: with none saved, saving starts and the write goes", async () => {
    const page = freshStore();
    const server = serve({ draft: "unreadable", review: versioned({ version: 1 }) });
    await page.start();
    server.answer = { ...server.answer, draft: null };
    page.addAnnotation(comment("", `${WIP}.review/v1.md`));

    expect(await page.writeDraft()).toBe(true);
    expect(server.puts.at(-1)?.annotations).toHaveLength(1);
  });

  test("a saved draft this tab never loaded is not written over: reload to see it", async () => {
    const page = freshStore();
    const saved = { annotations: [comment("s", `${WIP}.review/v1.md`)], edit: null };
    const server = serve({ draft: "unreadable", review: versioned({ version: 1 }) });
    await page.start();
    server.answer = { ...server.answer, draft: { ...saved, choices: {}, typed: EMPTY_TYPED } };

    expect(await page.writeDraft()).toBe(false);
    expect(server.puts).toEqual([]);
    expect(page.store.getState().failures.map(({ text }) => text)).toContain(
      "A saved draft this tab did not load is on the server: reload the page to see it before you send.",
    );
  });
});

/** The bar's Send of what the page shows: every comment, the edit, and each part. */
function all(
  page: PageModule,
  parts: readonly SendShare[] = [],
  takeDefaults: readonly string[] = [],
) {
  const s = page.store.getState();

  return page.send({
    annotations: s.annotations.map(({ id }) => id),
    edit: s.edited,
    choices: choicesIn(s.choices).map((choice) => refOf(choice)),
    parts,
    takeDefaults,
  });
}

/** An extension's share of the Send, which records its `sent` once the page has taken the Send. */
function sharing(count: number, seen: string[], settle = Promise.resolve()): SendShare {
  return {
    count,
    unanswered: [],
    more: false,
    sent: async () => {
      await settle;
      seen.push("sent");
    },
  };
}

describe("send", () => {
  const plan = `${WIP}.review/v1.md`;

  const typed = {
    ...EMPTY_TYPED,
    general: "Overall",
    grill: { [`${WIP}grill-1.md`]: { answers: { Q1: "yes" }, note: "" } },
  };

  test("writes the draft as the page shows it first, then sends what it names, then loads the review", async () => {
    const page = freshStore();

    const draft = {
      annotations: [comment("a", plan)],
      edit: edit(1, "mine\n"),
      choices: {},
      typed,
    };

    const server = serve({ draft, review: versioned({ version: 1 }) });
    await page.start();
    server.calls.length = 0;
    await all(page, [], ["Q2"]);

    expect(server.calls.slice(0, 3)).toEqual([
      "PUT /api/draft",
      "POST /api/send",
      "GET /api/review",
    ]);
    expect(server.sends).toEqual([
      { annotations: ["a"], edit: 1 as never, choices: [], parts: true, takeDefaults: ["Q2"] },
    ]);
  });

  test("takes out of the page what it sent, and leaves what is typed where it is", async () => {
    const page = freshStore();

    const draft = {
      annotations: [comment("a", plan)],
      edit: edit(1, "mine\n"),
      choices: {},
      typed,
    };

    serve({ draft, review: versioned({ version: 1 }) });
    await page.start();

    expect(await all(page)).toEqual({ kind: "sent", editKept: null });
    const s = page.store.getState();
    expect([s.annotations, s.edited, s.typed]).toEqual([[], null, typed]);
  });

  test("an edit the held review left in the draft stays on the page, with the plan's comment, under a notice", async () => {
    const flow = freshFlow();
    const held = "plan review 1 of v1 is running";
    const other = comment("b", `${WIP}notes.md`);

    const draft = {
      annotations: [comment("a", plan), other],
      edit: edit(1, "mine\n"),
      choices: {},
      typed,
    };

    const editKept = { reason: held, annotations: ["a"] };
    const answer = { file: `${WIP}.review/v1.feedback-1.md`, seq: 1, editKept } as never;
    serve({ draft, review: versioned({ version: 1, held }), send: { status: 200, answer } });
    await flow.start();

    expect(await all(flow)).toEqual({ kind: "sent", editKept: held });
    expect([flow.store.getState().annotations, flow.store.getState().edited]).toEqual([
      [comment("a", plan)],
      edit(1, "mine\n"),
    ]);
    expect(texts(flow)).toEqual([`Your edit waits: ${held}. Send it again once that ends.`]);
  });

  test("an edit alone the held review refused stays on the page, under the same notice", async () => {
    const flow = freshFlow();
    const held = "grill 1 is open";
    const draft = { annotations: [], edit: edit(1, "mine\n"), choices: {}, typed };
    const refusal = { status: 409, answer: { reason: "refused", rule: "held", text: held } };
    serve({ draft, review: versioned({ version: 1, held }), send: refusal as never });
    await flow.start();
    await all(flow);

    expect(flow.store.getState().edited).toEqual(edit(1, "mine\n"));
    expect(texts(flow)).toEqual([`Your edit waits: ${held}. Send it again once that ends.`]);
  });

  test("a held refusal the page has not heard of yet says the edit waits, in the server's words", async () => {
    const flow = freshFlow();
    const held = "plan review 1 of v1 is running";
    const draft = { annotations: [], edit: edit(1, "mine\n"), choices: {}, typed };
    const refusal = { status: 409, answer: { reason: "refused", rule: "held", text: held } };
    serve({ draft, review: versioned({ version: 1 }), send: refusal as never });
    await flow.start();
    await all(flow);

    expect(texts(flow)).toEqual([`Your edit waits: ${held}. Send it again once that ends.`]);
  });

  test("the edit's notice stays through a Send that carries no edit, and leaves with the edit", async () => {
    const flow = freshFlow();
    const held = "plan review 1 of v1 is running";

    const draft = {
      annotations: [comment("b", `${WIP}notes.md`)],
      edit: edit(1, "mine\n"),
      choices: {},
      typed,
    };

    const answer = {
      file: `${WIP}.review/v1.feedback-1.md`,
      seq: 1,
      editKept: { reason: held, annotations: [] },
    };

    const server = serve({
      draft,
      review: versioned({ version: 1, held }),
      send: { status: 200, answer: answer as never },
    });

    await flow.start();
    await flow.send({
      annotations: [],
      edit: flow.store.getState().edited,
      choices: [],
      parts: null,
      takeDefaults: [],
    });
    server.answer = {
      ...server.answer,
      send: { status: 200, answer: { ...answer, editKept: null } as never },
    };
    await flow.send({
      annotations: ["b"],
      edit: null,
      choices: [],
      parts: null,
      takeDefaults: [],
    });
    const waits = `Your edit waits: ${held}. Send it again once that ends.`;

    expect(texts(flow)).toContain(waits);
    flow.discardEdit();
    flow.finishEdit({ version: 1 as never, base: "", line: 1 }, "another\n");

    expect(texts(flow)).not.toContain(waits);
  });

  test("the edit's notice leaves once a load reads that nothing holds the review, and a hold after it brings none back", async () => {
    const flow = freshFlow();
    const held = "grill 1 is open";
    const draft = { annotations: [], edit: edit(1, "mine\n"), choices: {}, typed };
    const refusal = { status: 409, answer: { reason: "refused", rule: "held", text: held } };

    const server = serve({
      draft,
      review: versioned({ version: 1, held }),
      send: refusal as never,
    });

    await flow.start();
    await all(flow);

    const reads = async (view: ReviewView): Promise<void> => {
      server.answer = { ...server.answer, review: view };
      server.push("message");
      await settled();
    };

    await reads(versioned({ version: 1, held }));
    expect(texts(flow)).toEqual([`Your edit waits: ${held}. Send it again once that ends.`]);
    await reads(versioned({ version: 1 }));
    await reads(versioned({ version: 1, held: "grill 2 is open" }));

    expect(texts(flow)).toEqual([]);
  });

  test("names the choices by their option, and takes out those sent: another option chosen meanwhile stays", async () => {
    const page = freshStore();
    const out = Promise.withResolvers<void>();
    const choices = { [MOCKUP]: { layout: chose("d"), nav: chose("tabs") } };
    const draft = { annotations: [], edit: null, choices, typed: EMPTY_TYPED };
    const server = serve({ draft, review: versioned({ version: 1 }), sending: () => out.promise });
    await page.start();
    const sending = all(page);
    await settled();
    page.choose(MOCKUP, "layout", chose("e"));
    out.resolve();
    await sending;

    expect(server.sends[0]?.choices).toEqual([
      { doc: MOCKUP, decision: "layout", option: "d" },
      { doc: MOCKUP, decision: "nav", option: "tabs" },
    ]);
    expect(page.store.getState().choices).toEqual({ [MOCKUP]: { layout: chose("e") } });
  });

  test("a Send that names no choice leaves the choices as they were, the very same", async () => {
    const page = freshStore();
    const choices = { [MOCKUP]: { layout: chose("d") } };
    const draft = { annotations: [comment("a", plan)], edit: null, choices, typed: EMPTY_TYPED };
    serve({ draft, review: versioned({ version: 1 }) });
    await page.start();
    const before = page.store.getState().choices;
    await page.send({
      annotations: ["a"],
      edit: null,
      choices: [],
      parts: null,
      takeDefaults: [],
    });

    expect(page.store.getState().choices).toBe(before);
  });

  test("a Send the server cannot read says to reload the page", async () => {
    const page = freshStore();

    const draft = {
      annotations: [comment("a", plan)],
      edit: null,
      choices: {},
      typed: EMPTY_TYPED,
    };

    serve({
      draft,
      review: versioned({ version: 1 }),
      send: { status: 400, answer: null as never },
    });
    await page.start();

    expect(await all(page)).toEqual({ kind: "failed" });
    expect(
      page.store
        .getState()
        .failures.map(({ text }) => text)
        .join(),
    ).toContain("Reload the page");
  });

  test("a comment added while the Send is out stays: it was not sent", async () => {
    const page = freshStore();
    const out = Promise.withResolvers<void>();

    const draft = {
      annotations: [comment("a", plan)],
      edit: null,
      choices: {},
      typed: EMPTY_TYPED,
    };

    serve({ draft, review: versioned({ version: 1 }), sending: () => out.promise });
    await page.start();
    const sending = all(page);
    await settled();
    page.addAnnotation(comment("b", plan));
    out.resolve();
    await sending;

    expect(page.store.getState().annotations.map(({ mark }) => mark)).toEqual([
      { kind: "comment", body: "b" },
    ]);
  });

  test("the Send stays out until each part has read its state again: nothing counts a sent question meanwhile", async () => {
    const page = freshStore();
    const reread = Promise.withResolvers<void>();
    const seen: string[] = [];
    serve({ draft: null, review: versioned({ version: 1 }) });
    await page.start();
    const sending = all(page, [sharing(1, seen, reread.promise)]);
    await settled();
    await settled();

    expect(page.store.getState().sending).toBe(true);
    reread.resolve();
    await sending;
    expect([page.store.getState().sending, seen]).toEqual([false, ["sent"]]);
  });

  test("one write out at a time: a second Send while one is out sends nothing", async () => {
    const page = freshStore();
    const out = Promise.withResolvers<void>();

    const draft = {
      annotations: [comment("a", plan)],
      edit: null,
      choices: {},
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft, review: versioned({ version: 1 }), sending: () => out.promise });
    await page.start();
    const first = all(page);
    await settled();

    expect(await all(page)).toEqual({ kind: "failed" });
    out.resolve();
    await first;
    expect(server.sends).toHaveLength(1);
  });

  test("Send now names its comment alone, and no part: the rest of the draft stays", async () => {
    const page = freshStore();

    const draft = {
      annotations: [comment("a", plan), comment("b", plan)],
      edit: null,
      choices: {},
      typed,
    };

    const server = serve({ draft, review: versioned({ version: 1 }) });
    await page.start();
    await page.send({
      annotations: ["b"],
      edit: null,
      choices: [],
      parts: null,
      takeDefaults: [],
    });

    expect(server.sends).toEqual([
      { annotations: ["b"], edit: null, choices: [], parts: false, takeDefaults: [] },
    ]);
    expect(page.store.getState().annotations).toEqual([comment("a", plan)]);
    expect(page.store.getState().typed).toEqual(typed);
  });

  test("questions no answer takes keep everything, and answer their ids", async () => {
    const page = freshStore();
    const draft = { annotations: [comment("a", plan)], edit: null, choices: {}, typed };

    const unanswered = {
      status: 409,
      answer: { reason: "unanswered", ids: ["Q1", "Q2"] },
    } as const;

    serve({ draft, review: versioned({ version: 1 }), send: unanswered });
    await page.start();

    expect(await all(page)).toEqual({ kind: "unanswered", ids: ["Q1", "Q2"] });
    expect(page.store.getState().annotations).toEqual([comment("a", plan)]);
    expect(page.store.getState().failures).toEqual([]);
  });

  test("a refusal keeps the comments and says why", async () => {
    const page = freshStore();

    const draft = {
      annotations: [comment("a", plan)],
      edit: null,
      choices: {},
      typed: EMPTY_TYPED,
    };

    const stale = {
      status: 409,
      answer: {
        reason: "refused",
        rule: "stale",
        text: "your edit is of a version no longer under review",
      },
    } as const;

    serve({ draft, review: versioned({ version: 1 }), send: stale });
    await page.start();

    expect(await all(page)).toEqual({ kind: "failed" });
    expect(page.store.getState().annotations).toEqual([comment("a", plan)]);
    expect(page.store.getState().failures).toEqual([
      {
        op: "decision",
        text: "Not sent: your edit is of a version no longer under review. Your comments are kept.",
      },
    ]);
  });

  test("with the draft not saved nothing is sent: the server would send another", async () => {
    const page = freshStore();
    const refused = "draft.json was saved by an older version of vellum and cannot be read.";
    const server = serve({ draft: { refused }, review: versioned({ version: 1 }) });
    await page.start();
    page.addAnnotation(comment("", plan));

    expect(await all(page)).toEqual({ kind: "failed" });
    expect(server.sends).toEqual([]);
  });
});

describe("the failures", () => {
  test("one per operation: a repeat replaces, a success removes, the others stay", () => {
    const { fail, store, succeed } = freshStore();
    fail("load", "first");
    fail("decision", "no");
    fail("load", "second");
    succeed("decision");

    expect(store.getState().failures).toEqual([{ op: "load", text: "second" }]);
  });
});

describe("a deleted card", () => {
  test("can be undone from the notice, back at its place, and the notice goes", () => {
    const flow = freshFlow();
    const { store, removeAnnotation } = flow;
    const [a, b, c] = ["a", "b", "c"].map((id) => comment(id, `${WIP}plan.md`));
    store.setState({
      review: drafting([doc(`${WIP}plan.md`, "plan")]),
      annotations: [a, b, c] as never,
    });
    removeAnnotation("b");

    expect(store.getState().annotations).toEqual([a, c] as never);
    expect(noticed(flow).at(-1)?.key).toBe("undo");
    store.getState().undo?.run();
    expect(store.getState().annotations).toEqual([a, b, c] as never);
    expect(store.getState().undo).toBeNull();
  });

  test("its undo goes with a decision the server took: a sent comment is not brought back", async () => {
    const page = freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), decision: 200 });
    page.store.setState({ annotations: [comment("a", `${WIP}.review/v1.md`)] });
    page.removeAnnotation("a");
    await page.decide({ kind: "approve", edit: null, notes: "" });

    expect(page.store.getState().undo).toBeNull();
  });

  test("its undo goes with Done and with Discard edit: the lines it kept are the old text's", () => {
    const { store, discardEdit, finishEdit, removeAnnotation } = freshStore();

    store.setState({
      review: versioned({ version: 1, text: "a\nb\n" }),
      annotations: [onLine("a", `${WIP}.review/v1.md`, 2)],
    });
    removeAnnotation("a");
    finishEdit({ version: 1, base: "a\nb\n", line: 1 } as never, "new\na\nb\n");
    const afterDone = store.getState().undo;
    store.setState({
      edited: edit(1, "new\na\nb\n"),
      annotations: [onLine("b", `${WIP}.review/v1.md`, 3)],
    });
    removeAnnotation("b");
    discardEdit();

    expect([afterDone, store.getState().undo]).toEqual([null, null]);
  });

  test("its undo restores nothing on a page that locked meanwhile", () => {
    const { store, removeAnnotation } = freshStore();
    store.setState({
      review: versioned({ version: 1 }),
      annotations: [comment("a", `${WIP}.review/v1.md`)],
    });
    removeAnnotation("a");
    store.setState({ review: versioned({ version: 1, kind: "approved" }) });
    store.getState().undo?.run();

    expect(store.getState().annotations).toEqual([]);
    expect(store.getState().undo).toBeNull();
  });
});

describe("readWindow", () => {
  type Listener = (event: { readonly matches: boolean }) => void;

  /**
   * A window whose media queries answer by their text, and whose lists call the listeners of the
   * event they fire: a query or an event name the store misspells reaches nothing here.
   */
  function windowOf(matching: readonly string[]) {
    const listeners = new Map<string, Listener>();

    port("window", {
      matchMedia: (query: string) => ({
        matches: matching.includes(query),
        addEventListener: (type: string, listener: Listener) =>
          listeners.set(`${type} of ${query}`, listener),
      }),
    });

    return {
      change: (query: string, matches: boolean): void =>
        listeners.get(`change of ${query}`)?.({ matches }),
    };
  }

  test("before it the panel is open and the theme light", () => {
    const { store } = freshStore();

    expect([store.getState().commentsOpen, store.getState().dark]).toEqual([true, false]);
  });

  test("a window of 900px or less folds the comments panel and leaves the rail open", () => {
    const { store, readWindow } = freshStore();
    windowOf(["(max-width: 900px)"]);
    readWindow();
    const { commentsOpen, railOpen, dark } = store.getState();

    expect([commentsOpen, railOpen, dark]).toEqual([false, true, false]);
  });

  test("a wide window on a dark scheme opens the panel and draws dark", () => {
    const { store, readWindow } = freshStore();
    windowOf(["(prefers-color-scheme: dark)"]);
    readWindow();

    expect([store.getState().commentsOpen, store.getState().dark]).toEqual([true, true]);
  });

  test("the theme follows the scheme at each change, and the panel follows no resize", () => {
    const { store, readWindow } = freshStore();
    const media = windowOf([]);
    readWindow();
    media.change("(prefers-color-scheme: dark)", true);
    media.change("(max-width: 900px)", true);
    const night = store.getState().dark;
    media.change("(prefers-color-scheme: dark)", false);

    expect([night, store.getState().dark, store.getState().commentsOpen]).toEqual([
      true,
      false,
      true,
    ]);
  });
});
