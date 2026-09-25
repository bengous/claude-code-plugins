import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { Locator, Page } from "@playwright/test";
import { expect, test as base } from "@playwright/test";

import type { Annotation, ReviewView, SendAnswer } from "../src/core/protocol.ts";
import type { FinalDir, WipDir } from "../src/core/server/domain/paths.ts";
import { parseFinalDir, parseWipDir } from "../src/core/server/domain/paths.ts";
import { discard } from "../src/core/server/preview.ts";
import type {
  CloseReason,
  GrillPosts,
  GrillState,
  QuestionTriple,
} from "../src/extensions/grill/protocol.ts";
import type { Proposal, StepAnswer, StepState } from "../src/extensions/step/protocol.ts";

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

/** What the page's draft holds for the grill, by question id, and the comments beside it. */
export type Typing = {
  readonly answers?: Readonly<Record<string, string>>;
  readonly note?: string;
  readonly comments?: readonly Json[];
};

export type Vellum = {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
  /** The scratch copy `preview.ts` serves, absolute. */
  readonly workdir: string;
  /** The same, as the server names it: relative to the repository, its trailing slash kept. */
  readonly dir: string;
  api(path: string, body?: Json, method?: "GET" | "POST" | "PUT"): Promise<Reply>;
  /** Records `plan.md` as the next version, as the hooks module does at the end of a turn. */
  gate(): Promise<Reply>;
  /** Every entry of the channel, what reaches Claude, as `GET /api/channel` serves it to the hooks module. */
  channel(): Promise<Reply>;
  /**
   * The reviewer's Send without the page: the draft saved as the page saves it, the typing on
   * the open grill's transcript, then `POST /api/send` of all of it, the defaults taken.
   */
  send(typing?: Typing): Promise<Reply>;
  /** The batches the review wrote, oldest first, by name. */
  batches(): readonly string[];
  /** A batch's text, as Claude reads it. */
  batch(name: string): string;
  /** Replaces the served `plan.md`, as Claude's revision would. */
  writePlan(text: string): void;
  writeFile(name: string, text: string): void;
  readonly step: {
    /** `POST propose`, as `mcp__vellum__propose` posts it: answered at once with the id it waits under. */
    propose(proposal: Proposal): Promise<Reply>;
    /** Answers the proposal waiting under the id the server gave it, as another tab's window would. */
    answer(answer: StepAnswer): Promise<Reply>;
    state(): Promise<Reply>;
    /** `POST wait` on the proposal `id`, as a waiting `propose` holds it. */
    wait(id: string): Promise<Reply>;
  };
  readonly grill: {
    /** A grill of the reviewer's own, opened as the "Next step" window opened blank opens one. */
    open(subject: string): Promise<Reply>;
    ask(questions: readonly QuestionTriple[]): Promise<Reply>;
    /**
     * Claude's final text, as the hooks module posts it at the turn's end: by default a turn a
     * relay started, ended on its answer (`answer`, the engine's reason), that asked no round.
     */
    answer(text: string, turn?: Partial<Omit<GrillPosts["answer"], "text">>): Promise<Reply>;
    close(reason?: CloseReason): Promise<Reply>;
    state(): Promise<Reply>;
    /** `POST wait` on the round whose first question is `first`, as a waiting `grill_ask` holds it. */
    wait(first: number): Promise<Reply>;
  };
  stop(): Promise<void>;
};

/** What a child printed until now, each line with the milliseconds since its spawn. */
type Heard = { readonly since: number; readonly lines: string[] };

/**
 * The first line of `child`'s `name` stream matching `pattern`; the reader closes on it and the
 * rest drains unread. Past 20 s it fails with every line either stream printed and whether the
 * child exited: the one start timeout seen in CI (#207) carried nothing to find its cause by.
 */
