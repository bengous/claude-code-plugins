import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import type { Vellum } from "./harness.ts";
import {
  axe,
  beforeSending,
  boxOf,
  contrast,
  expect,
  onItsSurface,
  openVellum,
  sendAll,
  sendButton,
  settled,
  test,
} from "./harness.ts";

/**
 * An open grill, which the "Next step" window opens (`step.e2e.ts`), is a panel right of the
 * document pane, which the rail keeps choosing, and a band above the page that carries its
 * subject, its round, the questions waiting and End grill. A round in the panel is its questions
 * as chips over one question at a time, Recommended or Your answer, neither chosen until the
 * reviewer picks one; the answers leave with the bar's one Send.
 */

test.use({ fixture: "grill-real" });

const SUBJECT = "The coverage of the page";

const ROUND = [
  ["Storage", "IndexedDB or localStorage for the drafts?", "IndexedDB: no 5 MB cap."],
  ["Conflicts", "Who wins a conflict?", "The inspector, field by field."],
] as const;

function nextStep(page: Page): Locator {
  return page.locator(".bar").getByRole("button", { name: "Next step", exact: true });
}

/** A grill the reviewer opens from the "Next step" window opened blank, on `SUBJECT`. */
async function start(page: Page): Promise<void> {
  await nextStep(page).click();
  const window = page.getByRole("dialog", { name: "Next step", exact: true });
  await window.getByRole("textbox").fill(SUBJECT);
  await window.getByRole("button", { name: "Choose" }).click();
}

/** A text's colour against a surface's background: tokens written in hex, which the browser serializes as `rgb(…)`. */
async function ratio(text: Locator, surface: Locator): Promise<number> {
  await settled(text.page());
  const color = await text.evaluate((element) => getComputedStyle(element).color);
  const background = await surface.evaluate((element) => getComputedStyle(element).backgroundColor);

  return contrast(color, background);
}

test.beforeEach(async ({ vellum }) => {
  await vellum.gate();
});

function panel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Grill" });
}

function chips(page: Page): Locator {
  return panel(page).locator(".grill-chips").getByRole("button");
}

function chip(page: Page, id: string): Locator {
  return panel(page).locator(".grill-chips").getByRole("button", { name: id, exact: true });
}

/** The one question the panel shows, under the chips. */
function shown(page: Page): Locator {
  return panel(page).locator(".grill-round .grill-q");
}

function allRecommended(page: Page): Locator {
  return panel(page).getByRole("button", { name: "All recommended" });
}

/** The transcript `grill.open` wrote: the fixture holds `grill-1.md`, closed. */
function transcript(vellum: Vellum): string {
  return readFileSync(join(vellum.workdir, "grill-2.md"), "utf8");
}

/** Each chip's state, in order: answered, default or waiting. */
function statesOf(page: Page): Promise<(string | undefined)[]> {
  return chips(page).evaluateAll((all: HTMLElement[]) => all.map((node) => node.dataset["state"]));
}

/** A grill open on the plan with a round of two questions, and the page drawn on it. */
async function asking(page: Page, vellum: Vellum): Promise<void> {
  await vellum.grill.open(SUBJECT);
  await vellum.grill.ask(ROUND);
  await openVellum(page, vellum);
  await expect(chips(page)).toHaveCount(2);
}

/** Whether `right` starts where `left` ends, or past it. */
async function rightOf(right: Locator, left: Locator): Promise<boolean> {
  const [a, b] = [await boxOf(left), await boxOf(right)];

  return b.x >= a.x + a.width - 1;
}

/** Runs `write`, then waits for the page's next read of the grill's state, answered `status`. */
async function readAfter(page: Page, status: number, write: () => void): Promise<void> {
  const read = page.waitForResponse(
    (response) => response.url().includes("/x/grill/state") && response.status() === status,
  );

  write();
  await read;
}

