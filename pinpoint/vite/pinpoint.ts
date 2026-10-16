import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { PINPOINT_DIR, type RegistryEntry } from "../shared/wire.ts";

/**
 * The Vite plugin: in `vite dev` only, each HTML page served gets the overlay of the newest
 * pinpoint server whose session runs at or above the app's root. The server bundles this file to
 * `~/.claude/pinpoint/vite.mjs`, which an app's `vite.config.ts` imports.
 */

export type PinpointOptions = {
  /** The quick labels the composer offers, in order; the plugin's own when absent. */
  readonly labels?: readonly string[];
};

type HtmlTag = {
  readonly tag: "script";
  readonly attrs?: Readonly<Record<string, string | boolean>>;
  readonly children?: string;
  readonly injectTo: "body";
};

/** The part of Vite's `Plugin` this one fills: written here so pinpoint depends on no Vite. */
type VitePlugin = {
  readonly name: string;
  readonly apply: "serve";
  readonly configResolved: (config: { readonly root: string }) => void;
  readonly transformIndexHtml: () => HtmlTag[];
};

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser of the registry, files another process wrote. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEntry(value: unknown): RegistryEntry | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const { session, root, port, token, pid, started } = value;

  return typeof session === "string" &&
    typeof root === "string" &&
    typeof port === "number" &&
    typeof token === "string" &&
    typeof pid === "number" &&
    typeof started === "number"
    ? { version: 1, session, root, port, token, pid, started }
    : null;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
}

function holds(root: string, appRoot: string): boolean {
  const path = relative(root, appRoot);

  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function readEntry(file: string): RegistryEntry | null {
  try {
    return parseEntry(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // A file being written, or removed between the listing and the read: not a server to load.
    return null;
  }
}

/** The newest live server whose session holds `appRoot`, or `null`. */
export function liveEntry(sessions: string, appRoot: string): RegistryEntry | null {
  let names: string[];

  try {
    names = readdirSync(sessions).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }

  const live = names.flatMap((name) => {
    const entry = readEntry(join(sessions, name));

    return entry !== null && holds(entry.root, appRoot) && alive(entry.pid) ? [entry] : [];
  });

  return live.toSorted((a, b) => b.started - a.started)[0] ?? null;
}

/** The tag a page gets: the overlay of `entry`, or a line in the console saying how to start one. */
export function overlayTag(
  entry: RegistryEntry | null,
  appRoot: string,
  labels: readonly string[] | undefined,
): HtmlTag {
  if (entry === null) {
    const hint = `pinpoint: no session holds ${appRoot}. Run /pinpoint:start in Claude Code, then reload.`;

    return { tag: "script", children: `console.info(${JSON.stringify(hint)});`, injectTo: "body" };
  }

  const src = `http://127.0.0.1:${entry.port}/t/${entry.token}/overlay.js`;

  if (labels === undefined) return { tag: "script", attrs: { src, defer: true }, injectTo: "body" };

  // Each label URI-encoded, joined by commas: no quote to escape in the attribute.
  const encoded = labels.map((label) => encodeURIComponent(label)).join(",");

  return {
    tag: "script",
    attrs: { src, defer: true, "data-pinpoint-labels": encoded },
    injectTo: "body",
  };
}

export function pinpoint(options: PinpointOptions = {}): VitePlugin {
  let appRoot = process.cwd();
  const sessions = join(homedir(), PINPOINT_DIR, "sessions");

  return {
    name: "pinpoint",
    apply: "serve",
    configResolved: (config) => {
      appRoot = config.root;
    },
    // Read at each page: a session started after the dev server is found at the next reload.
    transformIndexHtml: () => [overlayTag(liveEntry(sessions, appRoot), appRoot, options.labels)],
  };
}
