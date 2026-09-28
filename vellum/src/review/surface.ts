/**
 * The review's values a part may use, frozen: one more is a decision to take. A part reads the
 * review through `contract.ts`, as types, and takes a value from this file, or the composer every
 * renderer opens from `composer.tsx`, the one other file of the surface (`REVIEW_SURFACE` in
 * `src/boundaries.spec.ts`): the mockup's frame script loads this file, and the composer would
 * bring the page's store and Preact into it.
 */

export {
  bestOffset,
  commonPrefix,
  commonSuffix,
  CONTEXT_CHARS,
  offsetIn,
  parseLines,
  passageFromRange,
  rangeFor,
} from "./anchoring.ts";

export { choicesIn } from "./review.ts";

export {
  dragRange,
  isSwitchKey,
  keyPressOf,
  selectedRange,
  SHEET_ATTRIBUTE,
  toggled,
} from "./selection.ts";
