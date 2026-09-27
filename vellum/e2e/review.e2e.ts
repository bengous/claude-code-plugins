import type { Locator, Page } from "@playwright/test";

import type { Vellum } from "./harness.ts";
import { expect, openVellum, reviewV1, test } from "./harness.ts";

/**
 * The Review button in the decision bar asks the server for a review of the version under
 * review; the hooks module launches the agent and posts its end, which the harness does here
 * (`vellum.review`). The page shows the run, its ✕, a failure's notice, and the verdict's file
 * in the rail.
 */

function reviewButton(page: Page): Locator {
  return page.locator(".bar").getByRole("button", { name: /^Review\b/u });
}

/** What the core told Claude through the channel: its notices, in order. */
async function notices(vellum: Vellum): Promise<readonly string[]> {
  // SAFETY: the server's own `ChannelLine[]`, serialized by `Response.json` in routes.ts.
  const lines = (await vellum.channel()).json as readonly {
    readonly entry: { readonly kind: string; readonly from?: string; readonly text?: string };
  }[];

  return lines.flatMap(({ entry }) =>
    entry.from === "core" && entry.text !== undefined ? [entry.text] : [],
  );
}

function forget(page: Page): Locator {
  return page.locator(".bar").getByRole("button", { name: "Forget this run" });
}

test("while drafting the button is greyed, and says why", async ({ page, vellum }) => {
  await openVellum(page, vellum);

  await expect(reviewButton(page)).toBeDisabled();
  await expect(reviewButton(page)).toHaveAttribute(
    "title",
    "No version under review yet: submit plan.md first",
  );
});

test("a click asks for a review of the version, and the button runs until the run ends", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await expect(reviewButton(page)).toHaveAttribute(
    "title",
    "Ask vellum:plan-reviewer to review v1",
  );
  await reviewButton(page).click();

  await expect(reviewButton(page)).toHaveText("Review running…");
  await expect(reviewButton(page)).toBeDisabled();
  expect((await vellum.review.state()).json).toEqual({
    run: { kind: "requested", seq: 1, version: 1 },
    failed: null,
    stopping: [],
  });
});

test("the ✕ stays while the run holds the review, forgets the run, and lifts the hold", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await reviewButton(page).click();
  await vellum.review.launched();

  await expect(page.locator(".bar .status")).toHaveText("Held · plan review 1 of v1 is running");
  await forget(page).click();

  await expect(reviewButton(page)).toHaveText("Review");
  await expect(reviewButton(page)).toBeEnabled();
  await expect(page.locator(".bar .status")).toHaveText("In review");
  expect((await vellum.review.state()).json).toEqual({
    run: null,
    failed: null,
    stopping: [{ seq: 1, agentId: "agent-1" }],
  });
});

test("while a run holds the review, Approve warns that what it was doing is lost", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await reviewButton(page).click();

  await expect(page.locator(".bar .status")).toHaveText("Held · plan review 1 of v1 is running");
  await page.locator(".bar").getByRole("button", { name: "Approve", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Before approving" });

  await expect(warning.locator(".warn-text")).toHaveText(
    "The review is held: plan review 1 of v1 is running.",
  );
  await expect(warning).toContainText("Approving ends it, and what it was doing is lost.");
});

test("an open grill greys the button with its reason: one hold at a time", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await vellum.grill.open("Where do drafts live?");

  await expect(page.locator(".bar .status")).toHaveText("Held · grill 1 is open");
  await expect(reviewButton(page)).toBeDisabled();
  await expect(reviewButton(page)).toHaveAttribute("title", "The review is held: grill 1 is open");
});

test("the verdict lands in the rail, with no reload", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  await reviewButton(page).click();
  await vellum.review.launched("claude-opus-5-5");
  await vellum.review.ended({ kind: "answer", text: "## Plan review\n\nStatus: Approved" });

  await expect(page.locator("#rail button", { hasText: "v1-claude-opus-5-5.md" })).toBeVisible();
  await expect(reviewButton(page)).toHaveText("Review");
});

test("a run that ends without a verdict leaves a notice, until dismissed", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await reviewButton(page).click();
  await vellum.review.launched();
  await vellum.review.ended({ kind: "failed", why: "aborted" });
  const notice = page.getByRole("alert").filter({ hasText: "Review failed" });

  await expect(notice).toContainText(
    "vellum:plan-reviewer ended on v1 without a verdict (aborted). Nothing was written.",
  );
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toBeHidden();
});

test("once approved the button is gone", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  await vellum.api("decision", { kind: "approve", edit: null, notes: "" });

  await expect(page.locator(".bar .status")).toContainText("Approved");
  await expect(reviewButton(page)).toHaveCount(0);
});

test("a run records no version of Claude's, and ending without a verdict with plan.md changed tells Claude once (A5)", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await reviewButton(page).click();
  await vellum.review.launched();
  vellum.writePlan("# Plan\n\nRevised while the run held the review.\n");

  expect((await vellum.api("gate", { unchanged: "keep" })).json).toEqual({
    error: "plan review 1 of v1 is running: plan.md waits; you are told when it ends",
  });
  await vellum.review.ended({ kind: "failed", why: "aborted" });
  await expect
    .poll(() => notices(vellum))
    .toEqual([
      "plan.md changed while plan review 1 of v1 was running, which ended without a verdict: check plan.md, then end your turn.",
    ]);
});