test.describe("the panel", () => {
  test("a grill chosen opens in a panel right of the document pane", async ({ page, vellum }) => {
    await openVellum(page, vellum);
    await start(page);
    await expect(panel(page)).toBeVisible();

    expect(await rightOf(panel(page), page.locator("#doc"))).toBe(true);
  });

  test("a grill chosen leaves the document pane on what it shows", async ({ page, vellum }) => {
    await openVellum(page, vellum);
    await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();
    await start(page);
    await expect(panel(page)).toBeVisible();

    await expect(page.locator("#rail button[aria-current]")).toContainText("pourquoi-issue-139");
  });

  test("selecting an artifact in the rail keeps the panel", async ({ page, vellum }) => {
    await asking(page, vellum);
    await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();

    await expect(page.locator("#doc .doc-head")).toContainText("pourquoi-issue-139.md");
    await expect(chips(page)).toHaveCount(2);
  });

  test("an answer typed in the panel leaves with the bar's Send, one batch, and Claude works", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await panel(page)
      .getByRole("textbox", { name: "Your answer to Q1" })
      .fill("One store per form.");
    await sendAll(page, true);

    await expect
      .poll(async () => (await vellum.grill.state()).json)
      .toMatchObject({ kind: "open", phase: "working" });
    expect(vellum.batches()).toEqual(["v1.feedback-1.md"]);
    expect(vellum.batch("v1.feedback-1.md")).toContain("Q1: One store per form.");
  });

  test("its sheet and the sheet's scrollbar stop before the comments' handle", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const handle = await boxOf(page.locator(".handle.right"));
    const sheet = await boxOf(panel(page).locator(".grill-sheet"));

    expect(sheet.x + sheet.width).toBeLessThanOrEqual(handle.x);
  });

  test("appearing, it folds the comments panel and leaves its handle", async ({ page, vellum }) => {
    await openVellum(page, vellum);
    await expect(page.locator("#comments")).not.toHaveAttribute("inert");
    await vellum.grill.open(SUBJECT);
    await expect(panel(page)).toBeVisible();

    await expect(page.locator("#comments")).toHaveAttribute("inert", "");
    await expect(page.locator(".handle.right")).toHaveAttribute("aria-expanded", "false");
  });

  test("a refused read of the grill's state keeps the panel and the comments as they were", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await page.locator(".handle.right").click();
    await panel(page).evaluate((element: HTMLElement) => {
      element.dataset["kept"] = "yes";
    });
    await page.route("**/api/x/grill/state*", (route) => route.fulfill({ status: 500 }), {
      times: 1,
    });
    await readAfter(page, 500, () => vellum.writeFile("notes.md", "One."));
    await readAfter(page, 200, () => vellum.writeFile("notes.md", "Two."));

    await expect(panel(page)).toHaveAttribute("data-kept", "yes");
    await expect(page.locator("#comments")).not.toHaveAttribute("inert");
  });

  test("the transcript in the document pane is read-only: no field, no foot", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await page.locator("#rail button", { hasText: "grill-2.md" }).click();
    await expect(page.locator("#doc .grill-q")).toHaveCount(2);

    await expect(page.locator("#doc textarea")).toHaveCount(0);
    await expect(page.locator("#doc .grill-q .btn")).toHaveCount(0);
    await expect(page.locator("#doc .grill-foot")).toHaveCount(0);
  });

  test("Beside the plan still splits the document pane, left of the panel", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();
    await page.locator(".tools [role=switch]", { hasText: "Beside the plan" }).click();

    await expect(page.locator("#doc .pane")).toHaveCount(2);
    expect(await rightOf(panel(page), page.locator("#doc"))).toBe(true);
  });

  test("axe finds nothing to fault on the panel, light and dark", async ({ page, vellum }) => {
    await asking(page, vellum);

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await axe(page, ".grill-panel")).toEqual([]);
    }
  });
});

const THREE = [
  ...ROUND,
  ["Replay", "When is the queue replayed?", "On the online event."],
] as const;

/** Round 1 sent (Q1 typed, Q2 chosen, Q3 by default), round 2 open (Q4, Q5), the page drawn on it. */
async function twoRounds(page: Page, vellum: Vellum): Promise<void> {
  const answers = { Q1: "One store per form.", Q2: "As recommended." };

  await vellum.grill.open(SUBJECT);
  await vellum.grill.ask(THREE);
  await vellum.send({ answers });
  await vellum.grill.ask(ROUND);
  await openVellum(page, vellum);
  await expect(chips(page)).toHaveCount(5);
}

