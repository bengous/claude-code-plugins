import { computed, signal } from "@preact/signals";

import type { Annotation, Decision, DocRef, PlanWorkspace, ReviewView } from "../src/protocol.ts";
import type { ProjectPath } from "../src/workspace/paths.ts";

const token = location.pathname.split("/")[2] ?? "";

export const base = `/t/${token}`;

export const review = signal<ReviewView | null>(null);

export const annotations = signal<readonly Annotation[]>([]);

/** The document shown; `null` is the plan. */
export const current = signal<ProjectPath | null>(null);

export const split = signal(false);

export const error = signal<string | null>(null);

export const planDoc = computed<DocRef | null>(() => {
  const plan = review.value?.plan;

  return plan === null || plan === undefined
    ? null
    : { path: plan.doc, mediaType: "text/markdown" };
});

export const docs = computed<readonly DocRef[]>(() => {
  const plan = planDoc.value;

  return plan === null ? [] : [plan, ...(review.value?.docs ?? [])];
});

export const currentDoc = computed<DocRef | null>(
  () => docs.value.find((doc) => doc.path === (current.value ?? planDoc.value?.path)) ?? null,
);

/** Decisions are taken on `inReview` only; every other state locks the page. */
export const locked = computed(() => review.value?.workspace.kind !== "inReview");

export function fileUrl(path: ProjectPath): string {
  return `${base}/files/${path}`;
}

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/${path}`, {
    ...init,
    headers: { "x-vellum-token": token, "content-type": "application/json" },
  });
}

export async function loadReview(): Promise<void> {
  const response = await api("review");

  if (!response.ok) {
    error.value = `GET /api/review failed: ${response.status}`;

    return;
  }

  const previous = review.value?.workspace;
  // SAFETY: the server's own `ReviewView`, serialized by `Response.json` in routes.ts.
  const next = (await response.json()) as ReviewView;
  review.value = next;

  if (versionOf(previous) !== versionOf(next.workspace)) annotations.value = [];
}

function versionOf(workspace: PlanWorkspace | undefined): number | null {
  return workspace === undefined || workspace.kind === "drafting" ? null : workspace.version;
}

export async function decide(decision: Decision): Promise<void> {
  const response = await api("decision", { method: "POST", body: JSON.stringify(decision) });

  if (response.status === 409) error.value = "This version was already decided.";
  else if (!response.ok) error.value = `POST /api/decision failed: ${response.status}`;
  await loadReview();
}

export function addAnnotation(annotation: Omit<Annotation, "id">): void {
  annotations.value = [...annotations.value, { ...annotation, id: crypto.randomUUID() }];
}

export function removeAnnotation(id: string): void {
  annotations.value = annotations.value.filter((annotation) => annotation.id !== id);
}

export function select(path: ProjectPath | null): void {
  current.value = path;

  if (path === null || path === planDoc.value?.path) split.value = false;
}

export function step(direction: 1 | -1): void {
  const list = docs.value;

  if (list.length === 0) return;
  const at = list.findIndex((doc) => doc.path === currentDoc.value?.path);
  const next = list[(at + direction + list.length) % list.length];
  select(next?.path ?? null);
}

export function listen(): void {
  const events = new EventSource(`${base}/events`);

  events.addEventListener("message", () => {
    void loadReview();
  });
}
