import type { Page } from "@playwright/test";

import { expect, openVellum, readFixture, test } from "./harness.ts";

/** Every state of the page draws its document, and no script of the page throws. */

const QUESTIONS = [
  ["Storage", "IndexedDB or localStorage for the drafts?", "IndexedDB: no 5 MB cap."],
  ["Conflicts", "Who wins a conflict?", "The inspector, field by field."],
] as const;

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  return errors;
}

test("drafting draws the working copy", async ({ page, vellum }) => {
  const errors = pageErrors(page);
  await openVellum(page, vellum);

  await expect(page.locator(".bar .status")).toHaveText("Drafting");
  await expect(page.locator(".plan h1")).toContainText("Offline sync");
  expect(errors).toEqual([]);
});

test("v1 under review draws the version", async ({ page, vellum }) => {
  const errors = pageErrors(page);
  await vellum.gate();
  await openVellum(page, vellum);

  await expect(page.locator(".bar .status")).toHaveText("In review");
  await expect(page.locator(".bar .version")).toHaveText("v1");
  await expect(page.locator(".plan h1")).toContainText("Offline sync");
  expect(errors).toEqual([]);
});

test("v2 with its changes draws the marks", async ({ page, vellum }) => {
  const errors = pageErrors(page);
  await vellum.gate();
  vellum.writePlan(readFixture("rich-v2", "plan.md"));
  await vellum.gate();
  await openVellum(page, vellum);
  await page.locator(".tools [role=switch]", { hasText: "Changes since" }).click();

  await expect(page.locator(".bar .version")).toHaveText("v2");
  await expect(page.locator(".plan .added").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("a grill draws its round in its panel: a chip per question, one question shown", async ({
  page,
  vellum,
}) => {
  const errors = pageErrors(page);
  await vellum.gate();
  await vellum.grill.open("Where do drafts live?");
  await vellum.grill.ask(QUESTIONS);
  await openVellum(page, vellum);
  const panel = page.getByRole("complementary", { name: "Grill" });

  await expect(panel.locator(".grill-chips .chip")).toHaveCount(2);
  await expect(panel.locator(".grill-q")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a mockup draws in its frame", async ({ page, vellum }) => {
  const errors = pageErrors(page);
  await vellum.gate();
  await openVellum(page, vellum);
  await page.locator("#rail button", { hasText: "mockup.html" }).click();

  await expect(page.frameLocator(".pane iframe").locator("h1")).toHaveText(
    "Roof and structure inspection",
  );
  expect(errors).toEqual([]);
});

test("an image draws", async ({ page, vellum }) => {
  const errors = pageErrors(page);
  await vellum.gate();
  await openVellum(page, vellum);
  await page.locator("#rail button", { hasText: "capture.png" }).click();

  await expect(page.locator(".image img")).toBeVisible();
  expect(errors).toEqual([]);
});
