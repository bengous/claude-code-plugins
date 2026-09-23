import type { GrillState, Suggestion } from "./protocol.ts";

/** The page's answer to the proposals, kept in a signal; never sent, so a reload asks again. */
export type Asking =
  | { readonly kind: "auto" }
  /** This proposal was put off: the Grill button carries it until it is opened. */
  | { readonly kind: "later"; readonly id: string }
  /** The Grill button was clicked. */
  | { readonly kind: "asked" };

export type Modal =
  | { readonly kind: "hidden" }
  | { readonly kind: "proposal"; readonly suggestion: Suggestion }
  | { readonly kind: "blank" };

const HIDDEN: Modal = { kind: "hidden" };

/** The proposal the slot holds pending; `null` with a grill open, a declined one or none. */
export function pendingOf(state: GrillState | null): Suggestion | null {
  return state?.kind === "none" && state.proposal?.kind === "pending"
    ? state.proposal.suggestion
    : null;
}

/**
 * What a new state does to the page's answer: a proposal landing on a typing is put off at once,
 * so the modal opens neither under the reviewer's hands nor once they stop; a grill that opens
 * ends what the Grill button asked for.
 */
export function askingOn(state: GrillState | null, asking: Asking, quiet: boolean): Asking {
  if (state?.kind === "open") return asking.kind === "asked" ? { kind: "auto" } : asking;
  const pending = pendingOf(state);

  return pending === null || quiet || asking.kind === "asked"
    ? asking
    : { kind: "later", id: pending.id };
}

/**
 * The modal the page shows. `quiet`: no editor open, no popover up, no field focused; the
 * Grill button's click is quiet by itself. On an approved page none shows, whatever the slot
 * holds: the approval cannot reach it.
 */
export function modalOf(
  state: GrillState | null,
  asking: Asking,
  approved: boolean,
  quiet: boolean,
): Modal {
  if (approved || state?.kind !== "none") return HIDDEN;
  const pending = pendingOf(state);

  if (asking.kind === "asked") {
    return pending === null ? { kind: "blank" } : { kind: "proposal", suggestion: pending };
  }

  if (pending === null || !quiet) return HIDDEN;

  return asking.kind === "later" && asking.id === pending.id
    ? HIDDEN
    : { kind: "proposal", suggestion: pending };
}
