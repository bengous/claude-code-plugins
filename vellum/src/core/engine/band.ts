import type { ServerInfo } from "./mode.ts";
import type { StageWire } from "./parse.ts";
import { pageUrl } from "./server.ts";

/** What the band above the prompt draws after vellum's name, in order: the segments, then the page's link. */
export type Band = { readonly segments: readonly string[]; readonly href: string };

/** `LinkProps.href` takes `https:` or `http://localhost` alone, and refuses the whole tree over `http://127.0.0.1`. */
function pageHref(info: ServerInfo): string {
  return pageUrl(info, "localhost");
}

function planSegment(stage: StageWire): string {
  switch (stage.kind) {
    case "drafting":
      return "plan draft";
    case "inReview":
      return `plan v${stage.version} · in review`;
    case "approved":
      return `plan v${stage.version} · approved`;
  }
}

/** The core's segment first, then each extension's in registry order; `null` says nothing. */
export function liveBand(
  info: ServerInfo,
  stage: StageWire | null,
  extensions: readonly (string | null)[],
): Band {
  const plan = stage === null ? [] : [planSegment(stage)];

  return {
    segments: [...plan, ...extensions.filter((segment) => segment !== null)],
    href: pageHref(info),
  };
}

/** A server that is gone says nothing of the plan: the status line says what went wrong. */
export function lostBand(info: ServerInfo): Band {
  return { segments: [], href: pageHref(info) };
}
