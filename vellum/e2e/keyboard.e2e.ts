import type { FrameLocator, Locator, Page } from "@playwright/test";

import type { Box } from "./harness.ts";
import { boxOf, commentOn, dragText, expect, readFixture, reviewV1, test } from "./harness.ts";

/**
 * Commenting from the keyboard, and the mockup's overlay: a block takes the focus and Enter,
 * `c` flips the switch from a document alone, a drag released past the sheet still picks, and
 * in a mockup the hover follows the scroll and the pointer, its label stays in view, and a
 * commented passage is boxed as the words that were dragged, the very ones among the same words.
 */

/** Where the focus is: the tag and `data-lines` of the active element, `BODY` when nothing holds it. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;

    return element === null || element === document.body
      ? "BODY"
      : `${element.tagName} ${element instanceof HTMLElement ? (element.dataset.lines ?? "") : ""}`.trim();
  });
}

/** Tab from the switch until the focus enters the sheet, at most ten times. */
async function tabIntoSheet(page: Page): Promise<void> {
  // The blocks become Tab stops in an effect after the switch's render, not with it.
  await expect(page.locator("article.plan h1[tabindex='0']")).toBeAttached();
  await page.locator(".tools [role=switch]", { hasText: "Comment" }).focus();

  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press("Tab");

    if (await page.evaluate(() => document.activeElement?.closest("article.plan") !== null)) return;
  }

  throw new Error("Tab never entered the sheet");
}

type OverlayBox = {
  readonly kind: string;
  readonly rect: Box;
  readonly label: string | null;
  readonly labelRect: Box | null;
  readonly outline: string;
};

/** The frame's overlay, read off its host's shadow root: every box, in frame coordinates. */
function overlay(frame: FrameLocator): Promise<OverlayBox[]> {
  return frame
    .locator(":root > div")
    .last()
    .evaluate((host) =>
      [...(host.shadowRoot?.querySelectorAll(".box") ?? [])].map((box) => {
        const label = box.querySelector(".label");
        const rect = box.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect() ?? null;

        return {
          kind: box.className,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          label: label?.textContent ?? null,
          labelRect:
            labelRect === null
              ? null
              : {
                  x: labelRect.x,
                  y: labelRect.y,
                  width: labelRect.width,
                  height: labelRect.height,
                },
          outline: getComputedStyle(box).outlineWidth,
        };
      }),
    );
}

/** Where the commented marks start, in frame coordinates, as offsets from `x`: `[0]` is one mark there. */
async function marksFrom(frame: FrameLocator, x: number): Promise<number[]> {
  const marks = (await overlay(frame)).filter((box) => box.kind.includes("comment"));

  return marks.map((mark) => Math.round(mark.rect.x - x));
}

/** The box of the characters `from` to `to` of the first text node of `locator`, in its frame's coordinates. */
function charsBox(locator: Locator, from: number, to: number): Promise<Box> {
  return locator.evaluate(
    (element, [first, last]) => {
      const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();

      if (node === null) throw new Error("no text node");
      const range = document.createRange();
      range.setStart(node, first);
      range.setEnd(node, last);
      const { x, y, width, height } = range.getBoundingClientRect();

      return { x, y, width, height };
    },
    [from, to] as const,
  );
}

/** Drags the characters `from` to `to` of `p.offline`, then sends a comment on them. */
async function commentWords(
  page: Page,
  frame: FrameLocator,
  from: number,
  to: number,
): Promise<void> {
  await dragText(page, frame.locator("p.offline"), from, to);
  await expect(page.locator(".popover textarea")).toBeFocused();
  await page.keyboard.type("Say who saves them.");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".comments .card")).toHaveCount(1);
}

async function choose(page: Page, name: string): Promise<FrameLocator> {
  await page.locator("#rail button", { hasText: name }).first().click();
  const frame = page.frameLocator(".pane iframe").last();
  await expect(page.locator(".pane iframe").last()).toBeVisible();

  return frame;
}

