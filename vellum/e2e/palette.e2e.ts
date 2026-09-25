import type { Locator, Page } from "@playwright/test";

import { axe, contrast, expect, openVellum, readFixture, reviewV1, test } from "./harness.ts";

/**
 * The palette: every pair `style.css` draws, resolved by the browser and composited on a canvas,
 * holds WCAG's ratio in both themes, text at 4.5:1, a component at 3:1; and the surfaces the theme
 * does not own, an image's paper and a mockup's mark, hold on their own.
 */

/** `[usage, foreground, background, ratio]`; 4.5 for text under 18.66px bold, 3 for a UI part. */
const PAIRS = [
  ["ink / sheet", "var(--ink)", "var(--sheet)", 4.5],
  ["graphite / sheet", "var(--graphite)", "var(--sheet)", 4.5],
  ["graphite / tint", "var(--graphite)", "var(--tint)", 4.5],
  ["graphite / desk", "var(--graphite)", "var(--desk)", 4.5],
  ["graphite / field (placeholder)", "var(--graphite)", "var(--field)", 4.5],
  ["code-comment / tint", "var(--code-comment)", "var(--tint)", 4.5],
  ["code-keyword / tint", "var(--code-keyword)", "var(--tint)", 4.5],
  ["code-string / tint", "var(--code-string)", "var(--tint)", 4.5],
  ["code-number / tint", "var(--code-number)", "var(--tint)", 4.5],
  ["code-name / tint", "var(--code-name)", "var(--tint)", 4.5],
  ["redline / sheet", "var(--redline)", "var(--sheet)", 4.5],
  [
    "redline / removed",
    "var(--redline)",
    "color-mix(in oklab, var(--redline) 7%, var(--sheet))",
    4.5,
  ],
  ["ink / status.err", "var(--ink)", "color-mix(in oklab, var(--redline) 12%, var(--sheet))", 4.5],
  ["ok / sheet", "var(--ok)", "var(--sheet)", 4.5],
  ["ink / status.ok", "var(--ink)", "color-mix(in oklab, var(--ok) 16%, var(--sheet))", 4.5],
  ["ok / field", "var(--ok)", "var(--field)", 4.5],
  ["ask / sheet", "var(--ask)", "var(--sheet)", 4.5],
  ["sheet / ask", "var(--sheet)", "var(--ask)", 4.5],
  ["sheet / redline", "var(--sheet)", "var(--redline)", 4.5],
  ["ink / edited", "var(--ink)", "color-mix(in oklab, var(--marker) 30%, var(--sheet))", 4.5],
  ["ink / wash-marker", "var(--ink)", "var(--wash-marker)", 4.5],
  ["ink / wash-ok", "var(--ink)", "var(--wash-ok)", 4.5],
  ["sheet / ink", "var(--sheet)", "var(--ink)", 4.5],
  ["switch off: edge / tint", "var(--edge)", "var(--tint)", 3],
  ["switch off: edge / field", "var(--edge)", "var(--field)", 3],
  ["switch on: redline / tint", "var(--redline)", "var(--tint)", 3],
  ["switch on: sheet / redline", "var(--sheet)", "var(--redline)", 3],
  ["field border: edge / field", "var(--edge)", "var(--field)", 3],
  ["field border: edge / tint", "var(--edge)", "var(--tint)", 3],
  [
    "field border: edge / banner",
    "var(--edge)",
    "color-mix(in oklab, var(--ask) 8%, var(--sheet))",
    3,
  ],
  ["button border: edge / sheet", "var(--edge)", "var(--sheet)", 3],
  ["focus ring: redline / sheet", "var(--redline)", "var(--sheet)", 3],
  ["focus ring: redline / tint", "var(--redline)", "var(--tint)", 3],
  ["focus ring: redline / desk", "var(--redline)", "var(--desk)", 3],
  [
    "rail hover: ink 12% / tint",
    "color-mix(in oklab, var(--ink) 12%, var(--tint))",
    "var(--tint)",
    1.2,
  ],
  [
    "rail hover: ink 12% / desk",
    "color-mix(in oklab, var(--ink) 12%, var(--desk))",
    "var(--desk)",
    1.2,
  ],
] as const;

type Resolved = {
  readonly usage: string;
  readonly fg: string;
  readonly bg: string;
  readonly need: number;
};

/** Each pair as the browser paints it: the background over the sheet, the foreground over that. */
function resolve(page: Page): Promise<readonly Resolved[]> {
  return page.evaluate((pairs) => {
    const brush = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const probe = document.createElement("div");

    if (brush === null) throw new Error("no canvas");
    document.body.append(probe);

    const paint = (css: string): void => {
      probe.style.color = css;
      brush.fillStyle = getComputedStyle(probe).color;
      brush.fillRect(0, 0, 1, 1);
    };

    const pixel = (): string => {
      const [r, g, b] = brush.getImageData(0, 0, 1, 1).data;

      return `rgb(${r}, ${g}, ${b})`;
    };

    const rows = pairs.map(([usage, fg, bg, need]) => {
      brush.clearRect(0, 0, 1, 1);
      paint("var(--sheet)");
      paint(bg);
      const back = pixel();
      paint(fg);

      return { usage, fg: pixel(), bg: back, need };
    });

    probe.remove();

    return rows;
  }, PAIRS);
}

