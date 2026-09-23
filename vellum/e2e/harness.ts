import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { Locator, Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";

import type { CloseReason, GrillState, QuestionTriple } from "../src/extensions/grill/protocol.ts";

/**
 * The browser suite's harness: `preview.ts` started on a copy of a fixture, its API driven
 * from the test, and the two measures the audit took in the page, axe and a contrast ratio.
 */

/** The repository: `preview.ts` resolves a plan's cited files against its cwd, and the fixtures cite this repository's. */
export const ROOT = resolve(import.meta.dirname, "../..");

export const FIXTURES = join(import.meta.dirname, "fixtures");

/** What a route answers, parsed: JSON, or the plain text of a refusal ("bad request"). */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export type Reply = { readonly status: number; readonly json: Json };

export type Vellum = {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
  /** The scratch copy `preview.ts` serves, absolute. */
  readonly workdir: string;
  api(path: string, body?: Json, method?: "GET" | "POST" | "PUT"): Promise<Reply>;
  /** Records `plan.md` as the next version, as the hooks module does at the end of a turn. */
  gate(): Promise<Reply>;
  /** Replaces the served `plan.md`, as Claude's revision would. */
  writePlan(text: string): void;
  writeFile(name: string, text: string): void;
  readonly grill: {
    suggest(subject: string, reason: string): Promise<Reply>;
    /** Declines the pending proposal under the id the server gave it, as another tab's Decline would. */
    decline(): Promise<Reply>;
    open(subject: string): Promise<Reply>;
    ask(questions: readonly QuestionTriple[]): Promise<Reply>;
    answer(text: string, own?: boolean): Promise<Reply>;
    close(reason?: CloseReason): Promise<Reply>;
    state(): Promise<Reply>;
  };
  stop(): Promise<void>;
};

/** The first line of `stream` matching `pattern`; the reader closes on it and the rest drains unread. */
function firstLine(stream: Readable, pattern: RegExp): Promise<string> {
  return new Promise((found, reject) => {
    const lines = createInterface({ input: stream });

    const timer = setTimeout(
      () => reject(new Error(`no line matching ${pattern} within 20 s`)),
      20_000,
    );

    lines.on("line", (line) => {
      if (!pattern.test(line)) return;
      clearTimeout(timer);
      lines.close();
      stream.resume();
      found(line.trim());
    });
  });
}

/**
 * Starts `preview.ts` on a copy of `fixture`, a name under `fixtures/` or a path, from the
 * repository's root. `NODE_ENV=test` keeps the server from opening a browser on the desktop
 * when a gate lands with no tab open.
 */
export async function startVellum(
  fixture: string,
  options: { readonly minutes?: number } = {},
): Promise<Vellum> {
  const child = spawn(
    "bun",
    [
      "vellum/src/core/server/preview.ts",
      resolve(FIXTURES, fixture),
      "--port",
      "0",
      "--minutes",
      String(options.minutes ?? 30),
    ],
    { cwd: ROOT, env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] },
  );

  // A test that throws never reaches stop(): the server and its scratch copy go with the runner.
  const onExit = (): void => {
    child.kill("SIGTERM");
  };

  process.on("exit", onExit);
  let gone = false;

  child.once("exit", () => {
    gone = true;
  });

  const url = await firstLine(child.stdout, /^http/u);
  const copied = await firstLine(child.stderr, /copied to /u);
  const workdir = /copied to (.+?); pid/u.exec(copied)?.[1];

  if (workdir === undefined) throw new Error(`preview.ts named no working copy: ${copied}`);
  const parsed = new URL(url);
  const token = parsed.pathname.split("/")[2] ?? "";
  const { origin } = parsed;

  const api: Vellum["api"] = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const init: RequestInit = {
      method,
      headers: { "x-vellum-token": token, "content-type": "application/json" },
    };

    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${origin}/api/${path}`, init);
    const text = await response.text();

    return { status: response.status, json: text === "" ? null : parseLoosely(text) };
  };

  return {
    url,
    origin,
    token,
    workdir,
    api,
    gate: () => api("gate", { unchanged: "record" }),
    writePlan: (text) => writeFileSync(join(workdir, "plan.md"), text),
    writeFile: (name, text) => {
      mkdirSync(dirname(join(workdir, name)), { recursive: true });
      writeFileSync(join(workdir, name), text);
    },
    grill: {
      suggest: (subject, reason) => api("x/grill/suggest", { subject, reason }),
      decline: async () => {
        // SAFETY: the server's own `GrillState`, serialized by `Response.json` in grill/server.ts.
        const state = (await api("x/grill/state")).json as GrillState;

        if (state.kind === "open" || state.proposal?.kind !== "pending") {
          throw new Error("no proposal is pending");
        }

        return api("x/grill/decline", { id: state.proposal.suggestion.id });
      },
      open: (subject) => api("x/grill/open", { subject }),
      ask: (questions) => api("x/grill/ask", { q: questions }),
      answer: (text, own = true) => api("x/grill/answer", { text, reason: "end_turn", own }),
      close: (reason = "page") => api("x/grill/close", { reason }),
      state: () => api("x/grill/state"),
    },
    // A test may stop the server itself, to cut the connection: the fixture's stop is then a no-op.
    stop: () =>
      new Promise((exited) => {
        process.off("exit", onExit);

        if (gone) {
          exited();

          return;
        }

        child.once("exit", () => exited());
        child.kill("SIGTERM");
      }),
  };
}

function parseLoosely(text: string): Json {
  try {
    // SAFETY: the server's own reply, `Response.json` in routes.ts or an extension's route.
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

export function readFixture(name: string, file: string): string {
  return readFileSync(join(FIXTURES, name, file), "utf8");
}

/** Opens the Vellum URL and waits until the page drew its bar. */
export async function openVellum(page: Page, vellum: Vellum): Promise<void> {
  await page.goto(vellum.url);
  await page.locator(".bar .brand").waitFor();
}

/** Records `plan.md` as v1 and opens the page on it, drawn. */
export async function reviewV1(page: Page, vellum: Vellum): Promise<void> {
  await vellum.gate();
  await openVellum(page, vellum);
  await expect(page.locator(".plan h1")).toBeVisible();
}

/** Turns the Comment switch on. */
export async function commentOn(page: Page): Promise<void> {
  const commentSwitch = page.locator(".tools [role=switch]", { hasText: "Comment" });
  await commentSwitch.click();
  await expect(commentSwitch).toHaveAttribute("aria-checked", "true");
}

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();

  if (box === null) throw new Error("no box");

  return box;
}

/**
 * Selects, by a real drag, the characters `from` to `to` of the first text node of `locator`,
 * in the page or in a mockup's frame: the characters are measured in the locator's own frame,
 * and the mouse moves in the page's.
 */
export async function dragText(
  page: Page,
  locator: Locator,
  from: number,
  to: number,
): Promise<void> {
  const [start, end, own] = await locator.evaluate(
    (element, [first, last]) => {
      const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();

      if (node === null) throw new Error("no text node");

      const at = (offset: number) => {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getClientRects()[0];

        if (rect === undefined) throw new Error("no rect");

        return { x: rect.left + 1, y: rect.top + rect.height / 2 };
      };

      const { left, top } = element.getBoundingClientRect();

      return [at(first), at(last), { x: left, y: top }];
    },
    [from, to] as const,
  );

  const box = await boxOf(locator);
  const dx = box.x - own.x;
  const dy = box.y - own.y;
  await page.mouse.move(start.x + dx, start.y + dy);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2 + dx, end.y + dy, { steps: 6 });
  await page.mouse.move(end.x + dx, end.y + dy, { steps: 6 });
  await page.mouse.up();
}

/** A server per test, on the fixture `test.use({ fixture })` names, `rich` by default, stopped after. */
export const test = base.extend<{ fixture: string; vellum: Vellum }>({
  fixture: ["rich", { option: true }],
  vellum: async ({ fixture }, use) => {
    const vellum = await startVellum(fixture);
    await use(vellum);
    await vellum.stop();
  },
});

export { expect } from "@playwright/test";

export type Violation = {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly string[]; readonly summary: string }[];
};

const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"];

type AxeResults = {
  readonly violations: readonly {
    readonly id: string;
    readonly impact?: string | null;
    readonly help: string;
    readonly nodes: readonly {
      readonly target: readonly string[];
      readonly failureSummary?: string;
    }[];
  }[];
};

/** Runs axe-core in the main frame and returns the violations, trimmed to what an assertion reads. */
export async function axe(page: Page): Promise<readonly Violation[]> {
  await page.evaluate(AXE);

  const result = await page.evaluate<AxeResults>(
    `axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(AXE_TAGS)} } })`,
  );

  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? null,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      summary: node.failureSummary ?? "",
    })),
  }));
}

function channel(value: number): number {
  const s = value / 255;

  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio of two colours as the browser serializes them (`rgb(…)` strings). */
export function contrast(fg: string, bg: string): number {
  const [light = 0, dark = 0] = [luminance(fg), luminance(bg)].toSorted((a, b) => b - a);

  return (light + 0.05) / (dark + 0.05);
}
