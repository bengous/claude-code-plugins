import { WORKDIR } from "./workdir.ts";

/** What the store keeps of the channel: the last entry relayed, for one working directory. */
export function relayed(channel: number, workdir: string = WORKDIR) {
  return { workdir, channel };
}
