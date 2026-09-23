/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures are branded values (ProjectPath, Version, WipDir) written as literals, and fakes stand where a browser global does: the brand is the parser's to grant, the global's type the browser's, and nothing here parses or runs in one. */
import { afterEach, describe, expect, test } from "bun:test";

import type {
  Annotation,
  Decision,
  DocGroup,
  Draft,
  Edit,
  GroupedDoc,
  ReviewView,
} from "../protocol.ts";
import { EMPTY_TYPED, lineDiff } from "../protocol.ts";

type Store = typeof import("./state.ts");

/** A store of its own for each test: `state.ts` under a query no import used before, which Bun evaluates again. */
async function freshStore(): Promise<Store> {
  const specifier = `./state.ts?state.spec=${crypto.randomUUID()}`;

  return (await import(specifier)) as Store;
}

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

function doc(path: string, group: DocGroup): GroupedDoc {
  return { path, mediaType: "text/markdown", modified: 0, group } as never;
}

function drafting(docs: readonly GroupedDoc[]): ReviewView {
  return {
    workspace: { kind: "drafting", dir: WIP, batches: 0 },
    plan: null,
    docs,
    held: null,
  } as never;
}

type Version = {
  readonly version: number;
  readonly text?: string;
  readonly previous?: string;
  readonly docs?: readonly GroupedDoc[];
  readonly kind?: "inReview" | "changesRequested" | "approved";
};

/** A view past `drafting`: the plan is `.review/v<version>.md`, as the server names it. */
function versioned({
  version,
  text = "",
  previous,
  docs = [],
  kind = "inReview",
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
    held: null,
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

/** What the page reads of a browser, each as small as the page's use of it. */
type Ports = {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly EventSource: new (url: string) => {
    addEventListener: (event: string, listener: () => void) => void;
  };
  readonly location: { readonly pathname: string };
  readonly window: { readonly matchMedia: (query: string) => MediaList };
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
  /** What `GET /api/review` waits on before its answer. */
  readonly load?: () => Promise<void>;
  /** What a `PUT /api/draft` waits on before its answer, and how it fails when this rejects. */
  readonly put?: () => Promise<void>;
  readonly putStatus?: number;
};

type Server = {
  /** Every request and every stream, in the order the page opened them. */
  readonly calls: string[];
  readonly puts: Draft[];
  readonly decisions: Decision[];
  readonly tokens: Set<string | undefined>;
  /** What the server pushes on the event stream: `message`, or the stream's own `error` and `open`. */
  readonly push: (event: "message" | "error" | "open") => void;
  answer: Served;
};

function answerOf(value: Draft | ReviewView | "unreadable"): Response {
  return value === "unreadable" ? new Response("", { status: 500 }) : Response.json(value);
}

/** The server as the page's ports see it: `fetch`, `EventSource`, and the token in the page's URL. */
function serve(answer: Served): Server {
  const listeners: { readonly event: string; readonly listener: () => void }[] = [];

  const server: Server = {
    calls: [],
    puts: [],
    decisions: [],
    tokens: new Set(),
    push: (event) => {
      for (const entry of listeners) if (entry.event === event) entry.listener();
    },
    answer,
  };

  port("location", { pathname: "/t/tok/" });

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

      return new Response("", { status: server.answer.decision ?? 200 });
    }

    if (method === "GET") {
      const { draft } = server.answer;

      if (draft === null) return new Response(null, { status: 204 });

      return draft !== "unreadable" && "refused" in draft
        ? Response.json({ error: draft.refused }, { status: 409 })
        : answerOf(draft);
    }

    server.puts.push(JSON.parse(String(init.body)) as Draft);
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
  test("is its own: what one sets, the next never sees", async () => {
    const one = await freshStore();
    const other = await freshStore();
    one.split.value = true;

    expect(other.split.value).toBe(false);
    expect(other.review).not.toBe(one.review);
  });
});

describe("docs", () => {
  test("before the first load the list is empty", async () => {
    const { docs } = await freshStore();

    expect(docs.value).toEqual([]);
  });

  test("while drafting the list is the server's, the working copy at its head as the plan", async () => {
    const { docs, planDoc, review } = await freshStore();
    const listed = [doc(`${WIP}plan.md`, "plan"), doc(`${WIP}mockup.md`, "artifact")];
    review.value = drafting(listed);

    expect(planDoc.value).toBeNull();
    expect(docs.value).toEqual(listed);
    expect(docs.value[0]?.group).toBe("plan");
  });

  test("once a version exists its file heads the list as the plan, before what the server lists", async () => {
    const { docs, planDoc, review } = await freshStore();
    const mockup = doc(`${WIP}mockup.md`, "artifact");
    review.value = versioned({ version: 2, docs: [mockup] });

    expect(planDoc.value).toEqual(doc(`${WIP}.review/v2.md`, "plan"));
    expect(docs.value).toEqual([doc(`${WIP}.review/v2.md`, "plan"), mockup]);
  });
});

