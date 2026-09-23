import type { Page } from "@playwright/test";

import type { Reply, Vellum } from "./harness.ts";
import { boxOf, expect, openVellum, readFixture, reviewV1, test } from "./harness.ts";

/**
 * The notices derive from the state: a greyed button says why, the pill says what holds the
 * review, a failed request is a banner in the reviewer's words, a banner leaves with its cause,
 * and the grill's rounds arrive where the reviewer looks.
 */

const ROUND_1 = [
  ["Storage", "IndexedDB or localStorage for the drafts?", "IndexedDB: no 5 MB cap."],
  ["Conflicts", "Who wins a conflict?", "The inspector, field by field."],
  ["Replay", "When is the queue replayed?", "On the online event."],
] as const;

const ROUND_2 = [
  ["Chunks", "How big is an upload chunk?", "512 KiB."],
  ["Retries", "How many retries?", "Three."],
  ["Audit", "Keep accepted drafts?", "Thirty days."],
] as const;

async function addGeneralComment(page: Page, text: string): Promise<void> {
  await page.locator("#global").fill(text);
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".comments .card").last()).toContainText(text);
}

async function openEditor(page: Page): Promise<void> {
  await page.locator(".tools").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".editor textarea")).toBeFocused();
}

/** Claude's final text for a turn of the grill, as the hooks module posts it. */
function claudeSays(vellum: Vellum, text: string): Promise<Reply> {
  return vellum.api("x/grill/answer", { text, reason: "answer", own: true });
}

test.describe("the decisions", () => {
  test("with the server gone they are greyed with a reason, and the note typed stays", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await page.getByRole("button", { name: "Approve with notes…" }).click();
    await page.locator("#approval-notes").fill("Keep the audit trail: drafts stay 30 days.");
    await vellum.stop();

    await expect(page.locator(".banner.err")).toContainText("Connection to the review server lost");
    const approve = page.locator(".bar").getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAttribute("title", /connection/iu);
    await expect(
      page.locator(".bar").getByRole("button", { name: /Send feedback/u }),
    ).toBeDisabled();
    await expect(page.locator("#approval-notes")).toHaveValue(
      "Keep the audit trail: drafts stay 30 days.",
    );
  });

  test("a 500 on the decision is a banner in plain words, and the comments stay", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "Say which store holds the attachments.");
    await page.route("**/api/decision", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.getByRole("button", { name: /Send feedback/u }).click();

    const banner = page.locator(".banner.err");
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(banner).toContainText("500");
    await expect(banner).not.toContainText("POST /api");
    await expect(page.locator(".comments .card")).toHaveCount(1);
    await expect(page.locator(".bar .status")).toHaveText("In review");
  });

  test("a greyed button says why in its title", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const feedback = page.getByRole("button", { name: /Send feedback/u });
    await expect(feedback).toBeDisabled();
    await expect(feedback).toHaveAttribute("title", /comment/iu);

    await openEditor(page);
    const approve = page.locator(".bar").getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAttribute("title", /Done/u);
    const grill = page.getByRole("button", { name: "Grill", exact: true });
    await expect(grill).toBeDisabled();
    await expect(grill).toHaveAttribute("title", /Done/u);
  });

  test("after a feedback they wait for the next version, Grill too", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "No.");
    await page.getByRole("button", { name: /Send feedback/u }).click();
    await expect(page.locator(".bar .status")).toHaveText("Feedback sent");

    const grill = page.getByRole("button", { name: "Grill", exact: true });
    await expect(grill).toBeDisabled();
    await expect(grill).toHaveAttribute("title", /next version/iu);
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveAttribute(
      "title",
      /next version/iu,
    );
  });

  test("approved draws no button", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.locator(".bar .status")).toHaveText("Approved");
    await expect(page.locator(".bar button")).toHaveCount(0);
    await expect(page.locator(".banner.ok code")).toContainText("plans/");
  });

  test("the notes popover puts Approve first", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.getByRole("button", { name: "Approve with notes…" }).click();

    await expect(page.locator(".popover .btn.send")).toContainText("Approve");
  });

  test("a second press on the notes' Approve while the first is in flight sends nothing", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    let sent = 0;

    await page.route("**/api/decision", async (route) => {
      sent += 1;
      await new Promise((done) => {
        setTimeout(done, 600);
      });
      await route.continue();
    });

    await page.getByRole("button", { name: "Approve with notes…" }).click();
    const approve = page.locator(".popover .btn.send");
    await approve.click();
    await expect(approve).toBeDisabled();
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".bar .status")).toHaveText("Approved");

    expect(sent).toBe(1);
    await expect(page.locator(".banner.err")).toHaveCount(0);
  });
});

