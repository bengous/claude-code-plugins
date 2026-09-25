import type { Page } from "@playwright/test";

import {
  boxOf,
  expect,
  openVellum,
  readFixture,
  reviewV1,
  sendAll,
  sendButton,
  test,
} from "./harness.ts";

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
    await expect(sendButton(page)).toBeDisabled();
    await expect(page.locator("#approval-notes")).toHaveValue(
      "Keep the audit trail: drafts stay 30 days.",
    );
  });

  test("a 500 on the Send is a banner in plain words, and the comments stay", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "Say which store holds the attachments.");
    await page.route("**/api/send", (route) => route.fulfill({ status: 500, body: "boom" }));
    await sendAll(page);

    const banner = page.locator(".banner.err");
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(banner).toContainText("500");
    await expect(banner).not.toContainText("POST /api");
    await expect(page.locator(".comments .card")).toHaveCount(1);
    await expect(page.locator(".bar .status")).toHaveText("In review");
  });

  test("a greyed button says why in its title", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await expect(sendButton(page)).toBeDisabled();
    await expect(sendButton(page)).toHaveAttribute("title", /comment/iu);

    await openEditor(page);
    const approve = page.locator(".bar").getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeDisabled();
    await expect(approve).toHaveAttribute("title", /Done/u);
    const next = page.getByRole("button", { name: "Next step", exact: true });
    await expect(next).toBeDisabled();
    await expect(next).toHaveAttribute("title", /Done/u);
  });

  test("after a Send nothing waits for the next version: Approve and Next step stay live", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "No.");
    await sendAll(page);
    await expect(page.locator(".bar .status")).toHaveText("In review · 1 sent");

    await expect(page.getByRole("button", { name: "Next step", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  });

  test("two Sends on v2 are two batches, and the page takes comments after each", async ({
    page,
    vellum,
  }) => {
    await vellum.gate();
    vellum.writePlan(readFixture("rich-v2", "plan.md"));
    await reviewV1(page, vellum);
    await addGeneralComment(page, "First batch.");
    await sendAll(page);
    await expect(page.locator(".comments .card")).toHaveCount(0);
    await addGeneralComment(page, "Second batch.");
    await sendAll(page);

    await expect.poll(() => vellum.batches()).toEqual(["v2.feedback-1.md", "v2.feedback-2.md"]);
    expect(vellum.batch("v2.feedback-2.md")).toContain("Second batch.");
    await expect(page.locator(".bar .status")).toHaveText("In review · 2 sent");
    await expect(page.locator("#global")).toBeEnabled();
  });

  test("approved draws no button", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.getByRole("button", { name: "Approve", exact: true }).click();

    await expect(page.locator(".bar .status")).toHaveText("Approved");
    await expect(page.locator(".bar button")).toHaveCount(0);
    await expect(page.locator(".banner.ok code")).toContainText("plans/");
  });

  test("the approval's warning says the review is held, in the holder's words", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await vellum.grill.open("Where do drafts live?");
    await expect(page.locator(".bar .status")).toHaveText("Held · grill 1 is open");
    await page.locator(".bar").getByRole("button", { name: "Approve", exact: true }).click();
    const warning = page.getByRole("dialog", { name: "Before approving" });

    await expect(warning.locator(".warn-text")).toHaveText("The review is held: grill 1 is open.");
    await expect(warning).toContainText("Approving ends it, and what it was doing is lost.");
  });

  test("a second grill opened behind the approval notes brings the warning back", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await vellum.grill.open("Where do drafts live?");
    await expect(page.locator(".bar .status")).toContainText("Held");
    await page.getByRole("button", { name: "Approve with notes…" }).click();
    await page.getByRole("button", { name: "Approve anyway" }).click();
    await vellum.grill.close();
    await vellum.grill.open("Who wins a conflict?");
    await expect(page.locator("#rail button", { hasText: "grill-2.md" })).toBeVisible();
    await page.locator(".popover .btn.send").click();

    await expect(page.getByRole("dialog", { name: "Before approving" })).toBeVisible();
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
  test("says what holds the review, no banner repeats it, and Send still goes", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "Say which store holds the attachments.");
    await vellum.grill.open("Where do drafts live?");

    await expect(page.locator(".bar .status")).toHaveText("Held · grill 1 is open");
    await expect(page.locator(".bar .status")).toHaveCount(1);
    await expect(sendButton(page)).toBeEnabled();
    await expect(page.locator(".banner")).toHaveCount(0);
  });

  test("while a run holds the review, a Send leaves the edit in the draft and says it waits", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    await addGeneralComment(page, "Say which store holds the attachments.");
    await openEditor(page);
    const area = page.locator(".editor textarea");
    await area.fill(`${await area.inputValue()}\nA line the reviewer added.\n`);
    await page.getByRole("button", { name: "Done" }).click();
    await page
      .locator(".bar")
      .getByRole("button", { name: /^Review\b/u })
      .click();
    await expect(page.locator(".bar .status")).toHaveText("Held · plan review 1 of v1 is running");
    await sendAll(page);

    await expect(page.locator(".banner.info")).toHaveText(
      "Your edit waits: plan review 1 of v1 is running. Send it again once that ends.",
    );
    await expect(page.locator(".doc-head .edited")).toBeVisible();
    await expect(sendButton(page)).toContainText("1");
    expect(vellum.batches()).toEqual(["v1.feedback-1.md"]);
    expect(vellum.batch("v1.feedback-1.md")).toContain("Say which store holds the attachments.");
    expect(vellum.batch("v1.feedback-1.md")).not.toContain("A line the reviewer added.");
  });

  test("in drafting, a batch sent is said, and counted", async ({ page, vellum }) => {
    await openVellum(page, vellum);
    await addGeneralComment(page, "Start with the conflict dialog.");
    await sendAll(page);

    await expect(page.locator(".banner.sent")).toContainText("Sent to Claude");
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

/** A grill of the reviewer's own, chosen in the "Next step" window opened blank. */
async function openOwnGrill(page: Page): Promise<void> {
  await page.locator(".bar").getByRole("button", { name: "Next step", exact: true }).click();
  const window = page.getByRole("dialog", { name: "Next step", exact: true });
  await window.getByRole("textbox").fill("The coverage of the page");
  await window.getByRole("button", { name: "Choose" }).click();
}

test.describe("the grill", () => {
  test.use({ fixture: "grill-real" });

  test("a grill the server cannot be reached for is a banner, and no error escapes", async ({
    page,
    vellum,
  }) => {
    await vellum.gate();
    await openVellum(page, vellum);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/x/step/answer", (route) => route.abort());
    await openOwnGrill(page);

    await expect(page.locator(".banner.err")).toContainText("did not reach the server");
    await expect(page.locator(".bar .status")).toHaveText("In review");
    expect(errors).toEqual([]);
  });

  test("a refused Send stays in the banner while the transcript loads again", async ({
    page,
    vellum,
  }) => {
    await vellum.gate();
    await vellum.grill.open("Where do drafts live?");
    await vellum.grill.ask(ROUND_1);
    await openVellum(page, vellum);
    const panel = page.getByRole("complementary", { name: "Grill" });
    await page.route("**/api/send", (route) => route.fulfill({ status: 500, body: "" }));
    await panel.getByRole("textbox", { name: "Your answer to Q1" }).fill("IndexedDB.");
    await sendAll(page, true);
    const banner = page.locator(".banner.err", { hasText: "Not sent" });
    await expect(banner).toBeVisible();

    await vellum.grill.answer("Still asking.", { asked: true });
    await expect(panel.locator(".plan")).toContainText("Still asking.");
    await expect(banner).toBeVisible();
  });

  test("the panel says Claude is working, and a round lands in view", async ({ page, vellum }) => {
    await vellum.gate();
    await openVellum(page, vellum);
    await openOwnGrill(page);

    const panel = page.getByRole("complementary", { name: "Grill" });
    const working = panel.getByRole("status");
    await expect(working).toHaveText("Claude is preparing the first round.");
    await expect(page.locator(".bar .status")).toHaveText("Held · grill 2 is open");
    await vellum.grill.ask(ROUND_1);
    await vellum.grill.answer("Round 1 is on the page.", { asked: true });
    await expect(panel.locator(".grill-chips .chip")).toHaveCount(3);
    await expect(working).toHaveText("");

    const sheet = panel.locator(".grill-sheet");
    await sheet.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await panel.getByRole("textbox", { name: "Your answer to Q1" }).fill("IndexedDB only.");
    await sendAll(page, true);
    await expect(working).toHaveText("Claude is preparing round 2.");
    await sheet.evaluate((element) => element.scrollTo(0, 0));
    await vellum.grill.ask(ROUND_2);
    await vellum.grill.answer("Round 2 is on the page.", { asked: true });
    await expect(panel.locator(".grill-chips .chip")).toHaveCount(6);

    const q4 = await boxOf(panel.locator(".grill-round .grill-q"));
    const foot = await boxOf(panel.locator(".grill-foot"));
    const window = await boxOf(sheet);
    expect(q4.y).toBeGreaterThanOrEqual(window.y - 1);
    expect(q4.y + 40).toBeLessThanOrEqual(foot.y);
  });
});
