import { offsetIn } from "../../core/page/anchoring.ts";
import { dragRange, isSwitchKey, keyPressOf, toggled } from "../../core/page/selection.ts";
import type { ElementDescription, ElementRef, WordsContext } from "../../core/protocol.ts";
import { descriptionOf, textOf } from "./describe.ts";
import type { CommentedPlace, FrameToPage, PageToFrame } from "./messages.ts";
import type { Step } from "./pick.ts";
import { labelOf, selectorOf, targetIndex } from "./pick.ts";
import { CLICK_CONTEXT, contextOf, cut, quoted, TEXT_LIMIT, wordsIn } from "./words.ts";

/**
 * Injected into every HTML file the server serves, so it runs inside the sandboxed mockup:
 * it owns hovering and selection there, and reports the chosen elements and the `C` key to the
 * page.
 */

/** The colours are the page's tokens, posted resolved with `vellum:theme` and set on the layer; a commented mark is two-toned, the marker inside an outline, so it holds on a surface of any theme; the hover's outline shows on a coloured surface its wash does not. */
const STYLE = `
.box { position: absolute; box-sizing: border-box; }
.wash { background: color-mix(in srgb, var(--redline) 10%, transparent); outline: 1px solid var(--redline); outline-offset: -1px; }
.adding { border: 2px dashed var(--redline); }
.chosen { border: 2px solid var(--redline); background: color-mix(in srgb, var(--redline) 6%, transparent); }
.comment { border: 2px solid var(--marker); box-shadow: 0 0 0 1px var(--outline); background: color-mix(in srgb, var(--marker) 25%, transparent); }
.label { position: absolute; left: -2px; top: -20px; padding: 3px 6px; border-radius: 3px;
  font: 600 11px/1 ui-monospace, Menlo, monospace; background: var(--redline); color: var(--sheet); white-space: nowrap; }
.label.below { top: 100%; }
`;

/** The label's height above its box: an element closer to the frame's top carries it below. */
const LABEL_HEIGHT = 20;

/**
 * The element a comment names, and what of it was chosen: all of it on a click, the text and
 * where it sits on a drag. What it is is read once, at the pick: a scroll resends the pick every
 * frame.
 */
type Pick = {
  readonly element: Element;
  readonly range: Range;
  readonly text: string;
  readonly context: WordsContext;
  readonly description: ElementDescription;
};

let commenting = false;

let chosen: readonly Pick[] = [];

let hovered: Element | null = null;

let holding = false;

let commented: readonly CommentedPlace[] = [];

/** Where the pointer last was over the frame, for the hover a scroll must move; `null` once it left. */
let pointer: { readonly x: number; readonly y: number } | null = null;

// The click that ends a drag, which picks nothing whether the drag made a place or not.
let swallow = false;

const layer = document.createElement("div");

function mount(): void {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  shadow.append(style, layer);
  document.documentElement.append(host);
}

function post(message: FrameToPage): void {
  window.parent.postMessage(message, "*");
}

function chainOf(element: Element): readonly Element[] {
  const chain: Element[] = [];

  for (let at: Element | null = element; at !== null; at = at.parentElement) chain.push(at);

  return chain;
}

function targetFrom(from: EventTarget | null): Element | null {
  if (!(from instanceof Element)) return null;
  const chain = chainOf(from);
  const index = targetIndex(chain.map((element) => element.tagName.toLowerCase()));

  return index === null ? null : (chain[index] ?? null);
}

function stepOf(element: Element): Step {
  const siblings = [...(element.parentElement?.children ?? [])].filter(
    (other) => other.tagName === element.tagName,
  );

  return {
    tag: element.tagName.toLowerCase(),
    id: element.id === "" ? null : element.id,
    classes: [...element.classList],
    nthOfType: siblings.indexOf(element) + 1,
    sameTagSiblings: siblings.length,
  };
}

function refOf(pick: Pick): ElementRef {
  const steps = chainOf(pick.element)
    .filter((one) => one !== document.body && one !== document.documentElement)
    .toReversed()
    .map((one) => stepOf(one));

  return {
    selector: selectorOf(steps),
    text: pick.text,
    label: labelOf(stepOf(pick.element)),
    context: pick.context,
    description: pick.description,
  };
}