function colorOf(
  locator: Locator,
  property: string,
  pseudo: string | null = null,
): Promise<string> {
  return locator.evaluate(
    (element, [name, part]) => {
      const brush = document.createElement("canvas").getContext("2d");

      if (brush === null) throw new Error("no canvas");
      brush.fillStyle = "#fff";
      brush.fillRect(0, 0, 1, 1);
      brush.fillStyle = getComputedStyle(element, part).getPropertyValue(name);
      brush.fillRect(0, 0, 1, 1);
      const [r, g, b] = brush.getImageData(0, 0, 1, 1).data;

      return `rgb(${r}, ${g}, ${b})`;
    },
    [property, pseudo] as const,
  );
}

test("every pair of the palette holds its ratio", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  const rows = await resolve(page);

  const short = rows
    .map((row) => ({ ...row, ratio: contrast(row.fg, row.bg) }))
    .filter((row) => row.ratio < row.need)
    .map((row) => `${row.usage}: ${row.ratio.toFixed(2)} < ${row.need} (${row.fg} on ${row.bg})`);

  expect(short).toEqual([]);
});

test("axe finds no contrast to fault on the plan under review", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  await page.locator(".tools .btn", { hasText: "Edit" }).click();
  await page.keyboard.type("Reviewer line.\n");
  await page.locator(".tools .btn", { hasText: "Done" }).click();
  await expect(page.locator(".edited")).toBeVisible();

  const contrastFaults = (await axe(page))
    .filter((violation) => violation.id === "color-contrast")
    .flatMap((violation) => violation.nodes.map((node) => node.target.join(" ")));

  expect(contrastFaults).toEqual([]);
});

test("axe after a theme switch waits for the page's transitions to end", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await page.emulateMedia({ colorScheme: "light" });
  const approve = page.locator(".bar").getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toHaveCSS("color", "rgb(22, 32, 42)");
  // Stretched far past the 120 ms the page runs, so a measure taken during it cannot pass by luck.
  await page.addStyleTag({ content: ":root { --transition: 1500ms linear !important; }" });
  await page.emulateMedia({ colorScheme: "dark" });

  expect(await axe(page, ".bar")).toEqual([]);
});

test("the fields: their placeholder reads, their border shows", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  const field = page.locator("#global");
  const placeholder = await colorOf(field, "color", "::placeholder");
  const background = await colorOf(field, "background-color");
  const border = await colorOf(field, "border-top-color");

  expect(contrast(placeholder, background)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(border, background)).toBeGreaterThanOrEqual(3);
});

test("the switch is seen off as well as on", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  const track = page.locator(".tools [role=switch]", { hasText: "Comment" }).locator(".track");
  const row = await colorOf(page.locator(".tools"), "background-color");
  const trackOff = await colorOf(track, "background-color");
  const edgeOff = await colorOf(track, "border-top-color");
  const knobOff = await colorOf(track, "background-color", "::after");

  expect(Math.max(contrast(trackOff, row), contrast(edgeOff, row))).toBeGreaterThanOrEqual(3);
  expect(contrast(knobOff, trackOff)).toBeGreaterThanOrEqual(3);
});

test("a commented passage keeps its ink under the wash", async ({ page, vellum }) => {
  await reviewV1(page, vellum);

  const highlight = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .flatMap((rule) =>
        rule instanceof CSSStyleRule && rule.selectorText.startsWith("::highlight(vellum-")
          ? [`${rule.selectorText} ${rule.style.color}`]
          : [],
      ),
  );

  expect(highlight).toEqual([
    "::highlight(vellum-comment) var(--ink)",
    "::highlight(vellum-draft) var(--ink)",
    "::highlight(vellum-focus) var(--ink)",
  ]);
});

test("the pills: Approved and a failed approval read in ink", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const pill = page.locator(".bar .status.ok");
  await expect(pill).toHaveText("Approved");

  expect(
    contrast(await colorOf(pill, "color"), await colorOf(pill, "background-color")),
  ).toBeGreaterThanOrEqual(4.5);
});

test("code draws no ligature", async ({ page, vellum }) => {
  await reviewV1(page, vellum);

  await expect(page.locator(".plan pre").first()).toHaveCSS("font-variant-ligatures", "none");
  await expect(page.locator(".plan code").first()).toHaveCSS("font-variant-ligatures", "none");
});

