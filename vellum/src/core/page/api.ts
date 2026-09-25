import type {
  Decision,
  DocRef,
  Draft,
  ReviewView,
  SendAnswer,
  SendRequest,
  VellumBuild,
} from "../protocol.ts";
import type { ProjectPath } from "../server/domain/paths.ts";

/** The page's side of the HTTP contract: the token from the URL, the routes, the event stream. */

function token(): string {
  return location.pathname.split("/")[2] ?? "";
}

function base(): string {
  return `/t/${token()}`;
}

export function fileUrl(path: ProjectPath): string {
  return `${base()}/files/${path}`;
}

/** The document's URL, changed with its mtime so a renderer reloads what Claude rewrote. */
export function docUrl(doc: DocRef): string {
  return `${fileUrl(doc.path)}?v=${doc.modified}`;
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/${path}`, {
    ...init,
    headers: { "x-vellum-token": token(), "content-type": "application/json" },
  });
}

/** An extension's own route, `/api/x/<id>/<path>`, behind the same token. */
export function extensionRequest(id: string, path: string, init?: RequestInit): Promise<Response> {
  return request(`x/${id}/${path}`, init);
}

export type Fetched<T> =
  | { readonly ok: true; readonly value: T }
  /** `reason` is the server's own sentence when it gave one; `null` leaves the status to speak. */
  | { readonly ok: false; readonly status: number; readonly reason: string | null };

export async function fetchReview(): Promise<Fetched<ReviewView>> {
  const response = await request("review");

  if (!response.ok) return { ok: false, status: response.status, reason: null };

  // SAFETY: the server's own `ReviewView`, serialized by `Response.json` in routes.ts.
  return { ok: true, value: (await response.json()) as ReviewView };
}

/** The running plugin's version and commit; refused with the server's reason when it could not read them. */
export async function fetchVellumBuild(): Promise<Fetched<VellumBuild>> {
  const response = await request("vellum-build");

  if (response.status === 500) {
    // SAFETY: the server's own `{ error }`, serialized by `Response.json` in routes.ts.
    const { error } = (await response.json()) as { readonly error: string };

    return { ok: false, status: response.status, reason: error };
  }

  if (!response.ok) return { ok: false, status: response.status, reason: null };

  // SAFETY: the server's own `VellumBuild`, parsed at its start and serialized by `Response.json`.
  return { ok: true, value: (await response.json()) as VellumBuild };
}

/** The unsent work the server keeps for a reload, `null` when it keeps none; refused with its reason when it cannot be read. */
export async function fetchDraft(): Promise<Fetched<Draft | null>> {
  const response = await request("draft");

  if (response.status === 409) {
    // SAFETY: the server's own `{ error }`, serialized by `Response.json` in routes.ts.
    const { error } = (await response.json()) as { readonly error: string };

    return { ok: false, status: response.status, reason: error };
  }

  if (!response.ok) return { ok: false, status: response.status, reason: null };

  if (response.status === 204) return { ok: true, value: null };

  // SAFETY: a `Draft` the route's parser read back from the file this page wrote.
  return { ok: true, value: (await response.json()) as Draft };
}

export async function putDraft(
  draft: Draft,
  options?: { readonly keepalive?: boolean },
): Promise<number> {
  const response = await request("draft", {
    method: "PUT",
    body: JSON.stringify(draft),
    ...options,
  });

  return response.status;
}

export async function postDecision(decision: Decision): Promise<number> {
  const response = await request("decision", { method: "POST", body: JSON.stringify(decision) });

  return response.status;
}

/** The Send's status, with its answer when the server gave one: a batch, or why it wrote none. */
export async function postSend(
  sending: SendRequest,
): Promise<{ readonly status: number; readonly answer: SendAnswer | null }> {
  const response = await request("send", { method: "POST", body: JSON.stringify(sending) });

  // SAFETY: the server's own `SendAnswer`, serialized by `Response.json` in routes.ts; a 400 is text.
  const answer = (await response.json().catch(() => null)) as SendAnswer | null;

  return { status: response.status, answer };
}

/**
 * Calls `onWorkspace` at every workspace event the server pushes. `EventSource` reconnects by
 * itself: `onDown` at each attempt that fails, `onUp` once the stream is open again.
 */
export function subscribe(onWorkspace: () => void, onDown: () => void, onUp: () => void): void {
  const events = new EventSource(`${base()}/events`);
  events.addEventListener("message", onWorkspace);
  events.addEventListener("error", onDown);
  events.addEventListener("open", onUp);
}
