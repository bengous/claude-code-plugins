import type { Unchanged } from "../runtime/hooks/client.ts";
import type { Host } from "../runtime/hooks/host.ts";
import type { Live } from "../runtime/hooks/mode.ts";
import type { GateWire } from "../runtime/hooks/parse.ts";

/**
 * The review's part of the hooks module: its tool, `submit`, and the gate of `plan.md` at the
 * turn's end. `runtime/hooks/register.ts` registers the tool and serves both from its hooks, since
 * `$` is spelled there alone and the matchers are its literals. Loaded by the hooks module, it
 * loads nothing: it reaches `runtime/hooks/` as types.
 */

export const SUBMIT = {
  name: "submit",
  description:
    "Submit plan.md from the vellum working directory for review in the browser, before the turn ends. The turn's end submits it anyway, but only when its text changed; once the reviewer sent a batch on the version under review, this tool also records an unchanged plan.md as the next version. Answers with the version under review. Refused, with the reason, outside a vellum planning session (entered by /vellum:start), when plan.md is missing, when the plan is approved, and while the review is held (a grill, a plan review): plan.md then waits, a prompt tells you once the hold ends, and the end of that turn records it.",
  inputSchema: { type: "object" },
};

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
 * The gate at the main loop's answer: an unchanged text is kept, so a turn that answered a
 * question opens no version, and a server that does not answer is one log line.
 */
export async function gateAtTurnEnd(host: Host, live: Live): Promise<void> {
  await submitPlan(host, live, "keep").catch((cause: unknown) => {
    host.log(`plan.md was not submitted at the turn's end: ${String(cause)}`);
  });
}
