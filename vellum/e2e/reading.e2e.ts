import type { Locator, Page } from "@playwright/test";

import type { Reply, Vellum } from "./harness.ts";
import { boxOf, expect, openVellum, reviewV1, test } from "./harness.ts";

/**
 * The sheet, the transcript and the image: a task list tells the truth, an image beside the plan
 * loads and fits, a wide diagram keeps a readable scale, nothing scrolls the pane sideways, a
 * backticked name is a link, a card's Markdown is drawn, its answer reads by its kind, its
 * recommendation fits, its field sends, and a capture opens at its real size.
 */

const ROUND_1 = [
  [
    "Classes to cover",
    "Which classes of defects should a check catch? The focus and `inert`, or the geometry too?",
    "I recommend all three: the six defects named in the fixes of #125 split four to two, and only a live check at 800px holds `readWindow()` today. The tool comes at the next round, once Playwright and happy-dom are measured under `bun test`.",
  ],
  [
    "Where a test dependency lives",
    "Where is a test dependency declared: the root `package.json`, or `vellum/package.json`?",
    "I recommend the root.",
  ],
] as const;

function claudeSays(vellum: Vellum, text: string): Promise<Reply> {
  return vellum.api("x/grill/answer", { text, reason: "answer", own: true });
}

function grillPanel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Grill" });
}

/** Opens a grill with one round asked, and the page on the plan, the round in the panel. */
async function grilling(page: Page, vellum: Vellum): Promise<void> {
  await vellum.gate();
  await vellum.grill.open("The coverage of the page");
  await vellum.grill.ask(ROUND_1);
  await claudeSays(vellum, "Round 1 is on the page.");
  await openVellum(page, vellum);
  await expect(grillPanel(page).locator(".grill-chips .chip")).toHaveCount(2);
}

function scrollOf(locator: Locator): Promise<{ readonly scroll: number; readonly client: number }> {
  return locator.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
  }));
}

test.describe("the sheet", () => {
  test("a done task is checked, disabled, named after its item, and carries no bullet", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const item = page.locator(".plan .task-list-item").first();
    const box = item.locator("input");

    await expect(box).toBeChecked();
    await expect(box).toBeDisabled();
    await expect(box).toHaveAttribute("aria-label", /D1 agreed with the platform team/u);
    await expect(item).toHaveCSS("list-style-type", "none");
  });

  test.describe("with images", () => {
    test.use({ fixture: "reading-edge" });

    test("an image beside the plan loads, and none runs past the pane", async ({
      page,
      vellum,
    }) => {
      await page.setViewportSize({ width: 1024, height: 768 });
      await reviewV1(page, vellum);
      const images = page.locator(".plan img");
      await expect(images).toHaveCount(2);
      const pane = await boxOf(page.locator(".pane").first());

      for (const image of await images.all()) {
        await expect
          .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
        const drawn = await boxOf(image);
        expect(drawn.x + drawn.width).toBeLessThanOrEqual(pane.x + pane.width);
      }
    });
  });

  test("a wide diagram shrinks to 0.8 at most, then its figure scrolls", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const figure = page.locator(".plan figure.mermaid").nth(1);
    await expect(figure.locator("svg")).toBeVisible();

    const scale = await figure.evaluate((element) => {
      const svg = element.querySelector("svg");

      if (svg === null) throw new Error("no svg");

      return svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    });

    expect(scale).toBeGreaterThanOrEqual(0.8);
    const { scroll, client } = await scrollOf(figure);
    expect(scroll).toBeGreaterThan(client);
  });

  test("at 1024 the pane scrolls nowhere sideways: the identifier wraps, the table scrolls alone", async ({
    page,
    vellum,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await reviewV1(page, vellum);
    await expect(page.locator(".plan figure.mermaid svg")).toHaveCount(2);
    const pane = await scrollOf(page.locator(".pane").first());
    expect(pane.scroll).toBeLessThanOrEqual(pane.client);
    const table = await scrollOf(page.locator(".plan .scroll-x").first());
    expect(table.scroll).toBeGreaterThan(table.client);
  });

  test("a document named in backticks is a link that switches the view", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);

    const name = page.locator(".plan a[data-path] > code", {
      hasText: "screens/conflict-dialog.html",
    });

    await expect(name).toHaveCount(1);
    await name.click();

    await expect(page.locator("#rail button[aria-current]")).toContainText("conflict-dialog.html");
  });
});

