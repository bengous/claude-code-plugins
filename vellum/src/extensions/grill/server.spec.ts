import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../../core/server/adapters/http/serve.ts";
import type { Started } from "../../core/server/adapters/http/serve.ts";
import { parseWipDir } from "../../core/server/domain/paths.ts";
import type { GrillPosts } from "./protocol.ts";
import { toHtml } from "./server.ts";

const WIP = "plans/2026-09-17/wip-c95eaf71/";

const running: Started[] = [];

type Grilling = {
  readonly dir: string;
  readonly get: (name: string) => Promise<Response>;
  /** Gates `plan.md` as v1 and approves it: the working directory is renamed. */
  readonly decide: () => Promise<void>;
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
    decide: async () => {
      await core("gate", "{}");
      await core("decision", JSON.stringify({ kind: "approve", edit: null, notes: "" }));
    },
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

  test("the state names the opening for the engine to relay", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });

    expect(await (await get("state")).json()).toMatchObject({
      subject: "auth",
      reviewer: { file: `${WIP}grill-1.md`, round: 0, text: "" },
    });
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
    expect(await (await get("state")).json()).toMatchObject({ phase: "waiting", reviewer: null });
  });

  test("reply closes every open question, the empty ones by default, and hands the engine the text", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });
    await post("ask", { q: [...Q, ...Q] });

    expect((await post("reply", { answers: [{ id: "Q2", text: "no" }], note: "" })).status).toBe(
      204,
    );
    expect(await (await get("state")).json()).toMatchObject({
      phase: "working",
      reviewer: { round: 1, text: "Q1: As recommended, by default.\n\nQ2: no" },
    });
  });

  test("a session command lands between the ask and the reply, and the round still takes it", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });
    await post("ask", { q: Q });
    await post("event", { command: "/vellum:start" });
    await post("answer", { text: "Welcome back.", reason: "answer" });

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
      post("answer", { text: "Two facts first.", reason: "answer" }),
      post("event", { command: "/compact" }),
    ]);

    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toEndWith(
      "### Claude\n\nTwo facts first.\n\n_(session: /compact)_\n",
    );
  });

  test("with no grill open nothing is written", async () => {
    const { dir, post } = await grilling();

    expect((await post("event", { command: "/clear" })).status).toBe(204);
    expect((await post("answer", { text: "hi", reason: "answer" })).status).toBe(204);
    expect(existsSync(join(dir, WIP, "grill-1.md"))).toBe(false);
  });
});

describe("closing a grill", () => {
  test("writes the footer with its reason, and the state reads none", async () => {
    const { dir, post, get } = await grilling();
    await post("open", { subject: "auth" });

    expect((await post("close", { reason: "page" })).status).toBe(204);
    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toMatch(/\nClosed .+ · page\n$/u);
    expect(await (await get("state")).json()).toEqual({
      kind: "none",
      suggestion: null,
      closed: { file: `${WIP}grill-1.md`, reason: "page" },
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

describe("after the approval", () => {
  test("close writes the footer in the renamed directory, and brings no wip- back", async () => {
    const { dir, post, decide } = await grilling();
    await post("open", { subject: "auth" });
    writeFileSync(join(dir, WIP, "plan.md"), "# Auth plan\n");
    await decide();

    expect((await post("close", { reason: "approved" })).status).toBe(204);
    expect(readdirSync(join(dir, "plans/2026-09-17"))).toEqual(["auth-plan"]);
    expect(readFileSync(join(dir, "plans/2026-09-17/auth-plan/grill-1.md"), "utf8")).toMatch(
      /\nClosed .+ · approved\n$/u,
    );
  });

  test("no grill opens on an approved plan", async () => {
    const { dir, post, decide } = await grilling();
    writeFileSync(join(dir, WIP, "plan.md"), "# Auth plan\n");
    await decide();

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
