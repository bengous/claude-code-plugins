import type { Locator, Page, Route } from "@playwright/test";

import type { WorkflowView } from "../src/runtime/protocol.ts";
import type { Proposal, Proposed } from "../src/steps/proposal/contract.ts";
import type { Vellum } from "./harness.ts";
import {
  axe,
  boxOf,
  contrast,
  expect,
  onItsSurface,
  openVellum,
  settled,
  test,
} from "./harness.ts";

/**
 * Claude proposes the next step in a window over the page, never opened under a typing: its
 * reason, its moves, the one it recommends marked and none checked. Esc puts it off onto the
 * Next step button, Choose sends the move picked or one of the reviewer's own, the same button reads
 * Decline while None of these is checked, which declines them all, and a grill chosen opens at once.
 * The Next step button opens the same window blank, and hides while a grill is open.
 */

test.use({ fixture: "grill-real" });

const SUBJECT = "The coverage of the page";

const QUESTION = "Does a draft survive a crash?";

/** The fixture holds `plan.md`, where the plan step is done: a proposal offers the other three. */
const PROPOSAL: Proposal = {
  reason: "Three choices change the interface.",
  moves: [
    { kind: "grill", subject: SUBJECT, choices: ["Storage", "Conflicts"] },
    { kind: "mockup", screen: "the settings window" },
    { kind: "prototype", question: QUESTION },
  ],
  recommended: 0,
};

const NEXT: Proposal = { ...PROPOSAL, reason: "The budget changes too.", recommended: 1 };

const REPLACED = "Claude's proposal was already answered or replaced.";

const PAUSED = "Paused · Claude stopped waiting; your pick reaches it as a message";

function nextStep(page: Page): Locator {
  return page.locator(".bar").getByRole("button", { name: "Next step", exact: true });
}

/** The mark beside the Next step button while the proposal behind it is paused. */
function pausedTag(page: Page): Locator {
  return page.locator(".bar").getByText("Paused", { exact: true });
}

/** Whether the Next step button draws its dot, a pseudo-element no locator reaches. */
function dotted(page: Page): Promise<boolean> {
  return nextStep(page).evaluate(
    (button) => getComputedStyle(button, "::after").content !== "none",
  );
}

function proposal(page: Page): Locator {
  return page.getByRole("dialog", { name: "Claude proposes the next step" });
}

function blank(page: Page): Locator {
  return page.getByRole("dialog", { name: "Next step", exact: true });
}

function move(dialog: Locator, kind: RegExp): Locator {
  return dialog.getByRole("radio", { name: kind });
}

function choose(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: "Choose" });
}

/** The same button, while None of these is checked. */
function decline(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: "Decline" });
}

/** What the channel told Claude, each text in order. */
async function told(vellum: Vellum): Promise<readonly string[]> {
  // SAFETY: the server's own `ChannelLine[]`, serialized by `Response.json` in routes.ts.
  const lines = (await vellum.channel()).json as readonly {
    readonly entry: { readonly kind: string; readonly text?: string };
  }[];

  return lines.flatMap(({ entry }) => (entry.text === undefined ? [] : [entry.text]));
}

/** The step's region, as `GET /api/workflow` answers it. */
async function stepRegion(vellum: Vellum): Promise<WorkflowView["regions"][number] | undefined> {
  // SAFETY: the server's own `WorkflowView`, serialized by `Response.json` in routes.ts.
  const view = (await vellum.api("workflow")).json as WorkflowView;

  return view.regions.find(({ id }) => id === "proposal");
}

async function propose(vellum: Vellum, proposed: Proposal = PROPOSAL): Promise<string> {
  // SAFETY: the server's own `Proposed`, serialized by `Response.json` in step/server.ts.
  return ((await vellum.step.propose(proposed)).json as Proposed).id;
}

/** A text's colour against a surface's background: tokens written in hex, which the browser serializes as `rgb(…)`. */
async function ratio(text: Locator, surface: Locator): Promise<number> {
  await settled(text.page());
  const color = await text.evaluate((element) => getComputedStyle(element).color);
  const background = await surface.evaluate((element) => getComputedStyle(element).backgroundColor);

  return contrast(color, background);
}

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

