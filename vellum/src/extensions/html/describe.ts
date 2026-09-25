import type { ElementDescription } from "../../core/protocol.ts";
import { cut, quoted, TEXT_LIMIT } from "./words.ts";

/**
 * What an element of a mockup is, for a reader who does not open the mockup: the heading it sits
 * under, its role and accessible name, its opening tag. The choices are pure functions of a tag
 * and its attributes; `descriptionOf` reads them off the element, in the frame, where the DOM is.
 * The accessible name is a subset of the W3C computation: the sources below, in their order.
 * The mockup's own scripts share the frame's globals and may declare a `Node` or a `CSS` of their
 * own, so the DOM half reads its constants and lookups off the elements and the document.
 */

export type Attribute = readonly [name: string, value: string];

/** A `style`, a path's `d`, a `data-` attribute or a data URI can run for kilobytes. */
const VALUE_LIMIT = 80;

/** A tag with many attributes still holds on the one line Claude reads. */
const TAG_LIMIT = 300;

const TAG_ROLES: ReadonlyMap<string, string> = new Map([
  ["article", "article"],
  ["aside", "complementary"],
  ["button", "button"],
  ["dialog", "dialog"],
  ["fieldset", "group"],
  ["figure", "figure"],
  ["h1", "heading"],
  ["h2", "heading"],
  ["h3", "heading"],
  ["h4", "heading"],
  ["h5", "heading"],
  ["h6", "heading"],
  ["hr", "separator"],
  ["img", "img"],
  ["li", "listitem"],
  ["main", "main"],
  ["nav", "navigation"],
  ["ol", "list"],
  ["option", "option"],
  ["progress", "progressbar"],
  ["table", "table"],
  ["td", "cell"],
  ["textarea", "textbox"],
  ["th", "columnheader"],
  ["tr", "row"],
  ["ul", "list"],
]);

const INPUT_ROLES: ReadonlyMap<string, string> = new Map([
  ["button", "button"],
  ["checkbox", "checkbox"],
  ["email", "textbox"],
  ["image", "button"],
  ["number", "spinbutton"],
  ["radio", "radio"],
  ["range", "slider"],
  ["reset", "button"],
  ["search", "searchbox"],
  ["submit", "button"],
  ["tel", "textbox"],
  ["text", "textbox"],
  ["url", "textbox"],
]);

/** The input types HTML knows that draw no text field and carry no role; any other type is a text field. */
const INPUT_TYPES_WITHOUT_ROLE: ReadonlySet<string> = new Set([
  "color",
  "date",
  "datetime-local",
  "file",
  "hidden",
  "month",
  "password",
  "time",
  "week",
]);

/** The roles whose name is their shown text when nothing names them otherwise. */
const NAMED_BY_CONTENT: ReadonlySet<string> = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

function valueOf(attributes: readonly Attribute[], name: string): string | null {
  return attributes.find(([one]) => one === name)?.[1] ?? null;
}

function inputRole(type: string): string {
  return INPUT_ROLES.get(type) ?? (INPUT_TYPES_WITHOUT_ROLE.has(type) ? "" : "textbox");
}

/** The first token of `role`, else what the tag implies; `""` for none. `tag` is lower-case. */
export function roleOf(tag: string, attributes: readonly Attribute[]): string {
  const explicit = (valueOf(attributes, "role") ?? "").trim().split(/\s+/u)[0]?.toLowerCase() ?? "";

  if (explicit !== "") return explicit === "none" || explicit === "presentation" ? "" : explicit;

  if (tag === "a" || tag === "area") return valueOf(attributes, "href") === null ? "" : "link";

  if (tag === "input") return inputRole((valueOf(attributes, "type") ?? "text").toLowerCase());

  if (tag === "select") {
    const size = Number.parseInt(valueOf(attributes, "size") ?? "", 10);

    return valueOf(attributes, "multiple") !== null || size > 1 ? "listbox" : "combobox";
  }

  if (tag === "img" && valueOf(attributes, "alt") === "") return "";

  return TAG_ROLES.get(tag) ?? "";
}

/** Where an accessible name can come from, as the element holds each; `""` for none. */
export type NameSources = {
  readonly ariaLabelledBy: string;
  readonly ariaLabel: string;
  /** From the host language: a `<label>`, an image's `alt`, a button input's value, a legend, a caption, an SVG's `<title>`. */
  readonly native: string;
  /** Read only for a role its content names: a whole `main` is no name. */
  readonly content: string;
  readonly title: string;
  readonly placeholder: string;
};

/** The first source that says something, the content only for a role it names, cut as a quote is. */
export function nameFrom(role: string, sources: NameSources): string {
  const content = NAMED_BY_CONTENT.has(role) ? sources.content : "";

  const order = [
    sources.ariaLabelledBy,
    sources.ariaLabel,
    sources.native,
    content,
    sources.title,
    sources.placeholder,
  ];

  return cut(
    order.map((source) => quoted(source)).find((source) => source !== "") ?? "",
    TEXT_LIMIT,
  );
}