test.describe("the pill", () => {
  test("says what holds the review, and a banner says it too", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "Say which store holds the attachments.");
    await vellum.grill.open("Where do drafts live?");

    await expect(page.locator(".bar .status")).toHaveText("Held · grill-1.md is open");
    await expect(page.locator(".bar .status")).toHaveCount(1);
    await expect(page.locator(".banner", { hasText: "grill-1.md" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Send feedback/u })).toHaveAttribute(
      "title",
      /grill-1\.md is open/u,
    );
  });

  test("in drafting, a feedback sent is said, and counted", async ({ page, vellum }) => {
    await openVellum(page, vellum);
    await addGeneralComment(page, "Start with the conflict dialog.");
    await page.getByRole("button", { name: /Send feedback/u }).click();

    await expect(page.locator(".banner.sent")).toContainText("sent to Claude");
    await expect(page.locator(".bar .status")).toHaveText("Drafting · 1 sent");
  });
});

test.describe("the stale editor", () => {
  test("its banner leaves with it, and Done is greyed meanwhile", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await openEditor(page);
    await page.keyboard.type("Reviewer: slice 5 adds a rollback.\n");
    vellum.writePlan(readFixture("rich-v2", "plan.md"));
    await vellum.gate();

    const banner = page.locator(".banner.err", { hasText: "v2 arrived" });
    await expect(banner).toBeVisible();
    const done = page.getByRole("button", { name: "Done" });
    await expect(done).toBeDisabled();
    await expect(done).toHaveAttribute("title", /v2/u);

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".editor textarea")).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    await openEditor(page);
    await expect(page.locator(".tools span").first()).toHaveText("Editing the source of v2");
    await expect(page.locator(".banner.err")).toHaveCount(0);
  });
});

test.describe("a deleted card", () => {
  test("can be undone from the banner", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "Say which store holds the attachments.");
    await page.locator(".comments .card").getByRole("button", { name: "Delete" }).click();

    await expect(page.locator(".comments .card")).toHaveCount(0);
    await page.locator(".banner").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".comments .card")).toHaveCount(1);
    await expect(page.locator(".banner", { hasText: "deleted" })).toHaveCount(0);
  });
});

test.describe("the grill", () => {
  test.use({ fixture: "grill-real" });

  test("a grill the server cannot be reached for is a banner, and no error escapes", async ({
    page,
    vellum,
  }) => {
    await vellum.gate();
    await vellum.grill.suggest("The coverage of the page", "three choices");
    await openVellum(page, vellum);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/x/grill/open", (route) => route.abort());
    await page.getByRole("dialog").getByRole("button", { name: "Start" }).click();

    await expect(page.locator(".banner.err")).toContainText("did not reach the server");
    await expect(page.locator(".bar .status")).toHaveText("In review");
    expect(errors).toEqual([]);
  });

  test("a refused reply stays in the banner while the transcript loads again", async ({
    page,
    vellum,
  }) => {
    await vellum.gate();
    await vellum.grill.open("Where do drafts live?");
    await vellum.grill.ask(ROUND_1);
    await openVellum(page, vellum);
    await page.locator("#rail button", { hasText: "grill-2.md" }).click();
    await page.route("**/api/x/grill/reply", (route) => route.fulfill({ status: 409, body: "" }));
    await page.locator(".grill-q").nth(0).locator("textarea").fill("IndexedDB.");
    await page.getByRole("button", { name: "Send answers" }).click();
    const banner = page.locator(".banner.err", { hasText: "refused" });
    await expect(banner).toBeVisible();

    await claudeSays(vellum, "Still asking.");
    await expect(page.locator(".grill-doc .plan")).toContainText("Still asking.");
    await expect(banner).toBeVisible();
  });

  test("the sheet says Claude is working, and a round lands in view", async ({ page, vellum }) => {
    await vellum.gate();
    await vellum.grill.suggest("The coverage of the page", "three choices");
    await openVellum(page, vellum);
    await page.getByRole("dialog").getByRole("button", { name: "Start" }).click();

    const working = page.locator(".grill-doc [role=status]");
    await expect(working).toBeVisible();
    await expect(page.locator(".bar .status")).toHaveText("Held · grill-2.md is open");
    await vellum.grill.ask(ROUND_1);
    await claudeSays(vellum, "Round 1 is on the page.");
    await expect(page.locator(".grill-q")).toHaveCount(3);
    await expect(working).toHaveCount(0);

    const pane = page.locator(".pane").last();
    await pane.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await page.locator(".grill-q").nth(2).locator("textarea").fill("On the online event only.");
    await page.getByRole("button", { name: "Send answers" }).click();
    await expect(working).toBeVisible();
    await vellum.grill.ask(ROUND_2);
    await claudeSays(vellum, "Round 2 is on the page.");
    await expect(page.locator(".grill-q")).toHaveCount(6);

    const q4 = await boxOf(page.locator(".grill-q").nth(3));
    const foot = await boxOf(page.locator(".grill-foot"));
    const window = await boxOf(pane);
    expect(q4.y).toBeGreaterThanOrEqual(window.y - 1);
    expect(q4.y + 40).toBeLessThanOrEqual(foot.y);
  });
});
