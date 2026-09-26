import type { ChannelEntry } from "../domain/channel.ts";
import type { FinalDir } from "../domain/paths.ts";
import type { Effect, JournalLine } from "../domain/workflow.ts";

/**
 * What `interpret` writes through, bound by `Review` to the file system and to its memory. A file
 * is named under the plan's directory and resolved at the write: the approval moves it.
 */
export type EffectPorts = {
  /** `plan.md` as the next version, and the memory of a failed approval forgotten. */
  readonly recordVersion: () => Promise<void>;
  readonly writeFile: (file: string, text: string) => Promise<void>;
  readonly appendFile: (file: string, text: string) => Promise<void>;
  readonly exists: (file: string) => Promise<boolean>;
  readonly removeFile: (file: string) => Promise<void>;
  /** Appends the entry to the channel and answers its number. */
  readonly relay: (entry: ChannelEntry) => Promise<number>;
  /** Hands a waiting call its answer, the entry `seq` it claims, and wakes the waits. */
  readonly returnToCall: (call: string, seq: number, text: string) => void;
  /**
   * The notes, the draft's removal, the approved text back in `plan.md`, then the rename to `dir`
   * and the memory: `false` once a rename that failed left its error in the memory.
   */
  readonly approveDirectory: (dir: FinalDir, notes: string | null) => Promise<boolean>;
  readonly journal: (line: JournalLine) => Promise<void>;
  readonly log: (text: string) => void;
};

/** A write the step could not make before its commit point: the route answers 500, naming its kind. */
export class EffectFailed extends Error {
  public constructor(
    public readonly kind: Effect["kind"],
    cause: unknown,
  ) {
    super(`${kind} failed: ${String(cause)}`, { cause });
  }
}

/** What a step's effects did: the numbers of the entries appended, and whether a failed approval stopped them. */
export type Interpreted = { readonly appended: readonly number[]; readonly stopped: boolean };

/**
 * Runs a step's effects in order, the one code that writes for the workflow. The commit point is
 * the step's first entry of the channel or its rename: before it a failure fails the step, and an
 * entry that fails removes the files the step created, so nothing is told of a step that failed;
 * after it a failure is logged, since Claude or the rename already took the step. A rename that
 * fails stops the rest, and the plan stays under review. The journal line fails nothing.
 */
export async function interpret(
  effects: readonly Effect[],
  ports: EffectPorts,
): Promise<Interpreted> {
  const created: string[] = [];
  const appended: number[] = [];
  let committed = false;
  let stopped = false;

  for (const effect of effects) {
    if (effect.kind === "journal") {
      await ports.journal(effect.line).catch((cause: unknown) => {
        ports.log(`a journal line was not written: ${String(cause)}`);
      });

      continue;
    }

    if (stopped) continue;

    try {
      switch (effect.kind) {
        case "recordVersion":
          await ports.recordVersion();
          break;
        case "writeFile":
          if (!committed && !(await ports.exists(effect.file))) created.push(effect.file);
          await ports.writeFile(effect.file, effect.text);
          break;
        case "appendFile":
          await ports.appendFile(effect.file, effect.text);
          break;
        case "channel":
          appended.push(await ports.relay(effect.entry));
          committed = true;
          break;
        case "returnToCall":
          ports.returnToCall(effect.call, claimed(appended), effect.text);
          break;
        case "approveDirectory":
          stopped = !(await ports.approveDirectory(effect.dir, effect.notes));
          committed = !stopped;
          break;
      }
    } catch (cause) {
      if (committed) {
        ports.log(`${effect.kind} failed after the step was taken: ${String(cause)}`);
        continue;
      }

      if (effect.kind === "channel") {
        for (const file of created) await ports.removeFile(file);
      }

      throw new EffectFailed(effect.kind, cause);
    }
  }

  return { appended, stopped };
}

/** The entry a call claims: the last one its step appended before it. */
function claimed(appended: readonly number[]): number {
  const seq = appended.at(-1);

  if (seq === undefined) throw new Error("a call was answered before any entry told it");

  return seq;
}
