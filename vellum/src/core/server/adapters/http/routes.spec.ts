import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serverExtensions } from "../../../../extensions/server.ts";
import { Review } from "../../app/review.ts";
import type { WipDir } from "../../domain/paths.ts";
import { parseWipDir } from "../../domain/paths.ts";
import { createHandler, TOKEN_HEADER, UNREADABLE_DRAFT } from "./routes.ts";
import { startServer } from "./serve.ts";
import type { Started } from "./serve.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const BIGGER = { kind: "comment", body: "bigger" };

const APPROVE = { kind: "approve", edit: null, notes: "" };

const PRO = {
  selector: "#pricing > div.card",
  text: "Pro",
  label: "div.card",
  context: { prefix: "", suffix: "", repeated: false },
  description: { heading: "Plans", role: "", name: "", openingTag: '<div class="card">' },
};

const CARD = { kind: "element", elements: [PRO] };

const PRO_WITHOUT_CONTEXT = {
  selector: PRO.selector,
  text: PRO.text,
  label: PRO.label,
  description: PRO.description,
};

const PRO_WITHOUT_DESCRIPTION = {
  selector: PRO.selector,
  text: PRO.text,
  label: PRO.label,
  context: PRO.context,
};

const ON_MOCKUP = { id: "a", doc: `${WIP}mockup.html`, anchor: CARD, mark: BIGGER };

const TYPED = { general: "", composer: {}, grill: {}, editor: null };

const LAYOUT = {
  option: "settings",
  label: "Settings",
  description: { heading: "Layout", role: "article", name: "", openingTag: "<article>" },
};

const CHOICES = { [`${WIP}mockup.html`]: { layout: LAYOUT } };

const SETTINGS = { doc: `${WIP}mockup.html`, decision: "layout", option: "settings" };

const DRAFT = {
  annotations: [ON_MOCKUP],
  edit: { version: 1, text: "# Q\n" },
  choices: CHOICES,
  typed: TYPED,
};

const EMPTY_DRAFT = { annotations: [], edit: null, choices: {}, typed: TYPED };

const DRAFT_PATH = `${WIP}.review/draft.json`;

const ALL = { annotations: ["a"], edit: null, choices: [], parts: true, takeDefaults: [] };

const NO_BUILD = { ok: false, error: "no commit for /vellum: no installed_plugins.json" } as const;

let started: Started;

let root: string;

function headers(): HeadersInit {
  return { "x-vellum-token": started.token, "content-type": "application/json" };
}

function url(path: string): string {
  return `http://127.0.0.1:${started.server.port}${path}`;
}

function post(path: string, body: string | null = null): Promise<Response> {
  return fetch(url(path), { method: "POST", headers: headers(), body });
}

function put(path: string, body: string): Promise<Response> {
  return fetch(url(path), { method: "PUT", headers: headers(), body });
}

function wipDir(): WipDir {
  const parsed = parseWipDir(WIP);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}

type Drafting = {
  readonly dir: string;
  readonly review: Review;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- an unparsed decision is the case under test: the route's parser is what grants the type.
  readonly decide: (decision: {
    readonly kind: string;
    readonly edit?: unknown;
    readonly notes?: unknown;
  }) => Promise<Response>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- an unparsed Send is the case under test: the route's parser is what grants the type.
  readonly sendBody: (body: unknown) => Promise<Response>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- an unparsed annotation is the case under test: the route's parser is what grants the type.
  readonly send: (annotation: {
    readonly anchor: unknown;
    readonly mark?: unknown;
  }) => Promise<Response>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- an unparsed draft is the case under test: the route's parser is what grants the type.
  readonly putDraft: (draft: {
    readonly annotations?: unknown;
    readonly edit?: unknown;
    readonly choices?: unknown;
    readonly typed?: unknown;
  }) => Promise<Response>;
  readonly getDraft: () => Promise<Response>;
  readonly channel: (after: string) => Promise<Response>;
};

/** A review still drafting, behind its own handler: a Send there writes `v0.feedback-<n>.md`. */
function drafting(): Drafting {
  const dir = mkdtempSync(join(tmpdir(), "vellum-decision-"));
  mkdirSync(join(dir, WIP, ".review"), { recursive: true });
  const review = new Review({ project: dir, workdir: wipDir(), extensions: serverExtensions });

  const { handle } = createHandler({
    token: "t",
    project: dir,
    review,
    frameScript: "",
    extensionRoutes: new Map(),
    openBrowser: () => {},
    heartbeat: () => {},
    vellumBuild: NO_BUILD,
  });

  const call = (method: string, path: string, body: string | null): Promise<Response> =>
    handle(new Request(`http://x${path}`, { method, headers: { [TOKEN_HEADER]: "t" }, body }));

  const decide: Drafting["decide"] = (decision) =>
    call("POST", "/api/decision", JSON.stringify(decision));

  const putDraft: Drafting["putDraft"] = (draft) =>
    call("PUT", "/api/draft", JSON.stringify(draft));

  const getDraft = (): Promise<Response> => call("GET", "/api/draft", null);

  const sendBody: Drafting["sendBody"] = (body) => call("POST", "/api/send", JSON.stringify(body));

  /** The annotation saved in the draft, as the page saves it, then the whole draft sent. */
  const send: Drafting["send"] = async (annotation) => {
    const annotations = [{ id: "a", doc: `${WIP}mockup.html`, ...annotation }];
    const saved = await putDraft({ ...EMPTY_DRAFT, annotations });

    return saved.status >= 300 ? saved : await sendBody(ALL);
  };

  const channel = (after: string): Promise<Response> =>
    call("GET", `/api/channel?after=${after}`, null);

  return { dir, review, decide, sendBody, send, putDraft, getDraft, channel };
}

/** The same review once `plan.md` was gated as v1. */
async function underReview(): Promise<Drafting> {
  const made = drafting();
  writeFileSync(join(made.dir, WIP, "plan.md"), "# Locked plan\n");
  await made.review.gate();

  return made;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "vellum-routes-"));
  mkdirSync(join(root, WIP), { recursive: true });
  writeFileSync(join(root, WIP, "mockup.html"), "<p>mock</p>");
  writeFileSync(join(root, WIP, "page.html"), "<body><p>hi</p></body>\n");
  writeFileSync(join(root, WIP, "notes.md"), "# notes\n");
  symlinkSync("/etc/hostname", join(root, WIP, "escape.txt"));
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);
  started = await startServer({ project: root, workdir: workdir.value, port: 0 });
});

afterAll(() => {
  started.stop();
});

