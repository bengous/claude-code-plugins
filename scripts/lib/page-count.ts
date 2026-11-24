/** The number of pages a list of `total` items fills at `perPage` items a page; an empty list fills none. */
export function pageCount(total: number, perPage: number): number {
  if (!Number.isInteger(total) || total < 0) {
    throw new RangeError(`total must be a whole number from 0, got ${total}`);
  }

  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError(`perPage must be a whole number from 1, got ${perPage}`);
  }

  return Math.floor(total / perPage) + 1;
}