/** Runs `write`, then waits for the page's next read of the step's state, answered `status`. */
async function readAfter(page: Page, status: number, write: () => void): Promise<void> {
  const read = page.waitForResponse(
    (response) => response.url().includes("/x/proposal/state") && response.status() === status,
  );

  write();
  await read;
}

test.beforeEach(async ({ vellum }) => {
  await vellum.gate();
});

test("a proposal opens a window on its reason and its moves, none checked, and the page behind takes no focus", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  const window = proposal(page);

  await expect(window.locator(".proposal-why")).toHaveText(PROPOSAL.reason);
  await expect(window.getByRole("radio")).toHaveCount(5);

  for (const radio of await window.getByRole("radio").all()) await expect(radio).not.toBeChecked();

  await expect(move(window, /^Grill/u)).toBeFocused();
  await page.locator("#global").focus();
  await expect(move(window, /^Grill/u)).toBeFocused();
});

test("the move Claude recommends is marked, never checked, and Choose is greyed until one is picked", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum, NEXT);
  const window = proposal(page);

  await expect(
    window.locator(".proposal-move", { has: page.locator(".proposal-rec") }),
  ).toContainText("the settings window");
  await expect(move(window, /^Mockup/u)).not.toBeChecked();
  await expect(choose(window)).toBeDisabled();
  await move(window, /^Mockup/u).check();
  await choose(window).click();

  await expect(window).toHaveCount(0);
  await expect.poll(() => told(vellum)).toEqual(["Accepted: a mockup of: the settings window."]);
});

test("another move is Chose, and the dot goes with the window", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await move(proposal(page), /^Prototype/u).check();
  await choose(proposal(page)).click();

  await expect(proposal(page)).toHaveCount(0);
  await expect.poll(() => told(vellum)).toEqual([`Chose: a prototype for: ${QUESTION}`]);
  await expect.poll(() => dotted(page)).toBe(false);
});

test("accepting a grill opens it: the panel beside the document pane, and the Next step button hides", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await move(proposal(page), /^Grill/u).check();
  await choose(proposal(page)).click();

  await expect(page.getByRole("complementary", { name: "Grill" })).toBeVisible();
  await expect(page.locator(".bar .status")).toHaveText("Held · grill 2 is open");
  await expect(nextStep(page)).toHaveCount(0);
  await expect
    .poll(async () => (await told(vellum))[0])
    .toMatch(/^Accepted: a grill on: The coverage of the page\. The reviewer opened grill-2\.md/u);
});

test("a propose waiting gets the reviewer's pick as its answer, under the entry that tells it", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  const id = await propose(vellum);
  const waiting = vellum.step.wait(id);
  await move(proposal(page), /^Mockup/u).check();
  await choose(proposal(page)).click();

  expect((await waiting).json).toEqual({
    kind: "answered",
    seq: 1,
    text: "Chose: a mockup of: the settings window.",
  });
});

test("Something else… takes a step of the reviewer's own kind and subject", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  const window = proposal(page);
  await move(window, /^Something else/u).check();
  await window.getByRole("combobox", { name: "Kind of step" }).selectOption("Prototype");
  await expect(choose(window)).toBeDisabled();
  await window.getByRole("textbox").fill("Drag or click?");
  await choose(window).click();

  await expect.poll(() => told(vellum)).toEqual(["Chose: a prototype for: Drag or click?"]);
});

test("Something else… picked again keeps its kind and its text", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await propose(vellum);
  const window = proposal(page);
  await move(window, /^Something else/u).check();
  await window.getByRole("combobox", { name: "Kind of step" }).selectOption("Prototype");
  await window.getByRole("textbox").fill("Drag or click?");
  await move(window, /^Mockup/u).check();
  await move(window, /^Something else/u).check();

  await expect(window.getByRole("combobox", { name: "Kind of step" })).toHaveValue("prototype");
  await expect(window.getByRole("textbox")).toHaveValue("Drag or click?");
});

