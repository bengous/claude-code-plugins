import type { Host } from "./host.ts";
import type { Live } from "./mode.ts";
import {
  type ChannelEntryWire,
  type ChannelLineWire,
  type GateWire,
  parseRelayed,
  type SessionId,
} from "./parse.ts";
import type { ReviewServer, Unchanged } from "./server.ts";

/**
 * What `$.store` keeps under `relayed:<id>`: the number of the last channel entry Claude was
 * handed, for one channel. A new working directory at the same path is another channel, with
 * another identity, and its numbers restart: a number kept for another channel is worth nothing.
 */
export type Relayed = { readonly channel: string; readonly seq: number };

/**
 * A tool call that waits for the reviewer's answer. `returned` names the entry its result carried
 * to Claude, which is never relayed; `close` ends the wait, after which an entry it held and did
 * not return is relayed, and a `returned` said late is not heard.
 */
export type Claim = {
  readonly returned: (seq: number) => void;
  readonly close: () => void;
};

/**
 * Relays a session's channel to Claude, once each entry and in order, for as long as its mode
 * holds it: one per session in a module's environment, across the servers a revival replaces.
 * `serve` reads from a server from now on and catches up; `hand` takes a line as the server
 * writes it; `retry` reads the channel again after a dropped prompt, or closes an approval whose
 * closing failed; `stop` relays nothing more once the mode was left. `claim` holds, while a tool
 * call waits, each entry `awaits` picks: the call may return it as its result, and then it is
 * never relayed.
 */
export type Follower = {
  readonly serve: (server: ReviewServer, channel: string) => void;
  readonly hand: (line: ChannelLineWire) => void;
  readonly retry: () => void;
  readonly stop: () => void;
  readonly claim: (awaits: (entry: ChannelEntryWire) => boolean) => Claim;
};

/**
 * `behind`: a prompt was dropped, or a read failed, and the channel is read again. `closing`:
 * the approval was told and the mode not closed yet; it is closed again, never told again.
 */
type Phase = "following" | "behind" | "closing" | "stopped";

/** What a follower reads before its first server. */
function nothingToRead(): Promise<ChannelLineWire[]> {
  return Promise.resolve([]);
}

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
 * One queue runs every relay, apart from the loop that reads the server: a prompt submitted while
 * a turn runs resolves once its own turn starts, and the loop must never wait with it. A number
 * already relayed is skipped; a number past the next one reads the entries it missed first. The
 * number is written to `$.store` after each prompt, so a reloaded module or a relaunched server
 * repeats nothing; the approval drops the record, and `approved` closes the mode.
 */
export function follow(host: Host, id: SessionId, approved: () => Promise<void>): Follower {
  const key = relayedKey(id);
  let relayed: Relayed = { channel: "", seq: 0 };
  let read: (after: number) => Promise<ChannelLineWire[]> = nothingToRead;
  let phase: Phase = "following";
  let queue = Promise.resolve();
  // The waits open now, and the entries a tool returned: an entry a wait may return is held until
  // the wait says, since the entry's line and the tool's answer reach the module by two paths.
  const claims = new Set<(entry: ChannelEntryWire) => boolean>();
  const returned = new Set<number>();
  let changed = Promise.withResolvers<void>();

  const change = (): void => {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  };

  const held = (entry: ChannelEntryWire): boolean => [...claims].some((awaits) => awaits(entry));

  /**
   * Whether the entry went to Claude as a tool's result, is due as a prompt, or goes nowhere since
   * the mode was left: while a tool may still return it, it waits.
   */
  const fateOf = async ({
    seq,
    entry,
  }: ChannelLineWire): Promise<"returned" | "due" | "stopped"> => {
    const waiting = (): boolean => !returned.has(seq) && held(entry) && phase !== "stopped";

    while (waiting()) await changed.promise;

    if (phase === "stopped") return "stopped";

    return returned.delete(seq) ? "returned" : "due";
  };

  const run = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((cause: unknown) => {
      host.log(`the channel relay failed: ${String(cause)}`);

      if (phase === "following") phase = "behind";
    });
  };

  const close = async (): Promise<void> => {
    await approved();
    phase = "stopped";
  };

  /** `false` stops a catch-up: a dropped prompt stays due, and the approval ends the relays. */
  const relay = async (line: ChannelLineWire): Promise<boolean> => {
    const { seq, entry } = line;

    if (phase === "stopped" || phase === "closing") return false;

    if (seq <= relayed.seq) return true;
    const fate = await fateOf(line);

    if (fate === "stopped") return false;
    const result = fate === "returned" ? null : await host.submitPrompt(promptOf(entry));

    if (result?.drop !== undefined) {
      host.log(`the review prompt was dropped: ${result.drop}`);

      if (phase === "following") phase = "behind";

      return false;
    }

    relayed = { ...relayed, seq };

    if (entry.kind === "approved") {
      await host.storeDelete(key).catch((cause: unknown) => {
        host.log(`the relayed record was not dropped: ${String(cause)}`);
      });
      phase = "closing";
      await close();

      return false;
    }

    // A store that refuses the record is logged, not obeyed: the prompt went out, once.
    await host.storeSet(key, relayed).catch((cause: unknown) => {
      host.log(`the relayed record was not kept: ${String(cause)}`);
    });

    return true;
  };

  const catchUp = async (): Promise<void> => {
    let next = relayed.seq + 1;

    for (const line of await read(relayed.seq)) {
      if (line.seq > next) host.log(`the channel holds no entry ${next} to ${line.seq - 1}`);

      if (!(await relay(line))) return;
      next = line.seq + 1;
    }

    if (phase === "behind") phase = "following";
  };

  return {
    serve: (server, channel) => {
      run(async () => {
        read = (after) => server.channel(after);

        if (channel !== relayed.channel) relayed = parseRelayed(await host.storeGet(key), channel);
        await catchUp();
      });
    },
    hand: (line) => {
      run(async () => {
        if (phase === "behind" || line.seq > relayed.seq + 1) await catchUp();
        else await relay(line);
      });
    },
    retry: () => {
      if (phase === "behind") run(catchUp);
      else if (phase === "closing") run(close);
    },
    stop: () => {
      phase = "stopped";
      change();
    },
    claim: (awaits) => {
      // Its own function, so two calls of one tool are two waits.
      const hold = (entry: ChannelEntryWire): boolean => awaits(entry);
      let open = true;
      claims.add(hold);

      return {
        returned: (seq) => {
          if (!open) return;
          returned.add(seq);
          change();
        },
        close: () => {
          open = false;
          claims.delete(hold);
          change();
        },
      };
    },
  };
}
