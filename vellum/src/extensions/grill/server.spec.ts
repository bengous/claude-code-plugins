import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../../core/server/adapters/http/serve.ts";
import type { Started } from "../../core/server/adapters/http/serve.ts";
import { parseWipDir } from "../../core/server/domain/paths.ts";
import type { GrillPosts, Opened } from "./protocol.ts";
import { toHtml } from "./server.ts";

const WIP = "plans/2026-09-17/wip-c95eaf71/";

const NOTE = {
  id: "a",
  doc: `${WIP}plan.md`,
  anchor: { kind: "global" },
  mark: { kind: "comment", body: "no" },
};

const HELD = "grill-1.md is open: the plan is submitted once the reviewer ends it";

const running: Started[] = [];

type Grilling = {
  readonly dir: string;
  readonly get: (name: string) => Promise<Response>;
  /** `POST /api/gate`, then `POST /api/decision` with an approval: the two calls the core takes. */
  readonly gate: () => Promise<Response>;
  readonly approve: () => Promise<Response>;
  readonly feedback: () => Promise<Response>;
  readonly view: () => Promise<{ readonly held: string | null }>;
  readonly post: <Name extends keyof GrillPosts>(
    name: Name,
    body: GrillPosts[Name],
  ) => Promise<Response>;
};

/** A server on a fresh working directory, its grill routes behind the token. */
async function grilling(): Promise<Grilling> {
  const dir = mkdtempSync(join(tmpdir(), "vellum-grill-"));
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);
  const started = await startServer({ project: dir, workdir: workdir.value, port: 0 });
  running.push(started);
  const headers = { "x-vellum-token": started.token, "content-type": "application/json" };

  const url = (name: string): string =>
    `http://127.0.0.1:${started.server.port}/api/x/grill/${name}`;

  const core = (path: string, body: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${started.server.port}/api/${path}`, { method: "POST", headers, body });

  return {
    dir,
    gate: () => core("gate", "{}"),
    approve: () => core("decision", JSON.stringify({ kind: "approve", edit: null, notes: "" })),
    feedback: () =>
      core("decision", JSON.stringify({ kind: "feedback", edit: null, annotations: [NOTE] })),
    view: async () =>
      // SAFETY: the server's own `ReviewView`, serialized by `Response.json` in routes.ts.
      (await (
        await fetch(`http://127.0.0.1:${started.server.port}/api/review`, { headers })
      ).json()) as { readonly held: string | null },
    get: (name) => fetch(url(name), { headers }),
    post: (name, body) => fetch(url(name), { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

afterEach(() => {
  for (const started of running.splice(0)) started.stop();
});

describe("opening a grill", () => {
  test("writes grill-1.md, its header alone: the subject is the reviewer's gesture", async () => {
    const { dir, post, get } = await grilling();

    const opened = await post("open", { subject: "auth" });

    expect(opened.status).toBe(201);
    expect(await opened.json()).toEqual({ file: `${WIP}grill-1.md` });
    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toMatch(
      /^# Grill: auth\n\nStarted .+ · session c95eaf71\n$/u,
    );
    expect(await (await get("state")).json()).toMatchObject({ kind: "open", phase: "working" });
  });

  test("the state hands the engine the opening, until its cursor is past it", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });
    const opening = { kind: "opened", seq: 0, name: "grill-1.md", subject: "auth" };

    expect(await (await get("state")).json()).toMatchObject({ relays: [opening] });
    expect(await (await get("state?after=0&file=grill-1.md")).json()).toMatchObject({ relays: [] });
  });

  test("a cursor kept for another file counts for nothing", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });
    await post("close", { reason: "stop" });
    await post("open", { subject: "again" });

    expect(await (await get("state?after=4&file=grill-1.md")).json()).toMatchObject({
      relays: [{ kind: "opened", seq: 0, name: "grill-2.md", subject: "again" }],
    });
  });

  test("the reply to `open` is an `Opened`: the file, and nothing of the grill's state", async () => {
    const { post } = await grilling();

    const opened: Opened = await (await post("open", { subject: "auth" })).json();

    // @ts-expect-error -- `subject` and `phase` cross `GET state`, never the reply to `open`.
    expect(opened.subject).toBeUndefined();
  });

  test("a second grill is refused while one is open, and takes the next number after it", async () => {
    const { dir, post } = await grilling();
    await post("open", { subject: "auth" });

    expect((await post("open", { subject: "again" })).status).toBe(409);
    await post("close", { reason: "page" });
    expect((await post("open", { subject: "again" })).status).toBe(201);
    expect(existsSync(join(dir, WIP, "grill-2.md"))).toBe(true);
  });

  test("an empty subject is a bad request", async () => {
    const { post } = await grilling();

    expect((await post("open", { subject: " " })).status).toBe(400);
  });

  test("no token, no route", async () => {
    const { get } = await grilling();
    const bare = await fetch((await get("state")).url);

    expect(bare.status).toBe(401);
  });
});

