import type { Box, ElementInfo, PageInfo } from "../shared/wire.ts";
import { cut, descriptionOf, TEXT_LIMIT, textOf } from "./describe.ts";
import {
  covers,
  labelOf,
  outermost,
  pageBox,
  type Scroll,
  selectorOf,
  type Step,
  targetIndex,
} from "./pick.ts";
import { keptStyles } from "./styles.ts";

/** What the overlay reads off the app's page: elements, their boxes, the page, the app's context. */

declare global {
  interface Window {
    /** Set by the app: what it wants Claude to know of its state, read at each selection. */
    pinpointContext?: () => object | string | number | boolean | null;
  }
}

/** A zone names this many elements at most, the outermost first in the document's order. */
const ZONE_ELEMENTS = 12;

/** Where the viewport draws `element`. */
export function boxOf(element: Element): Box {
  const { x, y, width, height } = element.getBoundingClientRect();

  return { x, y, width, height };
}

export function scrollOf(): Scroll {
  return { x: window.scrollX, y: window.scrollY };
}

function stepOf(element: Element): Step {
  const parent = element.parentElement;

  const twins =
    parent === null
      ? [element]
      : [...parent.children].filter((one) => one.localName === element.localName);

  return {
    tag: element.localName,
    id: element.id === "" ? null : element.id,
    classes: [...element.classList],
    nthOfType: twins.indexOf(element) + 1,
    sameTagSiblings: twins.length,
  };
}

/** The chain from below `body` down to `element`, outermost first. */
function chainOf(element: Element): Step[] {
  const steps: Step[] = [];

  for (
    let at: Element | null = element;
    at !== null && at.localName !== "body" && at.localName !== "html";
    at = at.parentElement
  ) {
    steps.unshift(stepOf(at));
  }

  return steps;
}

export function shortLabel(element: Element): string {
  return labelOf(stepOf(element));
}

export function infoOf(element: Element): ElementInfo {
  const description = descriptionOf(element);
  const computed = getComputedStyle(element);

  return {
    selector: selectorOf(chainOf(element)),
    ...description,
    text: cut(textOf(element), TEXT_LIMIT),
    box: pageBox(boxOf(element), scrollOf()),
    styles: keptStyles((property) => computed.getPropertyValue(property)),
  };
}

/** The element a point picks, `host` (the overlay) never: inside an SVG, the whole `svg`. */
export function elementAt(x: number, y: number, host: Element): Element | null {
  const under = document.elementFromPoint(x, y);

  if (under === null || under === host || host.contains(under)) return null;
  const chain: Element[] = [];

  for (let at: Element | null = under; at !== null; at = at.parentElement) chain.push(at);
  const index = targetIndex(chain.map((one) => one.localName));

  return index === null ? null : (chain[index] ?? null);
}

/** The box of what an element draws, its text and children: a block as wide as its column draws much less. */
function contentBox(element: Element): Box {
  const range = document.createRange();
  range.selectNodeContents(element);
  const { x, y, width, height } = range.getBoundingClientRect();

  return { x, y, width, height };
}

function meets(zone: Box, box: Box): boolean {
  return (
    box.x < zone.x + zone.width &&
    zone.x < box.x + box.width &&
    box.y < zone.y + zone.height &&
    zone.y < box.y + box.height
  );
}

/**
 * The outermost elements a zone of the viewport covers, the overlay's own left out: at least half
 * of the element's box, or of what it draws, lies in the zone.
 */
export function zoneElements(zone: Box, host: Element): Element[] {
  const covered = [...document.body.querySelectorAll("*")].filter((element) => {
    if (element === host || host.contains(element)) return false;
    const box = boxOf(element);

    return meets(zone, box) && (covers(zone, box) || covers(zone, contentBox(element)));
  });

  return outermost(covered, (element) => element.parentElement).slice(0, ZONE_ELEMENTS);
}

export function pageInfo(): PageInfo {
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  };
}

/** What `window.pinpointContext()` answers, as JSON; `null` when the app sets none. */
export function appContext(): string | null {
  const read = window.pinpointContext;

  if (read === undefined) return null;

  try {
    return JSON.stringify(read()) ?? null;
  } catch (cause) {
    return JSON.stringify({ pinpointContextFailed: String(cause) });
  }
}