describe("routes", () => {
  test("the page is served bundled at /t/<token>/", async () => {
    const response = await fetch(url(`/t/${started.token}/`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Vellum</title>");
    expect(html).toMatch(/<script[^>]+src="[^"]+\.js"/u);
  });

  test("/api needs the token", async () => {
    expect((await fetch(url("/api/review"))).status).toBe(401);
    expect((await fetch(url("/api/review"), { headers: headers() })).status).toBe(200);
  });

  test("files come with a sandbox CSP; escapes get 403 or vanish in URL parsing", async () => {
    const ok = await fetch(url(`/t/${started.token}/files/${WIP}mockup.html`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toBe("sandbox allow-scripts");

    const dots = await fetch(url(`/t/${started.token}/files/%2e%2e/%2e%2e/etc/passwd`));
    expect([403, 404]).toContain(dots.status);
    expect(await dots.text()).not.toContain("root:");

    const symlink = await fetch(url(`/t/${started.token}/files/${WIP}escape.txt`));
    expect(symlink.status).toBe(403);

    const missing = await fetch(url(`/t/${started.token}/files/${WIP}nope.html`));
    expect(missing.status).toBe(404);
  });

  test("an html file carries the frame script, a markdown file is untouched", async () => {
    const tag = `<script src="/t/${started.token}/frame.js"></script>`;

    const framed = await fetch(url(`/t/${started.token}/files/${WIP}page.html`));
    expect(await framed.text()).toBe(`<body><p>hi</p>${tag}</body>\n`);

    const noBody = await fetch(url(`/t/${started.token}/files/${WIP}mockup.html`));
    expect(await noBody.text()).toBe(`<p>mock</p>${tag}`);

    const markdown = await fetch(url(`/t/${started.token}/files/${WIP}notes.md`));
    expect(await markdown.text()).toBe("# notes\n");
  });

  test("the frame script is served as JavaScript in its own scope, and only under the token", async () => {
    const script = await fetch(url(`/t/${started.token}/frame.js`));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toStartWith("text/javascript");
    const text = await script.text();
    expect(text).toContain("vellum:pick");
    expect(text).toStartWith("(()=>{");

    expect((await fetch(url("/t/wrong-token/frame.js"))).status).toBe(404);
  });

  test("a file written under the working directory reaches the event stream", async () => {
    const events = await fetch(url(`/t/${started.token}/events`));
    const reader = events.body?.getReader();

    if (reader === undefined) throw new Error("no event stream");
    const next = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value);
    expect(await next()).toContain('"type":"workspace"');
    writeFileSync(join(root, WIP, "late.md"), "# late\n");
    expect(await next()).toContain('"type":"workspace"');
    await reader.cancel();
  });

  test("a draft write sends no workspace event", async () => {
    const events = await fetch(url(`/t/${started.token}/events`));
    const reader = events.body?.getReader();

    if (reader === undefined) throw new Error("no event stream");
    await reader.read();
    expect((await put("/api/draft", JSON.stringify(DRAFT))).status).toBe(204);
    expect(await Bun.file(join(root, DRAFT_PATH)).exists()).toBe(true);
    const next = await Promise.race([reader.read(), Bun.sleep(400).then(() => "quiet")]);
    expect(next).toBe("quiet");
    await reader.cancel();
  });

  test("gate answers 409 until plan.md exists, then the version", async () => {
    const missing = await post("/api/gate");
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: `write plan.md in ${WIP} first` });

    writeFileSync(join(root, WIP, "plan.md"), "# Routed plan\n");
    expect(await (await post("/api/gate")).json()).toEqual({ version: 1, kept: false });
    expect(await (await post("/api/gate")).json()).toEqual({ version: 1, kept: true });
  });

  test("gate reads how an unchanged plan.md is treated from its body", async () => {
    const kept = await post("/api/gate", JSON.stringify({ unchanged: "keep" }));
    expect(await kept.json()).toEqual({ version: 1, kept: true });
  });

  test("vellum-build answers this plugin's version and a full commit, behind the token", async () => {
    const manifest = await Bun.file(
      join(import.meta.dir, "../../../../../.claude-plugin/plugin.json"),
    ).json();

    expect((await fetch(url("/api/vellum-build"))).status).toBe(401);
    const response = await fetch(url("/api/vellum-build"), { headers: headers() });
    expect(response.status).toBe(200);
    const build = await response.json();
    expect(build.version).toBe(manifest.version);
    expect(build.commit).toMatch(/^[0-9a-f]{40}$/u);
  });

  test("a build the server could not read answers 500 with its reason", async () => {
    const { handle } = createHandler({
      token: "t",
      project: root,
      review: new Review({ project: root, workdir: wipDir(), extensions: serverExtensions }),
      frameScript: "",
      extensionRoutes: new Map(),
      openBrowser: () => {},
      heartbeat: () => {},
      vellumBuild: NO_BUILD,
    });

    const response = await handle(
      new Request("http://x/api/vellum-build", { headers: { [TOKEN_HEADER]: "t" } }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: NO_BUILD.error });
  });

  test("the finalize route is gone", async () => {
    expect((await post("/api/finalize", JSON.stringify({ version: 1 }))).status).toBe(404);
  });

  test("open reaches the browser while no tab listens, the server's own listener aside", async () => {
    let opened = 0;
    const review = new Review({ project: root, workdir: wipDir(), extensions: serverExtensions });

    const { handle } = createHandler({
      token: "t",
      project: root,
      review,
      frameScript: "",
      extensionRoutes: new Map(),
      openBrowser: () => (opened += 1),
      heartbeat: () => {},
      vellumBuild: NO_BUILD,
    });

    const open = (): Promise<Response> =>
      handle(
        new Request("http://x/api/open", { method: "POST", headers: { [TOKEN_HEADER]: "t" } }),
      );

    review.subscribe(() => {});

    expect((await open()).status).toBe(204);
    expect(opened).toBe(1);
    await handle(new Request("http://x/t/t/events"));
    await open();
    expect(opened).toBe(1);
  });

  test("a Send carries an element anchor; an element without a selector is refused", async () => {
    const { dir, send } = drafting();
    expect((await send({ anchor: CARD, mark: BIGGER })).status).toBe(200);
    expect(await Bun.file(join(dir, WIP, ".review/v0.feedback-1.md")).text()).toContain(
      'element `#pricing > div.card`, under "Plans", `<div class="card">`: "Pro"',
    );
    const unnamed = { kind: "element", elements: [{ text: "Pro" }] };
    expect((await send({ anchor: unnamed, mark: BIGGER })).status).toBe(400);
  });

  test("an element without the context of its words is refused", async () => {
    const { send } = drafting();
    const anchor = { kind: "element", elements: [PRO_WITHOUT_CONTEXT] };
    expect((await send({ anchor, mark: BIGGER })).status).toBe(400);
  });

  test("an element from a page older than the description is taken, and named as that page named it", async () => {
    const { dir, send } = drafting();
    const anchor = { kind: "element", elements: [PRO_WITHOUT_DESCRIPTION] };
    expect((await send({ anchor, mark: BIGGER })).status).toBe(200);
    expect(await Bun.file(join(dir, WIP, ".review/v0.feedback-1.md")).text()).toContain(
      'element `#pricing > div.card` (div.card): "Pro"',
    );
  });

  test("an element whose description is not four strings is refused", async () => {
    const { send } = drafting();
    const description = { ...PRO.description, openingTag: 3 };
    const anchor = { kind: "element", elements: [{ ...PRO, description }] };
    expect((await send({ anchor, mark: BIGGER })).status).toBe(400);
  });

  test("a label mark round-trips to the batch, its sentence alone", async () => {
    const { dir, send } = drafting();
    const mark = { kind: "label", label: "verify", body: "Bun.serve or the watcher?" };
    expect((await send({ anchor: CARD, mark })).status).toBe(200);
    expect(await Bun.file(join(dir, WIP, ".review/v0.feedback-1.md")).text()).toContain(
      '"Pro"\n   Verify this against the code or the docs, and cite what you read.\n',
    );
  });

  test("an unknown label is refused", async () => {
    const { send } = drafting();
    const mark = { kind: "label", label: "nitpick" };
    expect((await send({ anchor: CARD, mark })).status).toBe(400);
  });

  test("a delete mark is taken on an element and refused on a global anchor", async () => {
    const { send } = drafting();
    expect((await send({ anchor: CARD, mark: { kind: "delete" } })).status).toBe(200);
    expect((await send({ anchor: { kind: "global" }, mark: { kind: "delete" } })).status).toBe(400);
  });

  test("edit is null, or a version and a text: missing or malformed is refused", async () => {
    const { decide } = drafting();
    expect((await decide({ kind: "approve" })).status).toBe(400);
    expect((await decide({ kind: "approve", edit: "# Q\n" })).status).toBe(400);
    expect((await decide({ kind: "approve", edit: { version: 0, text: "# Q\n" } })).status).toBe(
      400,
    );
    expect((await decide({ kind: "approve", edit: { version: 1 } })).status).toBe(400);
    expect((await decide({ ...APPROVE, edit: null })).status).toBe(409);
  });

  test("a feedback is no decision any more: a Send is", async () => {
    const { decide } = drafting();
    expect((await decide({ kind: "feedback", edit: null })).status).toBe(400);
  });

  test("a Send names comment ids, the edit's version or null, whether the parts go, and the defaults agreed", async () => {
    const { sendBody } = drafting();

    for (const body of [
      {},
      { ...ALL, annotations: "all" },
      { ...ALL, annotations: [1] },
      { ...ALL, edit: 0 },
      { ...ALL, edit: "1" },
      { ...ALL, parts: "yes" },
      { ...ALL, takeDefaults: true },
      { ...ALL, choices: {} },
      { ...ALL, choices: [{ ...SETTINGS, doc: "/etc/passwd" }] },
      { ...ALL, choices: [{ ...SETTINGS, decision: "" }] },
      { ...ALL, choices: [{ ...SETTINGS, option: 1 }] },
    ]) {
      expect((await sendBody(body)).status, JSON.stringify(body)).toBe(400);
    }

    expect(await (await sendBody({ ...ALL, annotations: [] })).json()).toEqual({ reason: "empty" });
    expect(await (await sendBody(ALL)).json()).toEqual({ reason: "changed" });
  });

  test("a choice saved in the draft goes with the Send that names it, after the comments, and leaves the draft", async () => {
    const { dir, sendBody, putDraft, getDraft } = await underReview();
    await putDraft({ ...DRAFT, edit: null });
    const sent = await sendBody({ ...ALL, choices: [SETTINGS] });
    expect(sent.status).toBe(200);
    const batch = await Bun.file(join(dir, `${WIP}.review/v1.feedback-1.md`)).text();
    expect(batch).toContain(
      `## Choices\n\n1. \`${WIP}mockup.html\`, decision \`layout\`: option \`settings\`, under "Layout", \`<article>\`\n`,
    );
    expect(batch.indexOf("## Comments")).toBeLessThan(batch.indexOf("## Choices"));
    expect((await getDraft()).status).toBe(204);
  });

  test("a choice named with another option than the draft holds refuses the Send as changed", async () => {
    const { sendBody, putDraft } = await underReview();
    await putDraft({ ...EMPTY_DRAFT, choices: CHOICES });

    const other = await sendBody({
      ...ALL,
      annotations: [],
      choices: [{ ...SETTINGS, option: "d" }],
    });

    expect(await other.json()).toEqual({ reason: "changed" });
    const alone = await sendBody({ ...ALL, annotations: [], choices: [SETTINGS] });
    expect(alone.status).toBe(200);
  });

  test("a Send answers its batch and the entry's number, and leaves the page taking comments", async () => {
    const { dir, send, putDraft } = await underReview();
    const sent = await send({ anchor: CARD, mark: BIGGER });
    expect(await sent.json()).toEqual({ file: `${WIP}.review/v1.feedback-1.md`, seq: 1 });
    expect((await putDraft(DRAFT)).status).toBe(204);
    expect(existsSync(join(dir, DRAFT_PATH))).toBe(true);
  });

  test("an approve without notes, or with notes that are no string, is refused", async () => {
    const { decide } = drafting();
    expect((await decide({ kind: "approve", edit: null })).status).toBe(400);
    expect((await decide({ kind: "approve", edit: null, notes: null })).status).toBe(400);
    expect((await decide({ kind: "approve", edit: null, notes: 3 })).status).toBe(400);
  });

  test("an approve's note round-trips to the notes file of the final directory", async () => {
    const { dir, review, decide } = drafting();
    writeFileSync(join(dir, WIP, "plan.md"), "# Noted plan\n");
    await review.gate();
    expect((await decide({ ...APPROVE, notes: "Slice 1 only." })).status).toBe(200);
    const notes = Bun.file(join(dir, "plans/2026-09-15/noted-plan/.review/v1.notes.md"));
    expect(await notes.text()).toEndWith("\n\nSlice 1 only.\n");
  });

  test("a draft is written to .review/draft.json and read back as it is; none is 204", async () => {
    const { dir, putDraft, getDraft } = drafting();
    expect((await getDraft()).status).toBe(204);
    expect((await putDraft(DRAFT)).status).toBe(204);
    expect(await Bun.file(join(dir, DRAFT_PATH)).json()).toEqual(DRAFT);
    const read = await getDraft();
    expect(read.headers.get("content-type")).toStartWith("application/json");
    expect(await read.json()).toEqual(DRAFT);
  });

  test("a malformed draft is refused and leaves the saved one", async () => {
    const { getDraft, putDraft } = drafting();
    await putDraft(DRAFT);
    const onNothing = { ...ON_MOCKUP, anchor: { kind: "global" }, mark: { kind: "delete" } };
    expect((await putDraft({ annotations: [ON_MOCKUP], typed: TYPED })).status).toBe(400);
    expect((await putDraft({ ...EMPTY_DRAFT, annotations: "none" })).status).toBe(400);
    expect((await putDraft({ ...EMPTY_DRAFT, annotations: [{ id: 1 }] })).status).toBe(400);
    expect((await putDraft({ ...EMPTY_DRAFT, annotations: [onNothing] })).status).toBe(400);
    expect((await putDraft({ ...EMPTY_DRAFT, edit: { version: 0, text: "" } })).status).toBe(400);
    expect(await (await getDraft()).json()).toEqual(DRAFT);
  });

  test("a malformed choice refuses the draft", async () => {
    const { putDraft } = drafting();
    const mockup = `${WIP}mockup.html`;

    for (const choices of [
      [],
      { "/abs.html": { layout: LAYOUT } },
      { [mockup]: { "": LAYOUT } },
      { [mockup]: { layout: { ...LAYOUT, option: "" } } },
      { [mockup]: { layout: { option: "settings", label: "Settings" } } },
      { [mockup]: { layout: { ...LAYOUT, label: "" } } },
      { [mockup]: { layout: { option: LAYOUT.option, description: LAYOUT.description } } },
      { [mockup]: [LAYOUT] },
      { [mockup]: { layout: LAYOUT }, [`${WIP}./mockup.html`]: { nav: LAYOUT } },
      { [mockup]: { layout: { ...LAYOUT, description: { ...LAYOUT.description, role: 1 } } } },
    ]) {
      expect((await putDraft({ ...EMPTY_DRAFT, choices })).status, JSON.stringify(choices)).toBe(
        400,
      );
    }
  });

  test("a choice's mockup is kept under its path as parsed, so the Send that names it finds it", async () => {
    const { putDraft, getDraft, sendBody } = await underReview();
    await putDraft({ ...EMPTY_DRAFT, choices: { [`${WIP}./mockup.html`]: { layout: LAYOUT } } });

    expect(await (await getDraft()).json()).toEqual({ ...EMPTY_DRAFT, choices: CHOICES });
    expect((await sendBody({ ...ALL, annotations: [], choices: [SETTINGS] })).status).toBe(200);
  });

  test("a draft without what is typed, or with it malformed, is refused: the 0.11 shape included", async () => {
    const { putDraft } = drafting();
    expect((await putDraft({ annotations: [], edit: null })).status).toBe(400);
    expect((await putDraft({ ...EMPTY_DRAFT, typed: { general: "" } })).status).toBe(400);
    expect((await putDraft({ ...EMPTY_DRAFT, typed: { ...TYPED, general: 1 } })).status).toBe(400);
    expect(
      (await putDraft({ ...EMPTY_DRAFT, typed: { ...TYPED, composer: { "mockup.html": 1 } } }))
        .status,
    ).toBe(400);
    expect((await putDraft({ ...EMPTY_DRAFT, typed: { ...TYPED, composer: null } })).status).toBe(
      400,
    );
    expect(
      (
        await putDraft({
          ...EMPTY_DRAFT,
          typed: { ...TYPED, grill: { "g.md": { answers: { Q1: 1 }, note: "" } } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await putDraft({ ...EMPTY_DRAFT, typed: { ...TYPED, editor: { version: 0, text: "" } } }))
        .status,
    ).toBe(400);
  });

  test("what is typed round-trips, and alone keeps the file", async () => {
    const { dir, putDraft, getDraft } = drafting();

    const typed = {
      general: "Overall: no.",
      composer: { [`${WIP}mockup.html`]: "Bigger", [`${WIP}plan.md`]: "Which forms?" },
      grill: { [`${WIP}grill-1.md`]: { answers: { Q1: "IndexedDB." }, note: "Why?" } },
      editor: { version: 1, text: "# Mine\n" },
    };

    expect((await putDraft({ ...EMPTY_DRAFT, typed })).status).toBe(204);
    expect(await Bun.file(join(dir, DRAFT_PATH)).exists()).toBe(true);
    expect(await (await getDraft()).json()).toEqual({ ...EMPTY_DRAFT, typed });
  });

  test("a saved draft of an older shape is refused on read, with the reason, never read half-way", async () => {
    const { dir, getDraft } = drafting();
    writeFileSync(join(dir, DRAFT_PATH), JSON.stringify({ annotations: [ON_MOCKUP], edit: null }));
    const read = await getDraft();
    expect(read.status).toBe(409);
    expect(await read.json()).toEqual({ error: UNREADABLE_DRAFT });
    writeFileSync(join(dir, DRAFT_PATH), "not json");
    expect((await getDraft()).status).toBe(409);
  });

  test("a saved draft whose mockup comment has no context for its words is refused on read", async () => {
    const { dir, getDraft } = drafting();
    const anchor = { kind: "element", elements: [PRO_WITHOUT_CONTEXT] };
    const draft = { ...DRAFT, annotations: [{ ...ON_MOCKUP, anchor }] };
    writeFileSync(join(dir, DRAFT_PATH), JSON.stringify(draft));
    const read = await getDraft();
    expect(read.status).toBe(409);
    expect(await read.json()).toEqual({ error: UNREADABLE_DRAFT });
  });

  test("a draft saved by a page older than the description is read, its unsent comments kept", async () => {
    const { dir, getDraft } = drafting();
    const anchor = { kind: "element", elements: [PRO_WITHOUT_DESCRIPTION] };
    const draft = { ...DRAFT, annotations: [{ ...ON_MOCKUP, anchor }] };
    writeFileSync(join(dir, DRAFT_PATH), JSON.stringify(draft));
    const read = await getDraft();
    expect(read.status).toBe(200);
    const kept = { kind: "element", elements: [{ ...PRO_WITHOUT_DESCRIPTION, description: null }] };
    expect(await read.json()).toEqual({ ...draft, annotations: [{ ...ON_MOCKUP, anchor: kept }] });
  });

  test("a draft saved before the choices is read with none, its unsent comments kept", async () => {
    const { dir, getDraft } = drafting();
    writeFileSync(join(dir, DRAFT_PATH), JSON.stringify({ ...DRAFT, choices: undefined }));
    const read = await getDraft();
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ...DRAFT, choices: {} });
  });

  test("an empty draft deletes the file", async () => {
    const { dir, putDraft, getDraft } = drafting();
    await putDraft(DRAFT);
    expect((await putDraft(EMPTY_DRAFT)).status).toBe(204);
    expect(await Bun.file(join(dir, DRAFT_PATH)).exists()).toBe(false);
    expect((await getDraft()).status).toBe(204);
  });

  test("a draft that is no object is refused", async () => {
    expect((await put("/api/draft", "null")).status).toBe(400);
    expect((await put("/api/draft", '"draft"')).status).toBe(400);
    expect((await put("/api/draft", "not json")).status).toBe(400);
  });

  test("after an approve a draft with content is refused, and the working directory stays gone", async () => {
    const { dir, decide, putDraft } = await underReview();
    expect((await decide(APPROVE)).status).toBe(200);
    expect((await putDraft(DRAFT)).status).toBe(409);
    expect(existsSync(join(dir, WIP))).toBe(false);
    expect((await putDraft(EMPTY_DRAFT)).status).toBe(204);
    expect(existsSync(join(dir, WIP))).toBe(false);
  });

  test("two identical PUTs leave one file with each annotation once", async () => {
    const { dir, putDraft } = drafting();
    await putDraft(DRAFT);
    await putDraft(DRAFT);
    expect(readdirSync(join(dir, WIP, ".review"))).toEqual(["draft.json"]);
    expect(await Bun.file(join(dir, DRAFT_PATH)).json()).toEqual(DRAFT);
  });

  test("a passage says whether the edit removed it and what it quotes, or is refused", async () => {
    const { dir, send } = drafting();
    const passage = { quote: "the old gate", prefix: "", suffix: "", lines: [12, 14] };
    const anchor = { kind: "text", passages: [{ ...passage, removed: true, kind: "prose" }] };
    expect((await send({ anchor, mark: { kind: "delete" } })).status).toBe(200);
    expect(await Bun.file(join(dir, WIP, ".review/v0.feedback-1.md")).text()).toContain(
      "lines 12–14 (removed by the reviewer's edit)",
    );
    const bare = { kind: "text", passages: [{ ...passage, kind: "prose" }] };
    expect((await send({ anchor: bare, mark: { kind: "delete" } })).status).toBe(400);
    const unkinded = { kind: "text", passages: [{ ...passage, removed: false }] };
    expect((await send({ anchor: unkinded, mark: { kind: "delete" } })).status).toBe(400);
    const odd = { kind: "text", passages: [{ ...passage, removed: false, kind: "table" }] };
    expect((await send({ anchor: odd, mark: { kind: "delete" } })).status).toBe(400);
  });

  test("a delete mark is taken on a text anchor", async () => {
    const { dir, send } = drafting();

    const passage = {
      quote: "the old gate",
      prefix: "",
      suffix: "",
      lines: [12, 14],
      removed: false,
      kind: "prose",
    };

    const anchor = { kind: "text", passages: [passage] };
    expect((await send({ anchor, mark: { kind: "delete" } })).status).toBe(200);
    expect(await Bun.file(join(dir, WIP, ".review/v0.feedback-1.md")).text()).toContain(
      'lines 12–14: "the old gate"\n   Delete this.\n',
    );
  });

  test("a comment without a body is refused; a label takes none", async () => {
    const { send } = drafting();
    expect((await send({ anchor: CARD, mark: { kind: "comment" } })).status).toBe(400);
    expect((await send({ anchor: CARD, mark: { kind: "label", label: "verify" } })).status).toBe(
      200,
    );
  });

  test("an annotation without a mark, or with one of an unknown kind, is refused", async () => {
    const { send } = drafting();
    expect((await send({ anchor: CARD })).status).toBe(400);
    expect((await send({ anchor: CARD, mark: { kind: "shout", body: "x" } })).status).toBe(400);
  });

  test("decision round-trips over HTTP, and approve finalizes at once", async () => {
    const approve = await post("/api/decision", JSON.stringify(APPROVE));
    expect(approve.status).toBe(200);

    const channel = await fetch(url("/api/channel?after=0"), { headers: headers() });
    expect((await channel.json()).at(-1)).toMatchObject({
      entry: { kind: "approved", version: 1, dir: "plans/2026-09-15/routed-plan/", notes: null },
    });
  });
});

describe("the channel", () => {
  test("a batch sent is an entry naming its file, under the next number", async () => {
    const made = drafting();
    await made.send({ anchor: CARD, mark: BIGGER });
    await made.send({ anchor: CARD, mark: BIGGER });

    expect(await (await made.channel("1")).json()).toEqual([
      { seq: 2, entry: { kind: "sent", file: `${WIP}.review/v0.feedback-2.md` } },
    ]);
  });

  test("a number that is not a count of entries is a bad request", async () => {
    const made = drafting();

    for (const after of ["", "-1", "1.5", "x"]) {
      expect((await made.channel(after)).status, after).toBe(400);
    }
  });

  test("a line of the file that is no entry is left out, never answered in its place", async () => {
    const made = drafting();
    writeFileSync(join(made.dir, WIP, ".review/channel.jsonl"), "not json\n");
    await made.send({ anchor: CARD, mark: BIGGER });

    expect(await (await made.channel("0")).json()).toEqual([
      { seq: 2, entry: { kind: "sent", file: `${WIP}.review/v0.feedback-1.md` } },
    ]);
  });
});
