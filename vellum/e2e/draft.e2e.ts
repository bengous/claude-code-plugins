import type { Locator, Page } from "@playwright/test";

import type { Vellum } from "./harness.ts";
import { commentOn, dragText, expect, openVellum, reviewV1, sendButton, test } from "./harness.ts";

/**
 * The draft carries what is typed: a text typed and visible survives a reload and a change of
 * document, End grill sends the answers typed, and every action that would throw a typed text
 * asks first.
 */

const ROUND = [
  ["Storage", "IndexedDB or localStorage for the drafts?", "IndexedDB: no 5 MB cap."],
  ["Conflicts", "Who wins a conflict?", "The inspector, field by field."],
  ["Replay", "When is the queue replayed?", "On the online event."],
] as const;

async function reload(page: Page): Promise<void> {
  await page.reload();
  await page.locator(".bar .brand").waitFor();
  await expect(page.locator(".plan h1")).toBeVisible();
}

/**
 * Until the saved draft holds `text`. A typing is written once it pauses (`TYPED_WRITE_MS`), and
 * under load it pauses mid-word: a draft saved is not yet the text typed.
 */
async function savedWith(vellum: Vellum, text: string): Promise<void> {
  await expect.poll(async () => JSON.stringify((await vellum.api("draft")).json)).toContain(text);
}

async function openEditor(page: Page): Promise<void> {
  await page.locator(".tools").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".editor textarea")).toBeFocused();
}

function firstLine(page: Page): Promise<string> {
  return page.locator(".editor textarea").evaluate((area) => {
    if (!(area instanceof HTMLTextAreaElement)) throw new Error("no textarea");

    return area.value.split("\n")[0] ?? "";
  });
}

async function addComment(page: Page, text: string): Promise<void> {
  await dragText(page, page.locator("article.plan > p").first(), 4, 60);
  await page.keyboard.type(text);
  await page.locator(".popover").getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".comments .card").last()).toContainText(text);
}

test.describe("what is typed comes back after a reload", () => {
  test("the general box", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.locator("#global").fill("The slices lack an owner.");
    await savedWith(vellum, "The slices lack an owner.");
    await reload(page);

    await expect(page.locator("#global")).toHaveValue("The slices lack an owner.");
  });

  test("a composer opened again on the same document", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await dragText(page, page.locator("article.plan > p").first(), 4, 60);
    await page.keyboard.type("Which forms?");
    await savedWith(vellum, "Which forms?");
    await reload(page);

    await expect(page.locator(".popover")).toHaveCount(0);
    await commentOn(page);
    await dragText(page, page.locator("article.plan > p").nth(1), 0, 15);
    await expect(page.locator(".popover textarea")).toHaveValue("Which forms?");
  });

  test("the editor opened again on the same version", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await openEditor(page);
    await page.keyboard.type("Reviewer: every slice needs an owner.\n");
    await savedWith(vellum, "Reviewer: every slice needs an owner.");
    await reload(page);

    await expect(page.locator(".editor textarea")).toHaveCount(0);
    await openEditor(page);
    expect(await firstLine(page)).toBe("Reviewer: every slice needs an owner.");
  });

  test("a composer's text reloaded at once, before its typing paused", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await dragText(page, page.locator("article.plan > p").first(), 4, 60);
    await page.keyboard.type("Which forms?");
    await reload(page);

    await commentOn(page);
    await dragText(page, page.locator("article.plan > p").nth(1), 0, 15);
    await expect(page.locator(".popover textarea")).toHaveValue("Which forms?");
  });
});

/** The open grill's panel, beside the document pane. */
function grillPanel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Grill" });
}

/** The field of the one question the panel shows, once its chip picked it. */
async function answerField(page: Page, id: string): Promise<Locator> {
  await grillPanel(page)
    .locator(".grill-chips")
    .getByRole("button", { name: id, exact: true })
    .click();

  return grillPanel(page).getByRole("textbox", { name: `Your answer to ${id}` });
}

function noteField(page: Page): Locator {
  return grillPanel(page).getByRole("textbox", { name: "Anything else for Claude" });
}

/** A grill opened on the fixture's plan, its first round asked, drawn in the panel. */
async function roundOne(page: Page, vellum: Vellum): Promise<void> {
  await vellum.gate();
  await vellum.grill.open("Where do drafts live?");
  await vellum.grill.ask(ROUND);
  await openVellum(page, vellum);
  await expect(grillPanel(page).locator(".grill-chips .chip")).toHaveCount(3);
}