test("Something else… in the reviewer's own words tells Claude the words, their lines kept", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  const window = proposal(page);
  await move(window, /^Something else/u).check();
  await window.getByRole("combobox", { name: "Kind of step" }).selectOption("In my words");
  await window.getByRole("textbox").fill("Read the issue first.\nThen ask me.");
  await choose(window).click();

  await expect.poll(() => told(vellum)).toEqual(["Own: Read the issue first.\nThen ask me."]);
});

test("None of these declines every move: the propose waiting reads Declined, the note after it", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  const id = await propose(vellum);
  const waiting = vellum.step.wait(id);
  await move(proposal(page), /^None of these/u).check();
  await proposal(page).getByRole("textbox").fill("Not before the budget");
  await decline(proposal(page)).click();

  await expect(proposal(page)).toHaveCount(0);
  expect((await waiting).json).toEqual({
    kind: "answered",
    seq: 1,
    text: "Declined: Not before the budget.",
  });
});

test("the button reads Decline while None of these is checked, and Choose again on a move", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  const window = proposal(page);
  await move(window, /^None of these/u).check();
  await expect(decline(window)).toBeEnabled();
  await expect(choose(window)).toHaveCount(0);
  await move(window, /^Mockup/u).check();

  await expect(choose(window)).toBeEnabled();
  await expect(decline(window)).toHaveCount(0);
});

test("None of these picked again keeps its note", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await propose(vellum);
  const window = proposal(page);
  await move(window, /^None of these/u).check();
  await window.getByRole("textbox").fill("Not before the budget");
  await move(window, /^Mockup/u).check();
  await move(window, /^None of these/u).check();

  await expect(window.getByRole("textbox")).toHaveValue("Not before the budget");
});

test("Esc closes it and leaves the dot on the Next step button, whose box stays as it was", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  const before = await boxOf(nextStep(page));
  await propose(vellum);
  await expect(proposal(page)).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(proposal(page)).toHaveCount(0);
  expect(await dotted(page)).toBe(true);
  expect(await boxOf(nextStep(page))).toEqual(before);
});

test("the Next step button opens the proposal put off again, with the pick made on it", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await move(proposal(page), /^Something else/u).check();
  await proposal(page).getByRole("textbox").fill("The coverage, and its budget");
  await page.keyboard.press("Escape");
  await nextStep(page).click();

  await expect(move(proposal(page), /^Something else/u)).toBeChecked();
  await expect(proposal(page).getByRole("textbox")).toHaveValue("The coverage, and its budget");
});

test("an answer in flight draws no dot", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await propose(vellum);
  // Never answered: the answer stays in flight until the page closes.
  await page.route("**/x/proposal/answer", () => null);
  await move(proposal(page), /^Prototype/u).check();
  await choose(proposal(page)).click();
  await expect(proposal(page)).toHaveCount(0);

  expect(await dotted(page)).toBe(false);
});

test("an answer to a proposal replaced before the click says so, and the new one waits on the dot", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await expect(proposal(page)).toBeVisible();
  await propose(vellum, NEXT);
  await expect.poll(() => dotted(page)).toBe(true);
  await move(proposal(page), /^Prototype/u).check();
  await choose(proposal(page)).click();

  await expect(page.getByRole("alert")).toHaveText(REPLACED);
  await expect.poll(() => dotted(page)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a proposal that replaced the one answered, seen once the answer is refused, waits on the dot", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await expect(proposal(page)).toBeVisible();
  const release = await hold(page, "**/x/proposal/state");
  await propose(vellum, NEXT);
  await move(proposal(page), /^Prototype/u).check();
  await choose(proposal(page)).click();
  await expect(page.getByRole("alert")).toHaveText(REPLACED);
  await release();

  await expect.poll(() => dotted(page)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a proposal seen while an answer is in flight waits on the dot", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await expect(proposal(page)).toBeVisible();
  const state = await hold(page, "**/x/proposal/state");
  const answer = await hold(page, "**/x/proposal/answer");
  await propose(vellum, NEXT);
  await move(proposal(page), /^Prototype/u).check();
  await choose(proposal(page)).click();
  await state();
  await expect.poll(() => dotted(page)).toBe(true);
  await answer();

  await expect(page.getByRole("alert")).toHaveText(REPLACED);
  await expect.poll(() => dotted(page)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a proposal answered elsewhere leaves the window", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await expect(proposal(page)).toBeVisible();
  await vellum.step.answer({ kind: "move", move: { kind: "plan" } });

  await expect(proposal(page)).toHaveCount(0);
});

test("a proposal landing on a typing opens nothing: the typing goes on, the dot waits", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await page.locator("#global").fill("Overall: ");
  await propose(vellum);
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
  await propose(vellum);
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
  await propose(vellum);
  await expect.poll(() => dotted(page)).toBe(true);

  await expect(proposal(page)).toHaveCount(0);
});

test("the Next step button with no proposal opens it blank on a grill of the reviewer's own, Choose greyed until a subject is typed", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await nextStep(page).click();
  const window = blank(page);

  await expect(window.getByRole("combobox", { name: "Kind of step" })).toHaveValue("grill");
  await expect(choose(window)).toBeDisabled();
  await window.getByPlaceholder("What should Claude grill you on?").fill("Where do drafts live?");
  await choose(window).click();
  await expect(page.locator(".bar .status")).toHaveText("Held · grill 2 is open");
});

