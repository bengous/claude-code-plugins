import type { Decision, DocRef, Draft, ReviewView } from "../protocol.ts";
import type { ProjectPath } from "../server/domain/paths.ts";

/** The page's side of the HTTP contract: the token from the URL, the routes, the event stream. */

const token = location.pathname.split("/")[2] ?? "";

const base = `/t/${token}`;

export function fileUrl(path: ProjectPath): string {
  return `${base}/files/${path}`;
}

/** The document's URL, changed with its mtime so a renderer reloads what Claude rewrote. */
export function docUrl(doc: DocRef): string {
  return `${fileUrl(doc.path)}?v=${doc.modified}`;
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/${path}`, {
    ...init,
    headers: { "x-vellum-token": token, "content-type": "application/json" },
  });
}

/** An extension's own route, `/api/x/<id>/<path>`, behind the same token. */
export function extensionRequest(id: string, path: string, init?: RequestInit): Promise<Response> {
  return request(`x/${id}/${path}`, init);
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

/** The unsent work the server keeps for a reload, `null` when it keeps none. */
export async function fetchDraft(): Promise<Fetched<Draft | null>> {
  const response = await request("draft");

  if (!response.ok) return { ok: false, status: response.status };

  if (response.status === 204) return { ok: true, value: null };

  // SAFETY: a `Draft` this page sent, which the route's parser checked before the server kept it.
  return { ok: true, value: (await response.json()) as Draft };
}

export async function putDraft(draft: Draft): Promise<number> {
  const response = await request("draft", { method: "PUT", body: JSON.stringify(draft) });

  return response.status;
}

export async function postDecision(decision: Decision): Promise<number> {
  const response = await request("decision", { method: "POST", body: JSON.stringify(decision) });

  return response.status;
}

/**
 * Calls `onWorkspace` at every workspace event the server pushes. `EventSource` reconnects by
 * itself: `onDown` at each attempt that fails, `onUp` once the stream is open again.
 */
export function subscribe(onWorkspace: () => void, onDown: () => void, onUp: () => void): void {
  const events = new EventSource(`${base}/events`);
  events.addEventListener("message", onWorkspace);
  events.addEventListener("error", onDown);
  events.addEventListener("open", onUp);
}