describe("currentDoc", () => {
  const mockup = doc(`${WIP}mockup.md`, "artifact");
  const cited = doc("vellum/AGENTS.md", "cited");

  test("with nothing selected the plan shows", async () => {
    const { currentDoc, review } = await freshStore();
    review.value = versioned({ version: 1, docs: [mockup, cited] });

    expect(currentDoc.value?.path).toBe(`${WIP}.review/v1.md` as never);
  });

  test("a selected document shows", async () => {
    const { currentDoc, review, select } = await freshStore();
    review.value = versioned({ version: 1, docs: [mockup, cited] });
    select(cited.path);

    expect(currentDoc.value).toEqual(cited);
  });

  test("a selected version that went stale when the next one landed falls back on the plan", async () => {
    const { currentDoc, review, select } = await freshStore();
    review.value = versioned({ version: 1, docs: [mockup, cited] });
    select(`${WIP}.review/v1.md` as never);
    review.value = versioned({ version: 2, docs: [mockup, cited] });

    expect(currentDoc.value?.path).toBe(`${WIP}.review/v2.md` as never);
  });

  test("while drafting a selection that left the list falls back on the first document", async () => {
    const { currentDoc, review, select } = await freshStore();
    review.value = drafting([doc(`${WIP}plan.md`, "plan"), mockup, cited]);
    select(mockup.path);
    review.value = drafting([doc(`${WIP}plan.md`, "plan"), cited]);

    expect(currentDoc.value?.path).toBe(`${WIP}plan.md` as never);
  });

  test("an empty list shows nothing", async () => {
    const { currentDoc, review } = await freshStore();
    review.value = drafting([]);

    expect(currentDoc.value).toBeNull();
  });
});

describe("select", () => {
  const mockup = doc(`${WIP}mockup.md`, "artifact");

  test("on the plan's path clears split", async () => {
    const { current, review, select, split } = await freshStore();
    review.value = versioned({ version: 1, docs: [mockup] });
    split.value = true;
    select(`${WIP}.review/v1.md` as never);

    expect(split.value).toBe(false);
    expect(current.value).toBe(`${WIP}.review/v1.md` as never);
  });

  test("on another document keeps split", async () => {
    const { current, review, select, split } = await freshStore();
    review.value = versioned({ version: 1, docs: [mockup] });
    split.value = true;
    select(mockup.path);

    expect(split.value).toBe(true);
    expect(current.value).toBe(mockup.path);
  });

  test("while the editor is open moves nothing", async () => {
    const { current, openEditor, review, select } = await freshStore();
    review.value = versioned({ version: 1, docs: [mockup] });
    openEditor(1);
    select(mockup.path);

    expect(current.value).toBeNull();
  });
});

describe("locked", () => {
  test("before the first load the page is locked", async () => {
    const { locked } = await freshStore();

    expect(locked.value).toBe(true);
  });

  test("while drafting it takes comments", async () => {
    const { locked, review } = await freshStore();
    review.value = drafting([]);

    expect(locked.value).toBe(false);
  });

  test.each([
    ["inReview", false],
    ["changesRequested", true],
    ["approved", true],
  ] as const)("a version %s: locked is %p", async (kind, expected) => {
    const { locked, review } = await freshStore();
    review.value = versioned({ version: 1, kind });

    expect(locked.value).toBe(expected);
  });

  test("a locked page takes no comment", async () => {
    const { addAnnotation, annotations, review } = await freshStore();
    review.value = versioned({ version: 1, kind: "changesRequested" });
    addAnnotation(comment("", `${WIP}.review/v1.md`));

    expect(annotations.value).toEqual([]);
  });
});

describe("the comment switch", () => {
  test("a fresh store has the switch off, so an open page does not comment", async () => {
    const { commentSwitch, commenting, review } = await freshStore();
    review.value = versioned({ version: 1 });

    expect(commentSwitch.value).toBe(false);
    expect(commenting.value).toBe(false);
  });

  test("a locked page does not comment, whatever the switch", async () => {
    const { commentSwitch, commenting, review } = await freshStore();
    review.value = versioned({ version: 1, kind: "changesRequested" });
    commentSwitch.value = true;

    expect(commenting.value).toBe(false);
  });

  test("an open page comments once the switch is flipped on", async () => {
    const { commenting, flipCommentSwitch, review } = await freshStore();
    review.value = versioned({ version: 1 });
    flipCommentSwitch();

    expect(commenting.value).toBe(true);
  });

  test("a flip on a locked page leaves the switch as it was", async () => {
    const { commentSwitch, flipCommentSwitch, review } = await freshStore();
    review.value = versioned({ version: 1, kind: "approved" });
    flipCommentSwitch();

    expect(commentSwitch.value).toBe(false);
  });
});

