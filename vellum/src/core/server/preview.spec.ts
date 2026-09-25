import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ReviewView } from "../protocol.ts";
import { parseWipDir } from "./domain/paths.ts";
import { discard, scratchDir, scratchId, stage, today } from "./preview.ts";

const PREVIEW = join(import.meta.dir, "preview.ts");

const DIR = scratchDir("2026-09-15", "4c2a9d93");

const APPROVE = JSON.stringify({ kind: "approve", edit: null, notes: "" });

type Fixture = { readonly project: string; readonly source: string };

function fixture(): Fixture {
  const project = mkdtempSync(join(tmpdir(), "vellum-preview-"));
  const source = join(project, "approved");
  mkdirSync(join(source, ".review"), { recursive: true });
  mkdirSync(join(source, "shots"), { recursive: true });
  writeFileSync(join(source, "plan.md"), "# Plan\n");
  writeFileSync(join(source, "shots/mockup.html"), "<h1>Mockup</h1>\n");
  writeFileSync(join(source, ".review/v1.md"), "# Plan\n");

  return { project, source };
}

/** A file the user may not read: its mode on POSIX; on Windows, which reads no mode, an ACL that denies it. */
function unreadable(file: string): void {
  if (process.platform !== "win32") {
    chmodSync(file, 0o000);

    return;
  }

  const denied = Bun.spawnSync(["icacls", file, "/deny", `${process.env["USERNAME"]}:(R)`]);

  if (denied.exitCode !== 0) throw new Error(`icacls: ${denied.stdout.toString()}`);
}

/** The URL the command prints, read before it has said anything else. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  while (!buffered.includes("\n")) {
    const { value, done } = await reader.read();

    if (done) break;
    buffered += decoder.decode(value);
  }

  reader.releaseLock();

  return buffered.split("\n")[0] ?? "";
}

function api(url: string, path: string, body: string | null = null): Promise<Response> {
  const token = url.split("/t/")[1]?.replace("/", "") ?? "";

  return fetch(`${new URL(url).origin}${path}`, {
    method: body === null ? "GET" : "POST",
    headers: { "x-vellum-token": token, "content-type": "application/json" },
    body,
  });
}

async function viewOf(url: string): Promise<ReviewView> {
  // SAFETY: `GET /api/review` answers `Response.json(await review.view())`, a `ReviewView`.
  return (await (await api(url, "/api/review")).json()) as ReviewView;
}

/** Nothing else kills a preview, and one left running holds its copy for thirty minutes. */
const running: Bun.Subprocess[] = [];

afterEach(() => {
  for (const preview of running.splice(0)) preview.kill("SIGKILL");
});

function spawnPreview(fixed: Fixture): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const preview = Bun.spawn(["bun", PREVIEW, fixed.source], {
    cwd: fixed.project,
    stderr: "pipe",
  });

  running.push(preview);

  return preview;
}

describe("the scratch directory", () => {
  test("is the one shape serve accepts, and a fresh one every time", () => {
    expect<string>(DIR).toBe("plans/2026-09-15/wip-4c2a9d93/");
    expect(parseWipDir(scratchDir(today(), scratchId())).ok).toBe(true);
    expect(scratchId()).not.toBe(scratchId());
  });

  test("an id that is not eight hex fails where it is built, not where it is served", () => {
    expect(() => scratchDir("2026-09-15", "not-hex!")).toThrow("not a working directory");
  });
});

describe("the copy", () => {
  test("carries the documents and the review's versions, and leaves the source alone", () => {
    const { project, source } = fixture();
    stage(source, project, DIR);
    writeFileSync(join(project, DIR, ".review/draft.json"), "{}");

    expect(readdirSync(join(project, DIR)).toSorted()).toEqual([".review", "plan.md", "shots"]);
    expect(existsSync(join(project, DIR, "shots/mockup.html"))).toBe(true);
    expect(existsSync(join(project, DIR, ".review/v1.md"))).toBe(true);
    expect(readdirSync(join(source, ".review"))).toEqual(["v1.md"]);
  });

  test("is discarded whole, with the dates it was the only plan of", () => {
    const { project, source } = fixture();
    stage(source, project, DIR);
    writeFileSync(join(project, DIR, ".review/draft.json"), "{}");
    discard(project, DIR);

    expect(existsSync(join(project, "plans"))).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  test("leaves a date another plan lives under", () => {
    const { project, source } = fixture();
    mkdirSync(join(project, "plans/2026-09-15/kept"), { recursive: true });
    stage(source, project, DIR);
    discard(project, DIR);

    expect(readdirSync(join(project, "plans/2026-09-15"))).toEqual(["kept"]);
  });

  test("leaves the source's unsent draft where it was, since its comments name the source", () => {
    const { project, source } = fixture();
    writeFileSync(join(source, ".review/draft.json"), '{"annotations":[],"edit":null}');
    stage(source, project, DIR);

    expect(readdirSync(join(project, DIR, ".review"))).toEqual(["v1.md"]);
    expect(existsSync(join(source, ".review/draft.json"))).toBe(true);
  });
});

describe("the command", () => {
  // Windows has no signal to send: `kill("SIGINT")` ends the child and runs no handler. A
  // CTRL_C_EVENT in the child's own console does: measured by hand in PR #231, not from a test.
  test.skipIf(process.platform === "win32")(
    "serves a directory that is no working one, and takes its copy away on SIGINT",
    async () => {
      const fixed = fixture();
      const preview = spawnPreview(fixed);
      const url = await firstLine(preview.stdout);
      const view = await viewOf(url);

      expect((await fetch(url)).status).toBe(200);
      expect(view.plan?.text).toBe("# Plan\n");
      expect(view.docs.map((doc) => basename(doc.path))).toEqual(["mockup.html"]);
      preview.kill("SIGINT");
      await preview.exited;

      expect(existsSync(join(fixed.project, "plans"))).toBe(false);
    },
  );

  // Windows has no signal to send: see the test above.
  test.skipIf(process.platform === "win32")(
    "takes away the approved name the copy was renamed to, not the one it was staged at",
    async () => {
      const fixed = fixture();
      const preview = spawnPreview(fixed);
      const url = await firstLine(preview.stdout);
      await api(url, "/api/decision", APPROVE);

      expect(readdirSync(join(fixed.project, "plans", today()))).toEqual(["plan"]);
      preview.kill("SIGINT");
      await preview.exited;

      expect(existsSync(join(fixed.project, "plans"))).toBe(false);
    },
  );

  test("leaves no half copy behind when a file of the source cannot be read", async () => {
    const fixed = fixture();
    unreadable(join(fixed.source, "shots/mockup.html"));
    const preview = spawnPreview(fixed);

    expect(await preview.exited).toBe(1);
    expect(existsSync(join(fixed.project, "plans"))).toBe(false);
  });

  test("refuses a directory that holds no plan.md, and stages nothing", async () => {
    const { project } = fixture();
    const preview = Bun.spawn(["bun", PREVIEW, project], { cwd: project, stderr: "pipe" });

    running.push(preview);

    expect(await preview.exited).toBe(2);
    expect(await new Response(preview.stderr).text()).toContain("plan.md");
    expect(existsSync(join(project, "plans"))).toBe(false);
  });
});
