import { afterEach, describe, expect, test } from "bun:test";

import { pickPage, probe } from "./apps.ts";

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** A port that answers every request with `body` under `type`. */
function answering(type: string, body: string): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(body, { headers: { "content-type": type } }),
  });

  stops.push(() => void server.stop(true));

  return Number(server.port);
}

/** A port that takes the connection and never answers. */
function silent(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
  stops.push(() => listener.stop(true));

  return listener.port;
}

/** A port nothing listens on any more. */
async function refusing(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const { port } = server;
  await server.stop(true);

  return Number(port);
}

/** A port whose page sends its head at once, then holds the rest of its body for 3 s. */
function trickling(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: () =>
      new Response(
        new ReadableStream<string>({
          async start(controller) {
            controller.enqueue("<html><head><title>Trickle</title></head><body>");
            await Bun.sleep(3_000);
            controller.enqueue("</body></html>");
            controller.close();
          },
        }),
        { headers: { "content-type": "text/html" } },
      ),
  });

  stops.push(() => void server.stop(true));

  return Number(server.port);
}

describe("probing", () => {
  test("keeps the ports answering HTML, each with its page's first title, in the ports' order", async () => {
    const shop = answering(
      "text/html",
      "<html><head><title> Shop </title></head><body><svg><title>Cart</title></svg></body></html>",
    );

    const bare = answering("text/html; charset=utf-8", "<p>no title</p>");
    const api = answering("application/json", '{"ok":true}');
    const found = await probe([bare, api, await refusing(), shop], 0, 300);

    expect(found).toEqual([
      { kind: "answered", url: `http://localhost:${bare}/`, title: "" },
      { kind: "answered", url: `http://localhost:${shop}/`, title: "Shop" },
    ]);
  });

  test("offers a port that took the connection but did not answer in time as waiting", async () => {
    const port = silent();
    const started = performance.now();

    expect(await probe([port], 0, 300)).toEqual([
      { kind: "waiting", url: `http://localhost:${port}/` },
    ]);
    expect(performance.now() - started).toBeLessThan(800);
  });

  test("reads the title as it comes, not the rest of the page", async () => {
    const port = trickling();
    const started = performance.now();

    expect(await probe([port], 0, 1_000)).toEqual([
      { kind: "answered", url: `http://localhost:${port}/`, title: "Trickle" },
    ]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("skips the server's own port", async () => {
    const own = answering("text/html", "<title>pinpoint</title>");

    expect(await probe([own], own, 300)).toEqual([]);
  });
});

describe("the page", () => {
  test("offers each app by its title, or its address with none, and escapes what the app says", () => {
    const page = pickPage(
      "tok",
      [
        { kind: "answered", url: "http://localhost:3000/", title: `<b>"Shop" & co</b>` },
        { kind: "answered", url: "http://localhost:5173/", title: "" },
        { kind: "waiting", url: "http://localhost:4200/" },
      ],
      null,
      "",
    );

    expect(page).toContain(
      '<span class="name">&lt;b&gt;&quot;Shop&quot; &amp; co&lt;/b&gt;</span><span class="address">http://localhost:3000/</span>',
    );
    expect(page).toContain('<span class="name">localhost:5173</span>');
    expect(page).toContain(
      '<span class="name">localhost:4200</span><span class="address">http://localhost:4200/ · no answer within a second yet, maybe still starting</span>',
    );
    expect(page.match(/action="\/t\/tok\/pick"/gu)).toHaveLength(4);
  });

  test("with no app found says where it looked, and keeps the field", () => {
    const page = pickPage("tok", [], `"x" is not an http(s) address.`, "x");

    expect(page).toContain("No app answers on the usual dev ports (3000,");
    expect(page).toContain(
      '<p class="error" role="alert">&quot;x&quot; is not an http(s) address.</p>',
    );
    expect(page).toContain('value="x"');
  });
});
