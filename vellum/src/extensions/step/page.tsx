import { computed, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

import type { PageExtension } from "../../core/extension.ts";
import { extensionRequest } from "../../core/page/api.ts";
import { connection, editing, fail, review, succeed } from "../../core/page/state.ts";
import { answerFailure } from "./labels.ts";
import type { StepAnswer, StepPosts, StepState } from "./protocol.ts";
import { NextStepButton, StepWindow } from "./window.tsx";

const ID = "step";

/** The server's last word on the step, loaded again at every workspace event; `null` before the first answer. */
const step = signal<StepState | null>(null);

/** Whether the last read of the state was refused: the window on screen is put off, the button greyed. */
const refused = signal(false);

/** What the button and the window read: no state past a refused read. */
const read = computed(() => (refused.value ? null : step.value));

async function loadState(): Promise<void> {
  const response = await extensionRequest(ID, "state").catch(() => null);

  if (response?.ok !== true) {
    refused.value = true;

    return;
  }

  // SAFETY: the server's own `StepState`, serialized by `Response.json` in step/server.ts.
  step.value = (await response.json()) as StepState;
  refused.value = false;
}

/** `true` once the proposal no longer waits on the reviewer: answered, or already answered or replaced (409). */
async function answer(id: string | null, given: StepAnswer): Promise<boolean> {
  const body: StepPosts["answer"] = { id, answer: given };

  const response = await extensionRequest(ID, "answer", {
    method: "POST",
    body: JSON.stringify(body),
  }).catch(() => null);

  if (response === null) {
    fail("send", answerFailure(null, null));

    return false;
  }

  if (response.ok) {
    succeed("send");

    return true;
  }

  // SAFETY: a refusal of step/server.ts, `{ error }` serialized by `Response.json`.
  const refusal = (await response.json().catch(() => null)) as { readonly error?: string } | null;
  fail("send", answerFailure(response.status, refusal?.error ?? null));

  return response.status === 409;
}

/** Why the Next step button is greyed, in its title; `null` while a step can be taken. */
function stepWhy(state: StepState | null): string | null {
  if (connection.value === "down") return "The connection to the review server is lost";

  if (editing.value !== null) return "Finish editing (Done) first";

  return state === null ? "Loading the review" : null;
}

/** Hidden once approved, and while the review is held: a grill open takes no other step. */
function StepAction(): preact.JSX.Element | null {
  const view = review.value;
  const state = read.value;

  useEffect(() => {
    void loadState();
  }, [view]);

  return view?.workspace.kind === "approved" || (step.value?.held ?? null) !== null ? null : (
    <NextStepButton state={state} why={stepWhy(state)} />
  );
}

function StepNotice(): preact.JSX.Element {
  const state = read.value;

  return (
    <StepWindow
      state={state}
      approved={review.value?.workspace.kind === "approved"}
      why={stepWhy(state)}
      onAnswer={answer}
    />
  );
}

export const stepPage: PageExtension = {
  id: "step",
  actions: [StepAction],
  notices: [StepNotice],
};
