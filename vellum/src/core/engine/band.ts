import type { ServerInfo } from "./mode.ts";
import type { DrawnWire } from "./parse.ts";
import { pageUrl } from "./server.ts";

/** What the band above the prompt draws after vellum's name, in order: the segments, then the page's link. */
export type Band = { readonly segments: readonly string[]; readonly href: string };

/** `LinkProps.href` takes `https:` or `http://localhost` alone, and refuses the whole tree over `http://127.0.0.1`. */
function pageHref(info: ServerInfo): string {
  return pageUrl(info, "localhost");
}

/** The segments the server sent, the plan's first, then its pill: nothing before its first `stage` line. */
export function liveBand(info: ServerInfo, drawn: DrawnWire | null): Band {
  return {
    segments: drawn === null ? [] : [...drawn.segments, drawn.pill.text],
    href: pageHref(info),
  };
}

/** A server that is gone says nothing of the plan: the status line says what went wrong. */
export function lostBand(info: ServerInfo): Band {
  return { segments: [], href: pageHref(info) };
}
