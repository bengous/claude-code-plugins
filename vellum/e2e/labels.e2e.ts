import type { Locator, Page } from "@playwright/test";

import type { Vellum } from "./harness.ts";
import { boxOf, commentOn, dragText, expect, openVellum, reviewV1, test } from "./harness.ts";

/**
 * What the page names: a card says the plan's version and a line, a code block is quoted by
 * its first line, a diagram by its kind, a mockup's element by its label; the rail tells two
 * documents apart and keeps a long name's extension; a card leads to its passage and the list
 * to a new card; beside the plan, each Markdown sheet keeps its own highlights whatever the other
 * paints or clears; the general box beside the plan comments the plan; the transcript's foot says
 * who ended the grill.
 */

const ROUND_1 = [
  ["Storage", "IndexedDB or localStorage?", "IndexedDB."],
  ["Conflicts", "Who wins?", "The inspector."],
] as const;

/** Comments the block under `locator` with `text`, by a click that picks the whole block. */
async function commentBlock(page: Page, locator: Locator, text: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await boxOf(locator);
  await page.mouse.click(box.x + 40, box.y + 8);
  await expect(page.locator(".popover textarea")).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".comments .card", { hasText: text })).toHaveCount(1);
}

function scrollTop(page: Page): Promise<number> {
  return page
    .locator(".pane")
    .first()
    .evaluate((pane) => pane.scrollTop);
}

test.describe("what a card says", () => {
  test("the plan by its version, a passage by its line", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await dragText(page, page.locator("article.plan > p").first(), 4, 30);
    await page.keyboard.type("Which forms?");
    await page.keyboard.press("Control+Enter");

    await expect(page.locator(".comments .card .where")).toHaveText("Plan v1 · line 3");
    await expect(page.locator(".global label")).toHaveText("Comment on Plan v1");
    await expect(page.locator(".doc-head .path")).toHaveText("Plan v1");
  });

  test("a code block by its first line and its length, in mono; a diagram by its kind", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await commentBlock(page, page.locator("article.plan pre").first(), "Why a map?");
    const code = page.locator(".comments .card .quote").first();
    await expect(code).toContainText("export type Draft = {");
    await expect(code).toContainText("(14 lines)");
    await expect(code).not.toContainText("readonly id");
    expect(await code.evaluate((quote) => getComputedStyle(quote).fontFamily)).toContain("Mono");

    const figure = page.locator("article.plan figure.mermaid").first();
    await expect(figure.locator("svg")).toBeVisible();
    await commentBlock(page, figure, "Show the retry path.");
    await expect(page.locator(".comments .card .quote").nth(1)).toHaveText("“diagram (sequence)”");
  });

  test("a mockup's element by its label, never a selector", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "mockup.html" }).click();
    await commentOn(page);
    const frame = page.frameLocator(".pane iframe").last();
    await frame.locator("h1").click();
    // Control pressed while the mockup still holds the focus is dropped at the frame's blur.
    await expect(page.locator(".popover textarea")).toBeFocused();
    // Control held first: the composer lets the pointer through before the click is checked.
    await page.keyboard.down("Control");
    await frame.locator("label[for=notes]").click();
    await page.keyboard.up("Control");
    await expect(page.locator(".popover .quote")).toHaveCount(2);
    await page.keyboard.type("Name the two the same way.");
    await page.keyboard.press("Control+Enter");

    await expect(page.locator(".comments .card .where")).toHaveText("mockup.html · h1, label");
  });
});

test.describe("the rail", () => {
  test.describe("with nested folders", () => {
    test.use({ fixture: "rail-nested" });

    test("tells two documents of the same name apart, and two folders of the same name", async ({
      page,
      vellum,
    }) => {
      await reviewV1(page, vellum);
      const twins = page.locator("#rail button", { hasText: "formulaire.html" });
      await expect(twins).toHaveCount(2);
      await expect(twins.nth(0).locator(".dir")).toHaveText("apres");
      await expect(twins.nth(1).locator(".dir")).toHaveText("avant");

      const cited = page.locator("#rail .away button");
      await expect(cited.filter({ hasText: "architecture.md" }).locator(".dir")).toHaveText(
        "vellum/docs",
      );
      await expect(cited.filter({ hasText: "plugin-testing.md" }).locator(".dir")).toHaveText(
        "docs",
      );
    });
  });

  test("keeps a long name's extension, and widens with the window", async ({ page, vellum }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await reviewV1(page, vellum);
    expect((await boxOf(page.locator("#rail"))).width).toBeGreaterThanOrEqual(300);
    const row = page.locator("#rail button", { hasText: "a-very-long" });
    const ext = row.locator(".ext");
    await expect(ext).toHaveText(".md");

    const [name, extension, button] = [
      await boxOf(row.locator(".name")),
      await boxOf(ext),
      await boxOf(row),
    ];

    expect(extension.x + extension.width).toBeLessThanOrEqual(button.x + button.width);
    expect(extension.x + extension.width).toBeLessThanOrEqual(name.x + name.width + 1);

    const stem = row.locator(".stem");
    expect(await stem.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  });
});

test.describe("the list", () => {
  test("a click on a card leads to its passage, and the cards read in the plan's order", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await commentBlock(page, page.locator("article.plan > p").last(), "Then what?");
    await commentBlock(page, page.locator("article.plan > p").first(), "Which forms?");
    const cards = page.locator(".comments .card");
    await expect(cards.nth(0)).toContainText("Which forms?");
    await expect(cards.nth(1)).toContainText("Then what?");

    await page
      .locator(".pane")
      .first()
      .evaluate((pane) => pane.scrollTo(0, 0));
    expect(await scrollTop(page)).toBe(0);
    await cards.nth(1).click({ position: { x: 20, y: 10 } });
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);
    const passage = await boxOf(page.locator("article.plan > p").last());
    const pane = await boxOf(page.locator(".pane").first());
    expect(passage.y).toBeGreaterThanOrEqual(pane.y);
    expect(passage.y + passage.height).toBeLessThanOrEqual(pane.y + pane.height);
  });

  test("a comment added scrolls the list to its card", async ({ page, vellum }) => {
    await reviewV1(page, vellum);

    for (let i = 1; i <= 12; i += 1) {
      await page.locator("#global").fill(`Comment ${i}: slice ${i} needs an owner and a check.`);
      await page.getByRole("button", { name: "Add comment" }).click();
    }

    const list = page.locator("#comments .list");
    await expect(page.locator(".comments .card")).toHaveCount(12);
    const last = await boxOf(page.locator(".comments .card").last());
    const box = await boxOf(list);
    expect(last.y + last.height).toBeLessThanOrEqual(box.y + box.height + 1);
  });
});

