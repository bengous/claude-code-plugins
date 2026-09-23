import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

import { Button, Dialog, popoverUp } from "../../core/page/kit.tsx";
import { editing } from "../../core/page/state.ts";
import type { Asking } from "./modal.ts";
import { askingOn, modalOf, pendingOf } from "./modal.ts";
import type { GrillState } from "./protocol.ts";

const asking = signal<Asking>({ kind: "auto" });

/** The subject typed over the modal's, by the proposal it was typed on, `null` for the blank one. */
const subjectTyped = signal<{ readonly id: string | null; readonly text: string } | null>(null);

/** No editor open, no popover up, and no field outside a modal holding the focus. */
function quiet(): boolean {
  const active = document.activeElement;

  const typing =
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    active.closest("dialog") === null;

  return editing.peek() === null && !popoverUp() && !typing;
}

/** A dot while a proposal was put off; greyed for the reasons a grill cannot open, in its title. */
export function GrillButton(props: {
  readonly state: GrillState | null;
  readonly why: string | null;
}): preact.JSX.Element {
  const pending = pendingOf(props.state);
  const now = asking.value;
  const putOff = pending !== null && now.kind === "later" && now.id === pending.id;

  return (
    <Button
      variant="grill"
      class={putOff ? "grill-later" : undefined}
      disabled={props.why !== null}
      title={props.why ?? (putOff ? `Claude suggests a grill on: ${pending.subject}` : undefined)}
      onClick={() => {
        asking.value = { kind: "asked" };
      }}
    >
      Grill
    </Button>
  );
}

export type ProposalProps = {
  readonly state: GrillState | null;
  readonly approved: boolean;
  /** Why Start is greyed, the Grill button's reason; `null` while a grill can open. */
  readonly why: string | null;
  /** `true` once the grill opened: the subject typed can go. */
  readonly onStart: (subject: string) => Promise<boolean>;
  readonly onDecline: (id: string) => void;
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

  const modal = modalOf(state, asking.value, props.approved, quiet());

  if (modal.kind === "hidden") return null;
  const id = modal.kind === "proposal" ? modal.suggestion.id : null;
  const typed = subjectTyped.value;
  const given = modal.kind === "proposal" ? modal.suggestion.subject : "";
  const subject = typed !== null && typed.id === id ? typed.text : given;
  const title = id === null ? "Start a grill" : "Claude suggests a grill";

  const putOff = (): void => {
    asking.value = id === null ? { kind: "auto" } : { kind: "later", id };
  };

  const start = (): void => {
    if (why !== null || subject.trim() === "") return;
    putOff();

    void props.onStart(subject.trim()).then((opened) => {
      if (opened) subjectTyped.value = null;
    });
  };

  return (
    <Dialog
      label={title}
      class="grill-dialog"
      onCancel={putOff}
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
            text: event.currentTarget.value.replaceAll(/\s*\n\s*/gu, " "),
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
          <Button onClick={putOff}>Cancel</Button>
        ) : (
          <Button
            onClick={() => {
              putOff();
              props.onDecline(id);
            }}
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
