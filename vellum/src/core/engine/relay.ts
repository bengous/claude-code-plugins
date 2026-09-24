import type { Host } from "./host.ts";
import type { Live } from "./mode.ts";
import type { ChannelEntryWire, ChannelLineWire, GateWire, SessionId, Workdir } from "./parse.ts";
import type { Unchanged } from "./server.ts";

/**
 * What `$.store` keeps under `relayed:<id>`: the number of the last channel entry Claude was
 * handed, for one working directory. The numbers restart with the directory, so a number kept
 * for another one is worth nothing.
 */
export type Relayed = { readonly workdir: Workdir; readonly channel: number };

/**
 * Relays the channel's entries to Claude, once each and in order. `hand` takes a line as the
 * server writes it, `catchUp` reads the entries past the last one relayed, at a (re)spawn, and
 * `retry` does so only after a prompt another plugin dropped.
 */
export type Follower = {
  readonly hand: (line: ChannelLineWire) => void;
  readonly catchUp: () => void;
  readonly retry: () => void;
};

/**
 * What the follower answers to: whether its mode is still the current one, so a mode that was
 * left relays nothing more, and the approval that ends it.
 */
export type Following = {
  readonly current: () => boolean;
  readonly approved: () => Promise<void>;
};

export function relayedKey(id: SessionId): string {
  return `relayed:${id}`;
}

/**
 * Each entry as Claude reads it: the fact and its object, nothing else. The skill `start` already
 * says what to do with a file the reviewer sent and with an approval.
 */
function promptOf(entry: ChannelEntryWire): string {
  if (entry.kind === "text") return entry.text;

  if (entry.kind === "sent") return `Reviewer sent: read ${entry.file}.`;
  const notes = entry.notes === null ? "" : ` Read ${entry.notes} first.`;

  return `Plan v${entry.version} approved, at ${entry.dir}.${notes}`;
}

/**
 * Submits `plan.md` and says where it stands. A recorded version is announced in the
 * transcript, and the band draws it from the next `stage` line; a kept one changes nothing; a
 * refusal (no `plan.md` yet, the plan approved) is the caller's to read; a server that does not
 * answer is a rejection.
 */
export async function submitPlan(host: Host, live: Live, unchanged: Unchanged): Promise<GateWire> {
  const gate = await live.server.gate(unchanged);

  if ("error" in gate || gate.kept) return gate;
  host.log(`plan v${gate.version} is under review in the browser`);

  return gate;
}

/**
 * What the model reads from `submit`. A kept version reads as a recorded one: the model ends
 * its turn on both, and the skill `start` already says the review arrives as a prompt.
 */
export function submitResult(gate: GateWire): { result: string } | { deny: string } {
  return "error" in gate
    ? { deny: gate.error }
    : { result: `Plan v${gate.version} under review. End your turn.` };
}

/**
 * Follows the channel of `live`'s server, from what the store says was relayed. One queue runs
 * every relay, apart from the loop that reads the server: a prompt waits for the session to be
 * idle, and the loop must never wait with it. A number already relayed is skipped; a number past
 * the next one reads the entries it missed first. The number is written to `$.store` after each
 * prompt, so a reloaded module or a relaunched server repeats nothing; an approval drops the
 * record, since the next plan's directory numbers its channel from one again.
 */
export function follow(host: Host, live: Live, from: Relayed, following: Following): Follower {
  const key = relayedKey(live.session.id);
  let relayed = from;
  let behind = false;
  let queue = Promise.resolve();

  const run = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((cause: unknown) => {
      behind = true;
      host.log(`the channel relay failed: ${String(cause)}`);
    });
  };

  /** `false` when the prompt was dropped: the entry stays due, and the heartbeat retries it. */
  const relay = async ({ seq, entry }: ChannelLineWire): Promise<boolean> => {
    if (seq <= relayed.channel || !following.current()) return true;
    const result = await host.submitPrompt(promptOf(entry));

    if (result.drop !== undefined) {
      host.log(`the review prompt was dropped: ${result.drop}`);
      behind = true;

      return false;
    }

    relayed = { ...relayed, channel: seq };

    if (entry.kind === "approved") {
      await host.storeDelete(key).catch((cause: unknown) => {
        host.log(`the relayed record was not dropped: ${String(cause)}`);
      });
      await following.approved();

      return true;
    }

    // A store that refuses the record is logged, not obeyed: the prompt went out, once.
    await host.storeSet(key, relayed).catch((cause: unknown) => {
      host.log(`the relayed record was not kept: ${String(cause)}`);
    });

    return true;
  };

  const catchUp = async (): Promise<void> => {
    for (const line of await live.server.channel(relayed.channel)) {
      if (!(await relay(line))) return;
    }

    behind = false;
  };

  return {
    hand: (line) => {
      run(async () => {
        if (behind || line.seq > relayed.channel + 1) await catchUp();
        else await relay(line);
      });
    },
    catchUp: () => {
      run(catchUp);
    },
    retry: () => {
      if (behind) run(catchUp);
    },
  };
}