test.describe("commenting from the keyboard", () => {
  test("Tab reaches a block, Enter opens the composer on it, and Escape gives the focus back", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await tabIntoSheet(page);
    const block = await focused(page);
    expect(block).toMatch(/^H1 \d+-\d+$/u);

    await page.keyboard.press("Enter");
    await expect(page.locator(".popover textarea")).toBeFocused();
    await expect(page.locator(".popover .quote")).toContainText("Offline sync");
    await page.keyboard.press("Escape");
    await expect(page.locator(".popover")).toHaveCount(0);
    expect(await focused(page)).toBe(block);
  });

  test("Ctrl+Enter on a second block adds it to the pick", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await tabIntoSheet(page);
    await page.keyboard.press("Enter");
    await expect(page.locator(".popover .quote")).toHaveCount(1);
    await page.locator("article.plan > p").first().focus();
    expect(await focused(page)).toMatch(/^P /u);
    await page.keyboard.press("Control+Enter");

    await expect(page.locator(".popover .quote")).toHaveCount(2);
  });

  test("a selection made with the keyboard is picked once Shift is released", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    await tabIntoSheet(page);

    await page
      .locator("article.plan > p")
      .first()
      .evaluate((paragraph) => {
        const node = paragraph.firstChild;

        if (node === null) throw new Error("no text");
        document.getSelection()?.setBaseAndExtent(node, 4, node, 30);
      });

    await page.keyboard.down("Shift");
    await page.keyboard.up("Shift");

    await expect(page.locator(".popover .quote")).toContainText("inspectors lose the");
  });
});

test.describe("the c key", () => {
  test("from the bar it flips nothing; from the sheet it does", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const commentSwitch = page.locator(".tools [role=switch]", { hasText: "Comment" });
    await page.getByRole("button", { name: "Approve", exact: true }).focus();
    await page.keyboard.press("c");
    await expect(commentSwitch).toHaveAttribute("aria-checked", "false");

    await page.locator("article.plan > p").first().click();
    await page.keyboard.press("c");
    await expect(commentSwitch).toHaveAttribute("aria-checked", "true");
  });

  test("from a mockup's frame it flips the switch", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await choose(page, "mockup.html");
    const commentSwitch = page.locator(".tools [role=switch]", { hasText: "Comment" });
    await frame.locator("h1").click();
    await page.keyboard.press("c");

    await expect(commentSwitch).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("a drag past the sheet", () => {
  test("released on the comments panel, it picks what the sheet holds of it", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await commentOn(page);
    // From a paragraph, not the table: a drag out of a table that scrolls sideways scrolls it instead.
    const paragraph = page.locator("article.plan > p").first();
    const box = await boxOf(paragraph);
    const y = box.y + 10;
    await page.mouse.move(box.x + 40, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 8, y, { steps: 8 });
    const panel = await boxOf(page.locator("#comments"));
    await page.mouse.move(panel.x + 40, y, { steps: 8 });
    await page.mouse.up();

    const quote = page.locator(".popover .quote");
    await expect(quote).toHaveCount(1);
    await expect(quote).toContainText("lose the network in basements");
    await expect(quote).not.toContainText("No comments yet");
    expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe("");
  });
});

test.describe("in a mockup", () => {
  test.use({ fixture: "mockups-edge" });

  test("the hover follows the scroll, and leaves with the pointer", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await choose(page, "long.html");
    await commentOn(page);
    const paragraph = frame.locator("section:nth-of-type(2) p");
    const box = await boxOf(paragraph);
    const pointer = { x: box.x + box.width / 2, y: box.y + 10 };
    await page.mouse.move(pointer.x, pointer.y, { steps: 5 });
    await expect
      .poll(async () => (await overlay(frame)).find((b) => b.kind.includes("wash"))?.label)
      .toBe("p");

    for (let i = 0; i < 2; i += 1) await page.mouse.wheel(0, 60);

    await expect.poll(async () => (await boxOf(paragraph)).y).toBeLessThan(box.y - 100);
    const iframe = await boxOf(page.locator(".pane iframe").last());
    const inFrame = { x: pointer.x - iframe.x, y: pointer.y - iframe.y };

    await expect
      .poll(async () => {
        const wash = (await overlay(frame)).find((b) => b.kind.includes("wash"));

        return wash === undefined
          ? "none"
          : wash.rect.y <= inFrame.y && inFrame.y <= wash.rect.y + wash.rect.height;
      })
      .toBe(true);

    await page.mouse.move(700, 30);
    await expect
      .poll(async () => (await overlay(frame)).filter((b) => b.kind.includes("wash")))
      .toEqual([]);
  });

  test("the hover of an element at the top puts its label below, and draws an outline", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await choose(page, "long.html");
    await commentOn(page);
    await frame.locator("#brand").hover();

    await expect
      .poll(async () => {
        const wash = (await overlay(frame)).find((b) => b.kind.includes("wash"));

        return wash?.labelRect === null || wash === undefined
          ? null
          : { below: wash.labelRect.y >= wash.rect.y, outline: wash.outline };
      })
      .toEqual({ below: true, outline: "1px" });
  });
});