/** What a click quotes of `element`: its shown text, up to the limit. */
function clickText(element: Element): string {
  return cut(textOf(element), TEXT_LIMIT);
}

/** A click picks the whole element: its range holds any drag inside it, so the two overlap. */
function clickPick(element: Element): Pick {
  const range = document.createRange();
  range.selectNode(element);

  return {
    element,
    range,
    text: clickText(element),
    context: CLICK_CONTEXT,
    description: descriptionOf(element),
  };
}

function boxAt(rect: DOMRect, kind: string, label: string | null): HTMLElement {
  const box = document.createElement("div");
  box.className = `box ${kind}`;
  box.style.cssText = `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px`;

  if (label !== null) {
    const tag = document.createElement("span");
    tag.className = rect.top < LABEL_HEIGHT ? "label below" : "label";
    tag.textContent = label;
    box.append(tag);
  }

  return box;
}

function boxFor(of: Element | Range, kind: string, label: string | null): HTMLElement {
  return boxAt(of.getBoundingClientRect(), kind, label);
}

/** A commented element takes one box; the words dragged in one take a box per line, as the sheet paints them. */
function markOf(place: Element | Range): HTMLElement[] {
  const rects =
    place instanceof Range ? [...place.getClientRects()] : [place.getBoundingClientRect()];

  return rects.filter((rect) => rect.width > 0).map((rect) => boxAt(rect, "comment", null));
}

/** `text` as it was quoted, found again in `element` where its context fits best; `null` once it is gone. */
function rangeOfText(element: Element, text: string, context: WordsContext): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: { readonly node: Text; readonly start: number }[] = [];
  let raw = "";

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    nodes.push({ node, start: raw.length });
    raw += node.data;
  }

  const found = wordsIn(raw, text, context);

  if (found === null) return null;

  const at = (offset: number): [Text, number] | null => {
    const holder = nodes.findLast(({ start }) => start <= offset);

    return holder === undefined ? null : [holder.node, offset - holder.start];
  };

  const start = at(found[0]);
  const end = at(found[1]);

  if (start === null || end === null) return null;
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);

  return range;
}

/**
 * What each commented place boxes: the words that were dragged while they are still there,
 * the whole element for a click or once the words are gone. A selector crosses `postMessage`
 * and may no longer match the document; the overlay survives it.
 */
function commentedPlaces(): readonly (Element | Range)[] {
  return commented.flatMap(({ selector, text, context }) => {
    try {
      return [...document.querySelectorAll(selector)].map((element) =>
        text === clickText(element) ? element : (rangeOfText(element, text, context) ?? element),
      );
    } catch {
      return [];
    }
  });
}

function draw(): void {
  const adding = holding && chosen.length > 0;

  layer.replaceChildren(
    ...commentedPlaces().flatMap((place) => markOf(place)),
    ...chosen.map((pick) => boxFor(pick.range, "chosen", null)),
    ...(hovered === null
      ? []
      : [boxFor(hovered, adding ? "wash adding" : "wash", labelOf(stepOf(hovered)))]),
  );
}

function sendPick(): void {
  const [first, ...rest] = chosen.map((pick) => refOf(pick));
  const last = chosen.at(-1);

  if (first === undefined || last === undefined) {
    post({ type: "vellum:unpick" });

    return;
  }

  const rect = last.range.getBoundingClientRect();

  post({
    type: "vellum:pick",
    elements: [first, ...rest],
    box: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
  });
}

function setHolding(next: boolean): void {
  if (next === holding) return;
  holding = next;
  draw();
}

/** The frame's own Ctrl state changed: the page mirrors it, so its Composer lets clicks through or not. */
function hold(next: boolean): void {
  if (next === holding) return;
  setHolding(next);
  post({ type: "vellum:holding", holding: next });
}

function onKey(event: KeyboardEvent): void {
  hold(event.ctrlKey || event.metaKey);
}