test.describe("the transcript", () => {
  test.use({ fixture: "grill-real" });

  test("a card's backticks are drawn as code, and its number and topic are a heading", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "grill-1.md" }).click();
    const cards = page.locator(".grill-q");
    await expect(cards).toHaveCount(8);

    await expect(cards.first().locator(".ask code", { hasText: "inert" })).toHaveCount(1);
    await expect(cards.first().locator(".rec code", { hasText: "readWindow()" })).toHaveCount(1);
    await expect(cards.first().locator(".ask")).not.toContainText("`");
    await expect(page.locator(".grill-q h4")).toHaveCount(8);
  });

  test("an answer reads as the reviewer's own, or as the recommendation chosen or by default", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "grill-1.md" }).click();
    const labels = page.locator(".grill-q .answer .label");
    await expect(labels).toHaveCount(8);

    await expect(labels).toHaveText([
      "Your answer",
      "Your answer",
      "Your answer",
      "Your answer",
      "By default",
      "By default",
      "By default",
      "By default",
    ]);
    await expect(page.locator(".grill-q .answer .text").first()).toHaveText("As recommended.");
  });

  test("Recommended is reachable in the panel at 1024, its text within the card", async ({
    page,
    vellum,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await grilling(page, vellum);
    const card = grillPanel(page).locator(".grill-round .grill-q");
    const recommended = card.getByRole("radio", { name: "Recommended" });
    await recommended.evaluate((radio) => radio.scrollIntoView({ block: "center" }));

    const hit = await recommended.evaluate((radio) => {
      const box = radio.getBoundingClientRect();

      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === radio;
    });

    expect(hit).toBe(true);
    const [text, frame] = [await boxOf(card.locator(".grill-choice .text")), await boxOf(card)];
    expect(text.x + text.width).toBeLessThanOrEqual(frame.x + frame.width);
  });

  test("Ctrl+Enter in an answer's field sends the round", async ({ page, vellum }) => {
    await grilling(page, vellum);
    await grillPanel(page).getByRole("button", { name: "Next question, Q2" }).click();
    const field = grillPanel(page).getByRole("textbox", { name: "Your answer to Q2" });
    await field.fill("The plugin's own package.json.");
    await field.press("Control+Enter");

    await expect(grillPanel(page).locator('.grill-chips .chip[data-state="default"]')).toHaveCount(
      1,
    );
    const state = JSON.stringify((await vellum.grill.state()).json);
    expect(state).toContain("Q2: The plugin's own package.json.");
  });

  test("the foot's field is as wide as the cards", async ({ page, vellum }) => {
    await grilling(page, vellum);

    const [card, field] = [
      await boxOf(grillPanel(page).locator(".grill-round .grill-q")),
      await boxOf(grillPanel(page).locator(".grill-foot textarea")),
    ];

    expect(Math.abs(card.width - field.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(card.x - field.x)).toBeLessThanOrEqual(2);
  });
});

test.describe("an image", () => {
  test.use({ fixture: "mockups-edge" });

  test("a click shows it at its real size, and a second one fits it again", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "big.png" }).click();
    const image = page.locator(".image img");
    await expect(image).toBeVisible();
    const pane = page.locator(".pane").first();
    const shown = (): Promise<number> => image.evaluate((img) => img.clientWidth);
    const natural = await image.evaluate((img: HTMLImageElement) => img.naturalWidth);
    expect(natural).toBe(2880);
    expect(await shown()).toBeLessThan(natural);
    await expect(image).toHaveCSS("cursor", "zoom-in");

    await image.click();
    await expect.poll(shown).toBe(natural);
    await expect(image).toHaveCSS("cursor", "zoom-out");
    const wide = await scrollOf(pane);
    expect(wide.scroll).toBeGreaterThan(wide.client);

    await image.click({ position: { x: 10, y: 10 } });
    await expect.poll(shown).toBeLessThan(natural);
  });
});