test.describe("a comment in a mockup", () => {
  test("a drag's mark boxes the dragged words, not the whole element", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await choose(page, "mockup.html");
    await commentOn(page);
    const paragraph = frame.locator("p.offline");
    const box = await boxOf(paragraph);
    // On the first line, over a few words: at a narrow pane the text wraps, and a drag between two lines takes it whole.
    await page.mouse.move(box.x + 150, box.y + 18);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 18, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator(".popover textarea")).toBeFocused();
    await expect(page.locator(".popover .quote")).not.toContainText("network returns");
    await page.keyboard.type("Say when it was last synced.");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".comments .card")).toHaveCount(1);

    // One box per line of the drag, and none as wide as the paragraph: the words, not the element.
    await expect
      .poll(async () => {
        const marks = (await overlay(frame)).filter((b) => b.kind.includes("comment"));

        return marks.length === 0
          ? "no mark"
          : marks.every((mark) => mark.rect.width < box.width - 100);
      })
      .toBe(true);
  });

  // `p.offline` reads "You are offline. Your answers are saved on this tablet…": "are" at 4 and at 30.
  test("a drag on the second of two same words marks the second", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await choose(page, "mockup.html");
    await commentOn(page);
    await commentWords(page, frame, 30, 33);
    const second = await charsBox(frame.locator("p.offline"), 30, 33);

    await expect.poll(() => marksFrom(frame, second.x)).toEqual([0]);
  });

  test("a drag on the first of two same words marks the first", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await choose(page, "mockup.html");
    await commentOn(page);
    await commentWords(page, frame, 4, 7);
    const first = await charsBox(frame.locator("p.offline"), 4, 7);

    await expect.poll(() => marksFrom(frame, first.x)).toEqual([0]);
  });

  test("two same words picked together with Ctrl are two marks, each on its word", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await choose(page, "mockup.html");
    await commentOn(page);
    const paragraph = frame.locator("p.offline");
    await dragText(page, paragraph, 4, 7);
    await page.keyboard.down("Control");
    await dragText(page, paragraph, 30, 33);
    await page.keyboard.up("Control");
    await expect(page.locator(".popover .quote")).toHaveCount(2);
    await page.keyboard.type("Say who saves them.");
    await page.keyboard.press("Control+Enter");
    const [first, second] = [await charsBox(paragraph, 4, 7), await charsBox(paragraph, 30, 33)];

    await expect.poll(() => marksFrom(frame, first.x)).toEqual([0, Math.round(second.x - first.x)]);
  });

  test("dragged words the mockup no longer holds box their whole element", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await choose(page, "mockup.html");
    await commentOn(page);
    // "saved on this tablet", which the rewrite below takes away.
    await commentWords(page, frame, 34, 54);
    const mockup = readFixture("rich", "mockup.html");
    vellum.writeFile("mockup.html", mockup.replace("saved on this tablet", "kept here"));

    // The paragraph is measured with the marks, in the rewritten document: its width moves with the frame's scrollbar.
    await expect
      .poll(async () => {
        const marks = (await overlay(frame)).filter((b) => b.kind.includes("comment"));
        const paragraph = await boxOf(frame.locator("p.offline"));

        return marks.map((mark) => Math.round(mark.rect.width - paragraph.width));
      })
      .toEqual([0]);
  });
});