function spelled([name, value]: Attribute): string {
  if (value === "") return name;
  const kept = quoted(value);
  const short = cut(kept, VALUE_LIMIT);
  const shown = short === kept ? kept : `${short}…`;

  return `${name}="${shown.replaceAll('"', "&quot;")}"`;
}

/** The tag as a source spells it, on one line: an empty value is its name alone, a long one is cut. */
export function openingTag(tag: string, attributes: readonly Attribute[]): string {
  const whole = `<${[tag, ...attributes.map((attribute) => spelled(attribute))].join(" ")}>`;

  return [...whole].length > TAG_LIMIT ? `${cut(whole, TAG_LIMIT - 2)}…>` : whole;
}

const CAPTIONS: ReadonlyMap<string, string> = new Map([
  ["fieldset", "legend"],
  ["figure", "figcaption"],
  ["svg", "title"],
  ["table", "caption"],
]);

const HEADINGS = "h1, h2, h3, h4, h5, h6, [role=heading]";

/** An element's shown text, whitespace collapsed. */
export function textOf(element: Element): string {
  return quoted(element instanceof HTMLElement ? element.innerText : (element.textContent ?? ""));
}

function attributesOf(element: Element): readonly Attribute[] {
  return [...element.attributes].map(({ name, value }) => [name, value] as const);
}

/** A label's words, without the control it wraps: a `select`'s text is every option it holds. */
function labelText(label: Element, control: Element): string {
  if (!label.contains(control)) return textOf(label);
  const range = label.ownerDocument.createRange();
  range.selectNodeContents(label);
  range.setEndBefore(control);
  const before = range.toString();
  range.selectNodeContents(label);
  range.setStartAfter(control);

  return quoted(`${before} ${range.toString()}`);
}

function nativeName(element: Element): string {
  if (element instanceof HTMLImageElement || element instanceof HTMLAreaElement) return element.alt;

  if (element instanceof HTMLInputElement && element.type === "image") return element.alt;

  if (element instanceof HTMLInputElement && ["button", "reset", "submit"].includes(element.type)) {
    return element.value;
  }

  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLButtonElement
  ) {
    return [...(element.labels ?? [])].map((label) => labelText(label, element)).join(" ");
  }

  const caption = CAPTIONS.get(element.localName);
  const captioning = caption === undefined ? null : element.querySelector(`:scope > ${caption}`);

  return captioning === null ? "" : textOf(captioning);
}

function sourcesOf(element: Element, role: string): NameSources {
  const attribute = (name: string): string => element.getAttribute(name) ?? "";

  const labelling = attribute("aria-labelledby")
    .split(/\s+/u)
    .flatMap((id) => {
      // oxlint-disable-next-line unicorn/prefer-query-selector -- an id is not always a CSS identifier (`1st`), and the mockup may declare its own `CSS`, so `CSS.escape` is not ours to call.
      const one = id === "" ? null : element.ownerDocument.getElementById(id);

      return one === null ? [] : [textOf(one)];
    });

  return {
    ariaLabelledBy: labelling.join(" "),
    ariaLabel: attribute("aria-label"),
    native: nativeName(element),
    content: NAMED_BY_CONTENT.has(role) ? textOf(element) : "",
    title: attribute("title"),
    placeholder: attribute("placeholder"),
  };
}

function nameOf(element: Element, role: string): string {
  return nameFrom(role, sourcesOf(element, role));
}

/**
 * The name of the last heading before `element` in the document's order, one that holds it
 * included: a heading by its role, drawn, and named. A hidden tab panel's heading, or a tab drawn
 * as an `h3`, is not one the reviewer reads the element under.
 */
function headingOf(element: Element): string {
  const before = [...element.ownerDocument.querySelectorAll(HEADINGS)].filter(
    (heading) =>
      heading !== element &&
      (heading.compareDocumentPosition(element) & heading.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );

  return firstNamed(before.toReversed());
}

function firstNamed(headings: readonly Element[]): string {
  for (const heading of headings) {
    const role = roleOf(heading.localName, attributesOf(heading));
    const name = role === "heading" && heading.checkVisibility() ? nameOf(heading, role) : "";

    if (name !== "") return name;
  }

  return "";
}

/** The name of the first heading `element` holds, by the same test: what the page calls an option. */
export function headingIn(element: Element): string {
  return firstNamed([...element.querySelectorAll(HEADINGS)]);
}

/** What `element` is, read off its document: the frame computes it at the pick, where the DOM is. */
export function descriptionOf(element: Element): ElementDescription {
  const attributes = attributesOf(element);
  const role = roleOf(element.localName, attributes);

  return {
    heading: headingOf(element),
    role,
    name: nameOf(element, role),
    openingTag: openingTag(element.localName, attributes),
  };
}
