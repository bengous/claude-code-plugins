import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WipDir } from "../../domain/paths.ts";
import { parseWipDir } from "../../domain/paths.ts";
import { EXIT_WORKDIR_GONE, startServer, WorkdirGone } from "./serve.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const CLI = join(import.meta.dir, "../../cli.ts");

function wipDir(): WipDir {
  const parsed = parseWipDir(WIP);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "vellum-serve-"));
  mkdirSync(join(root, WIP), { recursive: true });

  return root;
}

describe("the watchdog", () => {
  test("without a heartbeat the server holds while a stream is open, and expires once the last one closed", async () => {
    let expired = 0;
    const watchdog = { graceMs: 40, tabHoldMs: 10_000, periodMs: 10, expire: () => (expired += 1) };
    const started = await startServer({ project: project(), workdir: wipDir(), port: 0, watchdog });
    const tab = new AbortController();
    const stream = await fetch(`${started.url}events`, { signal: tab.signal });
    await stream.body?.getReader().read();
    await Bun.sleep(120);

    expect(expired, "a tab listens, past the grace").toBe(0);
    tab.abort();
    await Bun.sleep(120);
    started.stop();

    expect(expired).toBeGreaterThan(0);
  });
});

describe("a server its module left", () => {
  test("a tab that still listens holds it for a while, not for good", async () => {
    let expired = 0;
    const watchdog = { graceMs: 20, tabHoldMs: 100, periodMs: 10, expire: () => (expired += 1) };
    const started = await startServer({ project: project(), workdir: wipDir(), port: 0, watchdog });
    const tab = new AbortController();
    const stream = await fetch(`${started.url}events`, { signal: tab.signal });
    await stream.body?.getReader().read();
    await Bun.sleep(60);

    expect(expired, "past the grace, the tab holds").toBe(0);
    await Bun.sleep(120);
    tab.abort();
    started.stop();

    expect(expired, "past the tab's hold, nothing does").toBeGreaterThan(0);
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

  test("--existing exits 3, through the launcher too", async () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-gone-"));
    const flags = ["--session", "s", "--project", root, "--workdir", WIP, "--existing"];
    const serve = Bun.spawn(["bun", CLI, "serve", ...flags], { stderr: "ignore" });
    const start = Bun.spawn(["bun", CLI, "start", ...flags], { stderr: "ignore" });

    expect(await serve.exited).toBe(EXIT_WORKDIR_GONE);
    expect(await start.exited).toBe(3);
  });
});
