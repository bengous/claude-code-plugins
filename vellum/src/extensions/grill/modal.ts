import type { GrillState, Suggestion } from "./protocol.ts";

/** The page's answer to the proposals, kept in a signal; never sent, so a reload asks again. */
export type Asking =
  | { readonly kind: "auto" }
  /** This proposal was put off: the Grill button carries it until it is opened. */
  | { readonly kind: "later"; readonly id: string }
  /**
   * The modal is up, on the proposal it opened on, or blank (`null`) from the Grill button. What
   * it shows never changes under the reviewer: a proposal that lands meanwhile waits on the dot.
   */
  | { readonly kind: "asked"; readonly on: Suggestion | null }
  /** Started or declined from the modal, the request in flight: no modal and no dot for it. */
  | { readonly kind: "answered"; readonly id: string };

export type Modal =
  | { readonly kind: "hidden" }
  | { readonly kind: "proposal"; readonly suggestion: Suggestion }
  | { readonly kind: "blank" };

const HIDDEN: Modal = { kind: "hidden" };

const AUTO: Asking = { kind: "auto" };

/** The proposal the slot holds pending; `null` with a grill open, a declined one or none. */
export function pendingOf(state: GrillState | null): Suggestion | null {
  return state?.kind === "none" && state.proposal?.kind === "pending"
    ? state.proposal.suggestion
    : null;
}

/** Esc, Cancel or a click on the backdrop: what the slot holds pending waits on the dot. */
export function putOff(state: GrillState | null): Asking {
  const pending = pendingOf(state);

  return pending === null ? AUTO : { kind: "later", id: pending.id };
}

/**
 * Start or Decline clicked on the modal opened on `id`, `null` for the blank one: the proposal
 * answered draws nothing while the request is out; one that replaced it meanwhile waits on the dot.
 */
export function answering(state: GrillState | null, id: string | null): Asking {
  return id !== null && pendingOf(state)?.id === id ? { kind: "answered", id } : putOff(state);
}

/** The answer to `id` failed: the proposal waits on the dot, unless something newer took its place. */
export function answerFailed(asking: Asking, id: string): Asking {
  return asking.kind === "answered" && asking.id === id ? { kind: "later", id } : asking;
}

/**
 * What the modal on screen becomes at a new state: a grill that opens ends it, a load that
 * failed hides it as Esc would, and the proposal it shows, answered elsewhere, takes it along.
 * A proposal that lands meanwhile changes nothing.
 */
function keptOn(state: GrillState | null, on: Suggestion | null): Asking {
  if (state === null) return on === null ? AUTO : { kind: "later", id: on.id };

  return state.kind === "open" || (on !== null && pendingOf(state) === null)
    ? AUTO
    : { kind: "asked", on };
}

/**
 * What a new state does to the page's answer: a proposal that lands opens the modal on a quiet
 * page, and on a typing is put off at once, so the modal opens neither under the reviewer's
 * hands nor once they stop. `quiet`: no editor open, no popover up, no field focused.
 */
export function askingOn(state: GrillState | null, asking: Asking, quiet: boolean): Asking {
  if (asking.kind === "asked") return keptOn(state, asking.on);
  const pending = pendingOf(state);

  if (pending === null || (asking.kind !== "auto" && asking.id === pending.id)) return asking;

  return quiet ? { kind: "asked", on: pending } : { kind: "later", id: pending.id };
}

/**
 * The modal the page shows. On an approved page none shows, whatever the slot holds: the
 * approval cannot reach it.
 */
export function modalOf(state: GrillState | null, asking: Asking, approved: boolean): Modal {
  if (approved || state?.kind !== "none" || asking.kind !== "asked") return HIDDEN;

  if (asking.on === null) return { kind: "blank" };

  return pendingOf(state) === null ? HIDDEN : { kind: "proposal", suggestion: asking.on };
}

/** The proposal the Grill button's dot stands for: pending, put off or landed behind the modal. */
export function dotOf(state: GrillState | null, asking: Asking): Suggestion | null {
  const pending = pendingOf(state);

  if (pending === null) return null;

  switch (asking.kind) {
    case "auto":
    case "answered":
      return null;
    case "later":
      return asking.id === pending.id ? pending : null;
    case "asked":
      return asking.on?.id === pending.id ? null : pending;
  }
}