test.describe("a round in the panel", () => {
  test("is its questions as chips, waiting, over the first one, neither choice checked", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);

    await expect(chips(page)).toHaveText(["Q1", "Q2"]);
    expect(await statesOf(page)).toEqual(["waiting", "waiting"]);
    await expect(chip(page, "Q1")).toHaveAttribute("aria-current", "true");
    await expect(shown(page).locator(".topic")).toHaveText("Storage");
    await expect(shown(page).getByRole("radio", { name: "Recommended" })).not.toBeChecked();
    await expect(shown(page).getByRole("radio", { name: "Your answer" })).not.toBeChecked();
    await expect(panel(page).locator(".grill-q")).toHaveCount(1);
  });

  test("Next, Previous and a chip walk its questions, one at a time", async ({ page, vellum }) => {
    await asking(page, vellum);
    await panel(page).getByRole("button", { name: "Next question, Q2" }).click();
    await expect(shown(page).locator(".topic")).toHaveText("Conflicts");
    await panel(page).getByRole("button", { name: "Previous question, Q1" }).click();
    await expect(shown(page).locator(".topic")).toHaveText("Storage");
    await chip(page, "Q2").click();

    await expect(shown(page).locator(".topic")).toHaveText("Conflicts");
    await expect(chip(page, "Q2")).toHaveAttribute("aria-current", "true");
  });

  test("choosing Recommended answers the question, and the bar's Send counts it", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await expect(sendButton(page)).toHaveText("Send");
    await shown(page).getByRole("radio", { name: "Recommended" }).click();

    await expect(sendButton(page)).toHaveText("Send 1");
    expect(await statesOf(page)).toEqual(["answered", "waiting"]);
  });

  test("with a question unanswered the bar asks before any request, and Cancel sends nothing", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const posted: string[] = [];
    page.on("request", (request) => posted.push(request.url()));
    await shown(page).getByRole("radio", { name: "Recommended" }).click();
    await sendButton(page).click();

    await expect(beforeSending(page)).toContainText("1 question has no answer.");
    await beforeSending(page).getByRole("button", { name: "Cancel" }).click();
    expect(posted.filter((url) => url.endsWith("/api/send"))).toEqual([]);
    expect(vellum.batches()).toEqual([]);
  });

  test("All recommended chooses the recommendation for every question left untouched", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await shown(page).getByRole("textbox", { name: "Your answer to Q1" }).fill("One store.");
    await allRecommended(page).click();

    expect(await statesOf(page)).toEqual(["answered", "answered"]);
    await chip(page, "Q2").click();
    await expect(shown(page).getByRole("radio", { name: "Recommended" })).toBeChecked();
    await expect(allRecommended(page)).toBeDisabled();
  });

  test("Recommended is greyed while Your answer holds a text: a click never throws the typing", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const field = shown(page).getByRole("textbox", { name: "Your answer to Q1" });
    await field.fill("One store per form.");

    await expect(shown(page).getByRole("radio", { name: "Your answer" })).toBeChecked();
    await expect(shown(page).getByRole("radio", { name: "Recommended" })).toBeDisabled();
    await field.fill("");
    await expect(shown(page).getByRole("radio", { name: "Recommended" })).toBeEnabled();
  });

  test("an answer typed through `As recommended.` keeps every letter, and Your answer", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const field = shown(page).getByRole("textbox", { name: "Your answer to Q1" });
    await field.pressSequentially("As recommended. But one store.");
    await expect(field).toHaveValue("As recommended. But one store.");
    await field.fill("As recommended.x");
    await field.press("Backspace");

    await expect(field).toHaveValue("As recommended.");
    await expect(shown(page).getByRole("radio", { name: "Your answer" })).toBeChecked();
  });

  test("after a send the chips say what each question took: an answer, or the recommendation by default", async ({
    page,
    vellum,
  }) => {
    await vellum.grill.open(SUBJECT);
    await vellum.grill.ask(THREE);
    await openVellum(page, vellum);
    await shown(page).getByRole("textbox", { name: "Your answer to Q1" }).fill("One store.");
    await chip(page, "Q2").click();
    await shown(page).getByRole("radio", { name: "Recommended" }).click();
    await sendAll(page, true);

    await expect.poll(() => statesOf(page)).toEqual(["answered", "answered", "default"]);
    await expect(shown(page)).toHaveCount(0);
  });

  test("an answered question, opened from its chip, reads its answer and takes nothing", async ({
    page,
    vellum,
  }) => {
    await twoRounds(page, vellum);
    await chip(page, "Q1").click();

    await expect(shown(page).locator(".answer .text")).toHaveText("One store per form.");
    await expect(shown(page).getByRole("radio")).toHaveCount(0);
    await expect(shown(page).getByRole("textbox")).toHaveCount(0);
    await chip(page, "Q3").click();
    await expect(shown(page).locator(".answer .label")).toHaveText("By default");
  });

  test("a Send before the transcript loads still asks: the server counts what is left unanswered", async ({
    page,
    vellum,
  }) => {
    await vellum.grill.open(SUBJECT);
    await vellum.grill.ask(ROUND);
    await page.route("**/api/x/grill/blocks*", (route) => route.fulfill({ status: 500 }));
    await openVellum(page, vellum);
    await commentOnArtifact(page, "No.");
    await sendButton(page).click();

    await expect(beforeSending(page)).toContainText("2 questions have no answer.");
    expect(vellum.batches()).toEqual([]);
  });

  test("Send clicked twice sends once: one batch", async ({ page, vellum }) => {
    await asking(page, vellum);
    await allRecommended(page).click();
    await noteField(page).fill("Keep the audit trail.");
    await page.route("**/api/send", async (route) => {
      await new Promise((done) => {
        setTimeout(done, 300);
      });
      await route.continue();
    });
    await sendButton(page).dblclick();
    await expect.poll(() => statesOf(page)).toEqual(["answered", "answered"]);

    await expect.poll(() => vellum.batches()).toEqual(["v1.feedback-1.md"]);
    // The round is written after the batch (`sendInOrder`): wait for it, not for the batch.
    await expect.poll(() => transcript(vellum).split("Keep the audit trail.")).toHaveLength(2);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("after a Send the bar has nothing left to send, and the round is closed", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await allRecommended(page).click();
    await sendAll(page);

    await expect(shown(page)).toHaveCount(0);
    await expect(sendButton(page)).toBeDisabled();
    await expect(sendButton(page)).toHaveAttribute("title", /comment/iu);
  });

  test("End grill waits while a Send is out: the note is written once", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await allRecommended(page).click();
    await noteField(page).fill("Keep it.");
    await page.route("**/api/send", async (route) => {
      await new Promise((done) => {
        setTimeout(done, 400);
      });
      await route.continue();
    });
    await sendButton(page).click();

    await expect(band(page).getByRole("button", { name: "End grill" })).toBeDisabled();
    await band(page).getByRole("button", { name: "End grill" }).click();
    await expect(band(page)).toHaveCount(0);
    expect(transcript(vellum).split("Keep it.")).toHaveLength(2);
  });

  test("a round that lands as many questions as the last shows its first, not the last pick", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await chip(page, "Q2").click();
    await page.route("**/api/x/grill/blocks*", (route) => route.fulfill({ status: 500 }));
    const replied = page.waitForResponse("**/api/send");
    await sendAll(page, true);
    await replied;
    await vellum.grill.ask(ROUND);
    await page.unroute("**/api/x/grill/blocks*");
    vellum.writeFile("notes.md", "One.");
    await expect(chips(page)).toHaveCount(4);

    await expect(shown(page).locator(".num")).toHaveText("Q3");
  });

  test("a question Claude gave no recommendation offers Your answer alone", async ({
    page,
    vellum,
  }) => {
    await vellum.grill.open(SUBJECT);
    await vellum.grill.answer("❓ **Q1** - **Store**: Which store?\n\n---\n");
    await openVellum(page, vellum);
    await expect(chips(page)).toHaveCount(1);

    await expect(shown(page).getByRole("radio")).toHaveCount(0);
    await expect(shown(page).getByRole("textbox", { name: "Your answer to Q1" })).toBeVisible();
  });

  test("Claude's text between rounds still reads in the panel", async ({ page, vellum }) => {
    await asking(page, vellum);
    await vellum.grill.answer("Round 1 is on the page.", { asked: true });
    await sendAll(page, true);
    await vellum.grill.answer("The frontier is empty.");

    await expect(panel(page).locator(".plan")).toContainText("Round 1 is on the page.");
    await expect(panel(page).locator(".plan")).toContainText("The frontier is empty.");
    await expect(chips(page)).toHaveCount(2);
  });

  test("axe finds nothing to fault on two rounds, a question open or answered, light and dark", async ({
    page,
    vellum,
  }) => {
    await twoRounds(page, vellum);

    for (const picked of ["Q4", "Q1"]) {
      await chip(page, picked).click();

      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        expect(await axe(page, ".grill-panel")).toEqual([]);
      }
    }
  });

  test("each chip's words read on its colour, and each choice's on its own, light and dark", async ({
    page,
    vellum,
  }) => {
    await twoRounds(page, vellum);
    const texts = [chip(page, "Q1"), chip(page, "Q3"), chip(page, "Q4"), chip(page, "Q5")];
    const labels = shown(page).locator(".grill-choice label");
    texts.push(labels.first(), labels.last());

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });

      for (const text of texts) {
        expect(await onItsSurface(text)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

/** A general comment on the grill fixture's artifact, the comments panel unfolded for it. */
async function commentOnArtifact(page: Page, text: string): Promise<void> {
  await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();
  await page.locator(".handle.right").click();
  await expect(page.locator("#comments")).not.toHaveAttribute("inert");
  await page.locator("#global").fill(text);
  await page.getByRole("button", { name: "Add comment" }).click();
}

/** The kinds of the channel's entries, in order: what reached Claude, and by which path. */
async function kinds(vellum: Vellum): Promise<readonly string[]> {
  // SAFETY: the server's own `ChannelLine[]`, serialized by `Response.json` in routes.ts.
  const lines = (await vellum.channel()).json as readonly { readonly entry: { kind: string } }[];

  return lines.map(({ entry }) => entry.kind);
}

test.describe("the one Send", () => {
  test("an answer and a comment on an artifact leave with one click: one batch, one entry", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await shown(page).getByRole("textbox", { name: "Your answer to Q1" }).fill("One store.");
    await chip(page, "Q2").click();
    await shown(page).getByRole("radio", { name: "Recommended" }).click();
    await commentOnArtifact(page, "Cut the second half.");
    await expect(sendButton(page)).toHaveText("Send 3");
    await sendAll(page);

    await expect.poll(() => vellum.batches()).toEqual(["v1.feedback-1.md"]);
    const batch = vellum.batch("v1.feedback-1.md");
    expect(batch).toMatch(
      /## Grill[\s\S]*Q1: One store\.[\s\S]*## Comments[\s\S]*Cut the second half\./u,
    );
    expect(await kinds(vellum)).toEqual(["text", "sent"]);
  });

  test("Send now sends the comment alone, and the round stays open, its answer kept", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const answer = shown(page).getByRole("textbox", { name: "Your answer to Q1" });
    await answer.fill("One store.");
    await commentOnArtifact(page, "Cut the second half.");
    await page.locator(".comments .card").getByRole("button", { name: "Send now" }).click();

    await expect.poll(() => vellum.batches()).toEqual(["v1.feedback-1.md"]);
    expect(vellum.batch("v1.feedback-1.md")).not.toContain("## Grill");
    await expect(page.locator(".comments .card")).toHaveCount(0);
    expect((await vellum.grill.state()).json).toMatchObject({ phase: "asking" });
    await expect(answer).toHaveValue("One store.");
  });

  test("after a Send the bar waits for the round to read again: no count of the questions it closed", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await allRecommended(page).click();
    await page.route("**/api/x/grill/blocks*", async (route) => {
      await new Promise((done) => {
        setTimeout(done, 1500);
      });
      await route.continue();
    });
    await sendAll(page);
    await expect.poll(() => vellum.batches()).toEqual(["v1.feedback-1.md"]);

    // Read once, inside the 1.5 s the round takes to read again: a retrying assertion outwaits it.
    expect(await sendButton(page).isDisabled()).toBe(true);
    await expect(sendButton(page)).toHaveText("Send");
  });

  test("a grill_ask waiting on the round gets the Send as its answer, the batch named for the rest", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const waiting = vellum.grill.wait(1);
    await allRecommended(page).click();
    await commentOnArtifact(page, "Cut the second half.");
    await sendAll(page);

    expect((await waiting).json).toEqual({
      kind: "answered",
      seq: 2,
      text: `Reviewer: Q1: As recommended.\n\nQ2: As recommended.\n\nComments and choices: read ${vellum.dir}.review/v1.feedback-1.md.`,
    });
  });
});

