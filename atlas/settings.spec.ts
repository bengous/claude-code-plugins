import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadFolder, planOf } from "./folder.ts";
import { paletteCss, settingsOf } from "./settings.ts";
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

describe("paletteCss", () => {
  test("each key becomes a custom property, light on :root, dark under both dark selectors", () => {
    const css = paletteCss({
      app: { light: "#1f6aa8", dark: "#6fb0ea" },
      data: { light: "#3a5688", dark: "#8fa9de" },
    });

    expect(css).toBe(
      [
        ":root { --palette-app: #1f6aa8; --palette-data: #3a5688; }",
        '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --palette-app: #6fb0ea; --palette-data: #8fa9de; } }',
        ':root[data-theme="dark"] { --palette-app: #6fb0ea; --palette-data: #8fa9de; }',
      ].join("\n"),
    );
  });

  test("every colour the sample draws with is a property its palette defines", async () => {
    const plan = await planOf(SAMPLE);
    const { config } = await loadFolder(SAMPLE);
    const css = paletteCss(config.palette);
    const colours = new Set([...plan.zones, ...plan.nodes].map((x) => x.color));

    expect(colours.size).toBeGreaterThan(0);

    for (const colour of colours) {
      expect(css).toContain(`${colour}: `);
    }
  });
});
