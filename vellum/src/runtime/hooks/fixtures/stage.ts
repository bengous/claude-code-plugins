import type { DrawnWire, WorkspaceWire } from "../parse.ts";
import { WORKDIR } from "./workdir.ts";

export const DRAFTING: WorkspaceWire = { kind: "drafting", dir: WORKDIR, batches: 0 };

export function inReview(version: number): WorkspaceWire {
  return { kind: "inReview", dir: WORKDIR, version, batches: 0, finalizeError: null };
}

/** What the band draws of a line, as a test writes it: the server computes it, never this fixture. */
export const DRAWN: DrawnWire = { pill: { text: "Drafting", tone: "neutral" }, segments: [] };

/** The line the server writes each time the review changes. */
export function stage(workspace: WorkspaceWire = DRAFTING, drawn: DrawnWire = DRAWN) {
  return { type: "stage", workspace, ...drawn };
}
