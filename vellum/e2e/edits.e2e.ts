import type { Locator, Page } from "@playwright/test";

import type { Vellum } from "./harness.ts";
import {
  boxOf,
  commentOn,
  expect,
  feedbackOf,
  openVellum,
  readFixture,
  reviewV1,
  test,
} from "./harness.ts";

/**
 * Edits and changes: a comment on a text the edit removed says so and moves nowhere, unless only
 * the edit held its line, and then it goes with the Done; Discard edit is the reverse of Done
 * and says first which comments go with the edit, the editor hands back the place and the focus,
 * Ctrl+Enter is Done, the comments stay readable meanwhile, and a code block says which lines
 * changed.
 */

async function openEditor(page: Page): Promise<void> {
  await page.locator(".tools").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".editor textarea")).toBeFocused();
}

/** Comments the block under `locator` with `text`, by a click that picks the whole block. */
async function commentBlock(page: Page, locator: Locator, text: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const box = await boxOf(locator);
  await page.mouse.click(box.x + 40, box.y + 8);
  await expect(page.locator(".popover textarea")).toBeFocused();
  await page.keyboard.type(text);
  await page.locator(".popover").getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".comments .card").last()).toContainText(text);
}

async function editPlan(page: Page, change: (text: string) => string): Promise<void> {
  await openEditor(page);
  const area = page.locator(".editor textarea");
  await area.fill(change(await area.inputValue()));
}

async function reviewV2(page: Page, vellum: Vellum): Promise<void> {
  await vellum.gate();
  vellum.writePlan(readFixture("rich-v2", "plan.md"));
  await vellum.gate();
  await openVellum(page, vellum);
  await expect(page.locator(".bar .version")).toHaveText("v2");
}

function fillets(page: Page): Promise<string[]> {
  return page
    .locator(".plan .marked")
    .evaluateAll((blocks) => blocks.map((block) => block.dataset.lines ?? ""));
}

function discarding(page: Page): Locator {
  return page.getByRole("dialog", { name: "Before discarding the edit" });
}

test.describe("a comment on a text the edit removes", () => {
  test("says so on its card and in the feedback, keeps its lines, and marks no block", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await commentBlock(page, page.locator("article.plan blockquote p"), "Decide this first.");
    const card = page.locator(".comments .card").first();
    const where = await card.locator(".where").textContent();
    await page.locator(".tools [role=switch]", { hasText: "Comment" }).click();

    await editPlan(page, (text) =>
      text
        .replace(
          "## Decisions\n",
          "## Context\n\nThree lines the reviewer added.\n\n## Decisions\n",
        )
        .replace(/> Open question:.*\n\n/u, ""),
    );
    await page.getByRole("button", { name: "Done" }).click();

    await expect(card).toContainText("removed by your edit");
    await expect(card.locator(".where")).toHaveText(where ?? "");
    expect(await fillets(page)).toEqual([]);
    await page.getByRole("button", { name: /Send feedback/u }).click();
    await expect(page.locator(".bar .status")).toHaveText("Feedback sent");
    expect(feedbackOf(vellum)).toContain("(removed by the reviewer's edit)");
  });

  test("goes with the Done that removes it when only the edit held its line, and Discard edit brings nothing back", async ({
    page,
    vellum,
  }) => {
    const mine = "One line the reviewer wrote.";
    await reviewV1(page, vellum);
    await editPlan(page, (text) => text.replace("## Decisions\n", `${mine}\n\n## Decisions\n`));
    await page.getByRole("button", { name: "Done" }).click();
    await commentOn(page);
    await commentBlock(page, page.locator("article.plan p", { hasText: mine }), "Why here?");
    await page.locator(".tools [role=switch]", { hasText: "Comment" }).click();

    await editPlan(page, (text) => `${text.replace(`${mine}\n\n`, "")}\nAnother line.\n`);
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".comments .card")).toHaveCount(0);
    await page.getByRole("button", { name: "Discard edit" }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".doc-head .edited")).toHaveCount(0);
    await expect(page.locator(".comments .card")).toHaveCount(0);
  });
});

