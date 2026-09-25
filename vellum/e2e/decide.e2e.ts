import type { FrameLocator, Locator, Page } from "@playwright/test";

import type { Vellum } from "./harness.ts";
import {
  boxOf,
  commentOn,
  expect,
  feedbackOf,
  readFixture,
  reviewV1,
  sendAll,
  sendButton,
  test,
} from "./harness.ts";

/**
 * A choice in a mockup: « Choose » adds the option to the draft and marks it, another option of
 * the same decision replaces it, a reload keeps both, and the one Send takes it into the batch.
 * With Comment on, a click on « Choose » is a pick like any other.
 */

test.use({ fixture: "decide" });

async function openMockup(page: Page, name = "layout.html"): Promise<FrameLocator> {
  await page.locator("#rail button", { hasText: name }).first().click();
  await expect(page.locator(".pane iframe").last()).toBeVisible();

  return page.frameLocator(".pane iframe").last();
}

function chooseButton(frame: FrameLocator, option: string) {
  return frame.locator(`[data-vellum-option="${option}"] [data-vellum-choose]`);
}

/** The options the overlay boxes as chosen, each with its tag's words: a box drawn over exactly that option. */
function marked(frame: FrameLocator): Promise<readonly string[]> {
  return frame
    .locator(":root > div")
    .last()
    .evaluate((host) => {
      const boxes = [...(host.shadowRoot?.querySelectorAll(".box.choice") ?? [])];
      const options = [...document.querySelectorAll<HTMLElement>("[data-vellum-option]")];

      return boxes.map((box) => {
        const { x, y, width, height } = box.getBoundingClientRect();

        const option = options.find((one) => {
          const at = one.getBoundingClientRect();

          return [at.x - x, at.y - y, at.width - width, at.height - height].every(
            (gap) => Math.abs(gap) < 1,
          );
        });

        return `${option?.dataset.vellumOption ?? "nothing"}: ${box.querySelector(".label")?.textContent ?? ""}`;
      });
    });
}

/** A choice's card in the comments panel. */
function choiceCard(page: Page): Locator {
  return page.locator("#comments .choice-card");
}

async function drafted(vellum: Vellum): Promise<string> {
  return JSON.stringify((await vellum.api("draft")).json);
}

