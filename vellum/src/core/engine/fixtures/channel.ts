import type { ChannelEntryWire, ChannelLineWire } from "../parse.ts";
import { WORKDIR } from "./workdir.ts";
import type { World } from "./world.ts";

/** A batch of the reviewer's comments, `.review/v0.feedback-<n>.md` while drafting. */
export function sent(file = `${WORKDIR}.review/v0.feedback-1.md`): ChannelEntryWire {
  return { kind: "sent", file };
}

/** A text an extension worded, relayed as it is. */
export function told(text: string, from = "grill"): ChannelEntryWire {
  return { kind: "text", from, text };
}

/** The line the server writes as an entry lands, under its number. */
export function channelLine(line: ChannelLineWire) {
  return { type: "channel", line };
}

/**
 * As the server does: each entry appended to the channel file under the next number, then
 * written on the last child's stdout.
 */
export function emit(world: World, ...entries: ChannelEntryWire[]): void {
  const lines = entries.map((entry) => {
    const line = { seq: world.channel.length + 1, entry };
    world.channel.push(line);

    return channelLine(line);
  });

  world.children.at(-1)?.write(...lines);
}