function firstLine(
  child: ChildProcessByStdio<null, Readable, Readable>,
  name: "stdout" | "stderr",
  pattern: RegExp,
  heard: Heard,
): Promise<string> {
  const stream = child[name];

  return new Promise((found, reject) => {
    const lines = createInterface({ input: stream });

    const timer = setTimeout(() => {
      const exit = child.exitCode ?? child.signalCode ?? "still running";
      const printed = heard.lines.length === 0 ? "nothing" : heard.lines.join("\n  ");
      reject(
        new Error(
          `no line matching ${pattern} on ${name} within 20 s; exit: ${exit}; printed:\n  ${printed}`,
        ),
      );
    }, 20_000);

    lines.on("line", (line) => {
      heard.lines.push(`${Math.round(performance.now() - heard.since)} ms ${name}: ${line}`);

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
  const heard: Heard = { since: performance.now(), lines: [] };

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

  const [url, copied] = await Promise.all([
    firstLine(child, "stdout", /^http/u, heard),
    firstLine(child, "stderr", /copied to /u, heard),
  ]);

  const workdir = /copied to (.+?); pid/u.exec(copied)?.[1];

  if (workdir === undefined) throw new Error(`preview.ts named no working copy: ${copied}`);
  // As the server names it, `/` between its folders: `relative` answers `\` on Windows.
  const dir = `${relative(ROOT, workdir).replaceAll(sep, "/")}/`;
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

  /** The open grill's transcript, as the server names it. */
  const openGrill = async (): Promise<string> => {
    // SAFETY: the server's own `GrillState`, serialized by `Response.json` in grill/server.ts.
    const state = (await api("x/grill/state")).json as GrillState;

    if (state.kind !== "open") throw new Error("no grill is open");

    return state.file;
  };

  const review = (): string => join(workdir, ".review");

  return {
    url,
    origin,
    token,
    workdir,
    dir,
    api,
    gate: () => api("gate", { unchanged: "record" }),
    channel: () => api("channel?after=0"),
    send: async ({ answers = {}, note = "", comments = [] } = {}) => {
      const grill = (await api("x/grill/state")).json;
      // SAFETY: the server's own `GrillState`, serialized by `Response.json` in grill/server.ts.
      const open = (grill as GrillState).kind === "open" ? await openGrill() : null;
      const typing = open === null ? {} : { [open]: { answers, note } };
      const typed = { general: "", composer: {}, grill: typing, editor: null };
      await api("draft", { annotations: comments, edit: null, choices: {}, typed }, "PUT");
      // SAFETY: the page's own `Annotation`s, as a test hands them to the draft.
      const ids = comments.map((comment) => (comment as Annotation).id);
      const all = { annotations: ids, edit: null, choices: [], parts: true };
      const first = await api("send", { ...all, takeDefaults: [] });
      // SAFETY: the server's own `SendAnswer`, serialized by `Response.json` in routes.ts.
      const answer = first.json as SendAnswer;

      return first.status === 409 && "reason" in answer && answer.reason === "unanswered"
        ? api("send", { ...all, takeDefaults: answer.ids })
        : first;
    },
    batches: () =>
      readdirSync(review())
        .filter((name) => /^v\d+\.feedback-\d+\.md$/u.test(name))
        .toSorted((a, b) => a.localeCompare(b, "en", { numeric: true })),
    batch: (name) => readFileSync(join(review(), name), "utf8"),
    writePlan: (text) => writeFileSync(join(workdir, "plan.md"), text),
    writeFile: (name, text) => {
      mkdirSync(dirname(join(workdir, name)), { recursive: true });
      writeFileSync(join(workdir, name), text);
    },
    step: {
      propose: (proposal) => api("x/step/propose", proposal),
      answer: async (answer) => {
        // SAFETY: the server's own `StepState`, serialized by `Response.json` in step/server.ts.
        const { pending } = (await api("x/step/state")).json as StepState;

        if (pending === null) throw new Error("no proposal is pending");

        return api("x/step/answer", { id: pending.id, answer });
      },
      state: () => api("x/step/state"),
      wait: (id) => api("x/step/wait", { id }),
    },
    grill: {
      open: (subject) =>
        api("x/step/answer", {
          id: null,
          answer: { kind: "move", move: { kind: "grill", subject, choices: [] } },
        }),
      ask: (questions) => api("x/grill/ask", { q: questions }),
      answer: (text, turn = {}) =>
        api("x/grill/answer", { text, reason: "answer", own: true, asked: false, ...turn }),
      close: (reason = "page") => api("x/grill/close", { reason }),
      state: () => api("x/grill/state"),
      wait: async (first) => api("x/grill/wait", { file: await openGrill(), first }),
    },
    // A test may stop the server itself, to cut the connection: the fixture's stop is then a no-op.
    stop: async () => {
      // Windows has no signal to send: `kill` ends preview.ts and runs no handler, so the copy
      // it served, renamed by an approval or not, is the harness's to take away. A server that
      // cannot say which leaves it, and is still killed.
      const left =
        process.platform === "win32" && !gone ? await servedDir(api).catch(() => null) : null;

      await new Promise<void>((exited) => {
        if (gone) {
          exited();

          return;
        }

        child.once("exit", () => exited());
        child.kill("SIGTERM");
      });
      process.off("exit", onExit);

      if (left !== null) discard(ROOT, left);
    },
  };
}

/** The directory the server serves now, as it names it: the staged copy, or the name an approval gave it. */
async function servedDir(api: Vellum["api"]): Promise<WipDir | FinalDir | null> {
  // SAFETY: the server's own `ReviewView`, serialized by `Response.json` in routes.ts.
  const { dir } = ((await api("review")).json as ReviewView).workspace;
  const wip = parseWipDir(dir);

  if (wip.ok) return wip.value;
  const final = parseFinalDir(dir);

  return final.ok ? final.value : null;
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

/** The one batch the review wrote, as Claude reads it. */
export function feedbackOf(vellum: Vellum): string {
  const [name, ...more] = vellum.batches();

  if (name === undefined || more.length > 0) throw new Error(`not one batch: ${vellum.batches()}`);

  return vellum.batch(name);
}

/** The warning the bar puts before a Send: questions it would take by default, a typed text it would throw. */
export function beforeSending(page: Page): Locator {
  return page.getByRole("dialog", { name: "Before sending" });
}

/** The bar's Send; `anyway` when the test knows the bar asks first, and agrees. */
export async function sendAll(page: Page, anyway = false): Promise<void> {
  await sendButton(page).click();

  if (anyway) await beforeSending(page).getByRole("button", { name: "Send anyway" }).click();
}

/** The bar's Send, its count in its badge. */
export function sendButton(page: Page): Locator {
  return page.locator(".bar").getByRole("button", { name: /^Send\b/u });
}

/**
 * Opens the Vellum URL and waits until the bar drew the review: its status pill, which comes with
 * the first load. The brand alone is drawn before it, and the bar's buttons move once it lands.
 */
export async function openVellum(page: Page, vellum: Vellum): Promise<void> {
  await page.goto(vellum.url);
  await page.locator(".bar .status").waitFor();
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

/**
 * Waits for the page's CSS transitions to end: a colour read right after a theme switch is a text
 * halfway between the two themes, over the new theme's background (`--transition` in style.css).
 * A transition cancelled by the next one settles too.
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished),
    ),
  );
}

/**
 * Runs axe-core in the main frame, over the whole document or the elements `within` selects, once
 * the page's transitions have ended, and returns the violations, trimmed to what an assertion reads.
 */
export async function axe(page: Page, within?: string): Promise<readonly Violation[]> {
  await settled(page);
  await page.evaluate(AXE);
  const context = within === undefined ? "document" : JSON.stringify({ include: [within] });

  const result = await page.evaluate<AxeResults>(
    `axe.run(${context}, { runOnly: { type: "tag", values: ${JSON.stringify(AXE_TAGS)} } })`,
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

/** A text's contrast on the nearest box that paints a background, its own or an ancestor's, both as a canvas paints them. */
export async function onItsSurface(text: Locator): Promise<number> {
  await settled(text.page());

  const [color, background] = await text.evaluate((node) => {
    const context = document.createElement("canvas").getContext("2d");

    if (context === null) throw new Error("no 2d context");

    const paint = (css: string): readonly number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);

      return [...context.getImageData(0, 0, 1, 1).data];
    };

    let surface: Element = node;

    while (paint(getComputedStyle(surface).backgroundColor)[3] === 0 && surface.parentElement) {
      surface = surface.parentElement;
    }

    const rgb = (css: string): string => `rgb(${paint(css).slice(0, 3).join(", ")})`;

    return [rgb(getComputedStyle(node).color), rgb(getComputedStyle(surface).backgroundColor)];
  });

  return contrast(color, background);
}
