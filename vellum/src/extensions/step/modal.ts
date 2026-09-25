import type { Pending, StepState } from "./protocol.ts";

/** The page's answer to the proposals, kept in a signal; never sent, so a reload asks again. */
export type Asking =
  | { readonly kind: "auto" }
  /** This proposal was put off: the Next step button carries it until it is opened. */
  | { readonly kind: "later"; readonly id: string }
  /**
   * The modal is up, on the proposal it opened on, or blank (`null`) from the Next step button.
   * What it shows never changes under the reviewer: a proposal that lands meanwhile waits on the dot.
   */
  | { readonly kind: "asked"; readonly on: Pending | null }
  /** Answered from the modal, the request in flight: no modal and no dot for it. */
  | { readonly kind: "answered"; readonly id: string };

export type Modal =
  | { readonly kind: "hidden" }
  | { readonly kind: "proposal"; readonly pending: Pending }
  | { readonly kind: "blank" };

const HIDDEN: Modal = { kind: "hidden" };

const AUTO: Asking = { kind: "auto" };

/** The proposal waiting; `null` with none, or while the review is held: no step is taken then. */
export function pendingOf(state: StepState | null): Pending | null {
  return state?.held === null ? state.pending : null;
}

/** Esc, Later or a click on the backdrop: the proposal waiting waits on the dot. */
export function putOff(state: StepState | null): Asking {
  const pending = pendingOf(state);

  return pending === null ? AUTO : { kind: "later", id: pending.id };
}

/**
 * An answer given on the modal opened on `id`, `null` for the blank one: the proposal answered
 * draws nothing while the request is out; one that replaced it meanwhile waits on the dot.
 */
export function answering(state: StepState | null, id: string | null): Asking {
  return id !== null && pendingOf(state)?.id === id ? { kind: "answered", id } : putOff(state);
}

/** The answer to `id` did not land: the proposal waits on the dot, unless something newer took its place. */
export function answerFailed(asking: Asking, id: string): Asking {
  return asking.kind === "answered" && asking.id === id ? { kind: "later", id } : asking;
}

/**
 * What the modal on screen becomes at a new state: a hold (a grill that opens) ends it, a load
 * that failed hides it as Esc would, and the proposal it shows, answered elsewhere, takes it
 * along. A proposal that lands meanwhile changes nothing.
 */
function keptOn(state: StepState | null, on: Pending | null): Asking {
  if (state === null) return on === null ? AUTO : { kind: "later", id: on.id };

  return state.held !== null || (on !== null && pendingOf(state) === null)
    ? AUTO
    : { kind: "asked", on };
}

/**
 * What a new state does to the answer to `id`, sent or refused as no longer pending: it holds
 * while `id` still waits, and ends once nothing does. A proposal waiting in its place waits on the
 * dot, whichever reached the page first, the refusal or that proposal: the reviewer just answered
 * the modal, and it does not open again under their hands.
 */
function answeredOn(state: StepState | null, id: string): Asking {
  const pending = pendingOf(state);

  if (state === null || pending?.id === id) return { kind: "answered", id };

  return pending === null ? AUTO : { kind: "later", id: pending.id };
}

/**
 * What a new state does to the page's answer: a proposal that lands opens the modal on a quiet
 * page, and on a typing is put off at once, so the modal opens neither under the reviewer's
 * hands nor once they stop. `quiet`: no editor open, no popover or other modal up, no field focused.
 */
export function askingOn(state: StepState | null, asking: Asking, quiet: boolean): Asking {
  if (asking.kind === "asked") return keptOn(state, asking.on);

  if (asking.kind === "answered") return answeredOn(state, asking.id);
  const pending = pendingOf(state);

  if (pending === null || (asking.kind === "later" && asking.id === pending.id)) return asking;

  return quiet ? { kind: "asked", on: pending } : { kind: "later", id: pending.id };
}

/**
 * The modal the page shows. On an approved page none shows, whatever waits: the approval took it,
 * and no step follows.
 */
export function modalOf(state: StepState | null, asking: Asking, approved: boolean): Modal {
  if (approved || state === null || state.held !== null || asking.kind !== "asked") return HIDDEN;

  if (asking.on === null) return { kind: "blank" };

  return pendingOf(state) === null ? HIDDEN : { kind: "proposal", pending: asking.on };
}

/** The proposal the Next step button's dot stands for: waiting, put off or landed behind the modal. */
export function dotOf(state: StepState | null, asking: Asking): Pending | null {
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
