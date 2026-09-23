import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { axe, expect, openVellum, reviewV1, ROOT, test } from "./harness.ts";

/**
 * Settings: the gear at the end of the bar opens a modal of sections, About Vellum the one
 * built, and every way out of it gives the focus back to the gear.
 */

const MANIFEST = join(ROOT, "vellum", ".claude-plugin", "plugin.json");

// SAFETY: plugin.json is this repository's manifest; `validate-marketplace` holds its version.
const { version } = JSON.parse(readFileSync(MANIFEST, "utf8")) as { readonly version: string };

function gear(page: Page) {
  return page.locator(".bar").getByRole("button", { name: "Settings" });
}

function settings(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

test("the gear opens a modal labelled Settings over an inert page", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await gear(page).click();
  await expect(settings(page)).toBeVisible();

  expect(await settings(page).evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
});

test("About Vellum is the current section and shows the version and the commit", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await gear(page).click();
  const nav = settings(page).getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("button", { name: "About Vellum" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const about = settings(page).getByRole("region", { name: "About Vellum" });
  await expect(about.locator(".srow", { hasText: "Version" }).locator("code")).toHaveText(version);
  await expect(about.locator(".srow", { hasText: "Commit" }).locator("code")).toHaveText(
    /^[0-9a-f]{8}$/u,
  );
});

test("the version and the commit select by hand, for a copy", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await gear(page).click();
  const about = settings(page).getByRole("region", { name: "About Vellum" });

  for (const row of ["Version", "Commit"]) {
    const value = about.locator(".srow", { hasText: row }).locator("code");
    await value.click({ clickCount: 3 });
    expect((await page.evaluate(() => getSelection()?.toString() ?? "")).trim()).toBe(
      (await value.textContent()) ?? "",
    );
  }
});

test("Escape closes it and gives the focus back to the gear", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await gear(page).click();
  await expect(settings(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
  await expect(gear(page)).toBeFocused();
});

test("a click on the backdrop closes it, and so does Close", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await gear(page).click();
  await page.mouse.click(8, 400);
  await expect(settings(page)).toHaveCount(0);
  await gear(page).click();
  await settings(page).getByRole("button", { name: "Close" }).click();
  await expect(settings(page)).toHaveCount(0);
});

test("with the notes popover up, the gear closes it and opens the modal", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await page.getByRole("button", { name: "Approve with notes…" }).click();
  await expect(page.locator(".popover")).toBeVisible();
  await gear(page).click();
  await expect(page.locator(".popover")).toHaveCount(0);
  await expect(settings(page)).toBeVisible();
});

test("axe finds nothing to fault on the modal, light and dark", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await gear(page).click();
  await expect(settings(page)).toBeVisible();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await axe(page)).toEqual([]);
  }
});