test.describe("the grill's answers", () => {
  test.use({ fixture: "grill-real" });

  test("survive a trip to another document", async ({ page, vellum }) => {
    await roundOne(page, vellum);
    await (await answerField(page, "Q1")).fill("IndexedDB, one store per form.");
    await (await answerField(page, "Q2")).fill("The inspector.");
    await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();
    await expect(page.locator("#doc .doc-head")).toContainText("pourquoi-issue-139.md");

    await expect(await answerField(page, "Q1")).toHaveValue("IndexedDB, one store per form.");
    await expect(await answerField(page, "Q2")).toHaveValue("The inspector.");
  });

  test("survive a reload, the note too", async ({ page, vellum }) => {
    await roundOne(page, vellum);
    await (await answerField(page, "Q1")).fill("IndexedDB.");
    await noteField(page).fill("Explain the issue first.");
    await savedWith(vellum, "Explain the issue first.");
    await page.reload();
    await page.locator(".bar .brand").waitFor();

    await expect(await answerField(page, "Q1")).toHaveValue("IndexedDB.");
    await expect(noteField(page)).toHaveValue("Explain the issue first.");
  });

  test("go with a grill Claude closed: the approval asks about nothing", async ({
    page,
    vellum,
  }) => {
    await roundOne(page, vellum);
    await (await answerField(page, "Q2")).fill("The inspector.");
    await vellum.grill.close("stop");
    await expect(grillPanel(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".bar .status")).toHaveText("Approved");
  });

  test("End grill while drafting returns to plan.md, the plan before any version", async ({
    page,
    vellum,
  }) => {
    await vellum.grill.open("Where do drafts live?");
    await openVellum(page, vellum);
    await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();
    await page.locator(".grill-band").getByRole("button", { name: "End grill" }).click();

    await expect(page.locator(".bar .status")).toHaveText("Drafting");
    await expect(page.locator("#rail .plate")).toHaveAttribute("aria-current", "page");
  });

  test("End grill sends the two answers typed, then ends", async ({ page, vellum }) => {
    await roundOne(page, vellum);
    await (await answerField(page, "Q2")).fill("The inspector.");
    await (await answerField(page, "Q3")).fill("Every 30 s as well.");
    await page.locator(".grill-band").getByRole("button", { name: "End grill" }).click();

    await expect(grillPanel(page)).toHaveCount(0);
    await page.locator("#rail button", { hasText: "grill-2.md" }).click();
    const q2 = page.locator("#doc .grill-q").nth(1);
    await expect(q2.locator(".answer .text")).toHaveText("The inspector.");
    const told = JSON.stringify((await vellum.channel()).json);
    expect(told).toContain("Q2: The inspector.\\n\\nQ3: Every 30 s as well.");
    expect(told).toMatch(/The reviewer ended grill-\d+\.md\./u);
  });
});

test.describe("an action that would throw a typed text asks first", () => {
  test("Send names the general box, and sends once agreed, the box keeping its text", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await addComment(page, "Say which forms.");
    await page.locator("#global").fill("The slices lack an owner.");
    await sendButton(page).click();

    const warning = page.getByRole("dialog");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("general");
    await expect(warning).toContainText("It stays here, unsent.");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(warning).toHaveCount(0);
    await expect(page.locator(".bar .status")).toHaveText("In review");

    await sendButton(page).click();
    await page.getByRole("button", { name: "Send anyway" }).click();
    await expect(page.locator(".bar .status")).toHaveText("In review · 1 sent");
    await expect(page.locator("#global")).toHaveValue("The slices lack an owner.");
  });

  test("Cancel in the editor with a text typed asks, and keeps the editor on Cancel", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await openEditor(page);
    await page.keyboard.type("Reviewer: a line.\n");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await firstLine(page)).toBe("Reviewer: a line.");

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".editor textarea")).toHaveCount(0);
    await openEditor(page);
    expect(await firstLine(page)).toBe(
      "# Offline sync for the field inspection app, with conflict review before merge",
    );
  });

  test("Cancel in the editor with nothing typed asks nothing", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await openEditor(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".editor textarea")).toHaveCount(0);
  });
});

test.describe("a card", () => {
  test("Edit reopens its text in place", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await addComment(page, "Say which forms. Tpyo here.");
    const card = page.locator(".comments .card").first();
    await card.getByRole("button", { name: "Edit" }).click();

    const field = card.locator("textarea");
    await expect(field).toHaveValue("Say which forms. Tpyo here.");
    await field.fill("Say which forms. Typo fixed.");
    await card.getByRole("button", { name: "Done" }).click();
    await expect(card.locator("textarea")).toHaveCount(0);
    await expect(card).toContainText("Say which forms. Typo fixed.");
    await expect(card).not.toContainText("Tpyo");
  });

  test("Edit cleared keeps the last words in the draft, and Done waits for some", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await addComment(page, "Say which forms.");
    const card = page.locator(".comments .card").first();
    await card.getByRole("button", { name: "Edit" }).click();
    await card.locator("textarea").fill("");

    await expect(card.getByRole("button", { name: "Done" })).toBeDisabled();
    await expect
      .poll(async () => JSON.stringify((await vellum.api("draft")).json))
      .toContain('"body":"Say which forms."');
    await card.locator("textarea").fill("Name the forms.");
    await card.getByRole("button", { name: "Done" }).click();
    await expect(card).toContainText("Name the forms.");
  });
});
