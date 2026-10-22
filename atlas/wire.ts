// What crosses between the page, serve.ts and the hooks module (hooks/register.ts), beside the
// token threads.ts names: the routes the page and the module post to, what they post, and the
// line serve.ts prints for the module to read. Types and constants only.

// The page posts the reader's selection here, with its Origin and the server's token, each time
// it changes: `place.node ?? place.zone` in engine.ts, the id the URL's #id holds.
export const SELECTION_PATH = "selection";

// The module beats a server it started here, with the secret it gave the server in HEARTBEAT_ENV,
// under HEARTBEAT_HEADER; a session that joined that server posts here without it, a probe.
// serve.ts started with --heartbeat leaves HEARTBEAT_GRACE_MS after the last beat.
export const HEARTBEAT_PATH = "heartbeat";

export const HEARTBEAT_ENV = "ATLAS_HEARTBEAT";

export const HEARTBEAT_HEADER = "x-atlas-heartbeat";

export const HEARTBEAT_GRACE_MS = 60_000;

// A zone or a brick by its id and the label the map draws; `id: null`, nothing selected.
export type Selection =
  | { readonly id: string; readonly label: string }
  | { readonly id: null; readonly label?: undefined };

// What a beat answers: the map folder the server serves, so a port another server took since is
// told apart from this one.
export type Beat = { readonly folder: string };

// One line of serve.ts's stdout, as JSON, after its first line (the page's address). Its other
// lines (a rebuild's) are plain text.
export type ServerLine = { readonly type: "selection" } & Selection;