/** The panel's live line: where the grill stands, empty while a round waits for the reviewer. */
function phaseLine(page: Page): Locator {
  return panel(page).locator(".grill-phase").getByRole("status");
}

function panelEnd(page: Page): Locator {
  return panel(page).getByRole("button", { name: "End grill and return to plan" });
}

function noteField(page: Page): Locator {
  return panel(page).getByRole("textbox", { name: "Anything else for Claude" });
}

/** The round of `asking` sent, then Claude's turn ended with no round, as the harness ends it unless `turn` says otherwise. */
async function answered(
  page: Page,
  vellum: Vellum,
  turn: Parameters<Vellum["grill"]["answer"]>[1] = {},
): Promise<void> {
  await asking(page, vellum);
  await sendAll(page, true);
  await expect(phaseLine(page)).toHaveText("Claude is preparing round 2.");
  await vellum.grill.answer("The frontier is empty.", turn);
}

/** Each text reads on its surface, light then dark, once the theme switch's transitions end. */
async function readable(page: Page, texts: readonly Locator[]): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await settled(page);

    for (const text of texts) {
      expect(await onItsSurface(text)).toBeGreaterThanOrEqual(4.5);
    }
  }
}

/** Axe over the panel, light then dark. */
async function faultless(page: Page): Promise<void> {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await axe(page, ".grill-panel")).toEqual([]);
  }
}