/** The pane of each range of the highlight `name`, by index, the plan's first; -1 in no pane. */
function panesOf(page: Page, name: string): Promise<number[]> {
  return page.evaluate((key) => {
    const panes = [...document.querySelectorAll(".pane")];

    return [...(CSS.highlights.get(key) ?? [])]
      .map((range) => panes.findIndex((pane) => pane.contains(range.startContainer)))
      .toSorted((a, b) => a - b);
  }, name);
}

/**
 * The plan and `research-notes.md` side by side, a comment dragged in each. The split is turned
 * on over another artifact first, so the notes' sheet mounts after the plan's and its effects run
 * last: the order in which one pane's cleanup follows the other's paint.
 */
async function commentedSideBySide(page: Page, vellum: Vellum): Promise<void> {
  await reviewV1(page, vellum);
  await page.locator("#rail button", { hasText: "a-very-long" }).click();
  await page.locator(".tools [role=switch]", { hasText: "Beside the plan" }).click();
  await page.locator("#rail button", { hasText: "research-notes.md" }).click();
  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(page.locator(".pane").nth(1)).toContainText("Replay ordering");
  await commentOn(page);

  for (const [pane, paragraph, text] of [
    [0, 0, "Which forms?"],
    [1, 1, "Which order?"],
  ] as const) {
    const passage = page.locator(".pane").nth(pane).locator("article.plan > p").nth(paragraph);
    await passage.scrollIntoViewIfNeeded();
    await dragText(page, passage, 4, 30);
    await page.keyboard.type(text);
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".comments .card", { hasText: text })).toHaveCount(1);
  }
}

test.describe("a Markdown artifact beside the plan", () => {
  test("each pane keeps its comment's highlight", async ({ page, vellum }) => {
    await commentedSideBySide(page, vellum);

    await expect.poll(() => panesOf(page, "vellum-comment")).toEqual([0, 1]);
  });

  // Blur and focus in one task, as a script's `focus()` gives them; the keyboard and the pointer
  // give them as two events, with a render between.
  test("a focus moved in one step from the artifact's card to the plan's lights the plan's passage", async ({
    page,
    vellum,
  }) => {
    await commentedSideBySide(page, vellum);
    const cards = page.locator(".comments .card");
    await cards.nth(1).getByRole("button", { name: "Edit" }).focus();
    await expect.poll(() => panesOf(page, "vellum-focus")).toEqual([1]);
    await cards.nth(0).getByRole("button", { name: "Delete" }).focus();

    await expect.poll(() => panesOf(page, "vellum-focus")).toEqual([0]);
  });

  test("turning Beside the plan off leaves the artifact's highlight", async ({ page, vellum }) => {
    await commentedSideBySide(page, vellum);
    await page.locator(".tools [role=switch]", { hasText: "Beside the plan" }).click();
    await expect(page.locator(".pane")).toHaveCount(1);

    await expect.poll(() => panesOf(page, "vellum-comment")).toEqual([0]);
  });
});

test.describe("beside the plan", () => {
  test.use({ fixture: "grill-real" });

  async function grilling(page: Page, vellum: Vellum): Promise<void> {
    await vellum.gate();
    await vellum.grill.open("The coverage of the page");
    await vellum.grill.ask(ROUND_1);
    await openVellum(page, vellum);
    await page.locator("#rail button", { hasText: "grill-2.md" }).click();
    await expect(page.locator("#doc .grill-q")).toHaveCount(2);
  }

  test("the general box comments the plan, not the transcript", async ({ page, vellum }) => {
    await grilling(page, vellum);
    await page.locator(".tools [role=switch]", { hasText: "Beside the plan" }).click();
    await page.locator(".handle.right").click();
    await expect(page.locator(".global label")).toHaveText("Comment on Plan v1");
    await page.locator("#global").fill("The plan says nothing of the issue.");
    await page.getByRole("button", { name: "Add comment" }).click();

    await expect(page.locator(".comments .card .where")).toHaveText("Plan v1 · general");
    await expect(page.locator("#rail .plate .badge")).toHaveText("1");
  });

  test("the transcript's foot says who ended the grill, and no session", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "grill-1.md" }).click();
    const sheet = page.locator(".grill-doc");
    await expect(sheet).toContainText("Ended by you");
    await expect(sheet).not.toContainText("session 4cbe3fc8");
    await expect(sheet).not.toContainText("· page");
  });
});
