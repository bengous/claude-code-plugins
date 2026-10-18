import { describe, expect, test } from "bun:test";

import type { ElementInfo, Selection, Target } from "../shared/wire.ts";
import { batchText, CONTEXT_LIMIT } from "./text.ts";

const SAVE: ElementInfo = {
  selector: "body > main > form.settings > button.save",
  role: "button",
  name: "Save",
  heading: "Account",
  openingTag: '<button class="save" type="submit">',
  text: "Save",
  box: { x: 1180.4, y: 812, width: 96, height: 32.6 },
  styles: [
    ["font", "500 13px/16px system-ui"],
    ["color", "rgb(29, 36, 48)"],
  ],
};

const HINT: ElementInfo = {
  selector: "body > main > form.settings > p.hint",
  role: "",
  name: "",
  heading: "Account",
  openingTag: '<p class="hint">',
  text: "Saved changes apply at once",
  box: { x: 960, y: 850, width: 300, height: 20 },
  styles: [],
};

const PAGE = {
  url: "http://localhost:5173/settings",
  title: "Settings",
  viewport: { width: 1440, height: 900 },
  scroll: { x: 0, y: 120 },
};

const ONE: Selection = {
  label: "Too small",
  note: "Must read from afar.\nAnd keep its color.",
  targets: [{ kind: "element", element: SAVE }],
  page: PAGE,
  context: '{"route":"settings"}',
};

const IMAGE_ID = "0d5e2c1a-7b3f-4e8a-9c6d-1f2e3a4b5c6d";

/** Where the server would keep an image, as `SessionFiles.imagePath` says it. */
const imagePath = (id: string): string => `/srv/pinpoint/sessions/s1/images/${id}.png`;

const ZONE: Target = {
  kind: "zone",
  box: { x: 950, y: 800, width: 420, height: 90 },
  elements: [SAVE, HINT],
  image: { id: IMAGE_ID },
};

const TWO: Selection = {
  label: null,
  note: "",
  targets: [ZONE],
  page: PAGE,
  context: null,
};

describe("batchText", () => {
  test("says each selection, its label and note first, the page's lines under it", () => {
    expect(batchText(3, [ONE], imagePath)).toBe(
      [
        "pinpoint batch 3: 1 selection the user made in their running app. Under each label and note, the lines are what the page reported; boxes are in page pixels, from the top-left corner of the document; a zone's image is a PNG of the zone as the page drew it.",
        "",
        "1. [Too small] Must read from afar.",
        "   And keep its color.",
        '   page: http://localhost:5173/settings · "Settings" · viewport 1440 × 900 · scroll 0, 120',
        "   element: body > main > form.settings > button.save",
        '     role button · name "Save" · under "Account"',
        '     <button class="save" type="submit">',
        "     box x 1180, y 812, 96 × 33",
        "     styles: font 500 13px/16px system-ui; color rgb(29, 36, 48)",
        '   app context: {"route":"settings"}',
      ].join("\n"),
    );
  });

  test("a zone names its image, then lists its elements; the page is said once while it stays the same", () => {
    const text = batchText(4, [ONE, TWO], imagePath);

    expect(text).toContain("2 selections");
    expect(text.match(/page: /gu)).toHaveLength(1);
    expect(text).toContain(
      [
        "2. (no note)",
        "   zone: x 950, y 800, 420 × 90, 2 elements in it",
        `     image: /srv/pinpoint/sessions/s1/images/${IMAGE_ID}.png`,
        "     - body > main > form.settings > button.save",
      ].join("\n"),
    );
    expect(text).toContain(
      '       text "Saved changes apply at once" · box x 960, y 850, 300 × 20',
    );
  });

  test("a zone whose image the page could not take says why, on one line", () => {
    const failed = {
      ...TWO,
      targets: [{ ...ZONE, image: { failed: "the page has\n  no canvas\n" } }],
    };

    expect(batchText(9, [failed], imagePath)).toContain(
      [
        "   zone: x 950, y 800, 420 × 90, 2 elements in it",
        "     image: not taken (the page has no canvas)",
        "     - body > main > form.settings > button.save",
      ].join("\n"),
    );
  });

  test("a page that changed is said again", () => {
    const moved = { ...TWO, page: { ...PAGE, scroll: { x: 0, y: 400 } } };

    expect(batchText(5, [ONE, moved], imagePath).match(/page: /gu)).toHaveLength(2);
  });

  test("the app's context is said again only when it changed", () => {
    const same = { ...TWO, context: ONE.context };
    const other = { ...TWO, context: '{"route":"profile"}' };

    expect(batchText(7, [ONE, same], imagePath).match(/app context: /gu)).toHaveLength(1);
    expect(batchText(8, [ONE, other], imagePath).match(/app context: /gu)).toHaveLength(2);
  });

  test("an app context past the limit is cut, and says how long it was", () => {
    const long = { ...ONE, context: "x".repeat(CONTEXT_LIMIT + 5) };

    expect(batchText(6, [long], imagePath)).toContain(
      `… (cut, ${CONTEXT_LIMIT + 5} characters in all)`,
    );
  });
});