test.describe("the panel's phases", () => {
  test("before the first round, it says Claude prepares it", async ({ page, vellum }) => {
    await vellum.grill.open(SUBJECT);
    await openVellum(page, vellum);

    await expect(phaseLine(page)).toHaveText("Claude is preparing the first round.");
  });

  test("a round open says nothing; sent, it says Claude prepares the next", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await expect(phaseLine(page)).toHaveText("");
    await sendAll(page, true);

    await expect(phaseLine(page)).toHaveText("Claude is preparing round 2.");
  });

  test("Claude's turn ended with no round: End grill is the panel's primary action, under Claude's last word", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await expect(phaseLine(page)).toHaveText("Claude has no question open.");
    const grillColour = await band(page).evaluate((node) => getComputedStyle(node).backgroundColor);

    await expect(panel(page).locator(".plan")).toContainText("The frontier is empty.");
    await expect(panelEnd(page)).toHaveCSS("background-color", grillColour);
    await expect(noteField(page)).toHaveCount(0);
  });

  test("Add a note opens the note, focused, and the note sets Claude to work", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await panel(page).getByRole("button", { name: "Add a note" }).click();
    await expect(noteField(page)).toBeFocused();
    await noteField(page).fill("One more branch: the audit trail.");
    await sendAll(page);

    await expect(phaseLine(page)).toHaveText("Claude is preparing round 2.");
    await expect
      .poll(async () => (await vellum.grill.state()).json)
      .toMatchObject({
        phase: "working",
      });
  });

  test("a note typed there comes back with the page, its field shown", async ({ page, vellum }) => {
    await answered(page, vellum);
    await panel(page).getByRole("button", { name: "Add a note" }).click();
    await noteField(page).fill("One more branch.");
    await expect
      .poll(async () => JSON.stringify((await vellum.api("draft")).json))
      .toContain("One more branch.");
    await page.reload();

    await expect(noteField(page)).toHaveValue("One more branch.");
  });

  test("an interrupted turn says so, with the note to continue and End grill", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum, { reason: "aborted" });

    await expect(phaseLine(page)).toHaveText(
      "Claude's turn was interrupted. Add a note to continue.",
    );
    await expect(noteField(page)).toBeVisible();
    await expect(panelEnd(page)).toBeVisible();
  });

  test("a page loaded while Claude works names its round once the transcript loads, never the first", async ({
    page,
    vellum,
  }) => {
    await vellum.grill.open(SUBJECT);
    await vellum.grill.ask(ROUND);
    await vellum.send();
    // Never answered: the transcript stays unloaded until the route goes.
    await page.route("**/api/x/grill/blocks*", () => null);
    await openVellum(page, vellum);
    await expect(panel(page)).toBeVisible();

    await expect(phaseLine(page)).toHaveText("");
    await page.unroute("**/api/x/grill/blocks*");
    vellum.writeFile("notes.md", "One.");
    await expect(phaseLine(page)).toHaveText("Claude is preparing round 2.");
  });

  test("a phase read before its transcript waits for it: the round drawn keeps its choices", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await page.route("**/api/x/grill/blocks*", () => null);

    const idle = page.waitForResponse(
      async (response) =>
        response.url().includes("/x/grill/state") && (await response.text()).includes('"idle"'),
    );

    await vellum.send();
    await vellum.grill.answer("The frontier is empty.");
    await idle;
    await page.waitForTimeout(300);

    await expect(phaseLine(page)).toHaveText("");
    await expect(allRecommended(page)).toBeVisible();
  });

  test("axe finds nothing to fault on the working, idle and stopped screens, light and dark", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await expect(panelEnd(page)).toBeVisible();
    await faultless(page);
    await panel(page).getByRole("button", { name: "Add a note" }).click();
    await noteField(page).fill("Go on.");
    await sendAll(page);
    await expect(phaseLine(page)).toHaveText("Claude is preparing round 2.");
    await faultless(page);
    await vellum.grill.answer("Reading the note", { reason: "aborted" });
    await expect(phaseLine(page)).toHaveText(/interrupted/u);
    await faultless(page);
  });

  test("the idle screen's words and buttons read on their surfaces, light and dark", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await expect(phaseLine(page)).toHaveText("Claude has no question open.");

    await readable(page, [
      phaseLine(page),
      panelEnd(page),
      panel(page).getByRole("button", { name: "Add a note" }),
    ]);
  });

  test("the idle screen's contrast after a theme switch waits for the page's transitions", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await expect(phaseLine(page)).toHaveText("Claude has no question open.");
    // Stretched far past the 120 ms the page runs, so a measure taken during it cannot pass by luck.
    await page.addStyleTag({ content: ":root { --transition: 1500ms linear !important; }" });

    await readable(page, [panelEnd(page), panel(page).getByRole("button", { name: "Add a note" })]);
  });

  test("the working and stopped screens' words read on their surfaces, light and dark", async ({
    page,
    vellum,
  }) => {
    await vellum.grill.open(SUBJECT);
    await openVellum(page, vellum);
    await expect(phaseLine(page)).toHaveText(/preparing/u);
    await readable(page, [phaseLine(page)]);
    await page.emulateMedia({ colorScheme: "light" });
    await vellum.grill.answer("Two facts first", { reason: "aborted" });
    await expect(phaseLine(page)).toHaveText(/interrupted/u);

    await readable(page, [phaseLine(page), panelEnd(page)]);
  });
});

