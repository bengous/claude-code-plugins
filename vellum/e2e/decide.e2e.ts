import type { FrameLocator, Page } from "@playwright/test";

import type { Vellum } from "./harness.ts";
import { commentOn, expect, feedbackOf, reviewV1, sendAll, sendButton, test } from "./harness.ts";

/**
 * A choice in a mockup: « Choose » adds the option to the draft and marks it, another option of
 * the same decision replaces it, a reload keeps both, and the one Send takes it into the batch.
 * With Comment on, a click on « Choose » is a pick like any other.
 */

test.use({ fixture: "decide" });

async function openMockup(page: Page): Promise<FrameLocator> {
  await page.locator("#rail button", { hasText: "layout.html" }).first().click();
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
    const frame = await openMockup(page);

    await chooseButton(frame, "tabs").evaluate((button) => {
      if (button instanceof HTMLElement) button.click();
    });
    await expect(frame.locator("#picked")).toHaveText("Picked in the mockup: tabs");

    expect(await marked(frame)).toEqual([]);
    await expect(sendButton(page)).toHaveText("Send");
  });
});