describe("the comments", () => {
  test("a comment joins the others under an id of its own", async () => {
    const { addAnnotation, annotations, review } = await freshStore();
    review.value = versioned({ version: 1 });
    annotations.value = [comment("first", `${WIP}.review/v1.md`)];
    addAnnotation(comment("the caller's", `${WIP}.review/v1.md`));

    expect(annotations.value.map((annotation) => annotation.mark)).toEqual([
      { kind: "comment", body: "first" },
      { kind: "comment", body: "the caller's" },
    ]);
    expect(annotations.value[1]?.id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test("a removed comment leaves the others", async () => {
    const { annotations, removeAnnotation } = await freshStore();
    annotations.value = [comment("kept", `${WIP}plan.md`), comment("gone", `${WIP}plan.md`)];
    removeAnnotation("gone");

    expect(annotations.value.map((annotation) => annotation.id)).toEqual(["kept"]);
  });
});

describe("what is typed", () => {
  test("setTyped is a patch: the rest stays", async () => {
    const { setTyped, typed } = await freshStore();
    setTyped({ general: "Overall" });
    setTyped({ editor: { version: 1, text: "mine\n" } as never });

    expect(typed.value).toEqual({
      ...EMPTY_TYPED,
      general: "Overall",
      editor: edit(1, "mine\n"),
    });
  });

  test("unsentTyped names each place holding a text, and skips the blank ones", async () => {
    const { setTyped, unsentTyped } = await freshStore();
    setTyped({
      general: "  ",
      composer: { [`${WIP}mockup.html`]: "Bigger", [`${WIP}plan.md`]: "" },
      grill: {
        [`${WIP}grill-1.md`]: { answers: { Q1: "", Q2: "The inspector." }, note: "" },
        [`${WIP}grill-2.md`]: { answers: {}, note: " " },
      },
      editor: { version: 1, text: "mine\n" } as never,
    });

    expect(unsentTyped.value).toEqual([
      { where: "a comment on mockup.html", text: "Bigger" },
      { where: "the answers in grill-1.md", text: "The inspector." },
      { where: "the editor", text: "mine\n" },
    ]);
  });

  test("a card's edit changes the mark and keeps the place", async () => {
    const { annotations, updateAnnotation } = await freshStore();
    annotations.value = [onLine("c1", `${WIP}plan.md`, 3), comment("c2", `${WIP}plan.md`)];
    updateAnnotation("c1", { kind: "comment", body: "fixed" });

    expect(annotations.value).toEqual([
      { ...onLine("c1", `${WIP}plan.md`, 3), mark: { kind: "comment", body: "fixed" } },
      comment("c2", `${WIP}plan.md`),
    ]);
  });
});

describe("planChanges", () => {
  test("at v1 there is nothing to compare with", async () => {
    const { planChanges, review } = await freshStore();
    review.value = versioned({ version: 1, text: "a\n" });

    expect(planChanges.value).toBeNull();
  });

  test("a version is compared with the one before, in that direction", async () => {
    const { planChanges, review } = await freshStore();
    review.value = versioned({ version: 2, previous: "a\n", text: "a\nb\n" });

    expect(planChanges.value).toEqual(lineDiff("a\n", "a\nb\n"));
  });

  test("the reviewer's unsent edit is the text compared, not the version's", async () => {
    const { edited, planChanges, review } = await freshStore();
    review.value = versioned({ version: 2, previous: "a\n", text: "a\nb\n" });
    edited.value = edit(2, "a\nc\nd\n");

    expect(planChanges.value).toEqual(lineDiff("a\n", "a\nc\nd\n"));
  });
});

describe("the editor", () => {
  test("opens on the version under review, at the line asked", async () => {
    const { editing, openEditor, review } = await freshStore();
    review.value = versioned({ version: 2, text: "a\n" });
    openEditor(7);

    expect(editing.value).toEqual({ version: 2, base: "a\n", line: 7 } as never);
  });

  test("opens on the unsent edit when there is one", async () => {
    const { edited, editing, openEditor, review } = await freshStore();
    review.value = versioned({ version: 2, text: "a\n" });
    edited.value = edit(2, "mine\n");
    openEditor(1);

    expect(editing.value?.base).toBe("mine\n");
  });

  test.each(["changesRequested", "approved"] as const)(
    "stays shut on a version %s",
    async (kind) => {
      const { editing, openEditor, review } = await freshStore();
      review.value = versioned({ version: 2, text: "a\n", kind });
      openEditor(1);

      expect(editing.value).toBeNull();
    },
  );

  test("stays shut while drafting", async () => {
    const { editing, openEditor, review } = await freshStore();
    review.value = drafting([doc(`${WIP}plan.md`, "plan")]);
    openEditor(1);

    expect(editing.value).toBeNull();
  });

  test("Done records the typed text with its version, and moves the plan's comments down with their lines; closeEditor closes on a line", async () => {
    const { annotations, closeEditor, edited, editing, finishEdit, openEditor, resume, review } =
      await freshStore();

    review.value = versioned({ version: 2, text: "a\nb\n" });
    annotations.value = [
      onLine("c1", `${WIP}.review/v2.md`, 2),
      onLine("c2", `${WIP}mockup.md`, 2),
    ];
    openEditor(1);
    finishEdit({ version: 2, base: "a\nb\n", line: 1 } as never, "new\na\nb\n");
    const recorded = editing.value !== null;
    closeEditor(2);

    expect(edited.value).toEqual(edit(2, "new\na\nb\n"));
    expect([recorded, editing.value, resume.value]).toEqual([true, null, 2]);
    expect(annotations.value).toEqual([
      onLine("c1", `${WIP}.review/v2.md`, 3),
      onLine("c2", `${WIP}mockup.md`, 2),
    ]);
  });

  test("Done on a second edit shifts from the text the editor opened on, not from the version's", async () => {
    const { annotations, finishEdit, review } = await freshStore();
    review.value = versioned({ version: 2, text: "a\nb\nc\n" });
    annotations.value = [onLine("c1", `${WIP}.review/v2.md`, 3)];
    finishEdit({ version: 2, base: "new\na\nb\nc\n", line: 1 } as never, "new\na\nb\nc\n");

    expect(annotations.value).toEqual([onLine("c1", `${WIP}.review/v2.md`, 3)]);
  });

  test("Done on a second edit that removes a commented line gives the comment the version's lines", async () => {
    const { annotations, finishEdit, review } = await freshStore();
    review.value = versioned({ version: 2, text: "a\nb\nc\n" });
    annotations.value = [onLine("c1", `${WIP}.review/v2.md`, 3)];
    finishEdit({ version: 2, base: "new\na\nb\nc\n", line: 1 } as never, "new\na\nc\n");

    expect(annotations.value).toEqual([
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

  test("Done on the version's own text is no edit", async () => {
    const { edited, finishEdit, review } = await freshStore();
    review.value = versioned({ version: 2, text: "a\n" });
    edited.value = edit(2, "mine\n");
    finishEdit({ version: 2, base: "mine\n", line: 1 } as never, "a\n");

    expect(edited.value).toBeNull();
  });

  test("Discard edit is the reverse of Done: the version's text, the comments back on its lines, a removed one removed no more", async () => {
    const { annotations, discardEdit, edited, finishEdit, review } = await freshStore();
    review.value = versioned({ version: 2, text: "a\nb\nc\n" });
    annotations.value = [
      onLine("kept", `${WIP}.review/v2.md`, 3),
      onLine("gone", `${WIP}.review/v2.md`, 2),
    ];
    finishEdit({ version: 2, base: "a\nb\nc\n", line: 1 } as never, "new\na\nc\n");

    const shifted = annotations.value.map((a) => [
      a.id,
      a.anchor.kind === "text" ? a.anchor.passages[0].lines[0] : 0,
      a.anchor.kind === "text" && a.anchor.passages[0].removed,
    ]);

    discardEdit();

    expect(shifted).toEqual([
      ["kept", 3, false],
      ["gone", 2, true],
    ]);
    expect(edited.value).toBeNull();
    expect(annotations.value).toEqual([
      onLine("kept", `${WIP}.review/v2.md`, 3),
      onLine("gone", `${WIP}.review/v2.md`, 2),
    ]);
  });

  test("Done once another version arrived keeps the editor open, and the notices say why", async () => {
    const { edited, editing, finishEdit, notices, openEditor, review } = await freshStore();
    review.value = versioned({ version: 1, text: "a\n" });
    openEditor(1);
    review.value = versioned({ version: 2, text: "b\n" });
    finishEdit({ version: 1, base: "a\n", line: 1 } as never, "mine\n");

    expect(editing.value).not.toBeNull();
    expect(edited.value).toBeNull();
    expect(notices.value.map((notice) => notice.text.join(""))).toEqual([
      "v2 arrived while you were editing v1. Copy what you need, then Cancel.",
    ]);
  });

  test("Done once the version was decided elsewhere keeps the editor open, and the notices say so", async () => {
    const { editing, finishEdit, notices, openEditor, review } = await freshStore();
    review.value = versioned({ version: 1, text: "a\n" });
    openEditor(1);
    review.value = versioned({ version: 1, text: "a\n", kind: "changesRequested" });
    finishEdit({ version: 1, base: "a\n", line: 1 } as never, "mine\n");

    expect(editing.value).not.toBeNull();
    expect(notices.value.map((notice) => notice.text.join(""))).toEqual([
      "v1 is no longer under review. Copy what you need, then Cancel.",
      "Feedback sent to Claude. Waiting for the next version of the plan.",
    ]);
  });
});

describe("start", () => {
  test("restores the saved draft before anything is written: the first PUT carries it, after both reads and the stream", async () => {
    const store = await freshStore();

    const saved: Draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: null,
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft: saved, review: versioned({ version: 1 }) });
    await store.start();
    await settled();

    expect(server.calls).toEqual([
      "GET /api/draft",
      "GET /api/review",
      "EventSource /t/tok/events",
      "PUT /api/draft",
    ]);
    expect(server.puts).toEqual([saved]);
    expect(store.annotations.value).toEqual(saved.annotations);
  });

  test("nothing is written while the first load is still out", async () => {
    const store = await freshStore();
    const loaded = Promise.withResolvers<void>();

    const saved: Draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: null,
      typed: EMPTY_TYPED,
    };

    const server = serve({
      draft: saved,
      review: versioned({ version: 1 }),
      load: () => loaded.promise,
    });

    const started = store.start();
    await settled();
    const whileLoading = [...server.calls];
    loaded.resolve();
    await started;
    await settled();

    expect(whileLoading).toEqual(["GET /api/draft", "GET /api/review"]);
    expect(server.puts).toEqual([saved]);
  });

  test("with no saved draft the first write is the empty one, still after both reads", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await store.start();
    await settled();

    expect(server.calls.indexOf("PUT /api/draft")).toBeGreaterThan(
      server.calls.indexOf("GET /api/review"),
    );
    expect(server.puts).toEqual([{ annotations: [], edit: null, typed: EMPTY_TYPED }]);
  });

  test("a restored edit meets the first load: another version arrived, so it is dropped with a banner and the comments stay", async () => {
    const store = await freshStore();
    const kept = [comment("c1", `${WIP}.review/v1.md`)];
    serve({
      draft: { annotations: kept, edit: edit(1, "mine\n"), typed: EMPTY_TYPED } as never,
      review: versioned({ version: 3 }),
    });
    await store.start();

    expect(store.edited.value).toBeNull();
    expect(store.failures.value).toEqual([
      {
        op: "edit",
        text: "Your unsent edit of v1 was dropped: another version of the plan arrived. Your comments are kept.",
      },
    ]);
    expect(store.annotations.value).toEqual(kept);
  });

  test("a restored editor typing of a version no longer under review is dropped: its field is gone", async () => {
    const store = await freshStore();

    serve({
      draft: { annotations: [], edit: null, typed: { ...EMPTY_TYPED, editor: edit(1, "mine\n") } },
      review: versioned({ version: 3 }),
    });

    await store.start();

    expect(store.typed.value.editor).toBeNull();
    expect(store.unsentTyped.value).toEqual([]);
  });

  test("a restored edit of the version loaded stays pending", async () => {
    const store = await freshStore();
    serve({
      draft: { annotations: [], edit: edit(1, "mine\n"), typed: EMPTY_TYPED } as never,
      review: versioned({ version: 1 }),
    });
    await store.start();

    expect(store.edited.value).toEqual(edit(1, "mine\n"));
    expect(store.failures.value).toEqual([]);
  });

  test("a restored edit that landed as the next version is cleared, and its comments become that version's", async () => {
    const store = await freshStore();

    const draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: edit(1, "mine\n"),
      typed: EMPTY_TYPED,
    };

    serve({ draft: draft as never, review: versioned({ version: 2, text: "mine\n" }) });
    await store.start();

    expect(store.edited.value).toBeNull();
    expect(store.failures.value).toEqual([]);
    expect(store.annotations.value).toEqual([comment("c1", `${WIP}.review/v2.md`)]);
  });

  test("a draft that cannot be read starts no saving, and says so", async () => {
    const store = await freshStore();
    const server = serve({ draft: "unreadable", review: versioned({ version: 1 }) });
    await store.start();
    store.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();

    expect(server.puts).toEqual([]);
    expect(store.failures.value).toEqual([
      {
        op: "draft",
        text: "The saved draft could not be read: the server answered 500. Nothing is saved until a reload succeeds.",
      },
    ]);
  });

  test("after it each change is one write, and the next waits for the one before", async () => {
    const store = await freshStore();
    const held = Promise.withResolvers<void>();

    const server = serve({
      draft: null,
      review: versioned({ version: 1 }),
      put: () => held.promise,
    });

    await store.start();
    store.addAnnotation(comment("", `${WIP}.review/v1.md`));
    store.edited.value = edit(1, "mine\n");
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
    const store = await freshStore();

    const draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: edit(1, "mine\n"),
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft, review: versioned({ version: 1 }) });
    await store.start();
    server.answer = { ...server.answer, review: versioned({ version: 2, text: "mine\n" }) };
    server.push("message");
    await settled();

    expect(server.puts).toEqual([
      draft,
      { annotations: [comment("c1", `${WIP}.review/v2.md`)], edit: null, typed: EMPTY_TYPED },
    ]);
  });

  test("Done is one write: the shifted comments and the edit, together", async () => {
    const store = await freshStore();

    const draft = {
      annotations: [onLine("c1", `${WIP}.review/v1.md`, 1)],
      edit: null,
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft, review: versioned({ version: 1, text: "a\n" }) });
    await store.start();
    store.finishEdit({ version: 1, base: "a\n", line: 1 } as never, "new\na\n");
    await settled();

    expect(server.puts).toEqual([
      draft,
      {
        annotations: [onLine("c1", `${WIP}.review/v1.md`, 2)],
        edit: edit(1, "new\na\n"),
        typed: EMPTY_TYPED,
      },
    ]);
  });

  test("a decision the server took is one write: no comment and no edit, together", async () => {
    const store = await freshStore();

    const draft = {
      annotations: [comment("c1", `${WIP}.review/v1.md`)],
      edit: edit(1, "mine\n"),
      typed: EMPTY_TYPED,
    };

    const server = serve({ draft, review: versioned({ version: 1 }) });
    await store.start();
    await store.decide({ kind: "approve", edit: edit(1, "mine\n"), notes: "" });
    await settled();

    expect(server.puts).toEqual([draft, { annotations: [], edit: null, typed: EMPTY_TYPED }]);
  });

  test("a draft the server refuses to read says the server's reason, and starts no saving", async () => {
    const store = await freshStore();
    const refused = "draft.json was saved by an older version of vellum and cannot be read.";
    const server = serve({ draft: { refused }, review: versioned({ version: 1 }) });
    await store.start();
    store.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();

    expect(server.puts).toEqual([]);
    expect(store.failures.value).toEqual([{ op: "draft", text: refused }]);
  });

  test("what is typed is restored before the first load, with the comments", async () => {
    const store = await freshStore();
    const typed = { ...EMPTY_TYPED, general: "Overall: no." };

    const server = serve({
      draft: { annotations: [], edit: null, typed },
      review: versioned({ version: 1 }),
    });

    await store.start();
    await settled();

    expect(store.typed.value).toEqual(typed);
    expect(server.puts).toEqual([{ annotations: [], edit: null, typed }]);
  });

  test("a continuous typing is one write, once it pauses", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await store.start();
    store.setTyped({ general: "O" });
    store.setTyped({ general: "Ov" });
    store.setTyped({ general: "Ove" });
    await settled();
    const whileTyping = server.puts.length;
    await Bun.sleep(400);

    expect(whileTyping).toBe(1);
    expect(server.puts.map((put) => put.typed.general)).toEqual(["", "Ove"]);
  });

  test("a comment added while a typing pauses carries the typing, in one write", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await store.start();
    store.setTyped({ general: "Overall" });
    store.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();
    await Bun.sleep(400);

    expect(server.puts.map((put) => [put.annotations.length, put.typed.general])).toEqual([
      [0, ""],
      [1, "Overall"],
    ]);
  });

  test("a decision the server took clears what is typed, in the same write", async () => {
    const store = await freshStore();
    const typed = { ...EMPTY_TYPED, general: "Overall: no." };

    const server = serve({
      draft: { annotations: [], edit: null, typed },
      review: versioned({ version: 1 }),
    });

    await store.start();
    await store.decide({ kind: "approve", edit: null, notes: "" });
    await settled();

    expect(store.typed.value).toEqual(EMPTY_TYPED);
    expect(server.puts.at(-1)).toEqual({ annotations: [], edit: null, typed: EMPTY_TYPED });
  });

  test("a write that never reaches the server says so, and the next change is still written", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await store.start();
    server.answer = { ...server.answer, put: () => Promise.reject(new Error("offline")) };
    store.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();
    server.answer = { ...server.answer, put: () => Promise.resolve() };
    store.addAnnotation(comment("", `${WIP}.review/v1.md`));
    await settled();

    expect(store.failures.value).toEqual([]);
    expect(server.puts.map((put) => put.annotations.length)).toEqual([0, 1, 2]);
  });

  test("a write the server refuses names its status", async () => {
    const store = await freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), putStatus: 500 });
    await store.start();
    await settled();

    expect(store.failures.value).toEqual([
      {
        op: "draft",
        text: "Your comments are kept in this tab, not saved: the server answered 500.",
      },
    ]);
  });

  test("the event stream opens once the first load is in, on the token's path", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await store.start();

    const opened = server.calls.indexOf("EventSource /t/tok/events");
    expect(opened).toBeGreaterThan(server.calls.indexOf("GET /api/review"));
    expect([...server.tokens]).toEqual(["tok"]);
  });

  test("a workspace event loads the review again", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await store.start();
    server.answer = { ...server.answer, review: versioned({ version: 2 }) };
    server.push("message");
    await settled();

    expect(store.planDoc.value?.path).toBe(`${WIP}.review/v2.md` as never);
  });

  test("a stream that fails says the connection is down, and up once it opens again", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    await store.start();
    server.push("error");
    const afterError = store.connection.value;
    server.push("open");

    expect([afterError, store.connection.value]).toEqual(["down", "up"]);
  });

  test("a review that cannot be read reaches the banner", async () => {
    const store = await freshStore();
    serve({ draft: null, review: "unreadable" });
    await store.start();

    expect(store.review.value).toBeNull();
    expect(store.failures.value).toEqual([
      { op: "review", text: "The review could not be loaded: the server answered 500." },
    ]);
  });

  test("a version that lands under an open editor says so, over the dropped edit's own banner", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1, text: "a\n" }) });
    await store.start();
    store.edited.value = edit(1, "mine\n");
    store.openEditor(1);
    server.answer = { ...server.answer, review: versioned({ version: 3, text: "c\n" }) };
    server.push("message");
    await settled();

    expect(store.edited.value).toBeNull();
    expect(store.editing.value).not.toBeNull();
    expect(store.notices.value.map((notice) => [notice.key, notice.text.join("")])).toEqual([
      [
        "failure:edit",
        "Your unsent edit of v1 was dropped: another version of the plan arrived. Your comments are kept.",
      ],
      ["stale-editor", "v3 arrived while you were editing v1. Copy what you need, then Cancel."],
    ]);
  });
});