function choose(one: Pick, event: MouseEvent): void {
  chosen = (event.ctrlKey || event.metaKey) && chosen.length > 0 ? toggled(chosen, one) : [one];
  sendPick();
  draw();
}

function hover(target: Element | null): void {
  if (target === hovered) return;
  hovered = target;
  draw();
}

function onMove(event: PointerEvent): void {
  pointer = { x: event.clientX, y: event.clientY };
  hover(commenting && event.buttons === 0 ? targetFrom(event.target) : null);
}

/** A drag picks the innermost element that holds the whole selection, with the dragged text. */
function onMouseUp(event: MouseEvent): void {
  const range = commenting ? dragRange(event) : null;

  if (range === null) return;
  swallow = true;
  const ancestor = range.commonAncestorContainer;
  // A phrase inside one text node has that node as its ancestor, and `targetFrom` takes elements.
  const element = targetFrom(ancestor instanceof Element ? ancestor : ancestor.parentElement);
  const text = quoted(range.toString());

  if (element === null || text === "") return;
  const start = offsetIn(element, range.startContainer, range.startOffset);
  const context = contextOf(element.textContent ?? "", start, start + range.toString().length);
  document.getSelection()?.removeAllRanges();
  choose({ element, range, text, context, description: descriptionOf(element) }, event);
}

/**
 * The click that ends a drag is stopped too, then swallowed: a drag that ends on a mockup's
 * button never runs it.
 */
function onClick(event: MouseEvent): void {
  if (!commenting) return;
  event.preventDefault();
  event.stopPropagation();

  if (swallow) {
    swallow = false;

    return;
  }

  const target = targetFrom(event.target);

  if (target !== null) choose(clickPick(target), event);
}

/**
 * `C` inside the mockup flips the page's switch. While on, the key stops here, before every
 * listener of the mockup's document; a `window` listener that the mockup adds before this script,
 * which the server appends at the end of `body`, still hears it.
 */
function onSwitchKey(event: KeyboardEvent): void {
  if (!isSwitchKey(keyPressOf(event))) return;
  post({ type: "vellum:switch" });

  if (commenting) event.stopImmediatePropagation();
}

function onMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return;
  // SAFETY: the page's own `PageToFrame`, posted across the sandbox; an unknown type does nothing.
  const message = event.data as PageToFrame;

  if (message.type === "vellum:commenting") {
    commenting = message.on;

    if (!commenting) {
      chosen = [];
      hovered = null;
    }
  }

  if (message.type === "vellum:holding") setHolding(message.holding);

  if (message.type === "vellum:commented") commented = message.places;

  if (message.type === "vellum:leave") {
    pointer = null;
    hovered = null;
  }

  if (message.type === "vellum:theme") {
    for (const [name, value] of Object.entries(message.theme)) {
      layer.style.setProperty(`--${name}`, value);
    }
  }

  if (message.type === "vellum:clear") chosen = [];
  draw();
}

mount();

document.addEventListener("pointermove", onMove, true);

// A drag that no click follows would otherwise swallow the next real click.
document.addEventListener(
  "pointerdown",
  () => {
    swallow = false;
  },
  true,
);

document.addEventListener("mouseup", onMouseUp, true);

document.addEventListener("click", onClick, true);

window.addEventListener("keydown", onSwitchKey, true);

document.addEventListener("keydown", onKey);

document.addEventListener("keyup", onKey);

// The keyup never arrives once the focus left: the page must hear the release from here.
window.addEventListener("blur", () => hold(false));

let resend = 0;

// The page places its composer from the box of a pick: a scroll or a reflow moves the box, so it
// is sent again, once per frame, since a wheel gesture fires many scroll events a frame. The
// hover is taken again under the pointer, which the scroll moved other text under.
function moved(): void {
  if (commenting && pointer !== null) {
    hovered = targetFrom(document.elementFromPoint(pointer.x, pointer.y));
  }

  draw();

  if (chosen.length === 0 || resend !== 0) return;

  resend = requestAnimationFrame(() => {
    resend = 0;
    sendPick();
  });
}

window.addEventListener("scroll", moved, true);

window.addEventListener("resize", moved);

window.addEventListener("message", onMessage);
