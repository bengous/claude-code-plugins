import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

import { Button, Dialog, dialogUp, popoverUp } from "../../core/page/kit.tsx";
import { editing } from "../../core/page/state.ts";
import type { OtherKind, Pick } from "./choice.ts";
import { answerOf, NO_PICK, oneLine, OWN_GRILL } from "./choice.ts";
import { detailOf, FIELD_HINTS, KIND_LABELS } from "./labels.ts";
import type { Asking, WindowState } from "./modal.ts";
import { answerFailed, answering, askingOn, dotOf, modalOf, pendingOf, putOff } from "./modal.ts";
import type { StepAnswer } from "./protocol.ts";

const asking = signal<Asking>({ kind: "auto" });

/** The pick made on a proposal, by its id, `null` for the blank window: Esc keeps it for the next opening. */
const picked = signal<{ readonly id: string | null; readonly pick: Pick } | null>(null);

const OTHER_KINDS: readonly OtherKind[] = ["grill", "mockup", "prototype", "plan", "own"];

/** No editor open, no popover or other modal up, and no field holding the focus: `askingOn` asks it with no modal of its own up. */
function quiet(): boolean {
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

  return editing.peek() === null && !popoverUp() && !dialogUp() && !typing;
}

/** A dot while a proposal was put off; greyed for the reasons no step is taken now, in its title. */
export function NextStepButton(props: {
  readonly state: WindowState | null;
  readonly why: string | null;
}): preact.JSX.Element {
  const waiting = dotOf(props.state, asking.value);

  return (
    <Button
      variant="grill"
      class={waiting === null ? undefined : "step-later"}
      disabled={props.why !== null}
      title={props.why ?? (waiting === null ? undefined : "Claude proposes the next step")}
      onClick={() => {
        asking.value = { kind: "asked", on: pendingOf(props.state) };
      }}
    >
      Next step
    </Button>
  );
}

export type WindowProps = {
  readonly state: WindowState | null;
  readonly approved: boolean;
  /** Why Choose is greyed, the Next step button's reason; `null` while a step can be taken. */
  readonly why: string | null;
  /** `true` once the proposal no longer waits: answered, or already answered or replaced. */
  readonly onAnswer: (id: string | null, answer: StepAnswer) => Promise<boolean>;
};

/**
 * Claude's proposal, or a step of the reviewer's own from the Next step button: a modal over the
 * page, nothing picked until the reviewer picks, the move Claude recommends marked, never checked.
 * A proposal that lands on a typing is put off before it opens, onto the button's dot.
 */
export function StepWindow(props: WindowProps): preact.JSX.Element | null {
  const { state, why } = props;
  const landed = pendingOf(state)?.id ?? null;

  useEffect(() => {
    asking.value = askingOn(state, asking.peek(), quiet());
  }, [state?.held, landed]);

  const modal = modalOf(state, asking.value, props.approved);

  if (modal.kind === "hidden") return null;
  const pending = modal.kind === "proposal" ? modal.pending : null;
  const id = pending?.id ?? null;
  const moves = pending?.proposal.moves ?? [];
  const kept = picked.value;
  const pick = kept !== null && kept.id === id ? kept.pick : id === null ? OWN_GRILL : NO_PICK;
  const answer = answerOf(pick, moves);
  const title = id === null ? "Next step" : "Claude proposes the next step";

  const choose = (next: Pick): void => {
    picked.value = { id, pick: next };
  };

  const later = (): void => {
    asking.value = putOff(state);
  };

  const send = (): void => {
    if (why !== null || answer === null) return;
    asking.value = answering(state, id);

    void props.onAnswer(id, answer).then((settled) => {
      if (settled) picked.value = null;
      else if (id !== null) asking.value = answerFailed(asking.peek(), id);
    });
  };

  const other = pick.kind === "other" ? pick : null;

  return (
    <Dialog
      label={title}
      class="step-dialog"
      onCancel={later}
      below={
        <>
          <kbd>Esc</kbd> {id === null ? "to cancel" : "for later"}
        </>
      }
    >
      <h2 class="step-who">{title}</h2>
      {pending !== null && <p class="step-why">{pending.proposal.reason}</p>}
      {pending !== null && (
        <div class="step-moves" role="radiogroup" aria-label="Next step">
          {moves.map((move, index) => {
            const recommended = index === pending.proposal.recommended;

            return (
              <label class="step-move" key={index}>
                <input
                  type="radio"
                  name="step-move"
                  checked={pick.kind === "move" && pick.index === index}
                  onChange={() => choose({ kind: "move", index })}
                />
                <span class="kind">{KIND_LABELS[move.kind]}</span>
                {recommended && <span class="step-rec">Recommended</span>}
                <span class="what">{detailOf(move)}</span>
                {move.kind === "grill" && move.choices.length > 0 && (
                  <span class="choices">{move.choices.join(" · ")}</span>
                )}
              </label>
            );
          })}
          <label class="step-move">
            <input
              type="radio"
              name="step-move"
              checked={other !== null}
              onChange={() => choose(OWN_GRILL)}
            />
            <span class="kind">Something else…</span>
          </label>
        </div>
      )}
      {other !== null && (
        <div class="step-other">
          <select
            aria-label="Kind of step"
            value={other.other}
            onChange={(event) => {
              // SAFETY: the options are `OTHER_KINDS`, drawn below; the select holds nothing else.
              choose({ ...other, other: event.currentTarget.value as OtherKind });
            }}
          >
            {OTHER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
          {other.other !== "plan" && (
            <textarea
              class="step-text"
              rows={other.other === "own" ? 3 : 1}
              aria-label={FIELD_HINTS[other.other]}
              placeholder={FIELD_HINTS[other.other]}
              value={other.text}
              onInput={(event) => {
                const { value } = event.currentTarget;
                choose({ ...other, text: other.other === "own" ? value : oneLine(value) });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || (other.other === "own" && !event.ctrlKey)) return;
                event.preventDefault();
                send();
              }}
            />
          )}
        </div>
      )}
      <div class="row">
        <Button onClick={later}>{id === null ? "Cancel" : "Later"}</Button>
        <Button
          variant="grill"
          class="lit"
          disabled={why !== null || answer === null}
          title={why ?? undefined}
          onClick={send}
        >
          Choose
        </Button>
      </div>
    </Dialog>
  );
}