describe("a suggestion", () => {
  const IDEA = { subject: "auth", reason: "three choices change the contract" };

  test("is kept for the page until a grill opens", async () => {
    const { post, get } = await grilling();

    expect((await post("suggest", IDEA)).status).toBe(204);
    expect(await (await get("state")).json()).toMatchObject({ kind: "none", suggestion: IDEA });
    await post("open", { subject: "auth" });
    await post("close", { reason: "page" });
    expect(await (await get("state")).json()).toMatchObject({ kind: "none", suggestion: null });
  });

  test("is refused while a grill is open, and without a reason", async () => {
    const { post } = await grilling();

    expect((await post("suggest", { ...IDEA, reason: "" })).status).toBe(400);
    await post("open", { subject: "auth" });
    expect(await (await post("suggest", IDEA)).json()).toEqual({ error: "grill-1.md is open" });
  });
});

describe("a round", () => {
  const Q = [["Tool names", "Prefix them?", "I recommend yes."]] as const;

  test("ask opens a round under Claude's voice and answers the questions' numbers", async () => {
    const { dir, post, get } = await grilling();
    await post("open", { subject: "auth" });

    const asked = await post("ask", { q: [...Q, ...Q] });

    expect(await asked.json()).toEqual({ first: 1, last: 2 });
    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toContain(
      "## Round 1\n\n### Claude\n\n❓ **Q1** - **Tool names**: Prefix them?\n\n➡️ I recommend yes.\n\n---\n",
    );
    expect(await (await get("state")).json()).toMatchObject({ phase: "waiting" });
  });

  test("reply closes every open question, the empty ones by default, and hands the engine the text", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });
    await post("ask", { q: [...Q, ...Q] });

    expect((await post("reply", { answers: [{ id: "Q2", text: "no" }], note: "" })).status).toBe(
      204,
    );
    expect(await (await get("state?after=0&file=grill-1.md")).json()).toMatchObject({
      phase: "working",
      relays: [{ kind: "reply", seq: 1, text: "Reviewer: Q2: no" }],
    });
  });

  test("a session command lands between the ask and the reply, and the round still takes it", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });
    await post("ask", { q: Q });
    await post("event", { command: "/vellum:start" });
    await post("answer", { text: "Welcome back.", reason: "answer", own: false });

    expect((await post("reply", { answers: [{ id: "Q1", text: "yes" }], note: "" })).status).toBe(
      204,
    );
    const blocks = await get(`blocks?file=${WIP}grill-1.md`);
    expect(await blocks.json()).toContainEqual(
      expect.objectContaining({ id: "Q1", answer: "yes" }),
    );
  });

  test("reply is refused with nothing to say, and with no grill open", async () => {
    const { post } = await grilling();

    expect((await post("reply", { answers: [], note: "x" })).status).toBe(409);
    await post("open", { subject: "auth" });
    expect((await post("reply", { answers: [], note: " " })).status).toBe(409);
    expect((await post("ask", { q: [] })).status).toBe(400);
  });
});

describe("what the transcript keeps", () => {
  test("Claude's text under the opening, a session command as an event, in the order they came", async () => {
    const { dir, post } = await grilling();
    await post("open", { subject: "auth" });

    await Promise.all([
      post("answer", { text: "Two facts first.", reason: "answer", own: true }),
      post("event", { command: "/compact" }),
    ]);

    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toEndWith(
      "### Claude\n\nTwo facts first.\n\n_(session: /compact)_\n",
    );
  });

  test("with no grill open nothing is written", async () => {
    const { dir, post } = await grilling();

    expect((await post("event", { command: "/clear" })).status).toBe(204);
    expect((await post("answer", { text: "hi", reason: "answer", own: true })).status).toBe(204);
    expect(existsSync(join(dir, WIP, "grill-1.md"))).toBe(false);
  });
});

describe("closing a grill", () => {
  test("writes the footer with its reason, and the state reads none", async () => {
    const { dir, post, get } = await grilling();
    await post("open", { subject: "auth" });

    expect((await post("close", { reason: "page" })).status).toBe(204);
    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toMatch(/\nClosed .+ · page\n$/u);
    expect(await (await get("state?after=0&file=grill-1.md")).json()).toEqual({
      kind: "none",
      suggestion: null,
      relays: [{ kind: "ended", seq: 1, name: "grill-1.md" }],
    });
  });

  test("a question still open takes the recommendation by default, above the footer", async () => {
    const { dir, post } = await grilling();
    await post("open", { subject: "auth" });
    await post("ask", { q: [["Tool names", "Prefix them?", "I recommend yes."]] });
    await post("close", { reason: "page" });

    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toMatch(
      /### Reviewer\n\nQ1: As recommended, by default\.\n\n---\n\nClosed .+ · page\n$/u,
    );
  });

  test("with none open it answers 204 and writes nothing", async () => {
    const { dir, post } = await grilling();

    expect((await post("close", { reason: "stop" })).status).toBe(204);
    expect(existsSync(join(dir, WIP, "grill-1.md"))).toBe(false);
  });
});