test.describe("a choice in a mockup", () => {
  test("Choose marks the option and adds it to the draft; another option of the decision replaces it", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await expect(sendButton(page)).toHaveText("Send");

    await chooseButton(frame, "sidebar").click();
    await expect.poll(() => marked(frame)).toEqual(["sidebar: Chosen"]);
    await expect(sendButton(page)).toHaveText("Send 1");
    await expect(frame.locator("#picked")).toHaveText("Picked in the mockup: sidebar");

    await chooseButton(frame, "tabs").click();
    await expect.poll(() => marked(frame)).toEqual(["tabs: Chosen"]);
    await expect(sendButton(page)).toHaveText("Send 1");
    await expect.poll(() => drafted(vellum)).toContain('"layout":{"option":"tabs"');
  });

  test("a reload keeps the choice and its mark", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await chooseButton(frame, "tabs").click();
    await expect.poll(() => drafted(vellum)).toContain('"option":"tabs"');

    await page.reload();
    await page.locator(".bar .status").waitFor();
    const again = await openMockup(page);

    await expect.poll(() => marked(again)).toEqual(["tabs: Chosen"]);
    await expect(sendButton(page)).toHaveText("Send 1");
    await expect(choiceCard(page)).toHaveCount(1);
  });

  test("each choice has its card: the mockup, the decision, the option chosen", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await chooseButton(frame, "tabs").click();

    await expect(choiceCard(page).locator(".where")).toHaveText("layout.html · layout");
    await expect(choiceCard(page)).toContainText("Chosen: “Tabs”");
    await expect(page.locator("#comments header")).toHaveText("Comments 1");
  });

  test("Send now on a choice's card sends that choice alone: a comment stays, and so does the Send", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await page.locator("#global").fill("Keep the save button in view.");
    await page.getByRole("button", { name: "Add comment" }).click();
    await chooseButton(frame, "tabs").click();
    await expect(sendButton(page)).toHaveText("Send 2");

    await choiceCard(page).getByRole("button", { name: "Send now" }).click();
    await expect.poll(() => vellum.batches()).toHaveLength(1);

    expect(feedbackOf(vellum)).toContain("## Choices\n\n1. ");
    expect(feedbackOf(vellum)).not.toContain("## Comments");
    await expect(choiceCard(page)).toHaveCount(0);
    await expect.poll(() => marked(frame)).toEqual([]);
    await expect(page.locator("#comments .card")).toHaveCount(1);
    await expect(sendButton(page)).toHaveText("Send 1");
  });

  test("Delete on a choice's card withdraws it: the card and the mark go", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await chooseButton(frame, "tabs").click();
    await expect.poll(() => marked(frame)).toEqual(["tabs: Chosen"]);

    await choiceCard(page).getByRole("button", { name: "Delete" }).click();

    await expect(choiceCard(page)).toHaveCount(0);
    await expect.poll(() => marked(frame)).toEqual([]);
    await expect(sendButton(page)).toHaveText("Send");
    await expect.poll(() => drafted(vellum)).not.toContain('"option":"tabs"');
  });

  test("Choose again on the option chosen withdraws it: the card and the mark go", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await chooseButton(frame, "tabs").click();
    await expect(choiceCard(page)).toHaveCount(1);

    await chooseButton(frame, "tabs").click();

    await expect(choiceCard(page)).toHaveCount(0);
    await expect.poll(() => marked(frame)).toEqual([]);
    await expect(sendButton(page)).toHaveText("Send");
  });

  test("the Send takes the choice: the batch names the decision, the option and its Choose, and the mark goes", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await chooseButton(frame, "tabs").click();
    await expect(sendButton(page)).toHaveText("Send 1");

    await sendAll(page);
    await expect.poll(() => vellum.batches()).toHaveLength(1);

    expect(feedbackOf(vellum)).toContain(
      `## Choices\n\n1. \`${vellum.dir}layout.html\`, decision \`layout\`: option \`tabs\`, button "Choose" under "Tabs", \`<button data-vellum-choose>\`\n`,
    );
    await expect.poll(() => marked(frame)).toEqual([]);
    await expect(sendButton(page)).toHaveText("Send");
  });

  test("with Comment on, a click on Choose is a pick: the composer opens, and nothing is chosen", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await commentOn(page);

    await chooseButton(frame, "tabs").click();
    await expect(page.locator(".popover textarea")).toBeFocused();
    await expect(frame.locator("#picked")).toHaveText("Nothing picked in the mockup yet.");
    expect(await marked(frame)).toEqual([]);
    await expect(sendButton(page)).toHaveText("Send");
  });

  test("an approval warns first that it discards the choice not sent", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await chooseButton(frame, "tabs").click();
    await expect(sendButton(page)).toHaveText("Send 1");

    await page.locator(".bar").getByRole("button", { name: "Approve", exact: true }).click();
    const warning = page.getByRole("dialog", { name: "Before approving" });

    await expect(warning.locator(".warn-text")).toHaveText("1 choice is not sent.");
    await expect(warning).toContainText("Approving discards it.");
  });

  test("a click the mockup's own script makes chooses nothing", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page, "edges.html");

    await chooseButton(frame, "roomy").evaluate((button) => {
      if (button instanceof HTMLElement) button.click();
    });
    await chooseButton(frame, "tabs").click();

    // The real click's choice made the whole round trip, which the script's would have made first.
    await expect.poll(() => marked(frame)).toEqual(["tabs: Chosen"]);
    await expect(choiceCard(page)).toHaveCount(1);
  });

  // Each test below lets the first choice land before the duplicate, as a person's pace does, then
  // chooses in another decision: once that one is marked, the duplicate's message has landed too.

  test("the second click of a double click on Choose chooses nothing", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page, "edges.html");
    const box = await boxOf(chooseButton(frame, "tabs"));
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.click(x, y);
    await expect(choiceCard(page)).toHaveCount(1);

    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await chooseButton(frame, "roomy").click();

    await expect.poll(() => marked(frame)).toEqual(["tabs: Chosen", "roomy: Chosen"]);
  });

  test("Enter held on a focused Choose chooses once", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page, "edges.html");
    await chooseButton(frame, "tabs").focus();
    await page.keyboard.down("Enter");
    await expect(choiceCard(page)).toHaveCount(1);

    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await chooseButton(frame, "roomy").click();

    await expect.poll(() => marked(frame)).toEqual(["tabs: Chosen", "roomy: Chosen"]);
  });

  test("a click on a label that is its option's Choose chooses once, though the label forwards it to its radio", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page, "edges.html");

    await frame.getByText("Dark").click();
    await chooseButton(frame, "roomy").click();

    await expect.poll(() => marked(frame)).toEqual(["roomy: Chosen", "dark: Chosen"]);
  });

  test("a card names the option by the heading the option holds, else by its key", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page, "edges.html");

    await chooseButton(frame, "tabs").click();
    await chooseButton(frame, "roomy").click();

    await expect(choiceCard(page)).toHaveText([/Chosen: “Tabs”/u, /Chosen: “roomy”/u]);
  });

  test("a choice whose option the mockup no longer holds is flagged, and left out of the Send and its count", async ({
    page,
    vellum,
  }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await chooseButton(frame, "tabs").click();
    await expect(sendButton(page)).toHaveText("Send 1");

    vellum.writeFile(
      "layout.html",
      readFixture("decide", "layout.html").replace('"tabs"', '"top-tabs"'),
    );

    await expect(choiceCard(page)).toContainText("no longer in the mockup");
    await expect(choiceCard(page).getByRole("button", { name: "Send now" })).toHaveCount(0);
    await expect(sendButton(page)).toHaveText("Send");
    await page.locator("#global").fill("Keep the save button in view.");
    await page.getByRole("button", { name: "Add comment" }).click();
    await sendAll(page);
    await expect.poll(() => vellum.batches()).toHaveLength(1);

    expect(feedbackOf(vellum)).not.toContain("## Choices");
    await choiceCard(page).getByRole("button", { name: "Delete" }).click();
    await expect(choiceCard(page)).toHaveCount(0);
  });

  test("the rail counts a mockup's choices with its comments", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    const frame = await openMockup(page);
    await chooseButton(frame, "tabs").click();

    await expect(
      page.locator("#rail button", { hasText: "layout.html" }).locator(".badge"),
    ).toHaveText("1");
  });
});