describe("decide", () => {
  const unsent = [comment("c1", `${WIP}.review/v1.md`)];

  test("a decision the server took clears the comments and the edit, then loads the review again", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }), decision: 200 });
    store.annotations.value = unsent;
    store.edited.value = edit(1, "mine\n");
    await store.decide({ kind: "approve", edit: null, notes: "" });

    expect(store.annotations.value).toEqual([]);
    expect(store.edited.value).toBeNull();
    expect(store.failures.value).toEqual([]);
    expect(server.calls).toEqual(["POST /api/decision", "GET /api/review"]);
  });

  test("the decision reaches the server as it was taken", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }) });
    const feedback: Decision = { kind: "feedback", edit: edit(1, "mine\n"), annotations: unsent };
    await store.decide(feedback);

    expect(server.decisions).toEqual([feedback]);
  });

  test("a redirect is a refusal as well: the comments stay, and the status is named", async () => {
    const store = await freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), decision: 300 });
    store.annotations.value = unsent;
    await store.decide({ kind: "approve", edit: null, notes: "" });

    expect(store.annotations.value).toEqual(unsent);
    expect(store.failures.value).toEqual([
      { op: "decision", text: "Not sent: the server answered 300. Your comments are kept." },
    ]);
  });

  test("a version already decided keeps the comments and says so", async () => {
    const store = await freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), decision: 409 });
    store.annotations.value = unsent;
    await store.decide({ kind: "approve", edit: null, notes: "" });

    expect(store.annotations.value).toEqual(unsent);
    expect(store.failures.value).toEqual([
      { op: "decision", text: "This version was already decided." },
    ]);
  });

  test("any other refusal keeps the comments and names the status", async () => {
    const store = await freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), decision: 500 });
    store.annotations.value = unsent;
    await store.decide({ kind: "approve", edit: null, notes: "" });

    expect(store.annotations.value).toEqual(unsent);
    expect(store.failures.value).toEqual([
      { op: "decision", text: "Not sent: the server answered 500. Your comments are kept." },
    ]);
  });

  test("a server that does not answer is a failure too, the comments kept, and the decision answers false", async () => {
    const store = await freshStore();
    serve({ draft: null, review: versioned({ version: 1 }) });
    store.annotations.value = unsent;
    port("fetch", () => Promise.reject(new Error("offline")));
    const taken = await store.decide({ kind: "approve", edit: null, notes: "" });

    expect(taken).toBe(false);
    expect(store.annotations.value).toEqual(unsent);
    expect(store.failures.value.map((failure) => failure.op)).toEqual(["decision"]);
  });

  test("a decision the server took answers true, and clears the failure of the one before", async () => {
    const store = await freshStore();
    const server = serve({ draft: null, review: versioned({ version: 1 }), decision: 500 });
    await store.decide({ kind: "approve", edit: null, notes: "" });
    server.answer = { ...server.answer, decision: 200 };
    const taken = await store.decide({ kind: "approve", edit: null, notes: "" });

    expect(taken).toBe(true);
    expect(store.failures.value).toEqual([]);
  });
});

