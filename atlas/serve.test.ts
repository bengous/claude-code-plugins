import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MAP_FILE, THREADS_FILE } from "./folder.ts";
import { TOKEN_HEADER, TOKEN_META } from "./threads.ts";

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

const WAIT_MS = 10_000;

type Page = { readonly status: number; readonly html: string; readonly script: string };

let dir = "";

let server: ReturnType<typeof Bun.spawn> | undefined;

let base = "";

let original = "";

let announced = "";

let nextEvent: (name: string) => Promise<string> = () => Promise.reject(new Error("no stream"));

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no ${what} within ${WAIT_MS} ms`));
    }, WAIT_MS);
  });

  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

// The server's first stdout line is its address; the rest of its output is drained, never read.
async function readyLine(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (!text.includes("\n")) {
    const { value, done } = await reader.read();

    if (done) {
      throw new Error(`the server exited before its ready line: ${text}`);
    }

    text += decoder.decode(value, { stream: true });
  }

  void (async () => {
    while (!(await reader.read()).done) {
      // drained
    }
  })();

  return text.slice(0, text.indexOf("\n"));
}

function eventsOf(body: ReadableStream<Uint8Array>): (name: string) => Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return async (name) => {
    for (;;) {
      const end = buffer.indexOf("\n\n");

      if (end === -1) {
        const { value, done } = await reader.read();

        if (done) {
          throw new Error("the event stream closed");
        }

        buffer += decoder.decode(value, { stream: true });
        continue;
      }

      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);

      if (/^event: (.*)$/mu.exec(block)?.[1] === name) {
        return /^data: ?(.*)$/mu.exec(block)?.[1] ?? "";
      }
    }
  };
}

async function page(): Promise<Page> {
  const response = await fetch(`${base}/plan.fr.html`);
  const html = await response.text();
  const src = /<script type="module"[^>]* src="\.\/([^"]+)"/u.exec(html)?.[1];
  const script = src === undefined ? "" : await (await fetch(`${base}/${src}`)).text();

  return { status: response.status, html, script };
}

// Waits through reloads until the page shows what the test saved: a save may reach the watch as
// more than one event, each rebuild followed by a reload.
async function reloadedTo(shows: (p: Page) => boolean): Promise<Page> {
  for (;;) {
    await within(nextEvent("reload"), "reload");
    const p = await page();

    if (shows(p)) {
      return p;
    }
  }
}

function saveAtomically(file: string, text: string): void {
  const temporary = join(dirname(file), `.${MAP_FILE}.${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

const token = (html: string): string =>
  new RegExp(`<meta name="${TOKEN_META}" content="([^"]+)">`, "u").exec(html)?.[1] ?? "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-serve-"));
  cpSync(SAMPLE, dir, { recursive: true });
  original = await Bun.file(join(dir, MAP_FILE)).text();

  server = Bun.spawn([process.execPath, join(import.meta.dir, "serve.ts"), dir, "0"], {
    stdout: "pipe",
    stderr: "ignore",
  });

  if (!(server.stdout instanceof ReadableStream)) {
    throw new TypeError("the server's stdout is not piped");
  }

  base = new URL(await within(readyLine(server.stdout), "ready line")).origin;
  const events = await fetch(`${base}/events`);

  if (events.body === null) {
    throw new Error("the event stream has no body");
  }

  nextEvent = eventsOf(events.body);
  announced = await within(nextEvent("server"), "server event");
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  rmSync(dir, { recursive: true, force: true });
});