test("the tools row draws its three states with the kit's switch", async ({ page, vellum }) => {
  await vellum.gate();
  vellum.writePlan(readFixture("rich-v2", "plan.md"));
  await vellum.gate();
  await openVellum(page, vellum);
  await page.locator("#rail button", { hasText: "research-notes.md" }).click();
  await expect(page.locator(".tools [role=switch]", { hasText: "Beside the plan" })).toBeVisible();
  await page.locator(".tools [role=switch]", { hasText: "Beside the plan" }).click();

  await expect(page.locator(".pane")).toHaveCount(2);
  await expect(page.locator(".tools [role=switch]")).toHaveCount(3);
  await expect(page.locator(".tools input")).toHaveCount(0);
});

test("a Mermaid note follows the theme", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  const figure = page.locator(".plan figure.mermaid").first();
  const note = figure.locator("rect.note").first();
  await expect(note).toBeVisible();

  const tint = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--tint)";
    document.body.append(probe);
    const brush = document.createElement("canvas").getContext("2d");

    if (brush === null) throw new Error("no canvas");
    brush.fillStyle = getComputedStyle(probe).color;
    brush.fillRect(0, 0, 1, 1);
    probe.remove();
    const [r, g, b] = brush.getImageData(0, 0, 1, 1).data;

    return `rgb(${r}, ${g}, ${b})`;
  });

  expect(await colorOf(note, "fill")).toBe(tint);
});

test("the grill's recommendation stands out of its card", async ({ page, vellum }) => {
  await vellum.gate();
  await vellum.grill.open("Where do drafts live?");
  await vellum.grill.ask([["Storage", "IndexedDB or localStorage?", "IndexedDB: no 5 MB cap."]]);
  await openVellum(page, vellum);
  await page.locator("#rail button", { hasText: "grill-1.md" }).click();
  const card = page.locator(".grill-q").first();
  const rec = card.locator(".rec");
  await expect(rec).toBeVisible();
  const cardBg = await colorOf(card, "background-color");
  const edge = await colorOf(rec, "border-top-color");
  const width = await rec.evaluate((element) => getComputedStyle(element).borderTopWidth);

  expect(width).not.toBe("0px");
  expect(contrast(edge, cardBg)).toBeGreaterThanOrEqual(1.3);
});

test("a rail line under the pointer shows it", async ({ page, vellum }) => {
  await reviewV1(page, vellum);
  const rail = page.locator("#rail");
  const line = rail.locator("button", { hasText: "research-notes.md" });
  const rest = await colorOf(rail, "background-color");
  await line.hover();

  await expect
    .poll(async () => contrast(await colorOf(line, "background-color"), rest))
    .toBeGreaterThanOrEqual(1.2);
});

test.describe("on a mockup's own surface", () => {
  test.use({ fixture: "mockups-edge" });

  test("an image lies on paper, with an edge", async ({ page, vellum }) => {
    await reviewV1(page, vellum);
    await page.locator("#rail button", { hasText: "diagram.png" }).click();
    const image = page.locator(".image img");
    await expect(image).toBeVisible();
    const paper = await colorOf(image, "background-color");
    const ink = "rgb(29, 35, 48)";

    expect(contrast(ink, paper)).toBeGreaterThanOrEqual(4.5);
    await expect(image).not.toHaveCSS("border-top-width", "0px");
  });
});

test("a commented element of a light mockup keeps a mark that holds on white", async ({
  page,
  vellum,
}) => {
  await reviewV1(page, vellum);
  await page.locator("#rail button", { hasText: "mockup.html" }).click();
  await page.locator(".tools [role=switch]", { hasText: "Comment" }).click();
  const frame = page.frameLocator(".pane iframe");
  await frame.locator("h1").click();
  await page.locator(".popover textarea").fill("Say which building.");
  await page.locator(".popover .btn.send").click();
  await page.locator(".tools [role=switch]", { hasText: "Comment" }).click();
  await expect(page.locator(".comments .card")).toHaveCount(1);
  const h1 = await frame.locator("h1").boundingBox();

  if (h1 === null) throw new Error("no h1");
  await page.mouse.move(5, 600);

  const strip = await page.screenshot({
    clip: { x: Math.round(h1.x) + 40, y: Math.round(h1.y) - 1, width: 1, height: 3 },
  });

  const darkest = await page.evaluate(
    async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const brush = canvas.getContext("2d");

      if (brush === null) throw new Error("no canvas");
      brush.drawImage(image, 0, 0);
      const { data } = brush.getImageData(0, 0, image.width, image.height);
      let best = "rgb(255, 255, 255)";
      let sum = Number.POSITIVE_INFINITY;

      for (let i = 0; i < data.length; i += 4) {
        const total = (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);

        if (total < sum) {
          sum = total;
          best = `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`;
        }
      }

      return best;
    },
    `data:image/png;base64,${strip.toString("base64")}`,
  );

  expect(contrast(darkest, "rgb(255, 255, 255)")).toBeGreaterThanOrEqual(3);
});
