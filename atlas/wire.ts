// What crosses between the page, serve.ts and the hooks module (hooks/register.ts), beside the
// token threads.ts names: the routes the page and the module post to, what they post, and the
// line serve.ts prints for the module to read. Types and constants only.

// The page posts the reader's selection here, with its Origin and the server's token, each time
// it changes: `place.node ?? place.zone` in engine.ts, the id the URL's #id holds. serve.ts prints
// it with the map's own label, for an id the map holds.
export const SELECTION_PATH = "selection";

// The module beats a server it started here, with the secret it gave the server in HEARTBEAT_ENV,
// under HEARTBEAT_HEADER; a session that joined that server posts here without it, a probe.
// serve.ts started with --heartbeat leaves HEARTBEAT_GRACE_MS after the last beat.
export const HEARTBEAT_PATH = "heartbeat";

export const HEARTBEAT_ENV = "ATLAS_HEARTBEAT";

export const HEARTBEAT_HEADER = "x-atlas-heartbeat";

export const HEARTBEAT_GRACE_MS = 60_000;

// What the page posts: the id of the zone or brick selected, `null` for none.
export type Selected = { readonly id: string | null };

// A zone or a brick by its id and the label the map gives it; `id: null`, nothing selected.
export type Selection =
  | { readonly id: string; readonly label: string }
  | { readonly id: null; readonly label?: undefined };

// What a beat answers: the map folder the server serves, so a port another server took since is
// told apart from this one.
export type Beat = { readonly folder: string };

// One line of serve.ts's stdout, as JSON, after its first line (the page's address). Its other
// lines (a rebuild's) are plain text.
export type ServerLine = { readonly type: "selection" } & Selection;

// The flags every bun process atlas starts takes before its script, `root` the plugin's folder.
// Bun reads bunfig.toml and .env from its working directory, which is often a map folder: a
// bunfig.toml there preloads code, and a .env setting BUN_OPTIONS preloads code in each bun the
// process starts. --config=<file> keeps the first out, written with `=` (`--config <file>` still
// read it), and --no-env-file the second. Measured on Bun 1.4.3, Linux.
export const CHILD_BUNFIG = "child.bunfig.toml";

export const bunFlags = (root: string): readonly string[] => [
  `--config=${root}/${CHILD_BUNFIG}`,
  "--no-env-file",
];
