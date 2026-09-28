import type { ChannelEntryWire } from "../parse.ts";
import { DATE } from "./date.ts";

export const FINAL = `plans/${DATE}/notification-settings/`;

/** The channel's entry once the plan is approved; `notes` is the notes file's path. */
export function approved(
  version: number,
  notes: string | null = null,
): Extract<ChannelEntryWire, { kind: "approved" }> {
  return { kind: "approved", version, dir: FINAL, notes };
}