test("a subject typed over lines is one line, as the transcript's header", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await nextStep(page).click();
  const field = blank(page).getByRole("textbox");
  await field.fill("Where do\ndrafts live?");

  await expect(field).toHaveValue("Where do drafts live?");
});

test("a proposal landing on the blank window leaves it as typed, and waits on the dot", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await nextStep(page).click();
  await blank(page).getByRole("textbox").fill("Where do drafts live?");
  await propose(vellum);
  await expect.poll(() => dotted(page)).toBe(true);

  await expect(blank(page).getByRole("textbox")).toHaveValue("Where do drafts live?");
  await expect(blank(page).getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("Choose is greyed with the Next step button's reason, and Enter sends nothing", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await expect(proposal(page)).toBeVisible();
  const answers: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/x/proposal/answer")) answers.push(request.url());
  });
  await move(proposal(page), /^Something else/u).check();
  await proposal(page).getByRole("textbox").fill("Where do drafts live?");
  await vellum.stop();

  await expect(choose(proposal(page))).toHaveAttribute("title", /connection/u);
  await expect(choose(proposal(page))).toBeDisabled();
  await proposal(page).getByRole("textbox").press("Enter");
  expect(answers).toEqual([]);
});

test("no proposal while a grill is open: the server refuses it, and no window comes", async ({
  page,
  vellum,
}) => {
  await vellum.grill.open(SUBJECT);
  await openVellum(page, vellum);
  await expect(page.locator(".bar .status")).toHaveText("Held · grill 2 is open");

  expect((await vellum.step.propose(PROPOSAL)).status).toBe(409);
  await expect(nextStep(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the Next step button comes back once the grill ends, its own state's reads refused", async ({
  page,
  vellum,
}) => {
  await vellum.grill.open(SUBJECT);
  await openVellum(page, vellum);
  await expect(nextStep(page)).toHaveCount(0);
  await page.route("**/api/x/proposal/state*", (route) => route.fulfill({ status: 500 }));
  await vellum.grill.close();

  await expect(page.locator(".bar .status")).toHaveText("In review");
  await expect(nextStep(page)).toBeVisible();
});

test("a refused read puts the window off onto the dot, where it stays at the next read", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await expect(proposal(page)).toBeVisible();
  await page.route("**/api/x/proposal/state*", (route) => route.fulfill({ status: 500 }), {
    times: 1,
  });
  await readAfter(page, 500, () => vellum.writeFile("notes.md", "One."));
  await readAfter(page, 200, () => vellum.writeFile("notes.md", "Two."));

  await expect(proposal(page)).toHaveCount(0);
  await expect.poll(() => dotted(page)).toBe(true);
});

test("axe finds nothing to fault on the window, its own step shown, light and dark", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await move(proposal(page), /^Something else/u).check();
  await expect(proposal(page).getByRole("textbox")).toBeVisible();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await axe(page)).toEqual([]);
  }
});

test("axe finds nothing to fault on the window, None of these picked, light and dark", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await move(proposal(page), /^None of these/u).check();
  await expect(proposal(page).getByRole("textbox")).toBeVisible();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await axe(page)).toEqual([]);
  }
});