test.describe("Discard edit", () => {
  test("gives back the count and every fillet to its block", async ({ page, vellum }) => {
    await reviewV2(page, vellum);
    await commentOn(page);
    await commentBlock(page, page.locator("article.plan h2", { hasText: "Slices" }), "Own it.");
    await commentBlock(page, page.locator("article.plan > p").last(), "Then?");
    await page.locator(".tools [role=switch]", { hasText: "Comment" }).click();
    const before = await fillets(page);
    await expect(page.locator(".bar .stat")).toHaveText("+12 −15");

    await editPlan(page, (text) =>
      text.replace(
        "## Decisions\n",
        "## Reviewer note\n\nOne line the reviewer wrote.\n\n## Decisions\n",
      ),
    );
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".doc-head .edited")).toBeVisible();
    await expect(page.locator(".bar .stat")).toHaveText("+16 −15");
    expect(await fillets(page)).not.toEqual(before);

    await page.getByRole("button", { name: "Discard edit" }).click();
    await expect(discarding(page)).not.toContainText("only your edit holds");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".doc-head .edited")).toHaveCount(0);
    await expect(page.locator(".bar .stat")).toHaveText("+12 −15");
    expect(await fillets(page)).toEqual(before);
  });

  test("says first that a comment on a line only the edit holds goes with it", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await editPlan(page, (text) =>
      text.replace("## Decisions\n", "One line the reviewer wrote.\n\n## Decisions\n"),
    );
    await page.getByRole("button", { name: "Done" }).click();
    await commentOn(page);
    const added = page.locator("article.plan p", { hasText: "One line the reviewer wrote." });
    await commentBlock(page, added, "Why here?");

    await page.getByRole("button", { name: "Discard edit" }).click();
    await expect(discarding(page)).toContainText(
      "1 comment is on a line only your edit holds: it goes with the edit.",
    );
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".comments .card")).toHaveCount(0);
  });
});

test.describe("closing the editor", () => {
  test("Done gives back the place and the focus to Edit", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const pane = page.locator(".pane").first();
    await page.locator("article.plan h2", { hasText: "Slices" }).evaluate((heading) => {
      heading.scrollIntoView({ block: "start" });
    });
    const before = await pane.evaluate((element) => element.scrollTop);
    expect(before).toBeGreaterThan(500);

    await openEditor(page);
    await page.keyboard.type("Persist ");
    await page.getByRole("button", { name: "Done" }).click();

    await expect(page.locator(".editor textarea")).toHaveCount(0);
    await expect(
      page.locator(".tools").getByRole("button", { name: "Edit", exact: true }),
    ).toBeFocused();
    await expect
      .poll(() => pane.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before - 60);
    expect(await pane.evaluate((element) => element.scrollTop)).toBeLessThan(before + 60);
  });

  test("Cancel gives back the place too", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const pane = page.locator(".pane").first();
    await page.locator("article.plan h2", { hasText: "Flow" }).evaluate((heading) => {
      heading.scrollIntoView({ block: "start" });
    });
    const before = await pane.evaluate((element) => element.scrollTop);

    await openEditor(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(
      page.locator(".tools").getByRole("button", { name: "Edit", exact: true }),
    ).toBeFocused();
    await expect
      .poll(() => pane.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before - 60);
    expect(await pane.evaluate((element) => element.scrollTop)).toBeLessThan(before + 60);
  });

  test("Ctrl+Enter is Done, and the button says so", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await openEditor(page);
    await expect(page.getByRole("button", { name: /Done/u }).locator("kbd")).toHaveCount(2);
    await page.keyboard.type("Reviewer: a line.\n");
    await page.keyboard.press("Control+Enter");

    await expect(page.locator(".editor textarea")).toHaveCount(0);
    await expect(page.locator(".doc-head .edited")).toBeVisible();
  });
});

