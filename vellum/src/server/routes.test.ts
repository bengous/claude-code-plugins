import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWipDir } from "../workspace/paths.ts";
import { startServer } from "./serve.ts";
import type { Started } from "./serve.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

let started: Started;

let root: string;

function headers(): HeadersInit {
  return { "x-vellum-token": started.token, "content-type": "application/json" };
}

function url(path: string): string {
  return `http://127.0.0.1:${started.server.port}${path}`;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "vellum-routes-"));
  mkdirSync(join(root, WIP), { recursive: true });
  writeFileSync(join(root, WIP, "mockup.html"), "<p>mock</p>");
  symlinkSync("/etc/hostname", join(root, WIP, "escape.txt"));
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);
  started = await startServer({ project: root, workdir: workdir.value, port: 0 });
});

afterAll(() => {
  started.stop();
});

describe("routes", () => {
  test("the page is served bundled at /t/<token>/", async () => {
    const response = await fetch(url(`/t/${started.token}/`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Vellum</title>");
    expect(html).toMatch(/<script[^>]+src="[^"]+\.js"/u);
  });

  test("/api needs the token", async () => {
    expect((await fetch(url("/api/review"))).status).toBe(401);
    expect((await fetch(url("/api/review"), { headers: headers() })).status).toBe(200);
  });

  test("files come with a sandbox CSP; escapes get 403 or vanish in URL parsing", async () => {
    const ok = await fetch(url(`/t/${started.token}/files/${WIP}mockup.html`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toBe("sandbox allow-scripts");

    const dots = await fetch(url(`/t/${started.token}/files/%2e%2e/%2e%2e/etc/passwd`));
    expect([403, 404]).toContain(dots.status);
    expect(await dots.text()).not.toContain("root:");

    const symlink = await fetch(url(`/t/${started.token}/files/${WIP}escape.txt`));
    expect(symlink.status).toBe(403);

    const missing = await fetch(url(`/t/${started.token}/files/${WIP}nope.html`));
    expect(missing.status).toBe(404);
  });

  test("gate, pending, decision and finalize round-trip over HTTP", async () => {
    const gate = await fetch(url("/api/gate"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ plan: "# Routed plan\n", planFilePath: "plans/p.md" }),
    });

    expect(await gate.json()).toEqual({ version: 1 });

    const bad = await fetch(url("/api/decision"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ kind: "feedback", annotations: [{ id: 1 }] }),
    });

    expect(bad.status).toBe(400);

    const badAgain = await fetch(url("/api/finalize"), {
      method: "POST",
      headers: headers(),
      body: "not json",
    });

    expect(badAgain.status).toBe(400);

    const early = await fetch(url("/api/finalize"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ version: 1 }),
    });

    expect(early.status).toBe(409);

    const approve = await fetch(url("/api/decision"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ kind: "approve" }),
    });

    expect(approve.status).toBe(200);
    const pending = await fetch(url("/api/pending"), { headers: headers() });
    expect(await pending.json()).toEqual({ kind: "approved", version: 1 });

    const finalize = await fetch(url("/api/finalize"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ version: 1 }),
    });

    expect(finalize.status).toBe(200);
    expect(await finalize.json()).toMatchObject({
      workspace: { kind: "approved", dir: "plans/2026-09-15/routed-plan/" },
      plan: "# Routed plan\n",
    });
  });
});
