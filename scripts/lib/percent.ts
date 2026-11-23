/** The share `part` is of `whole`, as a whole percent from 0 to 100. */
export function percentOf(part: number, whole: number): number {
  return Math.round((part / whole) * 10);
}