function endedNotice(page: Page): Locator {
  return page.locator(".banner", { hasText: "Grill ended" });
}

/** The page on an artifact, so a return to the plan shows. */
async function onArtifact(page: Page): Promise<void> {
  await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();
  await expect(page.locator("#doc .doc-head")).toContainText("pourquoi-issue-139.md");
}

test.describe("the end of a grill", () => {
  test("End grill on the idle screen selects the plan, and a notice counts the decisions", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await onArtifact(page);
    await panelEnd(page).click();

    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator("#rail .plate")).toHaveAttribute("aria-current", "page");
    await expect(endedNotice(page)).toContainText(
      "Grill ended: 2 decisions. Claude proposes the next step.",
    );
  });

  test("the band's End grill returns to the plan as well, the open questions counted", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await onArtifact(page);
    await band(page).getByRole("button", { name: "End grill" }).click();

    await expect(page.locator("#rail .plate")).toHaveAttribute("aria-current", "page");
    await expect(endedNotice(page)).toContainText("Grill ended: 2 decisions.");
  });

  test("the notice opens the transcript in the document pane, and stays", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await panelEnd(page).click();
    await endedNotice(page).getByRole("button", { name: "Read the transcript" }).click();

    await expect(page.locator("#doc .doc-head")).toContainText("grill-2.md");
    await expect(page.locator("#doc .grill-q")).toHaveCount(2);
    await expect(endedNotice(page)).toBeVisible();
  });

  test("the notice goes when dismissed", async ({ page, vellum }) => {
    await answered(page, vellum);
    await panelEnd(page).click();
    await endedNotice(page).getByRole("button", { name: "Dismiss" }).click();

    await expect(endedNotice(page)).toHaveCount(0);
  });

  test("the notice goes when a new grill opens", async ({ page, vellum }) => {
    await answered(page, vellum);
    await panelEnd(page).click();
    await expect(endedNotice(page)).toBeVisible();
    await vellum.grill.open("The budget of the page");

    await expect(panel(page)).toBeVisible();
    await expect(endedNotice(page)).toHaveCount(0);
  });

  test("a grill /vellum:stop ended draws no notice, and the document pane stays", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await onArtifact(page);
    await vellum.grill.close("stop");
    await expect(panel(page)).toHaveCount(0);

    await expect(endedNotice(page)).toHaveCount(0);
    await expect(page.locator("#doc .doc-head")).toContainText("pourquoi-issue-139.md");
  });

  test("axe finds nothing to fault on the notice, and its words read, light and dark", async ({
    page,
    vellum,
  }) => {
    await answered(page, vellum);
    await panelEnd(page).click();
    const notice = endedNotice(page);
    await expect(notice).toBeVisible();
    await readable(page, [
      notice.locator("span").first(),
      ...(await notice.getByRole("button").all()),
    ]);

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await axe(page, ".banner.ok")).toEqual([]);
    }
  });
});

