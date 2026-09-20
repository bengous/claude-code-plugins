import type { ElementRef } from "../../core/protocol.ts";
import type { FrameToPage, PickBox } from "./messages.ts";

/**
 * The boundary of `html`: what the frame's window posts arrives as `unknown` and is parsed here,
 * once. `event.source` proves the window, not the sender: the mockup's own scripts, which the
 * model wrote, run in that window beside `frame.ts` and post from it as well.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- the block below IS the boundary parser the rules ask for: it validates the messages a sandboxed window posts to the page, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseElement(value: unknown): ElementRef | null {
  return isRecord(value) &&
    typeof value.selector === "string" &&
    typeof value.text === "string" &&
    typeof value.label === "string"
    ? { selector: value.selector, text: value.text, label: value.label }
    : null;
}

function parseBox(value: unknown): PickBox | null {
  if (!isRecord(value)) return null;
  const { top, left, width, height } = value;

  return typeof top === "number" &&
    typeof left === "number" &&
    typeof width === "number" &&
    typeof height === "number" &&
    [top, left, width, height].every((side) => Number.isFinite(side))
    ? { top, left, width, height }
    : null;
}

/** `null` for whatever is not a whole `FrameToPage`: the listener drops it and nothing is drawn. */
export function parseFrameToPage(value: unknown): FrameToPage | null {
  if (!isRecord(value)) return null;
  const { type } = value;

  if (type === "vellum:unpick") return { type };

  if (type === "vellum:holding")
    return typeof value.holding === "boolean" ? { type, holding: value.holding } : null;

  if (type !== "vellum:pick" || !Array.isArray(value.elements)) return null;

  const elements = value.elements.map((element: unknown) => parseElement(element));
  const box = parseBox(value.box);

  return box !== null && elements.every((element) => element !== null)
    ? { type, elements, box }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */
