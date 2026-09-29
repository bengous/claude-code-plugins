/** What the sheet prints instead of the document; `null` once the document is there. */
export function waitingText(loaded: boolean, failed: boolean): string | null {
  if (loaded) return null;

  return failed ? "This document could not be loaded." : "Loading…";
}
