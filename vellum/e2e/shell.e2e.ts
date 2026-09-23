import type { Locator, Page } from "@playwright/test";

import type { Box } from "./harness.ts";
import { axe, boxOf, expect, openVellum, readFixture, reviewV1, test } from "./harness.ts";

/**
 * The shell: the handles keep a gutter of their own, the bar holds one line and names the plan,
 * the page has its landmarks, the rail says which document shows, the comments panel loads folded
 * at 900px, and nothing jumps.
 */

async function addGeneralComment(page: Page, text: string): Promise<void> {
  await page.locator("#global").fill(text);
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".comments .card").last()).toContainText(text);
}

/** The pane's border box, and the width of the scrollbar it draws inside it. */
function paneGeometry(page: Page): Promise<Box & { readonly bar: number }> {
  return page
    .locator(".pane")
    .first()
    .evaluate((pane: HTMLElement) => {
      const rect = pane.getBoundingClientRect();

      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        bar: pane.offsetWidth - pane.clientWidth,
      };
    });
}

/** The class of the element drawn at a point of the viewport. */
function under(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ([px, py]) => document.elementFromPoint(px, py)?.className.toString() ?? "",
    [x, y] as const,
  );
}

/** Where a commented block's margin fillet is drawn, in the viewport. */
function fillet(block: Locator): Promise<{ readonly x: number; readonly y: number }> {
  return block.evaluate((element) => {
    const after = getComputedStyle(element, "::after");
    const box = element.getBoundingClientRect();

    return {
      x: box.left + Number.parseFloat(after.left),
      y: box.top + Number.parseFloat(after.top),
    };
  });
}

test.describe("the handles have a gutter", () => {
  test("the pane, its scrollbar and a mockup stop before the handles", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const left = await boxOf(page.locator(".handle.left"));
    const right = await boxOf(page.locator(".handle.right"));
    const pane = await paneGeometry(page);

    expect(pane.bar).toBeGreaterThan(0);
    expect(pane.x).toBeGreaterThanOrEqual(left.x + left.width);
    expect(pane.x + pane.width).toBeLessThanOrEqual(right.x);

    await page.locator("#rail button", { hasText: "mockup.html" }).click();
    const frame = await boxOf(page.locator(".pane iframe"));

    expect(frame.x).toBeGreaterThanOrEqual(left.x + left.width);
    expect(frame.x + frame.width).toBeLessThanOrEqual(right.x);
  });

  test("the thumb under the handle is the pane's, and a click on it folds nothing", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const handle = await boxOf(page.locator(".handle.right"));
    const pane = await paneGeometry(page);
    const x = pane.x + pane.width - pane.bar / 2;
    const y = handle.y + handle.height / 2;

    expect(await under(page, x, y)).toBe("pane");
    await page.mouse.click(x, y);
    await expect(page.locator(".handle.right")).toHaveAttribute("aria-expanded", "true");
  });

  test("the editor's text stops before the handle and its badge", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "One general remark.");
    await page.locator(".tools .btn", { hasText: "Edit" }).click();
    const area = page.locator(".editor textarea");
    await expect(area).toBeVisible();

    const text = await area.evaluate((element) => {
      const rect = element.getBoundingClientRect();

      return {
        right: rect.right - Number.parseFloat(getComputedStyle(element).paddingRight),
        width: rect.width,
      };
    });

    const badge = await boxOf(page.locator(".handle.right .badge"));

    expect(text.right).toBeLessThanOrEqual(badge.x);
    expect(text.width).toBeLessThanOrEqual(900);
  });

  test("a comment's fillet is never under the handle, whatever the item's depth", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await page.locator(".tools [role=switch]", { hasText: "Comment" }).click();
    const heading = page.locator("article.plan > h2", { hasText: "Slices" });
    const item = page.locator("article.plan > ol > li").nth(1);

    const nested = page
      .locator("article.plan > ol > li")
      .first()
      .locator(":scope > ul > li")
      .first();

    for (const [block, dx] of [
      [heading, 40],
      [item, 60],
      [nested, 60],
    ] as const) {
      await block.scrollIntoViewIfNeeded();
      const box = await boxOf(block);
      await page.mouse.click(box.x + dx, box.y + 8);
      await page.keyboard.type("x");
      await page.keyboard.press("Control+Enter");
    }

    await expect(page.locator(".comments .card")).toHaveCount(3);
    const handle = await boxOf(page.locator(".handle.left"));

    await heading.evaluate(
      (element, y) => {
        const pane = element.closest(".pane");

        if (pane === null) throw new Error("no pane");
        pane.scrollTop += element.getBoundingClientRect().top - y;
      },
      handle.y + handle.height / 2 - 16,
    );

    const ofHeading = await fillet(heading);
    const ofItem = await fillet(item);
    const ofNested = await fillet(nested);

    expect(await under(page, ofHeading.x + 1, ofHeading.y + 6)).not.toContain("handle");
    expect(ofHeading.x).toBeGreaterThanOrEqual(handle.x + handle.width);
    expect(Math.abs(ofNested.x - ofItem.x)).toBeLessThan(1);
  });
});

