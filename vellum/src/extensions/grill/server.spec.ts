import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

  return {
    dir,
    get: (name) => fetch(url(name), { headers }),
    post: (name, body) => fetch(url(name), { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

afterEach(() => {
  for (const started of running.splice(0)) started.stop();
});

describe("opening a grill", () => {
  test("writes grill-1.md with the reviewer's gesture as round 1", async () => {
    const { dir, post, get } = await grilling();

    const opened = await post("open", { subject: "auth" });

    expect(opened.status).toBe(201);
    expect(await opened.json()).toEqual({ file: `${WIP}grill-1.md` });
    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toEndWith(
      "· session c95eaf71\n\n## Round 1\n\n### Reviewer\n\nGrill me on: auth\n",
    );
    expect(await (await get("state")).json()).toMatchObject({ kind: "open", phase: "working" });
  });

  test("the state names the reviewer's round for the engine to relay", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });

    expect(await (await get("state")).json()).toMatchObject({
      subject: "auth",
      reviewer: { file: `${WIP}grill-1.md`, round: 1, text: "Grill me on: auth" },
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
    expect(await (await get("state")).json()).toEqual({ kind: "none", suggestion: IDEA });
    await post("open", { subject: "auth" });
    await post("close", { reason: "page" });
    expect(await (await get("state")).json()).toEqual({ kind: "none", suggestion: null });
  });

  test("is refused while a grill is open, and without a reason", async () => {
    const { post } = await grilling();

    expect((await post("suggest", { ...IDEA, reason: "" })).status).toBe(400);
    await post("open", { subject: "auth" });
    expect(await (await post("suggest", IDEA)).json()).toEqual({ error: "grill-1.md is open" });
  });
});

describe("a round", () => {
  const Q = [["Tool names", "Prefix them?", "Yes."]] as const;

  test("ask writes the questions under Claude's voice and answers their numbers", async () => {
    const { dir, post, get } = await grilling();
    await post("open", { subject: "auth" });

    const asked = await post("ask", { q: [...Q, ...Q] });

    expect(await asked.json()).toEqual({ first: 1, last: 2 });
    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toContain(
      "### Claude\n\n❓ **Q1** - **Tool names**: Prefix them?\n\n➡️ Yes.\n\n---\n",
    );
    expect(await (await get("state")).json()).toMatchObject({ phase: "waiting", reviewer: null });
  });

  test("reply writes the reviewer's round, which the state hands to the engine", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });
    await post("ask", { q: Q });

    expect((await post("reply", { text: "Q1: yes" })).status).toBe(204);
    expect(await (await get("state")).json()).toMatchObject({
      phase: "working",
      reviewer: { round: 2, text: "Q1: yes" },
    });
  });

  test("reply is refused while Claude works, and empty", async () => {
    const { post } = await grilling();
    await post("open", { subject: "auth" });

    expect((await post("reply", { text: "too early" })).status).toBe(409);
    expect((await post("reply", { text: " " })).status).toBe(400);
  });

  test("ask and reply are refused with no grill open", async () => {
    const { post } = await grilling();

    expect((await post("ask", { q: Q })).status).toBe(409);
    expect((await post("reply", { text: "x" })).status).toBe(409);
  });
});

describe("word for word", () => {
  test("a prompt and a final text are written in the order they came", async () => {
    const { dir, post } = await grilling();
    await post("open", { subject: "auth" });

    await Promise.all([
      post("answer", { text: "Two facts first.", reason: "answer" }),
      post("prompt", { author: "User", text: "go on" }),
    ]);

    expect(readFileSync(join(dir, WIP, "grill-1.md"), "utf8")).toEndWith(
      "### Claude\n\nTwo facts first.\n\n## Round 2\n\n### User\n\ngo on\n",
    );
  });

  test("with no grill open nothing is written", async () => {
    const { dir, post } = await grilling();

    expect((await post("prompt", { author: "User", text: "hello" })).status).toBe(204);
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
    expect(await (await get("state")).json()).toEqual({ kind: "none", suggestion: null });
  });

  test("with none open it answers 204 and writes nothing", async () => {
    const { dir, post } = await grilling();

    expect((await post("close", { reason: "stop" })).status).toBe(204);
    expect(existsSync(join(dir, WIP, "grill-1.md"))).toBe(false);
  });
});

describe("the blocks the page draws", () => {
  test("the transcript comes rendered, under the name of a transcript alone", async () => {
    const { post, get } = await grilling();
    await post("open", { subject: "auth" });

    const blocks = await get(`blocks?file=${encodeURIComponent(`${WIP}grill-1.md`)}`);

    expect(await blocks.json()).toEqual([
      { kind: "html", html: expect.stringContaining("<h3>Reviewer</h3>") },
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
