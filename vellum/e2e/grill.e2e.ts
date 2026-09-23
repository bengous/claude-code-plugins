import type { Locator, Page } from "@playwright/test";

import { axe, boxOf, contrast, expect, openVellum, test } from "./harness.ts";

/**
 * Claude's proposal is a modal over the page, never opened under a typing: Esc puts it off onto
 * the Grill button, Decline reaches the server, and the Grill button opens the same modal blank.
 */

test.use({ fixture: "grill-real" });

const SUBJECT = "The coverage of the page";

const REASON = "three choices change the interface";

function grillButton(page: Page): Locator {
  return page.locator(".bar").getByRole("button", { name: "Grill", exact: true });
}

/** Whether the Grill button draws its dot, a pseudo-element no locator reaches. */
function dotted(page: Page): Promise<boolean> {
  return grillButton(page).evaluate(
    (button) => getComputedStyle(button, "::after").content !== "none",
  );
}

/** A text's colour against a surface's background: tokens written in hex, which the browser serializes as `rgb(…)`. */
async function ratio(text: Locator, surface: Locator): Promise<number> {
  const color = await text.evaluate((element) => getComputedStyle(element).color);
  const background = await surface.evaluate((element) => getComputedStyle(element).backgroundColor);

  return contrast(color, background);
}

function proposal(page: Page): Locator {
  return page.getByRole("dialog", { name: "Claude suggests a grill" });
}

test.beforeEach(async ({ vellum }) => {
  await vellum.gate();
});

test("a proposal opens a dialog, its subject in the field, and the page behind takes no focus", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  const field = proposal(page).getByRole("textbox", { name: "Subject of the grill" });

  await expect(field).toHaveValue(SUBJECT);
  await expect(field).toBeFocused();
  await page.locator("#global").focus();
  await expect(field).toBeFocused();
});

test("Esc closes it and leaves the dot on the Grill button, whose box stays as it was", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  const before = await boxOf(grillButton(page));
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(proposal(page)).toHaveCount(0);
  expect(await dotted(page)).toBe(true);
  expect(await boxOf(grillButton(page))).toEqual(before);
});

test("the Grill button opens the proposal put off again, with the subject typed over it", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await proposal(page).getByRole("textbox").fill("The coverage, and its budget");
  await page.keyboard.press("Escape");
  await grillButton(page).click();

  await expect(proposal(page).getByRole("textbox")).toHaveValue("The coverage, and its budget");
});

test("Decline reaches the server, and leaves no dot", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await proposal(page).getByRole("button", { name: "Decline" }).click();

  await expect(proposal(page)).toHaveCount(0);
  await expect
    .poll(async () => (await vellum.grill.state()).json)
    .toMatchObject({
      kind: "none",
      proposal: { kind: "declined", declined: { subject: SUBJECT } },
    });
  expect(await dotted(page)).toBe(false);
});

test("a proposal declined elsewhere leaves the modal", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();
  await vellum.grill.decline();

  await expect(proposal(page)).toHaveCount(0);
});

test("a proposal landing on a typing opens nothing: the typing goes on, the dot waits", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await page.locator("#global").fill("Overall: ");
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect.poll(() => dotted(page)).toBe(true);
  await page.keyboard.type("no.");

  await expect(page.locator("#global")).toHaveValue("Overall: no.");
  await expect(proposal(page)).toHaveCount(0);
});

test("the Grill button with no proposal opens it blank, Start greyed until a subject is typed", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await grillButton(page).click();
  const blank = page.getByRole("dialog", { name: "Start a grill" });
  const start = blank.getByRole("button", { name: "Start" });

  await expect(start).toBeDisabled();
  await blank.getByPlaceholder("What should Claude grill you on?").fill("Where do drafts live?");
  await start.click();
  await expect(page.locator(".bar .status")).toHaveText("Held · grill-2.md is open");
});

test("a proposal landing on the blank modal leaves it as typed, and waits on the dot", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await grillButton(page).click();
  const blank = page.getByRole("dialog", { name: "Start a grill" });
  await blank.getByRole("textbox").fill("Where do drafts live?");
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect.poll(() => dotted(page)).toBe(true);

  await expect(blank.getByRole("textbox")).toHaveValue("Where do drafts live?");
  await expect(blank.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("Start is greyed with the Grill button's reason, and Enter opens nothing", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();
  const opens: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/x/grill/open")) opens.push(request.url());
  });
  await vellum.stop();
  const start = proposal(page).getByRole("button", { name: "Start" });

  await expect(start).toHaveAttribute("title", /connection/u);
  await expect(start).toBeDisabled();
  await proposal(page).getByRole("textbox").press("Enter");
  expect(opens).toEqual([]);
});

test("axe finds nothing to fault on the modal, light and dark", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await axe(page)).toEqual([]);
  }
});

test("the modal's words read on their surfaces, light and dark: axe sees none in the top layer", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  const card = page.locator(".dialog-card");
  const start = card.getByRole("button", { name: "Start" });
  const below = page.locator(".dialog-below");

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await ratio(card.locator(".grill-who"), card)).toBeGreaterThanOrEqual(4.5);
    expect(await ratio(card.getByRole("textbox"), card)).toBeGreaterThanOrEqual(4.5);
    expect(await ratio(start, start)).toBeGreaterThanOrEqual(4.5);
    expect(await ratio(below, below)).toBeGreaterThanOrEqual(4.5);
  }
});

/** The page's sheet, then the same sheet under the modal's backdrop, each as a luminance painted on a canvas. */
function dimming(page: Page): Promise<{ readonly sheet: number; readonly under: number }> {
  return page.locator("dialog.dialog").evaluate((dialog) => {
    const app = document.querySelector(".app");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (app === null || context === null) throw new Error("no .app, or no 2d context");

    const paint = (color: string): number => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;

      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const sheet = paint(getComputedStyle(app).backgroundColor);

    return { sheet, under: paint(getComputedStyle(dialog, "::backdrop").backgroundColor) };
  });
}

test("the backdrop dims the page, light and dark", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const { sheet, under } = await dimming(page);

    expect(under).toBeLessThan(sheet);
  }
});
