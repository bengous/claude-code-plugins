/* oxlint-disable anti-slop/no-runtime-typeof -- isReply IS the boundary parser of what the page posts: there is no earlier place to narrow it. */
import { statSync, watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { BuildArtifact, BunPlugin, Server } from "bun";

import { coalesced } from "./coalesce.ts";
import { CONFIG_FILE, MAP_FILE, THREADS_FILE } from "./folder.ts";
import { TOKEN_HEADER, TOKEN_META } from "./threads.ts";

// Serves the page of one map folder:
//   bun atlas/serve.ts <map folder> [port]   prints the page's address once it listens; port 0 or
//                                            none takes a free one
// Bun.build bundles the page, atlas:map and atlas:config resolved to the folder's files, and the
// server answers the outputs from memory. A save in the folder or in the page's sources rebuilds it
// and reloads every open tab through a server-sent event. A failed build, or data the engine
// cannot draw, answers an error page instead, which reloads on the next save.
const DIR = import.meta.dir;

const PAGE = "plan.fr.html";

const EVENTS = "/events";

const SETTLE_MS = 50;

// The package's exports list only its entry point, so the WebAssembly is found beside that entry,
// never copied into this folder.
const WASM_FILE = join(dirname(Bun.resolveSync("libavoid-js", DIR)), "libavoid.wasm");

// html: the page as built, which names its chunks by the hash of their content.
type Bundle =
  | {
      readonly kind: "ok";
      readonly html: string;
      readonly files: ReadonlyMap<string, BuildArtifact>;
    }
  | { readonly kind: "error"; readonly message: string };

const same = (a: Bundle, b: Bundle): boolean =>
  a.kind === "ok"
    ? b.kind === "ok" && a.html === b.html
    : b.kind === "error" && a.message === b.message;

const USAGE = "usage: bun serve.ts <map folder> [port]";

const [dirArg, portArg = "0", ...extra] = process.argv.slice(2);

if (dirArg === undefined || extra.length > 0 || !/^\d+$/u.test(portArg)) {
  console.error(USAGE);
  process.exit(1);
}

const folder = resolve(dirArg);

if (statSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) {
  console.error(`serve: ${folder} is not a folder\n${USAGE}`);
  process.exit(1);
}

// Written into every page this server answers: a reply without it is refused, so another page open
// in the browser cannot write into a thread.
const token = crypto.randomUUID();

const mapResolver: BunPlugin = {
  name: "atlas-map",
  setup(build) {
    build.onResolve({ filter: /^atlas:(?:map|config)$/u }, ({ path }) => ({
      path: join(folder, path === "atlas:map" ? MAP_FILE : CONFIG_FILE),
    }));
  },
};

// `String(log)` drops where the error is; its position keeps the file, the line and the column. A
// file that is missing has a position with line and column -1, and no line to show.
function located(log: BuildMessage | ResolveMessage): string {
  const at = log.position;

  if (at === null) {
    return log.message;
  }

  return at.line < 0
    ? `${at.file}: ${log.message}`
    : `${at.file}:${at.line}:${at.column}: ${log.message}\n    ${at.lineText}`;
}

async function bundle(): Promise<Bundle> {
  const built = await Bun.build({
    entrypoints: [join(DIR, PAGE)],
    target: "browser",
    plugins: [mapResolver],
    throw: false,
  });

  if (!built.success) {
    return { kind: "error", message: built.logs.map(located).join("\n\n") };
  }

  const files = new Map(
    built.outputs.map((o): [string, BuildArtifact] => [`/${basename(o.path)}`, o]),
  );

  const html = files.get(`/${PAGE}`);

  if (html === undefined) {
    throw new Error(`the build has no ${PAGE}`);
  }

  return { kind: "ok", html: await html.text(), files };
}

// The page throws on data toPlan refuses, so the folder is loaded here first, in a fresh process:
// this one keeps the first evaluation of every module it imports.
async function drawable(): Promise<string | null> {
  const run = Bun.spawn([process.execPath, join(DIR, "folder.ts"), folder], {
    stdout: "ignore",
    stderr: "pipe",
  });

  const [code, error] = await Promise.all([run.exited, new Response(run.stderr).text()]);

  return code === 0 ? null : `the map in ${folder} cannot be drawn: ${error.trim()}`;
}

async function compile(): Promise<Bundle> {
  const [bundled, refusal] = await Promise.all([bundle(), drawable()]);

  return bundled.kind === "ok" && refusal !== null ? { kind: "error", message: refusal } : bundled;
}

let current = await compile();

if (current.kind === "error") {
  console.error(current.message);
}

const tabs = new Set<ReadableStreamDefaultController<string>>();

function tell(tab: ReadableStreamDefaultController<string>, event: string, data: string): void {
  try {
    tab.enqueue(`event: ${event}\ndata: ${data}\n\n`);
  } catch {
    // The tab closed before its stream was cancelled: it hears nothing more.
    tabs.delete(tab);
  }
}

// Appended to every page this server answers. A tab reloads on `reload`, and on a `server` event
// naming another token: the server it loaded from was replaced, and its token with it.
const LIVE = [
  `<meta name="${TOKEN_META}" content="${token}">`,
  "<script>{",
  `  const events = new EventSource("${EVENTS}");`,
  `  events.addEventListener("reload", () => location.reload());`,
  `  events.addEventListener("server", (e) => { if (e.data !== "${token}") location.reload(); });`,
  "}</script>",
].join("\n");

function events(request: Request, server: Server<undefined>): Response {
  server.timeout(request, 0);
  let mine: ReadableStreamDefaultController<string> | undefined;

  const stream = new ReadableStream<string>({
    start(controller) {
      mine = controller;
      tabs.add(controller);
      tell(controller, "server", token);
    },
    cancel() {
      if (mine !== undefined) {
        tabs.delete(mine);
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

// A tab reloads only when what it would load changed: a reload drops a reply being typed, and an
// editor's swap file or a regenerated atlas.d.ts changes nothing in the page.
async function rebuild(): Promise<void> {
  const started = performance.now();
  const next = await compile();
  const differs = !same(next, current);
  current = next;

  if (differs) {
    for (const tab of tabs) {
      tell(tab, "reload", "");
    }
  }

  const verdict = current.kind === "ok" ? "built" : "failed";
  const ms = Math.round(performance.now() - started);
  const outcome = differs ? `reload sent to ${tabs.size} tab(s)` : "page unchanged, no reload";
  console.log(`atlas: ${verdict} in ${ms} ms, ${outcome}`);

  if (differs && current.kind === "error") {
    console.error(current.message);
  }
}

let settle: ReturnType<typeof setTimeout> | undefined;

const rebuildSoon = coalesced(rebuild);

// threads.json changes on every reply, and the page reads it again by itself. An event on the
// watched folder itself, moved or deleted, comes with no file name (Bun 1.4.3): it rebuilds.
function changed(file: string | null | undefined): void {
  if (basename(file ?? "") === THREADS_FILE) {
    return;
  }

  clearTimeout(settle);
  settle = setTimeout(() => {
    void rebuildSoon();
  }, SETTLE_MS);
}

// A directory's watch survives an atomic save, a temporary file renamed over the old one; the
// page's sources sit at the top of this folder.
watch(folder, { recursive: true }, (_, file) => {
  changed(file);
});

watch(DIR, (_, file) => {
  changed(file);
});

function page(): Response {
  if (current.kind === "error") {
    const shown = `<!doctype html><meta charset="utf-8"><title>atlas: no map to show</title><pre>${Bun.escapeHTML(current.message)}</pre>`;

    return new Response(shown + LIVE, {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  return new Response(current.html + LIVE, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const isReply = (v: unknown): v is { readonly id: string; readonly text: string } =>
  typeof v === "object" &&
  v !== null &&
  "id" in v &&
  typeof v.id === "string" &&
  "text" in v &&
  typeof v.text === "string";

const isJson = (type: string | null): boolean =>
  type?.split(";")[0]?.trim().toLowerCase() === "application/json";

// The names this server answers to, with the port it listens on. A page on a name rebound to this
// machine is same-origin with the server: only the Host its requests name tells them apart.
const ownHosts = (): readonly string[] => [`127.0.0.1:${server.port}`, `localhost:${server.port}`];

const isOwnHost = (host: string | null): boolean => ownHosts().some((own) => host === own);

const isOwnOrigin = (origin: string | null): boolean =>
  ownHosts().some((own) => origin === `http://${own}`);

// A browser sends a cross-origin text/plain POST without asking first, so the content type, the
// Origin and the token are all required: a page elsewhere can set none of them to this server's.
async function reply(request: Request): Promise<Response> {
  if (!isOwnOrigin(request.headers.get("origin"))) {
    return new Response("a reply comes from this server's own page", { status: 403 });
  }

  if (request.headers.get(TOKEN_HEADER) !== token) {
    return new Response("a reply carries this server's token: reload the page", { status: 403 });
  }

  if (!isJson(request.headers.get("content-type"))) {
    return new Response("a reply is application/json", { status: 415 });
  }

  const body: unknown = await request.json().catch(() => null);

  if (!isReply(body)) {
    return new Response('expected JSON { "id": <open id>, "text": <reply> }', { status: 400 });
  }

  const run = Bun.spawn(
    [process.execPath, join(DIR, "reply.ts"), folder, body.id, "--as", "human", body.text],
    { stdout: "ignore", stderr: "pipe" },
  );

  const [code, error] = await Promise.all([run.exited, new Response(run.stderr).text()]);

  if (code !== 0) {
    return new Response(error.trim(), { status: 400 });
  }

  return new Response(Bun.file(join(folder, THREADS_FILE)), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function threads(): Promise<Response> {
  const file = Bun.file(join(folder, THREADS_FILE));

  return (await file.exists())
    ? new Response(file, { headers: { "cache-control": "no-store" } })
    : new Response(`no ${THREADS_FILE} in ${folder}`, { status: 404 });
}

function route(request: Request, server: Server<undefined>): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  const get = request.method === "GET";

  if (pathname === `/${THREADS_FILE}` && request.method === "POST") {
    return reply(request);
  }

  if (!get) {
    return new Response("method not allowed", { status: 405 });
  }

  switch (pathname) {
    case "/":
      return Response.redirect(`/${PAGE}`, 302);
    case `/${PAGE}`:
      return page();
    case EVENTS:
      return events(request, server);
    case "/libavoid.wasm":
      return new Response(Bun.file(WASM_FILE), { headers: { "cache-control": "no-store" } });
    case `/${THREADS_FILE}`:
      return threads();
    default: {
      const file = current.kind === "ok" ? current.files.get(pathname) : undefined;

      return file === undefined
        ? new Response("not found", { status: 404 })
        : new Response(file, {
            headers: { "content-type": file.type, "cache-control": "no-store" },
          });
    }
  }
}

// Every route sits behind the Host check, so a route added later cannot skip it.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(portArg),
  reusePort: false,
  fetch: (request, self) =>
    isOwnHost(request.headers.get("host"))
      ? route(request, self)
      : new Response("atlas answers requests to its own address only", { status: 403 }),
});

console.log(`${server.url.href}${PAGE}`);
