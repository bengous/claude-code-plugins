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

const COMPONENT = String.raw`(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:%|deg|grad|rad|turn)?|none)`;

const COMMAS = String.raw`${COMPONENT}\s*,\s*${COMPONENT}\s*,\s*${COMPONENT}(?:\s*,\s*${COMPONENT})?`;

const SPACES = String.raw`${COMPONENT}\s+${COMPONENT}\s+${COMPONENT}(?:\s*\/\s*${COMPONENT})?`;

// The colours a swatch may hold: a hex colour, or a colour function with three components and an
// optional alpha. Nothing else can reach the page's style, a ; } or ) included.
const COLOR = new RegExp(
  String.raw`^(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?:${COMMAS}|${SPACES})\s*\))$`,
  "iu",
);

const COLOR_FORMS = "#hex, or rgb(), hsl(), hwb(), lab(), lch(), oklab() or oklch()";

function checkPalette(palette: Config["palette"]): void {
  for (const [key, swatch] of Object.entries(palette)) {
    if (!PALETTE_KEY.test(key)) {
      throw new PlanError(`palette key "${key}": a key is letters, digits, - and _`);
    }

    for (const shade of ["light", "dark"] as const) {
      if (!COLOR.test(swatch[shade])) {
        throw new PlanError(
          `palette ${key}.${shade}: "${swatch[shade]}" is not a colour: ${COLOR_FORMS}, with three components and an optional alpha`,
        );
      }
    }
  }
}

// The Config is the map's data, checked by its type only where it was written: every value the
// page writes as CSS or looks up by key is checked here, keys as own keys, never through Object's
// prototype.
export function settingsOf(config: Config): Settings {
  const lang = config.lang ?? "en";

  if (!Object.hasOwn(WORDS, lang)) {
    throw new PlanError(
      `lang "${lang}": the page's words exist in ${Object.keys(WORDS).join(", ")}`,
    );
  }

  checkPalette(config.palette);
  const ratio = config.overview?.ratio ?? "screen";

  if (ratio !== "screen" && !(Number.isFinite(ratio) && ratio > 0)) {
    throw new PlanError(`overview ratio ${ratio}: "screen", or a width / height above 0`);
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
    pins: config.pins ?? "shared",
    ratio,
    tags: config.tags ?? { names: [], outside: "optional" },
    legend: { ...words.legend, ...config.legend },
  };
}

export const paletteVar = (key: string): string => `--palette-${key}`;

// One rule of the page's palette: its custom properties under a selector, inside a media query
// or not. The page sets each property on its own, so a value cannot reach the next one.
export type PaletteRule = {
  readonly media: string | null;
  readonly selector: string;
  readonly properties: ReadonlyArray<readonly [name: string, value: string]>;
};

// Light, then dark the way the page's own tokens switch: by the system's scheme unless
// data-theme says light, or by data-theme="dark".
export function paletteRules(palette: Readonly<Record<string, Swatch>>): PaletteRule[] {
  const properties = (shade: keyof Swatch): Array<readonly [string, string]> =>
    Object.entries(palette).map(([key, swatch]) => [paletteVar(key), swatch[shade]] as const);

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