test.describe("the bar", () => {
  test("holds one line with a badge and a grill open", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "One general remark.");
    await vellum.grill.open("Where do drafts live?");
    await expect(page.locator(".bar .status", { hasText: "Grill" })).toBeVisible();
    const bar = await boxOf(page.locator(".bar"));

    const tops = await page
      .locator(".bar .btn")
      .evaluateAll((buttons) =>
        buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
      );

    expect(bar.height).toBeLessThan(60);
    expect(new Set(tops).size).toBe(1);
  });

  test("the first badge moves nothing: the buttons keep one height", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const before = await boxOf(page.locator(".doc-head"));
    await addGeneralComment(page, "One general remark.");
    const after = await boxOf(page.locator(".doc-head"));
    const send = await boxOf(page.locator(".bar .btn.send"));
    const approve = await boxOf(page.getByRole("button", { name: "Approve", exact: true }));

    expect(after.y).toBe(before.y);
    expect(send.height).toBeCloseTo(approve.height, 0);
  });

  test("names the plan, whole, in the bar and in the tab, and follows the reviewer's edit", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const title = page.locator(".bar .title");
    const name = "Offline sync for the field inspection app, with conflict review before merge";
    await expect(title).toHaveText(name);
    await expect(title).toHaveAttribute("title", name);
    await expect(page).toHaveTitle(`${name} · Vellum`);

    await page.locator(".tools .btn", { hasText: "Edit" }).click();
    const area = page.locator(".editor textarea");
    await area.fill((await area.inputValue()).replace(/^# .*$/mu, "# Offline drafts, retitled"));
    await page.locator(".tools .btn", { hasText: "Done" }).click();

    await expect(title).toHaveText("Offline drafts, retitled");
    await expect(page).toHaveTitle("Offline drafts, retitled · Vellum");
  });

  test("gives the title the room the window has", async ({ page, vellum }, info) => {
    test.skip(info.project.name !== "light-1920", "the room is a wide window's");
    await reviewV1(page, vellum);

    const clipped = await page
      .locator(".bar .title")
      .evaluate((element) => element.scrollWidth > element.clientWidth);

    expect(clipped).toBe(false);
  });
});

test.describe("the landmarks", () => {
  test("a skip link leads to the one main, under a header", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.keyboard.press("Tab");
    const skip = page.locator("a.skip");
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page.locator("main#doc")).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("main") !== null)).toBe(true);
    await expect(page.locator("main#doc")).toHaveCount(1);
    await expect(page.locator("header.bar")).toHaveCount(1);
    const ids = (await axe(page)).map((violation) => violation.id);
    expect(ids).not.toContain("landmark-one-main");
    expect(ids).not.toContain("aria-allowed-attr");
  });

  test("the rail says which document shows", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "mockup.html" }).click();
    const current = page.locator("#rail button[aria-current='page']");

    await expect(current).toHaveCount(1);
    await expect(current).toContainText("mockup.html");
    await expect(page.locator("#rail [aria-selected]")).toHaveCount(0);
  });

  test("the page carries its icon, so no tab asks for /favicon.ico", async ({ page, vellum }) => {
    await reviewV1(page, vellum);

    await expect(page.locator("link[rel=icon]")).toHaveAttribute("href", /^data:image\/svg\+xml/u);
  });
});

/** The rail slid out by its whole width, whatever the window gave it. */
async function railFolded(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator("#rail").evaluate((rail) => {
        const slid = -Number.parseFloat(getComputedStyle(rail).marginLeft);

        return Math.abs(slid - rail.getBoundingClientRect().width) < 1;
      }),
    )
    .toBe(true);
}

