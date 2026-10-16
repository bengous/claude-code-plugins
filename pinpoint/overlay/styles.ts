import type { Style } from "../shared/wire.ts";

/**
 * The few computed styles a visual fix needs, a value the browser's default left out: Claude
 * reads a size, a colour or a spacing here instead of measuring the page again.
 */

/** A value that says nothing for its property: the browser's default. */
const DEFAULTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["background-color", new Set(["rgba(0, 0, 0, 0)", "transparent"])],
  ["padding", new Set(["0px"])],
  ["margin", new Set(["0px"])],
  ["border-radius", new Set(["0px"])],
  ["opacity", new Set(["1"])],
]);

const PLAIN = [
  "color",
  "background-color",
  "padding",
  "margin",
  "border-radius",
  "display",
  "opacity",
];

/** A border with no width or no style draws nothing; sides that differ read as `""`. */
function borderOf(read: (property: string) => string): string {
  const border = read("border");

  return border === "" || border.startsWith("0px") || border.includes(" none") ? "" : border;
}

/** `read` answers a property's computed value, `getComputedStyle(element).getPropertyValue`. */
export function keptStyles(read: (property: string) => string): Style[] {
  const font = `${read("font-weight")} ${read("font-size")}/${read("line-height")} ${read("font-family")}`;

  const plain = PLAIN.flatMap((property): Style[] => {
    const value = read(property);

    return value === "" || DEFAULTS.get(property)?.has(value) === true ? [] : [[property, value]];
  });

  const border = borderOf(read);

  return [["font", font], ...plain, ...(border === "" ? [] : [["border", border] as const])];
}
