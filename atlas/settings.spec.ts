import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { Config, Lang } from "./atlas.ts";
import { loadFolder, planOf } from "./folder.ts";
import { paletteRules, settingsOf } from "./settings.ts";
import { WORDS } from "./words.ts";

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

describe("settingsOf", () => {
  test("a Config with only its title and palette takes every default", () => {
    expect(settingsOf({ title: "T", palette: {} })).toEqual({
      title: "T",
      subtitle: null,
      lang: "en",
      words: WORDS.en,
      human: null,
      stepWords: [],
      palette: {},
      pins: "shared",
      ratio: "screen",
      tags: { names: [], outside: "optional" },
      legend: WORDS.en.legend,
    });
  });

  test("a Config's own values replace the defaults, and its language picks the words", () => {
    const steps = [/\bF2a\b/u];

    const settings = settingsOf({
      title: "T",
      subtitle: "S",
      lang: "fr",
      human: "Ada",
      stepWords: steps,
      palette: {},
      pins: "exclusive",
      overview: { ratio: 0.8 },
      tags: { names: ["order"], outside: "required" },
      legend: { outside: "hors du serveur" },
    });

    expect(settings).toMatchObject({
      subtitle: "S",
      lang: "fr",
      words: WORDS.fr,
      human: "Ada",
      stepWords: steps,
      pins: "exclusive",
      ratio: 0.8,
      tags: { names: ["order"], outside: "required" },
    });
  });

  test.each(["constructor", "toString", "hasOwnProperty", "__proto__", "de"])(
    "refuses the language %s, which the dictionary does not hold",
    (lang) => {
      // SAFETY: a language outside Lang, as a map folder's data can hold once it skips its typecheck.
      const config = { title: "T", palette: {}, lang: lang as Lang };

      expect(() => settingsOf(config)).toThrow(`lang "${lang}": the page's words exist in fr, en`);
    },
  );

  test("a step word with a g or y flag keeps no state from one text to the next", () => {
    const [global, sticky] = settingsOf({
      title: "T",
      palette: {},
      stepWords: [/F2a/gu, /^F2a/uy],
    }).stepWords;

    expect([global?.flags, sticky?.flags]).toEqual(["u", "u"]);
    expect([global?.test("F2a"), global?.test("F2a"), sticky?.test("F2a")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("a legend label the Config omits keeps the dictionary's", () => {
    const { legend } = settingsOf({
      title: "T",
      lang: "fr",
      palette: {},
      legend: { deny: "bloqué" },
    });

    expect(legend).toEqual({ ...WORDS.fr.legend, deny: "bloqué" });
  });
});

const withSwatch = (light: string): Config => ({
  title: "T",
  palette: { app: { light, dark: "#6fb0ea" } },
});

describe("the Config's values the page writes as CSS", () => {
  test.each([
    "#abc",
    "#abcd",
    "#76690f",
    "#76690fcc",
    "rgb(118 105 15)",
    "rgba(118, 105, 15, 0.5)",
    "hsl(120deg 50% 40% / 0.5)",
    "hwb(120 10% 20%)",
    "lab(50% 20 30)",
    "oklch(60% 0.1 120)",
    "oklch(0.6 0.1 none / 50%)",
  ])("a swatch %s is a colour", (light) => {
    expect(settingsOf(withSwatch(light)).palette).toEqual(withSwatch(light).palette);
  });

  test.each([
    "rgb(118 105 15",
    "#76690f; } .top { display: none } :root { --x: 1",
    "#76690f;",
    "rgb(118 105)",
    "rgb(118 105 15 0.5)",
    "var(--x)",
    "color-mix(in srgb, red, blue)",
    "red",
    "#76690g",
  ])("a swatch %s is refused", (light) => {
    expect(() => settingsOf(withSwatch(light))).toThrow(
      `palette app.light: "${light}" is not a colour`,
    );
  });

  test.each([0, -0.8, Number.NaN, Number.POSITIVE_INFINITY])(
    "an overview ratio %p is refused",
    (ratio) => {
      expect(() => settingsOf({ title: "T", palette: {}, overview: { ratio } })).toThrow(
        `overview ratio ${ratio}: "screen", or a width / height above 0`,
      );
    },
  );
});

describe("paletteRules", () => {
  test("each key becomes a custom property, light on :root, dark under both dark selectors", () => {
    const rules = paletteRules({
      app: { light: "#1f6aa8", dark: "#6fb0ea" },
      data: { light: "#3a5688", dark: "#8fa9de" },
    });

    const dark: ReadonlyArray<readonly [string, string]> = [
      ["--palette-app", "#6fb0ea"],
      ["--palette-data", "#8fa9de"],
    ];

    expect(rules).toEqual([
      {
        media: null,
        selector: ":root",
        properties: [
          ["--palette-app", "#1f6aa8"],
          ["--palette-data", "#3a5688"],
        ],
      },
      {
        media: "(prefers-color-scheme: dark)",
        selector: ':root:not([data-theme="light"])',
        properties: dark,
      },
      { media: null, selector: ':root[data-theme="dark"]', properties: dark },
    ]);
  });

  test("every colour the sample draws with is a property its palette defines", async () => {
    const plan = await planOf(SAMPLE);
    const { config } = await loadFolder(SAMPLE);

    const names = new Set(
      paletteRules(config.palette).flatMap((r) => r.properties.map(([n]) => n)),
    );

    const colours = new Set([...plan.zones, ...plan.nodes].map((x) => x.color));

    expect(colours.size).toBeGreaterThan(0);

    for (const colour of colours) {
      expect(names).toContain(colour);
    }
  });
});