test("the window's words read on their surfaces, light and dark: axe sees none in the top layer", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  await propose(vellum);
  const card = page.locator(".dialog-card");
  await move(proposal(page), /^Mockup/u).check();
  const go = choose(card);
  const below = page.locator(".dialog-below");

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(await ratio(card.locator(".proposal-who"), card)).toBeGreaterThanOrEqual(4.5);
    expect(await ratio(card.locator(".proposal-why"), card)).toBeGreaterThanOrEqual(4.5);
    expect(
      await ratio(card.locator(".proposal-rec"), card.locator(".proposal-rec")),
    ).toBeGreaterThanOrEqual(4.5);

    for (const words of await card.locator(".proposal-move > span").all()) {
      expect(await onItsSurface(words)).toBeGreaterThanOrEqual(4.5);
    }

    expect(await ratio(go, go)).toBeGreaterThanOrEqual(4.5);
    expect(await ratio(below, below)).toBeGreaterThanOrEqual(4.5);
  }
});

test("Choose still reads under the pointer, light and dark", async ({ page, vellum }) => {
  await openVellum(page, vellum);
  await propose(vellum);
  await move(proposal(page), /^Mockup/u).check();
  const go = choose(proposal(page));
  await go.hover();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect.poll(() => onItsSurface(go)).toBeGreaterThanOrEqual(4.5);
  }
});

/** The page's sheet, then the same sheet under the modal's backdrop, each as a luminance painted on a canvas. */
async function dimming(page: Page): Promise<{ readonly sheet: number; readonly under: number }> {
  await settled(page);

  return await page.locator("dialog.dialog").evaluate((dialog) => {
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
  await propose(vellum);
  await expect(proposal(page)).toBeVisible();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const { sheet, under } = await dimming(page);

    expect(under).toBeLessThan(sheet);
  }
});

test("a proposal that offers the plan once plan.md exists is refused, and no window comes (A7)", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);

  const plan: Proposal = {
    reason: "Nothing is left open.",
    moves: [{ kind: "plan" }],
    recommended: 0,
  };

  expect(await vellum.step.propose(plan)).toEqual({
    status: 409,
    json: { error: "plan.md exists: the plan step is done" },
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a proposal survives a restart, paused, and a pick then reaches Claude as a prompt (A9)", async ({
  page,
  vellum,
}) => {
  await openVellum(page, vellum);
  const id = await propose(vellum);
  await vellum.restart();

  expect(await stepRegion(vellum)).toMatchObject({ state: "open", wait: "paused" });
  await page.reload();
  await expect(pausedTag(page)).toBeVisible();
  await nextStep(page).click();
  await move(proposal(page), /^Mockup/u).check();
  await choose(proposal(page)).click();
  await expect.poll(() => told(vellum)).toEqual(["Chose: a mockup of: the settings window."]);
  expect((await vellum.step.wait(id)).json).toMatchObject({ kind: "answered", seq: 1 });
});

test("a proposal Claude stopped waiting on waits behind Next step, marked Paused, and the pick reaches Claude as a message (A2)", async ({
  page,
  vellum,
}) => {
  await vellum.step.pause(await propose(vellum));
  await openVellum(page, vellum);
  await expect(pausedTag(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await dotted(page)).toBe(true);
  await nextStep(page).click();
  await expect(proposal(page)).toContainText(PAUSED);
  await move(proposal(page), /^Mockup/u).check();
  await choose(proposal(page)).click();

  await expect.poll(() => told(vellum)).toEqual(["Chose: a mockup of: the settings window."]);
});

test("a new proposal replaces the paused one, and the window opens on it (A3)", async ({
  page,
  vellum,
}) => {
  const first = await propose(vellum);
  await vellum.step.pause(first);
  await openVellum(page, vellum);
  await expect(pausedTag(page)).toBeVisible();
  await propose(vellum, NEXT);

  await expect(proposal(page)).toContainText(NEXT.reason);
  await expect(proposal(page)).not.toContainText(PAUSED);
  await expect(pausedTag(page)).toHaveCount(0);
  expect((await vellum.step.wait(first)).json).toEqual({ kind: "ended", why: "replaced" });
});