describe("the failures", () => {
  test("one per operation: a repeat replaces, a success removes, the others stay", async () => {
    const { fail, failures, succeed } = await freshStore();
    fail("load", "first");
    fail("decision", "no");
    fail("load", "second");
    succeed("decision");

    expect(failures.value).toEqual([{ op: "load", text: "second" }]);
  });
});

describe("a deleted card", () => {
  test("can be undone from the notice, back at its place, and the notice goes", async () => {
    const { annotations, notices, removeAnnotation, review, undo } = await freshStore();
    const [a, b, c] = ["a", "b", "c"].map((id) => comment(id, `${WIP}plan.md`));
    review.value = drafting([doc(`${WIP}plan.md`, "plan")]);
    annotations.value = [a, b, c] as never;
    removeAnnotation("b");

    expect(annotations.value).toEqual([a, c] as never);
    expect(notices.value.at(-1)?.key).toBe("undo");
    undo.value?.run();
    expect(annotations.value).toEqual([a, b, c] as never);
    expect(undo.value).toBeNull();
  });

  test("its undo goes with a decision the server took: a sent comment is not brought back", async () => {
    const store = await freshStore();
    serve({ draft: null, review: versioned({ version: 1 }), decision: 200 });
    store.annotations.value = [comment("a", `${WIP}.review/v1.md`)];
    store.removeAnnotation("a");
    await store.decide({ kind: "feedback", edit: null, annotations: [] });

    expect(store.undo.value).toBeNull();
  });

  test("its undo goes with Done and with Discard edit: the lines it kept are the old text's", async () => {
    const { annotations, discardEdit, edited, finishEdit, removeAnnotation, review, undo } =
      await freshStore();

    review.value = versioned({ version: 1, text: "a\nb\n" });
    annotations.value = [onLine("a", `${WIP}.review/v1.md`, 2)];
    removeAnnotation("a");
    finishEdit({ version: 1, base: "a\nb\n", line: 1 } as never, "new\na\nb\n");
    const afterDone = undo.value;
    edited.value = edit(1, "new\na\nb\n");
    annotations.value = [onLine("b", `${WIP}.review/v1.md`, 3)];
    removeAnnotation("b");
    discardEdit();

    expect([afterDone, undo.value]).toEqual([null, null]);
  });

  test("its undo restores nothing on a page that locked meanwhile", async () => {
    const { annotations, removeAnnotation, review, undo } = await freshStore();
    review.value = versioned({ version: 1 });
    annotations.value = [comment("a", `${WIP}.review/v1.md`)];
    removeAnnotation("a");
    review.value = versioned({ version: 1, kind: "changesRequested" });
    undo.value?.run();

    expect(annotations.value).toEqual([]);
    expect(undo.value).toBeNull();
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

  test("before it the panel is open and the theme light", async () => {
    const { commentsOpen, dark } = await freshStore();

    expect([commentsOpen.value, dark.value]).toEqual([true, false]);
  });

  test("a window of 900px or less folds the comments panel and leaves the rail open", async () => {
    const { commentsOpen, dark, railOpen, readWindow } = await freshStore();
    windowOf(["(max-width: 900px)"]);
    readWindow();

    expect([commentsOpen.value, railOpen.value, dark.value]).toEqual([false, true, false]);
  });

  test("a wide window on a dark scheme opens the panel and draws dark", async () => {
    const { commentsOpen, dark, readWindow } = await freshStore();
    windowOf(["(prefers-color-scheme: dark)"]);
    readWindow();

    expect([commentsOpen.value, dark.value]).toEqual([true, true]);
  });

  test("the theme follows the scheme at each change, and the panel follows no resize", async () => {
    const { commentsOpen, dark, readWindow } = await freshStore();
    const media = windowOf([]);
    readWindow();
    media.change("(prefers-color-scheme: dark)", true);
    media.change("(max-width: 900px)", true);
    const night = dark.value;
    media.change("(prefers-color-scheme: dark)", false);

    expect([night, dark.value, commentsOpen.value]).toEqual([true, false, true]);
  });
});