describe("serve.ts", () => {
  test("serves a map folder that sits outside the plugin, with no package.json", async () => {
    expect(dir.startsWith(import.meta.dir)).toBe(false);
    expect(await Bun.file(join(dir, "package.json")).exists()).toBe(false);

    const p = await page();

    expect(p.status).toBe(200);
    expect(p.script).toContain("Nightly backup");
  });

  test("writes its token into the page and names it first on the event stream", async () => {
    const written = token((await page()).html);

    expect(written).not.toBe("");
    expect(announced).toBe(written);
  });

  test("answers libavoid.wasm from the installed package", async () => {
    const response = await fetch(`${base}/libavoid.wasm`);

    const installed = join(
      dirname(Bun.resolveSync("libavoid-js", import.meta.dir)),
      "libavoid.wasm",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(await response.bytes()).toEqual(await Bun.file(installed).bytes());
  });

  test(
    "an atomic save of the data is rebuilt and reloads the page",
    async () => {
      saveAtomically(join(dir, MAP_FILE), original.replace("Nightly backup", "Weekly backup"));
      const changed = await reloadedTo((p) => p.script.includes("Weekly backup"));

      expect(changed.status).toBe(200);

      saveAtomically(join(dir, MAP_FILE), original);
      await reloadedTo((p) => p.script.includes("Nightly backup"));
    },
    WAIT_MS * 3,
  );

  test(
    "a build error shows its file and line, and the next good save recovers",
    async () => {
      const lines = original.split("\n");
      const at = lines.findIndex((l) => l.includes('title: "Bookshop",'));
      lines[at] = '    title: "Bookshop" "broken",';
      saveAtomically(join(dir, MAP_FILE), lines.join("\n"));
      const broken = await reloadedTo((p) => p.status === 500);

      expect(broken.html).toContain(`${join(dir, MAP_FILE)}:${at + 1}:`);

      saveAtomically(join(dir, MAP_FILE), original);
      const fixed = await reloadedTo((p) => p.status === 200);

      expect(fixed.script).toContain("Nightly backup");
    },
    WAIT_MS * 3,
  );

  test(
    "data the engine cannot draw shows why, and the next good save recovers",
    async () => {
      saveAtomically(join(dir, MAP_FILE), original.replace('id: "catalog"', 'id: "web"'));
      const refused = await reloadedTo((p) => p.status === 500);

      expect(refused.html).toContain("node web: a second node has this id");

      saveAtomically(join(dir, MAP_FILE), original);
      await reloadedTo((p) => p.status === 200);
    },
    WAIT_MS * 3,
  );
});

const post = async (headers: Record<string, string>): Promise<Response> =>
  await fetch(`${base}/${THREADS_FILE}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "backup-restore-untested", text: "A restore was tried." }),
  });

// What the page sends: the browser sets its Origin, and the page adds the token it was served.
const own = async (): Promise<Record<string, string>> => ({
  origin: base,
  "content-type": "application/json",
  [TOKEN_HEADER]: token((await page()).html),
});

const threads = async (): Promise<string> => await Bun.file(join(dir, THREADS_FILE)).text();

describe("a reply posted to threads.json", () => {
  test("from another origin is refused, and threads.json is left as it was", async () => {
    const before = await threads();
    const response = await post({ ...(await own()), origin: "http://elsewhere.example" });

    expect(response.status).toBe(403);
    expect(await threads()).toBe(before);
  });

  test("without this server's token is refused", async () => {
    const before = await threads();
    const { [TOKEN_HEADER]: _, ...untokened } = await own();

    expect((await post(untokened)).status).toBe(403);
    expect((await post({ ...untokened, [TOKEN_HEADER]: crypto.randomUUID() })).status).toBe(403);
    expect(await threads()).toBe(before);
  });

  test("as text/plain, which a browser sends cross-origin unasked, is refused", async () => {
    const before = await threads();
    const response = await post({ ...(await own()), "content-type": "text/plain" });

    expect(response.status).toBe(415);
    expect(await threads()).toBe(before);
  });

  test("from the page, with its origin and token, is written to the folder", async () => {
    const response = await post(await own());

    expect(response.status).toBe(200);

    const answered: unknown = await response.json();

    expect(answered).toEqual(JSON.parse(await threads()));
    expect(answered).toMatchObject({
      "backup-restore-untested": [
        { who: "agent", text: "The dump runs each night; no restore from it was ever measured." },
        { who: "human", text: "A restore was tried." },
      ],
    });
  });
});
