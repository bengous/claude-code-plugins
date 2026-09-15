import type { ProjectPath } from "../src/domain/paths.ts";
import type { Decision, ReviewView } from "../src/protocol.ts";

/** The page's side of the HTTP contract: the token from the URL, the routes, the event stream. */

const token = location.pathname.split("/")[2] ?? "";

const base = `/t/${token}`;

export function fileUrl(path: ProjectPath): string {
  return `${base}/files/${path}`;
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/${path}`, {
    ...init,
    headers: { "x-vellum-token": token, "content-type": "application/json" },
  });
}

export type Fetched<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number };

export async function fetchReview(): Promise<Fetched<ReviewView>> {
  const response = await request("review");

  if (!response.ok) return { ok: false, status: response.status };

  // SAFETY: the server's own `ReviewView`, serialized by `Response.json` in routes.ts.
  return { ok: true, value: (await response.json()) as ReviewView };
}

export async function postDecision(decision: Decision): Promise<number> {
  const response = await request("decision", { method: "POST", body: JSON.stringify(decision) });

  return response.status;
}

/** Calls `onWorkspace` at every workspace event the server pushes. */
export function subscribe(onWorkspace: () => void): void {
  new EventSource(`${base}/events`).addEventListener("message", onWorkspace);
}
