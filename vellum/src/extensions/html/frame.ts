import { nextSelection } from "../../core/page/selection.ts";
import type { ElementRef } from "../../core/protocol.ts";
import type { FrameToPage, PageToFrame } from "./messages.ts";
import type { Step } from "./pick.ts";
import { elementRelation, labelOf, selectorOf, targetIndex } from "./pick.ts";

/**
 * Injected into every HTML file the server serves, so it runs inside the sandboxed mockup:
 * it owns hovering and selection there, and reports the chosen elements to the page.
 */

const TEXT_LIMIT = 120;

/** The colours are the page's tokens, posted resolved with `vellum:theme` and set on the layer. */
const STYLE = `
.box { position: absolute; box-sizing: border-box; }
.wash { background: color-mix(in srgb, var(--redline) 10%, transparent); }
.adding { border: 2px dashed var(--redline); }
.chosen { border: 2px solid var(--redline); background: color-mix(in srgb, var(--redline) 6%, transparent); }
.comment { border: 2px solid color-mix(in srgb, var(--marker) 70%, var(--ink)); background: color-mix(in srgb, var(--marker) 25%, transparent); }
.label { position: absolute; left: -2px; top: -20px; padding: 3px 6px; border-radius: 3px;
  font: 600 11px/1 ui-monospace, Menlo, monospace; background: var(--redline); color: var(--sheet); white-space: nowrap; }
`;

let method: "select" | "pinpoint" = "select";

let chosen: readonly Element[] = [];

let hovered: Element | null = null;

let holding = false;

let commented: readonly string[] = [];

const layer = document.createElement("div");

function mount(): void {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
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

function refOf(element: Element): ElementRef {
  const steps = chainOf(element)
    .filter((one) => one !== document.body && one !== document.documentElement)
    .toReversed()
    .map((one) => stepOf(one));

  const shown = element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");

  return {
    selector: selectorOf(steps),
    text: shown.replaceAll(/\s+/gu, " ").trim().slice(0, TEXT_LIMIT),
    label: labelOf(stepOf(element)),
  };
}

/** A Ctrl+click, in document order: the same element leaves, one that holds another replaces it. */
function toggled(current: readonly Element[], one: Element): readonly Element[] {
  const { keep, add } = nextSelection(
    current.map((other) =>
      elementRelation(other === one, other.contains(one), one.contains(other)),
    ),
  );

  const next = current.filter((_, index) => keep.includes(index));

  return [...next, ...(add ? [one] : [])].toSorted((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) === 0 ? 1 : -1,
  );
}

function boxFor(element: Element, kind: string, label: string | null): HTMLElement {
  const rect = element.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = `box ${kind}`;
  box.style.cssText = `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px`;

  if (label !== null) {
    const tag = document.createElement("span");
    tag.className = "label";
    tag.textContent = label;
    box.append(tag);
  }

  return box;
}

/** A selector crosses `postMessage` and may no longer match the document; the overlay survives it. */
function commentedElements(): readonly Element[] {
  return commented.flatMap((selector) => {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
  });
}

function draw(): void {
  const adding = holding && chosen.length > 0;

  layer.replaceChildren(
    ...commentedElements().map((element) => boxFor(element, "comment", null)),
    ...chosen.map((element) => boxFor(element, "chosen", null)),
    ...(hovered === null
      ? []
      : [boxFor(hovered, adding ? "wash adding" : "wash", labelOf(stepOf(hovered)))]),
  );
}

function sendPick(): void {
  const [first, ...rest] = chosen.map((element) => refOf(element));
  const last = chosen.at(-1);

  if (first === undefined || last === undefined) {
    post({ type: "vellum:unpick" });

    return;
  }

  const rect = last.getBoundingClientRect();

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

function onMove(event: PointerEvent): void {
  const target = method === "pinpoint" ? targetFrom(event.target) : null;

  if (target === hovered) return;
  hovered = target;
  draw();
}

function onClick(event: MouseEvent): void {
  if (method !== "pinpoint") return;
  event.preventDefault();
  event.stopPropagation();
  const target = targetFrom(event.target);

  if (target === null) return;
  chosen =
    (event.ctrlKey || event.metaKey) && chosen.length > 0 ? toggled(chosen, target) : [target];
  sendPick();
  draw();
}

function onMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return;
  // SAFETY: the page's own `PageToFrame`, posted across the sandbox; an unknown type does nothing.
  const message = event.data as PageToFrame;

  if (message.type === "vellum:method") {
    method = message.method;

    if (method === "select") {
      chosen = [];
      hovered = null;
    }
  }

  if (message.type === "vellum:holding") setHolding(message.holding);

  if (message.type === "vellum:comments") commented = message.selectors;

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

document.addEventListener("pointerleave", () => {
  hovered = null;
  draw();
});

document.addEventListener("click", onClick, true);

document.addEventListener("keydown", onKey);

document.addEventListener("keyup", onKey);

// The keyup never arrives once the focus left: the page must hear the release from here.
window.addEventListener("blur", () => hold(false));

window.addEventListener("scroll", draw, true);

// The page places its composer from the box of a pick: a reflow moves the box, so it is sent again.
window.addEventListener("resize", () => {
  draw();

  if (chosen.length > 0) sendPick();
});

window.addEventListener("message", onMessage);
