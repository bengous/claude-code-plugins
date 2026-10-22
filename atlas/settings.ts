import type { Config, Lang, LegendKey, Pins, Swatch, Tags } from "./atlas.ts";
import { PlanError } from "./model.ts";
import type { Words } from "./words.ts";
import { WORDS } from "./words.ts";

// A map's Config with every default filled in: what the engine reads instead of the Config.
export type Settings = {
  readonly title: string;
  readonly subtitle: string | null;
  readonly lang: Lang;
  readonly words: Words;
  readonly human: string | null;
  readonly stepWords: readonly RegExp[];
  readonly palette: Readonly<Record<string, Swatch>>;
  readonly pins: Pins;
  readonly ratio: "screen" | number;
  readonly tags: Tags;
  readonly legend: Readonly<Record<LegendKey, string>>;
};

// A palette key is the end of a CSS custom property's name.
const PALETTE_KEY = /^[\w-]+$/u;

// The Config is the map's data, checked by its type only where it was written: the language and
// the palette's keys are looked up as own keys, never through Object's prototype.
export function settingsOf(config: Config): Settings {
  const lang = config.lang ?? "en";

  if (!Object.hasOwn(WORDS, lang)) {
    throw new PlanError(
      `lang "${lang}": the page's words exist in ${Object.keys(WORDS).join(", ")}`,
    );
  }

  for (const key of Object.keys(config.palette)) {
    if (!PALETTE_KEY.test(key)) {
      throw new PlanError(`palette key "${key}": a key is letters, digits, - and _`);
    }
  }

  const words = WORDS[lang];

  return {
    title: config.title,
    subtitle: config.subtitle ?? null,
    lang,
    words,
    human: config.human ?? null,
    stepWords: config.stepWords ?? [],
    palette: config.palette,
    pins: config.pins ?? "shared",
    ratio: config.overview?.ratio ?? "screen",
    tags: config.tags ?? { names: [], outside: "optional" },
    legend: { ...words.legend, ...config.legend },
  };
}

export const paletteVar = (key: string): string => `--palette-${key}`;

// The palette as the page's custom properties, light, then dark the way the page's own tokens
// switch: by the system's scheme unless data-theme says light, or by data-theme="dark".
export function paletteCss(palette: Readonly<Record<string, Swatch>>): string {
  const props = (shade: keyof Swatch): string =>
    Object.entries(palette)
      .map(([key, swatch]) => `${paletteVar(key)}: ${swatch[shade]};`)
      .join(" ");

  return [
    `:root { ${props("light")} }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${props("dark")} } }`,
    `:root[data-theme="dark"] { ${props("dark")} }`,
  ].join("\n");
}
