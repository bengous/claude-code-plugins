/**
 * Every value that crosses a process boundary of pinpoint: the page to the server (HTTP), the
 * server to the page (its event stream), the server to the hooks module (its stdout), the module
 * to the server (HTTP), and the server to the Vite plugin (the registry file).
 */

/** A box in CSS pixels of the viewport, as `getBoundingClientRect` read it at the pick. */
export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** One computed style the selection carries, `[property, value]`. */
export type Style = readonly [property: string, value: string];

/** What an element is, read off the page at the pick: what a reader who does not see the page needs. */
export type ElementInfo = {
  readonly selector: string;
  readonly role: string;
  /** Its accessible name, `""` for none. */
  readonly name: string;
  /** The name of the last heading before it, `""` for none. */
  readonly heading: string;
  readonly openingTag: string;
  readonly text: string;
  readonly box: Box;
  readonly styles: readonly Style[];
};

export type Target =
  | { readonly kind: "element"; readonly element: ElementInfo }
  | { readonly kind: "zone"; readonly box: Box; readonly elements: readonly ElementInfo[] };

export type PageInfo = {
  readonly url: string;
  readonly title: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly scroll: { readonly x: number; readonly y: number };
};

export type Selection = {
  readonly label: string | null;
  readonly note: string;
  readonly targets: readonly Target[];
  readonly page: PageInfo;
  /** What the app's `window.pinpointContext()` answered, as JSON text; `null` when the app gives none. */
  readonly context: string | null;
};

/** `POST /t/<token>/api/batch`. */
export type BatchRequest = { readonly selections: readonly Selection[] };

/** Its answer, 202: the number the server gave the batch. */
export type BatchAccepted = { readonly seq: number };

/** What the server tells the page on `GET /t/<token>/api/events`, one per `data:` line. */
export type PageEvent =
  | { readonly type: "delivered"; readonly seq: number }
  | { readonly type: "dropped"; readonly seq: number; readonly reason: string };

/** What the server writes on stdout for the hooks module, one JSON per line, `ready` first. */
export type ServerLine =
  | { readonly type: "ready"; readonly port: number; readonly token: string }
  | { readonly type: "batch"; readonly seq: number; readonly text: string };

/** `POST /t/<token>/api/delivery`: what became of a batch the module handed to the session. */
export type Delivery =
  | { readonly seq: number; readonly outcome: "delivered" }
  | { readonly seq: number; readonly outcome: "dropped"; readonly reason: string };

/** `~/.claude/pinpoint/sessions/<session>.json`, which the Vite plugin reads to find a live server. */
export type RegistryEntry = {
  readonly version: 1;
  readonly session: string;
  /** The directory the Claude Code session runs in: a Vite root at or under it is served. */
  readonly root: string;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  /** Milliseconds since the epoch: the newest live entry wins. */
  readonly started: number;
};

/** Where every server's files live, under the user's home. */
export const PINPOINT_DIR = ".claude/pinpoint";
