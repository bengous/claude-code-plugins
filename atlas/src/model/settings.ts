import type { Config, Lang, LegendKey, PanelHeading, Pins, Swatch, Tags } from "./atlas.ts";
import type { Words } from "./words.ts";
import { WORDS } from "./words.ts";

// Why a Config, or a map against its Config, cannot be drawn: settingsOf and drawableOf throw it,
// check.ts reports it.
export class ConfigError extends Error {}

// A map's Config with every default filled in: what the engine reads instead of the Config.
export type Settings = {
  readonly title: string;
  readonly subtitle: string | null;
  readonly lang: Lang;
  readonly words: Words;
  readonly human: string | null;
  readonly stepWords: readonly RegExp[];
  readonly palette: Readonly<Record<string, Swatch>>;
  /** The colour of every open-point mark: the map's badges, the button, the panel, the legend. */
  readonly openColor: Swatch;
  readonly pins: Pins;
  readonly ratio: "screen" | number;
  readonly tags: Tags;
  readonly legend: Readonly<Record<LegendKey, string>>;
  /** The map's text, not the page's words: the panel escapes each where it inserts it. */
  readonly headings: Readonly<Record<PanelHeading, string>>;
};

export const OPEN_COLOR: Swatch = { light: "#c2410c", dark: "#fb923c" };

// A palette key is the end of a CSS custom property's name.
const PALETTE_KEY = /^[\w-]+$/u;

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?`;

const PERCENT = `${NUMBER}%`;

const HUE_ANGLE = `${NUMBER}(?:deg|grad|rad|turn)?`;

const AMOUNT = `(?:${NUMBER}%?|none)`;

const HUE = `(?:${HUE_ANGLE}|none)`;

// The modern form: three components apart, then an optional alpha after a slash.
const spaced = (a: string, b: string, c: string): string =>
  String.raw`\(\s*${a}\s+${b}\s+${c}(?:\s*\/\s*${AMOUNT})?\s*\)`;

// The legacy form of rgb() and hsl(): three components and an optional alpha, between commas.
const commas = (a: string, b: string, c: string): string =>
  String.raw`\(\s*${a}\s*,\s*${b}\s*,\s*${c}(?:\s*,\s*${NUMBER}%?)?\s*\)`;

// The colours a swatch may hold, each function in the forms CSS Color 4 gives it: an angle only
// where a hue goes, percentages or numbers alike in rgb()'s legacy form, percentages in hsl()'s.
// Nothing else can reach the page's style, a ; } or ) included.
const COLOR = new RegExp(
  `^(?:${[
    String.raw`#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})`,
    `rgba?${spaced(AMOUNT, AMOUNT, AMOUNT)}`,
    `rgba?${commas(NUMBER, NUMBER, NUMBER)}`,
    `rgba?${commas(PERCENT, PERCENT, PERCENT)}`,
    `hsla?${spaced(HUE, AMOUNT, AMOUNT)}`,
    `hsla?${commas(HUE_ANGLE, PERCENT, PERCENT)}`,
    `hwb${spaced(HUE, AMOUNT, AMOUNT)}`,
    `(?:ok)?lab${spaced(AMOUNT, AMOUNT, AMOUNT)}`,
    `(?:ok)?lch${spaced(AMOUNT, AMOUNT, HUE)}`,
  ].join("|")})$`,
  "iu",
);

const COLOR_FORMS = "#hex, or rgb(), hsl(), hwb(), lab(), lch(), oklab() or oklch()";

function checkSwatch(name: string, swatch: Swatch): void {
  for (const shade of ["light", "dark"] as const) {
    if (!COLOR.test(swatch[shade])) {
      throw new ConfigError(
        `${name}.${shade}: "${swatch[shade]}" is not a colour: ${COLOR_FORMS}, with three components and an optional alpha`,
      );
    }
  }
}

function checkPalette(palette: Config["palette"]): void {
  for (const [key, swatch] of Object.entries(palette)) {
    if (!PALETTE_KEY.test(key)) {
      throw new ConfigError(`palette key "${key}": a key is letters, digits, - and _`);
    }

    checkSwatch(`palette ${key}`, swatch);
  }
}

// The Config is the map's data, checked by its type only where it was written: every value the
// page writes as CSS or looks up by key is checked here, keys as own keys, never through Object's
// prototype.
export function settingsOf(config: Config): Settings {
  const lang = config.lang ?? "en";

  if (!Object.hasOwn(WORDS, lang)) {
    throw new ConfigError(
      `lang "${lang}": the page's words exist in ${Object.keys(WORDS).join(", ")}`,
    );
  }

  checkPalette(config.palette);
  const openColor = config.openColor ?? OPEN_COLOR;
  checkSwatch("openColor", openColor);
  const ratio = config.overview?.ratio ?? "screen";

  if (ratio !== "screen" && !(Number.isFinite(ratio) && ratio > 0)) {
    throw new ConfigError(`overview ratio ${ratio}: "screen", or a width / height above 0`);
  }

  const words = WORDS[lang];

  return {
    title: config.title,
    subtitle: config.subtitle ?? null,
    lang,
    words,
    human: config.human ?? null,
    // A g or y flag keeps where the last match stopped, and the next text would be read from there.
    stepWords: (config.stepWords ?? []).map(
      (re) => new RegExp(re.source, re.flags.replaceAll(/[gy]/gu, "")),
    ),
    palette: config.palette,
    openColor,
    pins: config.pins ?? "shared",
    ratio,
    tags: config.tags ?? { names: [], outside: "optional" },
    legend: { ...words.legend, ...config.legend },
    headings: { ...words.headings, ...config.headings },
  };
}

export const paletteVar = (key: string): string => `--palette-${key}`;

/** The page's own token every open-point mark is coloured with. */
export const OPEN_VAR = "--open";

// One rule of the page's palette: its custom properties under a selector, inside a media query
// or not. The page sets each property on its own, so a value cannot reach the next one.
export type PaletteRule = {
  readonly media: string | null;
  readonly selector: string;
  readonly properties: ReadonlyArray<readonly [name: string, value: string]>;
};

// Light, then dark the way the page's own tokens switch: by the system's scheme unless
// data-theme says light, or by data-theme="dark". The open-point colour takes the page's own
// token, so every mark follows it.
export function paletteRules(
  palette: Readonly<Record<string, Swatch>>,
  openColor: Swatch,
): PaletteRule[] {
  const properties = (shade: keyof Swatch): Array<readonly [string, string]> => [
    ...Object.entries(palette).map(([key, swatch]) => [paletteVar(key), swatch[shade]] as const),
    [OPEN_VAR, openColor[shade]] as const,
  ];

  return [
    { media: null, selector: ":root", properties: properties("light") },
    {
      media: "(prefers-color-scheme: dark)",
      selector: ':root:not([data-theme="light"])',
      properties: properties("dark"),
    },
    { media: null, selector: ':root[data-theme="dark"]', properties: properties("dark") },
  ];
}
