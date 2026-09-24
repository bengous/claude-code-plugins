import type { WorkspaceWire } from "../parse.ts";
import { WORKDIR } from "./workdir.ts";

export const DRAFTING: WorkspaceWire = { kind: "drafting", dir: WORKDIR, batches: 0 };

export function inReview(version: number): WorkspaceWire {
  return { kind: "inReview", dir: WORKDIR, version, batches: 0, finalizeError: null };
}

export function changesRequested(version: number): WorkspaceWire {
  return { kind: "changesRequested", dir: WORKDIR, version };
}

/** The line the server writes each time the review changes. */
export function stage(workspace: WorkspaceWire = DRAFTING) {
  return { type: "stage", workspace };
}