/** Longer than the band is wide at 1920: its end must be cut, never wrapped. */
const LONG_SUBJECT = Array.from(
  { length: 6 },
  () => "which tool covers which class of defect in the page, where the suite runs,",
).join(" ");

function band(page: Page): Locator {
  return page.locator(".grill-band");
}

/** A colour as a canvas paints it, `rgb(…)`: a `color-mix()` computes to `oklab(…)`, which `contrast` cannot read. */
async function painted(element: Locator, property: "color" | "backgroundColor"): Promise<string> {
  await settled(element.page());

  return await element.evaluate((node, key) => {
    const context = document.createElement("canvas").getContext("2d");

    if (context === null) throw new Error("no 2d context");
    context.fillStyle = getComputedStyle(node)[key];
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;

    return `rgb(${r}, ${g}, ${b})`;
  }, property);
}

/** How many lines a text runs over: a range over it gives one box per line. */
function linesOf(text: Locator): Promise<number> {
  return text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);

    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
}

test.describe("the band", () => {
  test("says the grill's subject, its round and how many questions wait", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);

    await expect(band(page).locator(".subject")).toHaveText(`Grill · ${SUBJECT}`);
    await expect(band(page).locator(".count")).toHaveText("round 1 · 2 questions waiting");
  });

  test("says the round alone once it is sent", async ({ page, vellum }) => {
    await asking(page, vellum);
    await sendAll(page, true);

    await expect(band(page).locator(".count")).toHaveText("round 1");
    await expect(band(page).locator(".subject")).toHaveText(`Grill · ${SUBJECT}`);
  });

  test("its live region is the count alone, never End grill", async ({ page, vellum }) => {
    await asking(page, vellum);

    await expect(band(page).getByRole("status")).toHaveText("round 1 · 2 questions waiting");
    await expect(page.getByRole("status").filter({ hasText: "End grill" })).toHaveCount(0);
  });

  test("counts the questions the draft leaves untouched, as the chips do", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await shown(page).getByRole("radio", { name: "Recommended" }).click();

    await expect(band(page).locator(".count")).toHaveText("round 1 · 1 question waiting");
  });

  test("says the last round asked", async ({ page, vellum }) => {
    await twoRounds(page, vellum);

    await expect(band(page).locator(".count")).toHaveText("round 2 · 2 questions waiting");
  });

  test("says no round before the first", async ({ page, vellum }) => {
    await vellum.grill.open(SUBJECT);
    await openVellum(page, vellum);
    await expect(band(page).locator(".subject")).toHaveText(`Grill · ${SUBJECT}`);

    await expect(band(page).locator(".count")).toHaveText("");
  });

  test("its End grill, the page's one, sends what is typed, then ends", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await panel(page)
      .getByRole("textbox", { name: "Your answer to Q1" })
      .fill("One store per form.");
    await expect(page.getByRole("button", { name: "End grill" })).toHaveCount(1);
    await band(page).getByRole("button", { name: "End grill" }).click();

    await expect(band(page)).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    const told = JSON.stringify((await vellum.channel()).json);
    expect(told).toContain("Q1: One store per form.");
    expect(told).toMatch(/The reviewer ended grill-\d+\.md\./u);
  });

  test("the Next step button hides while it shows, and comes back once the grill ends", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);

    await expect(nextStep(page)).toHaveCount(0);
    await vellum.grill.close();
    await expect(band(page)).toHaveCount(0);
    await expect(nextStep(page)).toBeVisible();
  });

  test("refused reads of the grill's state keep it as it was, the Next step button still hidden", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await band(page).evaluate((element: HTMLElement) => {
      element.dataset["kept"] = "yes";
    });
    await page.route("**/api/x/grill/state*", (route) => route.fulfill({ status: 500 }));
    await readAfter(page, 500, () => vellum.writeFile("notes.md", "One."));
    await readAfter(page, 500, () => vellum.writeFile("notes.md", "Two."));

    await expect(band(page)).toHaveAttribute("data-kept", "yes");
    await expect(band(page).locator(".count")).toHaveText("round 1 · 2 questions waiting");
    await expect(nextStep(page)).toHaveCount(0);
  });

  test("an approval takes it and the panel away, the grill's state refused or not", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await page.route("**/api/x/grill/state*", (route) => route.fulfill({ status: 500 }));
    await page.locator(".bar").getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByRole("button", { name: "Approve anyway" }).click();
    await expect(page.locator(".bar .status")).toHaveText("Approved");

    await expect(band(page)).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
  });

  test("a transcript load that failed is read again at the next workspace event", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await page.route("**/api/x/grill/blocks*", (route) => route.fulfill({ status: 500 }));
    await vellum.grill.answer("Round 1 is on the page.", { asked: true });
    await expect(page.getByRole("alert")).toContainText("could not be loaded");
    await page.unroute("**/api/x/grill/blocks*");
    vellum.writeFile("notes.md", "One.");

    await expect(panel(page).locator(".plan")).toContainText("Round 1 is on the page.");
  });

  test("an event that lands while a transcript load is out reads it again, that load failing", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const held = Promise.withResolvers<void>();
    await page.route(
      "**/api/x/grill/blocks*",
      async (route) => {
        await held.promise;
        await route.fulfill({ status: 500 });
      },
      { times: 1 },
    );
    const out = page.waitForRequest("**/api/x/grill/blocks*");
    await vellum.grill.answer("Round 1 is on the page.", { asked: true });
    await out;
    vellum.writeFile("notes.md", "One.");
    // Shown while the first load is still held: only a read asked for meanwhile can draw it.
    await expect(panel(page).locator(".plan")).toContainText("Round 1 is on the page.");

    const refused = page.waitForResponse(
      (response) => response.url().includes("/x/grill/blocks") && response.status() === 500,
    );

    held.resolve();
    await refused;

    await expect(panel(page).locator(".plan")).toContainText("Round 1 is on the page.");
  });

  test("End grill waits for the transcript, so no answer typed is closed unread", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await panel(page)
      .getByRole("textbox", { name: "Your answer to Q1" })
      .fill("One store per form.");
    await expect
      .poll(async () => JSON.stringify((await vellum.api("draft")).json))
      .toContain("form.");
    await page.route("**/api/x/grill/blocks*", (route) => route.fulfill({ status: 500 }));
    await page.reload();
    const end = band(page).getByRole("button", { name: "End grill" });
    await expect(end).toBeDisabled();
    await page.unroute("**/api/x/grill/blocks*");
    vellum.writeFile("notes.md", "One.");
    await end.click();

    const told = async (): Promise<string> => JSON.stringify((await vellum.channel()).json);
    await expect.poll(told).toContain("Q1: One store per form.");
  });

  test("End grill clicked twice ends once: the note reaches Claude once", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const note = panel(page).getByRole("textbox", { name: "Anything else for Claude" });
    await note.fill("Keep the audit trail.");
    await page.route("**/api/x/grill/close", async (route) => {
      await new Promise((done) => {
        setTimeout(done, 300);
      });
      await route.continue();
    });
    await band(page).getByRole("button", { name: "End grill" }).dblclick();
    await expect(band(page)).toHaveCount(0);

    const told = JSON.stringify((await vellum.channel()).json);
    expect(told.split("Keep the audit trail.")).toHaveLength(2);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a long subject is cut on its one line, and End grill stays in the band", async ({
    page,
    vellum,
  }) => {
    await vellum.grill.open(LONG_SUBJECT);
    await vellum.grill.ask(ROUND);
    await openVellum(page, vellum);
    const subject = band(page).locator(".subject");
    await expect(band(page).locator(".count")).toHaveText("round 1 · 2 questions waiting");

    expect(await subject.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    await expect(subject).toHaveCSS("text-overflow", "ellipsis");
    expect([await linesOf(subject), await linesOf(band(page).locator(".count"))]).toEqual([1, 1]);
    const [box, end] = [await boxOf(band(page)), await boxOf(band(page).getByRole("button"))];
    expect(end.x + end.width).toBeLessThanOrEqual(box.x + box.width);
    expect(end.y + end.height).toBeLessThanOrEqual(box.y + box.height);
  });

  test("axe finds nothing to fault on it, light and dark", async ({ page, vellum }) => {
    await asking(page, vellum);

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await axe(page, ".grill-band")).toEqual([]);
    }
  });

  test("its words read on its colour, light and dark", async ({ page, vellum }) => {
    await asking(page, vellum);
    const end = band(page).getByRole("button", { name: "End grill" });

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await ratio(band(page).locator(".subject"), band(page))).toBeGreaterThanOrEqual(4.5);
      expect(await ratio(band(page).locator(".count"), band(page))).toBeGreaterThanOrEqual(4.5);
      expect(await ratio(end, band(page))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("its End grill still reads under the pointer, light and dark", async ({ page, vellum }) => {
    await asking(page, vellum);
    const end = band(page).getByRole("button", { name: "End grill" });
    await end.hover();

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect
        .poll(async () =>
          contrast(await painted(end, "color"), await painted(end, "backgroundColor")),
        )
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  test("its End grill's focus ring shows on its colour, light and dark", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    const end = band(page).getByRole("button", { name: "End grill" });
    await end.focus();

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const ring = await end.evaluate((element) => getComputedStyle(element).outlineColor);

      const surface = await band(page).evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );

      expect(contrast(ring, surface)).toBeGreaterThanOrEqual(3);
    }
  });
});
