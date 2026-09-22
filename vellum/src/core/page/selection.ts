/** How a new place sits against one already chosen. */
export type Relation = "same" | "overlapping" | "separate";

/** Which chosen places survive a place added under Ctrl, and whether the new one joins them. */
export type SelectionUpdate = { readonly keep: readonly number[]; readonly add: boolean };

/** Under Ctrl: the same place leaves the set, an overlapping one is replaced, anything else joins. */
export function nextSelection(relations: readonly Relation[]): SelectionUpdate {
  return {
    keep: relations.flatMap((relation, index) => (relation === "separate" ? [index] : [])),
    add: !relations.includes("same"),
  };
}

/**
 * `a.compareBoundaryPoints(Range.<FIELD>, b)` for each constant, by its own name.
 * The names read backwards: START_TO_END compares a's end with b's start.
 */
export type Bounds = {
  /** `Range.START_TO_START`: a.start against b.start. */
  readonly startToStart: number;
  /** `Range.START_TO_END`: a.end against b.start. */
  readonly startToEnd: number;
  /** `Range.END_TO_END`: a.end against b.end. */
  readonly endToEnd: number;
  /** `Range.END_TO_START`: a.start against b.end. */
  readonly endToStart: number;
};

/** Two places overlap when they share text: one that ends where the other starts shares none. */
export function relationOf(bounds: Bounds): Relation {
  if (bounds.startToStart === 0 && bounds.endToEnd === 0) return "same";

  return bounds.startToEnd === 1 && bounds.endToStart === -1 ? "overlapping" : "separate";
}

function boundsOf(a: Range, b: Range): Bounds {
  return {
    startToStart: a.compareBoundaryPoints(Range.START_TO_START, b),
    startToEnd: a.compareBoundaryPoints(Range.START_TO_END, b),
    endToEnd: a.compareBoundaryPoints(Range.END_TO_END, b),
    endToStart: a.compareBoundaryPoints(Range.END_TO_START, b),
  };
}

/** The set once `one` is added under Ctrl, in document order. */
export function toggled<T extends { readonly range: Range }>(
  chosen: readonly T[],
  one: T,
): readonly T[] {
  const { keep, add } = nextSelection(
    chosen.map((other) => relationOf(boundsOf(other.range, one.range))),
  );

  const next = chosen.filter((_, index) => keep.includes(index));

  return [...next, ...(add ? [one] : [])].toSorted((a, b) =>
    a.range.compareBoundaryPoints(Range.START_TO_START, b.range),
  );
}

/**
 * What is selected, as a copy the clearing of the selection keeps, or `null` for nothing. The
 * last range: a Firefox Ctrl+drag adds one to a selection that holds one already.
 */
export function selectedRange(): Range | null {
  const selection = document.getSelection();

  // `getRangeAt` throws on a selection with no range: the guard comes first.
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;

  return selection.getRangeAt(selection.rangeCount - 1).cloneRange();
}

/** What a primary-button drag leaves selected; `null` for a click and any other button. */
export function dragRange(event: MouseEvent): Range | null {
  return event.button === 0 ? selectedRange() : null;
}

/**
 * The attribute a renderer sets on its sheet, the document it draws from Markdown source lines:
 * the core finds the sheet by this name, never by a renderer's class.
 */
export const SHEET_ATTRIBUTE = "data-sheet";

/** Where a key comes from: the Markdown sheet, a mockup's frame, or anywhere else in the page. */
export type KeyOrigin = "sheet" | "frame" | "elsewhere";

export type KeyPress = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "repeat"> & {
  /** The key went to a field: `input`, `textarea`, `select` or editable content. */
  readonly typing: boolean;
  readonly from: KeyOrigin;
};

/** `c` flips the switch from a document that takes comments alone: the sheet, or a mockup's frame. */
export function isSwitchKey(press: KeyPress): boolean {
  return (
    (press.key === "c" || press.key === "C") &&
    !press.ctrlKey &&
    !press.metaKey &&
    !press.altKey &&
    !press.repeat &&
    !press.typing &&
    press.from !== "elsewhere"
  );
}

/**
 * Field by field: a spread copies none of a KeyboardEvent's fields, which are getters. `from` is
 * read off the path: through the sheet, or up to the window of a framed document.
 */
export function keyPressOf(event: KeyboardEvent): KeyPress {
  // The path's first node, not `target`: an open shadow root retargets a key typed in its input
  // to its host.
  const path = event.composedPath();
  const [origin] = path;
  const sheet = `[${SHEET_ATTRIBUTE}]`;
  const inSheet = path.some((node) => node instanceof Element && node.matches(sheet));

  return {
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    repeat: event.repeat,
    typing:
      origin instanceof HTMLElement &&
      (origin.isContentEditable || origin.matches("input, textarea, select")),
    from: inSheet ? "sheet" : window.parent === window ? "elsewhere" : "frame",
  };
}
