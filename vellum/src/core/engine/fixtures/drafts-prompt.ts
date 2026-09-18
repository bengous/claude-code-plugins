import { batch } from "./batch.ts";

export function draftsPrompt(...batches: number[]): string {
  const paths = batches.map((n) => batch(n).path).join(", ");

  return `Drafting feedback: read ${paths}.`;
}
