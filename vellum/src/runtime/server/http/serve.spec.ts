import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WipDir } from "../../../workshop/paths.ts";
import { parseWipDir } from "../../../workshop/paths.ts";
import type { ServerLine } from "../../protocol.ts";
import { EXIT_WORKDIR_GONE, startServer, WorkdirGone } from "./serve.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const CLI = join(import.meta.dir, "../cli.ts");

function wipDir(): WipDir {
  const parsed = parseWipDir(WIP);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}

/** A child's stdout, a line at a time. */
async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let tail = "";

  for await (const piece of stream) {
    const cut = `${tail}${decoder.decode(piece, { stream: true })}`.split("\n");
    tail = cut.pop() ?? "";
    yield* cut;
  }
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "vellum-serve-"));
  mkdirSync(join(root, WIP), { recursive: true });

  return root;
}

type HandClock = {
  readonly now: () => number;
  /** Sets the time, and answers once a check of the watchdog has read it. */
  readonly checkedAt: (ms: number) => Promise<void>;
};

/** The watchdog's time, moved by the test alone: a loaded runner stretches no window. */
function handClock(): HandClock {
  let time = 0;
  let read = Promise.withResolvers<void>();

  return {
    now: () => {
      read.resolve();

      return time;
    },
    checkedAt: (ms) => {
      time = ms;
      read = Promise.withResolvers<void>();

      return read.promise;
    },
  };
}

describe("the watchdog", () => {
  test("without a heartbeat the server holds while a stream is open, and expires once the last one closed", async () => {
    const { now, checkedAt } = handClock();
    const expired = Promise.withResolvers<void>();
    const expire = (): void => expired.resolve();
    const watchdog = { graceMs: 40, tabHoldMs: 10_000, periodMs: 1, now, expire };
    const started = await startServer({ project: project(), workdir: wipDir(), port: 0, watchdog });
    const tab = new AbortController();
    const stream = await fetch(`${started.url}events`, { signal: tab.signal });
    await stream.body?.getReader().read();
    await checkedAt(120);

    expect(Bun.peek.status(expired.promise), "a tab listens, past the grace").toBe("pending");
    tab.abort();
    await expired.promise;
    started.stop();
  });
});

describe("a server its module left", () => {
  test("a tab that still listens holds it for a while, not for good", async () => {
    const { now, checkedAt } = handClock();
    const expired = Promise.withResolvers<void>();
    const expire = (): void => expired.resolve();
    const watchdog = { graceMs: 20, tabHoldMs: 100, periodMs: 1, now, expire };
    const started = await startServer({ project: project(), workdir: wipDir(), port: 0, watchdog });
    const tab = new AbortController();
    const stream = await fetch(`${started.url}events`, { signal: tab.signal });
    await stream.body?.getReader().read();
    await checkedAt(60);

    expect(Bun.peek.status(expired.promise), "past the grace, the tab holds").toBe("pending");
    await checkedAt(180);
    tab.abort();
    started.stop();

    expect(Bun.peek.status(expired.promise), "past the tab's hold, nothing does").toBe("fulfilled");
  });
});

describe("the kept port and token", () => {
  test("a token handed over is the one the page is served under", async () => {
    const started = await startServer({
      project: project(),
      workdir: wipDir(),
      port: 0,
      token: "kept",
    });

    const { port } = started.server;
    started.stop();

    expect(started.token).toBe("kept");
    expect(started.url).toBe(`http://127.0.0.1:${port}/t/kept/`);
  });

  test("a port taken meanwhile binds another one and draws a new token", async () => {
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const taken = squatter.port ?? 0;

    const started = await startServer({
      project: project(),
      workdir: wipDir(),
      port: taken,
      token: "kept",
    });

    const { port } = started.server;
    started.stop();
    await squatter.stop(true);

    expect(port).not.toBe(taken);
    expect(started.token).not.toBe("kept");
  });
});

describe("a working directory that is gone", () => {
  test("is refused when the server must find it, and not created", async () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-gone-"));

    const starting = startServer({ project: root, workdir: wipDir(), port: 0, existing: true });

    await expect(starting).rejects.toBeInstanceOf(WorkdirGone);
    expect(existsSync(join(root, WIP))).toBe(false);
  });

  test("--existing exits 3 before a line on stdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-gone-"));
    const flags = ["--session", "s", "--project", root, "--workdir", WIP, "--existing"];
    const serve = Bun.spawn(["bun", CLI, "serve", ...flags], { stderr: "ignore" });

    expect(await serve.exited).toBe(EXIT_WORKDIR_GONE);
    expect(await new Response(serve.stdout).text()).toBe("");
  });
});

