import type { Locator, Page, Route } from "@playwright/test";

import type { Vellum } from "./harness.ts";
import { axe, boxOf, contrast, expect, openVellum, test } from "./harness.ts";

/**
 * Claude's proposal is a modal over the page, never opened under a typing: Esc puts it off onto
 * the Grill button, Decline reaches the server, and the Grill button opens the same modal blank.
 * An open grill is a panel right of the document pane, which the rail keeps choosing.
 */

test.use({ fixture: "grill-real" });

const SUBJECT = "The coverage of the page";

const REASON = "three choices change the interface";

const ROUND = [
  ["Storage", "IndexedDB or localStorage for the drafts?", "IndexedDB: no 5 MB cap."],
  ["Conflicts", "Who wins a conflict?", "The inspector, field by field."],
] as const;

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
  await expect.poll(() => dotted(page)).toBe(false);
});

test("a decline in flight draws no dot", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  // Never answered: the decline stays in flight until the page closes.
  await page.route("**/x/grill/decline", () => null);
  await proposal(page).getByRole("button", { name: "Decline" }).click();
  await expect(proposal(page)).toHaveCount(0);

  expect(await dotted(page)).toBe(false);
});

/** Holds the page's requests to `url` until the returned call lets them through, in order. */
async function hold(page: Page, url: string): Promise<() => Promise<void>> {
  const held: Route[] = [];
  let holding = true;

  await page.route(url, async (route) => {
    if (holding) held.push(route);
    else await route.continue();
  });

  return async () => {
    holding = false;

    for (const route of held.splice(0)) await route.continue();
  };
}

const NEXT_SUBJECT = "The budget of the page";

const REPLACED = "Claude's proposal was already answered or replaced.";

test("a decline of a proposal replaced before the click says so, and the new one waits on the dot", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();
  await vellum.grill.suggest(NEXT_SUBJECT, REASON);
  await expect.poll(() => dotted(page)).toBe(true);
  await proposal(page).getByRole("button", { name: "Decline" }).click();

  await expect(page.getByRole("alert")).toHaveText(REPLACED);
  await expect.poll(() => dotted(page)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a proposal that replaced the one declined, seen once the decline is refused, waits on the dot", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();
  const release = await hold(page, "**/x/grill/state");
  await vellum.grill.suggest(NEXT_SUBJECT, REASON);
  await proposal(page).getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("alert")).toHaveText(REPLACED);
  await release();

  await expect.poll(() => dotted(page)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a proposal seen while a decline is in flight waits on the dot", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();
  const state = await hold(page, "**/x/grill/state");
  const decline = await hold(page, "**/x/grill/decline");
  await vellum.grill.suggest(NEXT_SUBJECT, REASON);
  await proposal(page).getByRole("button", { name: "Decline" }).click();
  await state();
  await expect.poll(() => dotted(page)).toBe(true);
  await decline();

  await expect(page.getByRole("alert")).toHaveText(REPLACED);
  await expect.poll(() => dotted(page)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
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

test("a proposal landing while the plan's editor is open, no field focused, opens nothing", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await page.locator(".tools").getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".editor textarea").blur();
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect.poll(() => dotted(page)).toBe(true);

  await expect(proposal(page)).toHaveCount(0);
});

test("a proposal landing while a popover is up, no field focused, opens nothing", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await page.locator("#global").fill("One general remark.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect.poll(() => dotted(page)).toBe(true);

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

test("a subject typed over lines is one line, as the transcript's header", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await grillButton(page).click();
  const field = page.getByRole("dialog", { name: "Start a grill" }).getByRole("textbox");
  await field.fill("Where do\ndrafts live?");

  await expect(field).toHaveValue("Where do drafts live?");
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

test("Start and Decline are greyed with the Grill button's reason, and Enter opens nothing", async ({
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
  await expect(proposal(page).getByRole("button", { name: "Decline" })).toBeDisabled();
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

function panel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Grill" });
}

/** A grill open on the plan with a round of two questions, and the page drawn on it. */
async function asking(page: Page, vellum: Vellum): Promise<void> {
  await vellum.grill.open(SUBJECT);
  await vellum.grill.ask(ROUND);
  await openVellum(page, vellum);
  await expect(panel(page).locator(".grill-q")).toHaveCount(2);
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

test("a refused read puts the modal off onto the dot, where it stays at the next read", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await vellum.grill.suggest(SUBJECT, REASON);
  await expect(proposal(page)).toBeVisible();
  await page.route("**/api/x/grill/state*", (route) => route.fulfill({ status: 500 }), {
    times: 1,
  });
  await readAfter(page, 500, () => vellum.writeFile("notes.md", "One."));
  await readAfter(page, 200, () => vellum.writeFile("notes.md", "Two."));

  await expect(proposal(page)).toHaveCount(0);
  await expect.poll(() => dotted(page)).toBe(true);
});

test.describe("the panel", () => {
  test("Start opens the grill in a panel right of the document pane", async ({ page, vellum }) => {
    await openVellum(page, vellum);
    await vellum.grill.suggest(SUBJECT, REASON);
    await proposal(page).getByRole("button", { name: "Start" }).click();
    await expect(panel(page)).toBeVisible();

    expect(await rightOf(panel(page), page.locator("#doc"))).toBe(true);
  });

  test("Start leaves the document pane on what it shows", async ({ page, vellum }) => {
    await openVellum(page, vellum);
    await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();
    await vellum.grill.suggest(SUBJECT, REASON);
    await proposal(page).getByRole("button", { name: "Start" }).click();
    await expect(panel(page)).toBeVisible();

    await expect(page.locator("#rail button[aria-current]")).toContainText("pourquoi-issue-139");
  });

  test("selecting an artifact in the rail keeps the panel", async ({ page, vellum }) => {
    await asking(page, vellum);
    await page.locator("#rail button", { hasText: "pourquoi-issue-139.md" }).click();

    await expect(page.locator("#doc .doc-head")).toContainText("pourquoi-issue-139.md");
    await expect(panel(page).locator(".grill-q")).toHaveCount(2);
  });

  test("an answer typed and sent in the panel reaches the server, and Claude works", async ({
    page,
    vellum,
  }) => {
    await asking(page, vellum);
    await panel(page).getByRole("textbox", { name: "Answer to Q1" }).fill("One store per form.");
    await panel(page).getByRole("button", { name: "Send answers" }).click();

    await expect
      .poll(async () => (await vellum.grill.state()).json)
      .toMatchObject({ kind: "open", phase: "working" });
    expect(JSON.stringify((await vellum.grill.state()).json)).toContain("Q1: One store per form.");
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
