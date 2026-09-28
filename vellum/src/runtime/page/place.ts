/** A box in the scrolled content of a pane: the target of a popover, or the pane's own window. */
export type Rect = {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
};

export type Placement = { readonly top: number; readonly left: number };

/** A pane's window in its own scrolled content: the space `placeNear` keeps a popover inside. */
export function windowOf(pane: HTMLElement): Rect {
  return {
    top: pane.scrollTop,
    left: pane.scrollLeft,
    width: pane.clientWidth,
    height: pane.clientHeight,
  };
}

const GAP = 8;

/**
 * Under `target` when the room exists in `pane`, above it otherwise, under again when neither
 * side has it, since the pane scrolls; never past the pane's right edge nor before its left.
 */
export function placeNear(
  target: Rect,
  pane: Rect,
  size: { readonly width: number; readonly height: number },
): Placement {
  const under = target.top + target.height + GAP;
  const over = target.top - GAP - size.height;
  const above = under + size.height > pane.top + pane.height && over >= pane.top;
  const rightmost = pane.left + pane.width - size.width - GAP;

  return {
    top: above ? over : under,
    left: Math.max(pane.left + GAP, Math.min(target.left, rightmost)),
  };
}
