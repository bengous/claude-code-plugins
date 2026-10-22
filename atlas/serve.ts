/* oxlint-disable anti-slop/no-runtime-typeof -- isBundle and isReply ARE the boundary parsers of what a dynamic import answers and what the page posts: there is no earlier place to narrow them. */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HTMLBundle } from "bun";

import live from "./plan.fr.html";

// Serves the plan and its drafts (drafts/<name>/, a copy of this folder)
// over HTTP. Each page is an HTML import: Bun bundles its TypeScript on
// request, and in development mode reloads the open tab when a source
// changes. libavoid.wasm is answered next to each page, from the installed
// libavoid-js package: avoid.ts fetches it by that relative URL. threads.json
// is served the same way, from the page's own folder; a POST to the live
// /threads.json ({ id, text }) adds the human's reply through reply.ts and
// answers the updated threads. A draft's threads are read-only from its page.
// Run: bun atlas/serve.ts [port]
const DIR = import.meta.dir;

const DRAFTS = join(DIR, "drafts");

const PAGE = "plan.fr.html";

const WASM = "libavoid.wasm";

// The package's exports list only its entry point, so the WebAssembly is
// found beside that entry, never copied into this folder.
const WASM_FILE = join(dirname(Bun.resolveSync("libavoid-js", DIR)), WASM);

const DRAFT_PAGE = /^\/drafts\/([a-z0-9][a-z0-9-]*)\/plan\.fr\.html$/u;

const THREADS = "threads.json";

const DRAFT_FILE = /^\/drafts\/([a-z0-9][a-z0-9-]*)\/(libavoid\.wasm|threads\.json)$/u;

const port = Number(process.argv[2] ?? 8765);

function isBundle(module: unknown): module is { default: HTMLBundle } {
  return typeof module === "object" && module !== null && "default" in module;
}

async function draftPage(name: string): Promise<[string, HTMLBundle]> {
  const module: unknown = await import(join(DRAFTS, name, PAGE));

  if (!isBundle(module)) {
    throw new TypeError(`drafts/${name}/${PAGE} is not an HTML import`);
  }

  return [`/drafts/${name}/${PAGE}`, module.default];
}

// The live page and every draft that exists now; a draft created later is
// added by fetch() on its first request.
async function pages(): Promise<Map<string, HTMLBundle>> {
  const names = existsSync(DRAFTS)
    ? readdirSync(DRAFTS).filter((n) => existsSync(join(DRAFTS, n, PAGE)))
    : [];

  return new Map([[`/${PAGE}`, live], ...(await Promise.all(names.map((n) => draftPage(n))))]);
}

function staticFile(path: string): string | null {
  if (path === `/${WASM}`) {
    return WASM_FILE;
  }

  if (path === `/${THREADS}`) {
    return join(DIR, THREADS);
  }

  const draft = DRAFT_FILE.exec(path);
  const name = draft?.[1];
  const file = draft?.[2];

  if (name === undefined || file === undefined) {
    return null;
  }

  return file === WASM && existsSync(join(DRAFTS, name)) ? WASM_FILE : join(DRAFTS, name, file);
}

const isReply = (v: unknown): v is { readonly id: string; readonly text: string } =>
  typeof v === "object" &&
  v !== null &&
  "id" in v &&
  typeof v.id === "string" &&
  "text" in v &&
  typeof v.text === "string";

// FIXME: no Origin, content-type or token check: any page open in the browser can POST a
// text/plain body here, which a browser sends cross-origin without a preflight, and write into a
// thread as human.
async function reply(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isReply(body)) {
    return new Response('expected JSON { "id": <open id>, "text": <reply> }', { status: 400 });
  }

  const run = Bun.spawn(
    [process.execPath, join(DIR, "reply.ts"), body.id, "--as", "human", body.text],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );

  const [code, error] = await Promise.all([run.exited, new Response(run.stderr).text()]);

  if (code !== 0) {
    return new Response(error.trim(), { status: 400 });
  }

  return new Response(Bun.file(join(DIR, THREADS)), {
    headers: { "content-type": "application/json" },
  });
}

async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/") {
    return Response.redirect(`/${PAGE}`, 302);
  }

  const draft = DRAFT_PAGE.exec(path)?.[1];

  if (draft !== undefined && existsSync(join(DRAFTS, draft, PAGE))) {
    server.reload({ routes: Object.fromEntries(await pages()), fetch: handle });

    return Response.redirect(path, 307);
  }

  if (path === `/${THREADS}` && request.method === "POST") {
    return reply(request);
  }

  const file = staticFile(path);

  if (file !== null && existsSync(file)) {
    return request.method === "GET"
      ? new Response(Bun.file(file), { headers: { "cache-control": "no-store" } })
      : new Response("read-only here: a draft takes replies through its own reply.ts", {
          status: 405,
        });
  }

  return new Response("not found", { status: 404 });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: true,
  routes: Object.fromEntries(await pages()),
  fetch: handle,
});

console.log(`${server.url.href}${PAGE}`);
