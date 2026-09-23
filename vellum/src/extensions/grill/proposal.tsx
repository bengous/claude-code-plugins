import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

import { Button, Dialog, popoverUp } from "../../core/page/kit.tsx";
import { editing } from "../../core/page/state.ts";
import type { Asking } from "./modal.ts";
import { answerFailed, answering, askingOn, dotOf, modalOf, pendingOf, putOff } from "./modal.ts";
import type { GrillState } from "./protocol.ts";

const asking = signal<Asking>({ kind: "auto" });

/** The subject typed over the modal's, by the proposal it was typed on, `null` for the blank one. */
const subjectTyped = signal<{ readonly id: string | null; readonly text: string } | null>(null);

/** No editor open, no popover up, and no field holding the focus: `askingOn` asks it with no modal up. */
function quiet(): boolean {
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

  return editing.peek() === null && !popoverUp() && !typing;
}

/** A dot while a proposal was put off; greyed for the reasons a grill cannot open, in its title. */
export function GrillButton(props: {
  readonly state: GrillState | null;
  readonly why: string | null;
}): preact.JSX.Element {
  const waiting = dotOf(props.state, asking.value);

  return (
    <Button
      variant="grill"
      class={waiting === null ? undefined : "grill-later"}
      disabled={props.why !== null}
      title={
        props.why ??
        (waiting === null ? undefined : `Claude suggests a grill on: ${waiting.subject}`)
      }
      onClick={() => {
        asking.value = { kind: "asked", on: pendingOf(props.state) };
      }}
    >
      Grill
    </Button>
  );
}

export type ProposalProps = {
  readonly state: GrillState | null;
  readonly approved: boolean;
  /** Why Start and Decline are greyed, the Grill button's reason; `null` while a grill can open. */
  readonly why: string | null;
  /** `true` once the grill opened: the subject typed can go. */
  readonly onStart: (subject: string) => Promise<boolean>;
  /** `true` once the server declined it. */
  readonly onDecline: (id: string) => Promise<boolean>;
};

/**
 * Claude's proposal, or the subject asked for from the Grill button: a modal over the page. A
 * proposal that lands on a typing is put off before it opens, onto the Grill button's dot.
 */
export function Proposal(props: ProposalProps): preact.JSX.Element | null {
  const { state, why } = props;
  const landed = pendingOf(state)?.id ?? null;

  useEffect(() => {
    asking.value = askingOn(state, asking.peek(), quiet());
  }, [state?.kind, landed]);

  const modal = modalOf(state, asking.value, props.approved);

  if (modal.kind === "hidden") return null;
  const id = modal.kind === "proposal" ? modal.suggestion.id : null;
  const typed = subjectTyped.value;
  const given = modal.kind === "proposal" ? modal.suggestion.subject : "";
  const subject = typed !== null && typed.id === id ? typed.text : given;
  const title = id === null ? "Start a grill" : "Claude suggests a grill";

  const later = (): void => {
    asking.value = putOff(state);
  };

  /** The modal closes at the click; a request that fails puts the proposal back on the dot. */
  const answer = (request: Promise<boolean>): Promise<boolean> => {
    asking.value = answering(state, id);

    return request.then((taken) => {
      if (!taken && id !== null) asking.value = answerFailed(asking.peek(), id);

      return taken;
    });
  };

  const start = (): void => {
    if (why !== null || subject.trim() === "") return;

    void answer(props.onStart(subject.trim())).then((opened) => {
      if (opened) subjectTyped.value = null;
    });
  };

  return (
    <Dialog
      label={title}
      class="grill-dialog"
      onCancel={later}
      below={
        <>
          <kbd>Enter</kbd> to start <kbd>Esc</kbd> {id === null ? "to cancel" : "for later"}
        </>
      }
    >
      <h2 class="grill-who">{title}</h2>
      {/* A field that wraps, so a long subject reads whole; it keeps one line of text, since the transcript's header is one. */}
      <textarea
        class="grill-subject"
        rows={1}
        aria-label="Subject of the grill"
        placeholder="What should Claude grill you on?"
        value={subject}
        onInput={(event) => {
          subjectTyped.value = {
            id,
            text: event.currentTarget.value.replaceAll(/\s*[\n\r\u2028\u2029]\s*/gu, " "),
          };
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          start();
        }}
      />
      <div class="row">
        {id === null ? (
          <Button onClick={later}>Cancel</Button>
        ) : (
          <Button
            disabled={why !== null}
            title={why ?? undefined}
            onClick={() => void answer(props.onDecline(id))}
          >
            Decline
          </Button>
        )}
        <Button
          variant="grill"
          class="lit"
          disabled={why !== null || subject.trim() === ""}
          title={why ?? undefined}
          onClick={start}
        >
          Start
        </Button>
      </div>
    </Dialog>
  );
}
