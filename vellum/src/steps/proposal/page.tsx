import type { JSX } from "react";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { PageHalf } from "../../runtime/extension.ts";
import { extensionRequest } from "../../runtime/page/api.ts";
import type { EditSession } from "../../runtime/page/state.ts";
import { fail, memoized, succeed, usePage } from "../../runtime/page/state.ts";
import type { ReviewView } from "../../runtime/protocol.ts";
import type { AnswerBody, StepAnswer, ProposalPlugs, StepState } from "./contract.ts";
import { answerFailure } from "./labels.ts";
import type { WindowState } from "./modal.ts";
import { NextStepButton, StepWindow } from "./window.tsx";

const ID: ProposalPlugs["id"] = "proposal";

/** The part's own state: what the server said of the step, and whether its last read was refused. */
type ProposalPage = {
  /** The server's last word on the step, loaded again at every workspace event; `null` before the first answer. */
  readonly step: StepState | null;
  /** Whether the last read of the state was refused: the window on screen is put off, the button greyed. */
  readonly refused: boolean;
};

const proposalStore = createStore<ProposalPage>(() => ({ step: null, refused: false }));

function useProposal<T>(pick: (s: ProposalPage) => T): T {
  return useStore(proposalStore, pick);
}

/** What the button and the window read: the proposal, whether it is paused, and the core's hold, none past a refused read. */
const readOf = memoized(
  (
    view: ReviewView | null,
    step: StepState | null,
    refused: boolean,
  ): [ReviewView | null, StepState | null, boolean] => [view, step, refused],
  (view, step, refused): WindowState | null =>
    refused || step === null || view === null
      ? null
      : { pending: step.pending, held: view.workflow.held, paused: step.paused },
);

function useRead(): WindowState | null {
  const view = usePage((s) => s.review);
  const step = useProposal((s) => s.step);
  const refused = useProposal((s) => s.refused);

  return readOf(view, step, refused);
}

async function loadState(): Promise<void> {
  const response = await extensionRequest(ID, "state").catch(() => null);

  if (response?.ok !== true) {
    proposalStore.setState({ refused: true });

    return;
  }

  // SAFETY: the server's own `StepState`, serialized by `Response.json` in step/server.ts.
  proposalStore.setState({ step: (await response.json()) as StepState, refused: false });
}

/** `true` once the proposal no longer waits on the reviewer: answered, or already answered or replaced (409). */
async function answer(id: string | null, given: StepAnswer): Promise<boolean> {
  const body: AnswerBody = { id, answer: given };

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
function stepWhy(
  state: WindowState | null,
  connection: "up" | "down",
  editing: EditSession | null,
): string | null {
  if (connection === "down") return "The connection to the review server is lost";

  if (editing !== null) return "Finish editing (Done) first";

  return state === null ? "Loading the review" : null;
}

/** Hidden once approved, and while the review is held: a grill open takes no other step. */
function StepAction(): JSX.Element | null {
  const view = usePage((s) => s.review);
  const connection = usePage((s) => s.connection);
  const editing = usePage((s) => s.editing);
  const state = useRead();

  useEffect(() => {
    void loadState();
  }, [view]);

  return view === null ||
    view.workspace.kind === "approved" ||
    view.workflow.held !== null ? null : (
    <NextStepButton state={state} why={stepWhy(state, connection, editing)} />
  );
}

function StepNotice(): JSX.Element {
  const state = useRead();
  const approved = usePage((s) => s.review?.workspace.kind === "approved");
  const connection = usePage((s) => s.connection);
  const editing = usePage((s) => s.editing);

  return (
    <StepWindow
      state={state}
      approved={approved}
      why={stepWhy(state, connection, editing)}
      onAnswer={answer}
    />
  );
}

export const page: PageHalf<ProposalPlugs> = {
  id: "proposal",
  actions: [StepAction],
  notices: [StepNotice],
};