test.describe("while editing", () => {
  test("the comments stay readable and scroll, their actions off", async ({ page, vellum }) => {
    await reviewV1(page, vellum);

    for (let i = 1; i <= 9; i += 1) {
      await page.locator("#global").fill(`Comment ${i}: slice ${i} needs an owner and a check.`);
      await page.getByRole("button", { name: "Add comment" }).click();
    }

    await expect(page.locator(".comments .card")).toHaveCount(9);
    await openEditor(page);
    const list = page.locator("#comments .list");
    const box = await boxOf(list);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 800);

    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator("#comments").evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
    await expect(page.locator("#comments")).not.toHaveAttribute("inert", "");
    await expect(
      page.locator(".comments .card button", { hasText: "Delete" }).first(),
    ).toBeDisabled();
    await expect(page.locator("#global")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add comment" })).toBeDisabled();
  });
});

test.describe("Changes since, in a code block", () => {
  test("the added lines alone are highlighted, and the removed run keeps the block's width", async ({
    page,
    vellum,
  }) => {
    await reviewV2(page, vellum);
    await page.locator(".tools [role=switch]", { hasText: "Changes since" }).click();
    const pre = page.locator(".plan pre", { hasText: "purge.ts" });
    await pre.scrollIntoViewIfNeeded();

    const lineOf = (text: string): Promise<{ y: number; height: number }> =>
      pre.evaluate((element, wanted) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);

        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const at = node.textContent?.indexOf(wanted) ?? -1;

          if (at === -1) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + wanted.length);
          const rect = range.getBoundingClientRect();

          return { y: rect.y, height: rect.height };
        }

        throw new Error(`${wanted} not in the block`);
      }, text);

    const bands = pre.locator(".line-added");
    await expect(bands).toHaveCount(2);
    const [purge, app] = [await lineOf("purge.ts"), await lineOf("app.tsx")];
    const drawn = await Promise.all((await bands.all()).map((band) => boxOf(band)));

    for (const line of [purge, app]) {
      expect(
        drawn.some(
          (band) => band.y <= line.y + 2 && band.y + band.height >= line.y + line.height - 2,
        ),
      ).toBe(true);
    }

    // Under the text, not over it: a band paints below the block's content, inside its own stacking context.
    const layering = await pre.evaluate((element) => ({
      isolation: getComputedStyle(element).isolation,
      band: getComputedStyle(element.querySelector(".line-added") ?? element).zIndex,
    }));

    expect(layering).toEqual({ isolation: "isolate", band: "-1" });

    const removed = page.locator(".plan details.removed").filter({
      has: page.locator('div[data-source*="app.tsx"]'),
    });

    const [run, block] = [await boxOf(removed), await boxOf(pre)];
    expect(Math.abs(run.width - block.width)).toBeLessThan(8);
  });
});

test.describe("Changes since, a removed run", () => {
  test("a table carries no removed row where nothing was removed", async ({ page, vellum }) => {
    await reviewV2(page, vellum);
    await expect(page.locator(".plan table tr").first()).toBeVisible();
    await expect(page.locator(".plan tr.removed-row")).toHaveCount(0);

    await page.locator(".tools [role=switch]", { hasText: "Changes since" }).click();
    await expect(page.locator(".plan tr.removed-row")).toHaveCount(1);
  });

  test("follows the checkbox of a task item, and sits in the table as a row", async ({
    page,
    vellum,
  }) => {
    await reviewV2(page, vellum);
    await page.locator(".tools [role=switch]", { hasText: "Changes since" }).click();

    const item = page.locator(".plan li", { hasText: "D4 storage team confirmed" });

    const order = await item.evaluate((element) =>
      [...element.children].map((child) => child.tagName.toLowerCase()),
    );

    expect(order.slice(0, 2)).toEqual(["input", "details"]);

    const row = page.locator(".plan table tr", { has: page.locator("details.removed") });
    await expect(row).toHaveCount(1);
    await expect(row.locator("td[colspan]")).toHaveCount(1);
    const next = await row.evaluate((element) => element.nextElementSibling?.textContent ?? "");
    expect(next).toContain("When to replay");
  });
});