/** A `serve` child, read a line at a time. */
type Serving = {
  readonly next: () => Promise<string>;
  readonly pid: number;
  readonly stop: () => void;
};

/** `serve` on `flags`; the test ends it in a `finally`, whatever it expects. */
function serving(flags: readonly string[]): Serving {
  const serve = Bun.spawn(["bun", CLI, "serve", ...flags], { stderr: "ignore" });
  const lines = linesOf(serve.stdout);

  return {
    next: async () => String((await lines.next()).value),
    pid: serve.pid,
    stop: () => serve.kill(),
  };
}

const NOTE = {
  id: "a",
  doc: `${WIP}plan.md`,
  anchor: { kind: "global" },
  mark: { kind: "comment", body: "no" },
};

describe("what serve writes on stdout", () => {
  test("ready first, with the channel's identity, then where the review stands, then each entry as it lands", async () => {
    const root = project();
    const serve = serving(["--session", "s", "--project", root, "--workdir", WIP]);

    try {
      // SAFETY: `serve` writes one `ServerLine` per line on its stdout; this test checks it is `ready`.
      const ready = JSON.parse(await serve.next()) as Extract<ServerLine, { type: "ready" }>;

      expect(ready).toEqual({
        type: "ready",
        port: expect.any(Number),
        token: expect.any(String),
        pid: serve.pid,
        channel: readFileSync(join(root, WIP, ".review/channel.id"), "utf8"),
      });
      expect(JSON.parse(await serve.next())).toMatchObject({
        type: "stage",
        workspace: { kind: "drafting" },
        pill: { text: "Drafting", tone: "neutral" },
        segments: ["plan draft"],
      });

      const headers = { "x-vellum-token": ready.token, "content-type": "application/json" };
      const typed = { general: "", composer: {}, grill: {}, editor: null };

      await fetch(`http://127.0.0.1:${ready.port}/api/draft`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ annotations: [NOTE], edit: null, typed }),
      });
      await fetch(`http://127.0.0.1:${ready.port}/api/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          annotations: ["a"],
          edit: null,
          choices: [],
          parts: true,
          takeDefaults: [],
        }),
      });

      expect(JSON.parse(await serve.next())).toEqual({
        type: "channel",
        line: { seq: 1, entry: { kind: "sent", file: `${WIP}.review/v0.feedback-1.md` } },
      });
      expect(JSON.parse(await serve.next())).toMatchObject({
        type: "stage",
        workspace: { kind: "drafting", batches: 1 },
        pill: { text: "Drafting · 1 sent", tone: "neutral" },
        segments: ["plan draft"],
      });
    } finally {
      serve.stop();
    }
  });

  test("revived in the final directory an approval renamed, it serves the approval there and recreates nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-serve-"));
    const final = "plans/2026-09-15/auth/";
    mkdirSync(join(root, final, ".review"), { recursive: true });
    writeFileSync(join(root, final, ".review/v1.md"), "# Auth\n");
    writeFileSync(join(root, final, ".review/channel.jsonl"), "");
    writeFileSync(join(root, final, ".review/channel.id"), "kept");
    const flags = ["--session", "s", "--project", root, "--workdir", WIP, "--existing"];
    const serve = serving([...flags, "--final", final]);

    try {
      // SAFETY: `serve` writes one `ServerLine` per line on its stdout; this test checks it is `ready`.
      const ready = JSON.parse(await serve.next()) as Extract<ServerLine, { type: "ready" }>;

      expect(ready).toMatchObject({ type: "ready", channel: "kept" });
      expect(JSON.parse(await serve.next())).toMatchObject({
        type: "stage",
        workspace: { kind: "approved", dir: final },
      });

      const channel = await fetch(`http://127.0.0.1:${ready.port}/api/channel?after=0`, {
        headers: { "x-vellum-token": ready.token },
      });

      expect(await channel.json()).toEqual([
        { seq: 1, entry: { kind: "approved", version: 1, dir: final, notes: null } },
      ]);
      expect(existsSync(join(root, WIP))).toBe(false);
    } finally {
      serve.stop();
    }
  });
});
