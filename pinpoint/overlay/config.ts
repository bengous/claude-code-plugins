import type { Spot } from "./view.ts";

/** The labels the composer offers when the app's `pinpoint({ labels })` names none. */
export const DEFAULT_LABELS: readonly string[] = [
  "Misaligned",
  "Too big",
  "Too small",
  "Wrong text",
  "Remove",
];

/**
 * The labels `data-pinpoint-labels` carries, each URI-encoded and joined by commas (the Vite
 * plugin's `overlayTag`); the defaults when the attribute is absent, none when it is empty.
 */
export function labelsFrom(attribute: string | undefined): readonly string[] {
  if (attribute === undefined) return DEFAULT_LABELS;

  return attribute === "" ? [] : attribute.split(",").map((label) => decodeURIComponent(label));
}

/** Whether pointing was on when the page went away, off the mode's kind the tab kept; off for anything else. */
export function pointingFrom(stored: string | null): boolean {
  return stored === "on";
}

const PINNED = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u;

/** Where the tab pinned the composer, off the `x,y` it kept; unpinned for anything else. */
export function pinnedFrom(stored: string | null): Spot | null {
  const match = PINNED.exec(stored ?? "");

  return match === null ? null : { x: Number(match[1]), y: Number(match[2]) };
}

/** How many characters of the session's folder the panel shows: past it, the middle gives way. */
export const FOLDER_CHARS = 36;

/**
 * The session's folder, the last segment of its root, as the panel names it. A longer one keeps
 * its start and its end, where names of sibling checkouts usually differ.
 */
export function folderOf(root: string): string {
  const folder = root.split(/[\\/]/u).findLast((segment) => segment !== "") ?? root;
  const chars = [...folder];

  if (chars.length <= FOLDER_CHARS) return folder;
  const tail = Math.floor((FOLDER_CHARS - 1) / 3);

  return `${chars.slice(0, FOLDER_CHARS - 1 - tail).join("")}…${chars.slice(-tail).join("")}`;
}

/** What the session's name says on hover: the whole directory. */
export function sessionTitle(root: string): string {
  return `Batches go to the Claude Code session in ${root}`;
}

/** The server's address for the page, `http://127.0.0.1:<port>/t/<token>/`, off the overlay's own URL. */
export function baseOf(scriptUrl: string): string {
  return scriptUrl.slice(0, scriptUrl.lastIndexOf("/") + 1);
}
