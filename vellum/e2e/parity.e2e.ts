import type { Page } from "@playwright/test";

import { commentOn, expect, openVellum, reviewV1, settled, test } from "./harness.ts";

/**
 * A throwaway reference of the page's pixels, taken on the code before the framework swap and
 * compared on the code after it: four fixtures at three windows, the Mermaid figures masked since
 * their SVG is drawn outside the page's components. It leaves with the swap: a golden file says
 * that something moved, never what (`tests.md`).
 */

const WINDOWS = new Set(["light-1440", "dark-1440", "light-1024"]);

const ROUND = [
  ["Storage", "IndexedDB or localStorage for the drafts?", "IndexedDB: no 5 MB cap."],
  ["Conflicts", "Who wins a conflict?", "The inspector, field by field."],
] as const;

test.beforeEach(async ({ page }, info) => {
  test.skip(!WINDOWS.has(info.project.name), "three windows are the reference");
  await page.emulateMedia({ reducedMotion: "reduce" });
});

/** Every diagram drawn, every image decoded, every font loaded, every transition ended. */
async function drawn(page: Page): Promise<void> {
  const figures = page.locator("figure.mermaid");

  for (const figure of await figures.all()) await expect(figure.locator("svg")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluateAll((images: HTMLImageElement[]) => images.every((image) => image.complete)),
    )
    .toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
}

async function same(page: Page, name: string): Promise<void> {
  await drawn(page);

  await expect(page).toHaveScreenshot(`${name}.png`, {
    mask: [page.locator("figure.mermaid"), page.locator(".grill-when")],
  });
}

test("the plan under review, a comment added, Comment on, the warning before an approval up", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await page.locator("#global").fill("Overall: the conflict screen needs a Cancel.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".comments .card")).toHaveCount(1);
  await commentOn(page);
  await page.getByRole("button", { name: "Approve with notes…" }).click();
  await expect(page.getByRole("dialog", { name: "Before approving" })).toBeVisible();

  await same(page, "rich");
});

test.describe("a grill open", () => {
  test.use({ fixture: "grill-real" });

  test("its band, its panel on the first round, the transcript listed", async ({
    page,
    vellum,
  }) => {
    await vellum.gate();
    await vellum.grill.open("The coverage of the page");
    await vellum.grill.ask(ROUND);
    await openVellum(page, vellum);
    await expect(page.locator(".grill-band")).toBeVisible();
    await expect(page.locator(".grill-panel .grill-q")).toBeVisible();

    await same(page, "grill-real");
  });
});

test.describe("a mockup with a decision", () => {
  test.use({ fixture: "decide" });

  test("an option chosen: its box in the frame, its card in the panel", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "layout.html" }).click();
    const frame = page.frameLocator(".pane iframe");
    await frame.locator('[data-vellum-option="tabs"] [data-vellum-choose]').click();
    await expect(page.locator("#comments .choice-card")).toHaveCount(1);
    await expect(frame.locator("#picked")).toHaveText("Picked in the mockup: tabs");

    await same(page, "decide");
  });
});

test.describe("an image", () => {
  test.use({ fixture: "mockups-edge" });

  test("drawn on its paper", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "diagram.png" }).click();
    await expect(page.locator(".image img")).toBeVisible();

    await same(page, "mockups-edge");
  });
});