describe("an open grill holds the review", () => {
  test("a gate is refused with the file's name, at the turn's end and from submit alike", async () => {
    const { dir, post, gate, view } = await grilling();
    writeFileSync(join(dir, WIP, "plan.md"), "# Auth plan\n");
    await post("open", { subject: "auth" });
    const refused = await gate();

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: HELD });
    expect(existsSync(join(dir, WIP, ".review/v1.md"))).toBe(false);
    expect((await view()).held).toBe("grill-1.md is open");
  });

  test("a drafting comment and a feedback are refused, until the reviewer ends the grill", async () => {
    const { dir, post, gate, feedback, view } = await grilling();
    writeFileSync(join(dir, WIP, "plan.md"), "# Auth plan\n");
    await post("open", { subject: "auth" });

    expect((await feedback()).status, "drafting").toBe(409);
    await post("close", { reason: "page" });
    await gate();
    await post("open", { subject: "again" });

    expect((await feedback()).status, "under review").toBe(409);
    await post("close", { reason: "page" });

    expect((await view()).held).toBeNull();
    expect((await feedback()).status).toBe(200);
  });

  test("a gate and an open launched together never leave a version the grill did not see", async () => {
    const { dir, post, gate } = await grilling();
    writeFileSync(join(dir, WIP, "plan.md"), "# Auth plan\n");
    const [opened, gated] = await Promise.all([post("open", { subject: "auth" }), gate()]);

    expect(opened.status).toBe(201);
    expect(existsSync(join(dir, WIP, ".review/v1.md"))).toBe(gated.status === 200);
  });
});

describe("the approval", () => {
  test("with no module alive, the server ends the grill: defaults and the footer, in the renamed directory", async () => {
    const { dir, post, gate, approve } = await grilling();
    writeFileSync(join(dir, WIP, "plan.md"), "# Auth plan\n");
    await gate();
    await post("open", { subject: "auth" });
    await post("ask", { q: [["Store", "Which store?", "Redis"]] });

    expect((await approve()).status).toBe(200);
    expect(readdirSync(join(dir, "plans/2026-09-17"))).toEqual(["auth-plan"]);
    expect(readFileSync(join(dir, "plans/2026-09-17/auth-plan/grill-1.md"), "utf8")).toMatch(
      /Q1: As recommended, by default\.\n\n---\n\nClosed .+ · approved\n$/u,
    );
  });

  test("`approved` is the server's reason alone: the close route refuses it", async () => {
    const { post } = await grilling();
    await post("open", { subject: "auth" });

    // @ts-expect-error -- the route's body names `page` and `stop` only.
    expect((await post("close", { reason: "approved" })).status).toBe(400);
  });

  test("no grill opens on an approved plan", async () => {
    const { dir, post, gate, approve } = await grilling();
    writeFileSync(join(dir, WIP, "plan.md"), "# Auth plan\n");
    await gate();
    await approve();

    expect((await post("open", { subject: "late" })).status).toBe(409);
  });
});

describe("the blocks the page draws", () => {
  test("the transcript comes rendered, under the name of a transcript alone", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });

    const blocks = await get(`blocks?file=${encodeURIComponent(`${WIP}grill-1.md`)}`);

    expect(await blocks.json()).toEqual([
      { kind: "html", html: expect.stringContaining("<h1>Grill: auth</h1>") },
    ]);
    expect((await get("blocks?file=../../../etc/passwd")).status).toBe(404);
    expect((await get("blocks?file=grill-9.md")).status).toBe(404);
  });

  test("raw HTML stays text and a link that would run code is cut", () => {
    const html = toHtml(
      "<script>x</script>\n\n[a](javascript:alert(1)) [b](https://x.dev) [c](./d.md)",
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain('<a href="#">a</a>');
    expect(html).toContain('href="https://x.dev"');
    expect(html).toContain('href="./d.md"');
  });
});

describe("names and cursors from outside", () => {
  test("a transcript named with a leading zero is not one, so it hides no open grill", async () => {
    const { dir, post, get } = await grilling();
    await post("open", { subject: "auth" });
    writeFileSync(join(dir, WIP, "grill-02.md"), "# Grill: stray\n");

    expect(await (await get("state")).json()).toMatchObject({
      kind: "open",
      file: `${WIP}grill-1.md`,
    });
  });

  test("an empty cursor is no cursor: the opening is still due", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });

    expect(await (await get("state?after=&file=grill-1.md")).json()).toMatchObject({
      relays: [{ kind: "opened", seq: 0 }],
    });
  });

  test("with the plan's directory gone the routes refuse, they do not fail", async () => {
    const { dir, get, post } = await grilling();
    renameSync(join(dir, WIP), join(dir, "plans/2026-09-17/elsewhere"));

    expect((await get("state")).status).toBeLessThan(500);
    expect((await post("ask", { q: [["T", "A?", "R"]] })).status).toBe(409);
  });
});
