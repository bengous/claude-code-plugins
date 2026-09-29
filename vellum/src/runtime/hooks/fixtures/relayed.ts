import { CHANNEL } from "./children.ts";

/** What the store keeps of the channel: the last entry relayed, for one channel. */
export function relayed(seq: number, channel: string = CHANNEL) {
  return { channel, seq };
}
