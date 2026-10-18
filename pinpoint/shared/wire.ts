/**
 * Every value that crosses a process boundary of pinpoint: the page to the server (HTTP), the
 * server to the page (its answers), the server to the hooks module (its stdout), the module to
 * the server (HTTP), and the server to the Vite plugin (the registry file). The "Which app?" form
 * posts one field, `url`, read by `targetOf` (`target.ts`).
 */

/**
 * A box in CSS pixels. Every box a selection carries is in page pixels, from the top-left corner
 * of the document: measured at its pick, the viewport's box plus the scroll then.
 */
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

/**
 * What the server writes on stdout for the hooks module, one JSON per line, `ready` first.
 * `target` is the app the server serves, an `http(s)` URL's `href`, `null` while none is chosen:
 * `ready` says the one it took from `--target`, which it refuses when that is its own address; a
 * `target` line says the app a page picked or `api/target` set since.
 */
export type ServerLine =
  | {
      readonly type: "ready";
      readonly port: number;
      readonly token: string;
      readonly target: string | null;
    }
  | { readonly type: "batch"; readonly seq: number; readonly text: string }
  | { readonly type: "target"; readonly target: string };

/**
 * The session a server sends its batches to, which it bakes into the overlay it builds as
 * `PINPOINT_SESSION`: every page that loads the overlay from that server names it.
 */
export type OverlaySession = {
  /** The Claude Code session's directory, `--root`. */
  readonly root: string;
};

/** `POST /t/<token>/api/target`, the module's alone: the app to serve from now on. */
export type TargetRequest = { readonly url: string };

/** `POST /t/<token>/api/delivery`: what became of a batch the module handed to the session. */
export type Delivery =
  | { readonly seq: number; readonly outcome: "delivered" }
  | { readonly seq: number; readonly outcome: "dropped"; readonly reason: string };

/**
 * What became of a batch, as `GET /t/<token>/api/outcomes?seq=<n>&seq=<n>` answers it, one per
 * seq asked, in order: `pending` until the module reports it, then what it reported; `unknown`
 * for a seq the server holds nothing of, never numbered or settled too long ago.
 */
export type Outcome =
  | { readonly seq: number; readonly outcome: "pending" }
  | Delivery
  | { readonly seq: number; readonly outcome: "unknown" };

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