test.describe("the rail's handle", () => {
  test("two clicks 150 ms apart on the folded handle open the rail and change no document", async ({
    page,
    vellum,
  }) => {
    for (let i = 1; i <= 24; i += 1)
      vellum.writeFile(`note-${String(i).padStart(2, "0")}.md`, `# Note ${i}\n`);
    await reviewV1(page, vellum);
    await expect(page.locator("#rail button", { hasText: "note-24.md" })).toBeVisible();
    const head = page.locator(".doc-head .path");
    const shown = await head.textContent();
    const handle = page.locator(".handle.left");
    await handle.click();
    await expect(handle).toHaveAttribute("aria-expanded", "false");
    await railFolded(page);
    const chevron = await boxOf(handle.locator(".chevron"));
    const x = chevron.x + chevron.width / 2;
    const y = chevron.y + chevron.height / 2;

    await page.mouse.click(x, y);
    await page.waitForTimeout(150);
    await page.mouse.click(x, y);

    await expect(handle).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(500);
    await expect(head).toHaveText(shown ?? "");
  });

  test("a line clicked 50 ms after the unfolding, away from the handle, is chosen", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const handle = page.locator(".handle.left");
    await handle.click();
    await railFolded(page);
    await handle.click();
    await page.waitForTimeout(50);
    const line = await boxOf(page.locator("#rail button", { hasText: "research-notes.md" }));
    await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);

    await expect(page.locator(".doc-head .path")).toContainText("research-notes.md");
  });
});

/**
 * Records, from before the page's scripts run, each class `#comments` takes, in order, joined
 * by ` | ` in the root's `data-comments-seen`.
 */
async function recordCommentsClass(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];

    const observer = new MutationObserver(() => {
      const now = document.querySelector("#comments")?.className;

      if (now === undefined || now === seen.at(-1)) return;
      seen.push(now);
      document.documentElement.dataset["commentsSeen"] = seen.join(" | ");
    });

    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  });
}

test.describe("in a window 900px wide", () => {
  test.use({ viewport: { width: 900, height: 600 } });

  test("the comments panel is folded from its first render", async ({ page, vellum }, info) => {
    test.skip(info.project.name !== "light-1440", "the window is the test's own at every project");
    await recordCommentsClass(page);
    await reviewV1(page, vellum);
    await expect(page.locator("#comments")).toHaveAttribute("inert", "");
    await expect(page.locator("html")).toHaveAttribute("data-comments-seen", "comments folded");
  });
});

test.describe("the sheet", () => {
  test("headings hold the prose's measure", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const h1 = await boxOf(page.locator(".plan h1"));
    const prose = await boxOf(page.locator(".plan > p").first());

    expect(h1.width).toBeLessThanOrEqual(prose.width + 1);
  });

  test("the tools row keeps one height from an image to a mockup", async ({ page, vellum }) => {
    await reviewV1(page, vellum);

    const heightOf = (): Promise<number> =>
      page.locator(".tools").evaluate((element) => element.getBoundingClientRect().height);

    const plan = await heightOf();
    await page.locator("#rail button", { hasText: "capture.png" }).click();
    await expect(page.locator(".image img")).toBeVisible();
    const image = await heightOf();
    await page.locator("#rail button", { hasText: "mockup.html" }).click();
    await expect(page.locator(".pane iframe")).toBeVisible();
    const mockup = await heightOf();

    expect([image, mockup]).toEqual([plan, plan]);
  });

  test("a focused control of a grill stays above its foot", async ({ page, vellum }) => {
    await vellum.gate();
    vellum.writePlan(readFixture("rich-v2", "plan.md"));
    await vellum.gate();
    await vellum.grill.open("Where do drafts live?");
    await vellum.grill.ask([
      ["Storage", "IndexedDB or localStorage for the drafts?", "IndexedDB: no 5 MB cap."],
      ["Conflicts", "Who wins a conflict?", "The inspector, field by field."],
      ["Retention", "How long do we keep a draft once accepted?", "30 days."],
      ["Photos", "Do photos replay with the form or after it?", "After it, chunked."],
      ["Badge", "Where does the pending badge sit?", "On the form card, top right."],
      ["Timer", "Is 30 s right for the replay timer?", "Yes, with backoff."],
    ]);
    await openVellum(page, vellum);
    const panel = page.getByRole("complementary", { name: "Grill" });
    await expect(panel.locator(".grill-q")).toHaveCount(6);
    await page.locator(".handle.left").focus();

    for (let takeIts = 0; takeIts < 3;) {
      await page.keyboard.press("Tab");

      if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Take it")
        takeIts += 1;
    }

    const focused = await page.evaluate(() => {
      const rect = document.activeElement?.getBoundingClientRect();

      if (rect === undefined) throw new Error("nothing focused");

      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    const foot = await boxOf(panel.locator(".grill-foot"));

    expect(focused.y + focused.height).toBeLessThanOrEqual(foot.y);
  });
});
