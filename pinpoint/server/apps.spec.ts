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

describe("probing", () => {
  test("keeps the ports answering HTML, with their titles, in the ports' order", async () => {
    const shop = answering("text/html", "<html><head><title> Shop </title></head></html>");
    const bare = answering("text/html; charset=utf-8", "<p>no title</p>");
    const api = answering("application/json", '{"ok":true}');
    const ports = [bare, api, silent(), await refusing(), shop];
    const started = performance.now();
    const found = await probe(ports, 0, 300);

    expect(found).toEqual([
      { url: `http://localhost:${bare}/`, title: "" },
      { url: `http://localhost:${shop}/`, title: "Shop" },
    ]);
    expect(performance.now() - started).toBeLessThan(1_000);
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
        { url: "http://localhost:3000/", title: `<b>"Shop" & co</b>` },
        { url: "http://localhost:5173/", title: "" },
      ],
      null,
      "",
    );

    expect(page).toContain(
      '<span class="name">&lt;b&gt;&quot;Shop&quot; &amp; co&lt;/b&gt;</span><span class="address">http://localhost:3000/</span>',
    );
    expect(page).toContain('<span class="name">localhost:5173</span>');
    expect(page.match(/action="\/t\/tok\/pick"/gu)).toHaveLength(3);
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
