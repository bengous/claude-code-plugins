import type { JSX } from "react";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { Button, Dialog, dialogUp, popoverUp, Tag } from "../../runtime/page/kit.tsx";
import { pageStore, patchStore } from "../../runtime/page/state.ts";
import type { DeclinePick, OtherKind, OtherPick, Pick } from "./choice.ts";
import { answerOf, DECLINE, NO_PICK, oneLine, OWN_GRILL } from "./choice.ts";
import type { StepAnswer } from "./contract.ts";
import { detailOf, FIELD_HINTS, KIND_LABELS, NOTE_HINT } from "./labels.ts";
import type { Asking, WindowState } from "./modal.ts";
import { answerFailed, answering, askingOn, dotOf, modalOf, pendingOf, putOff } from "./modal.ts";

/**
 * The pick made on a proposal, by its id, `null` for the blank window, and the last step of the
 * reviewer's own and the last note typed there: Esc keeps them for the next opening, and a move
 * picked meanwhile does not throw the typing away.
 */
type Picked = {
  readonly id: string | null;
  readonly pick: Pick;
  readonly other: OtherPick;
  readonly decline: DeclinePick;
};

/** The window's own state: whether it asks, and what was picked in it. */
type WindowPage = {
  readonly asking: Asking;
  readonly picked: Picked | null;
};

const windowStore = createStore<WindowPage>(() => ({ asking: { kind: "auto" }, picked: null }));

function useWindow<T>(pick: (s: WindowPage) => T): T {
  return useStore(windowStore, pick);
}

function setAsking(asking: Asking): void {
  patchStore(windowStore, { asking });
}

const OTHER_KINDS: readonly OtherKind[] = ["grill", "mockup", "prototype", "plan", "own"];

/** No editor open, no popover or other modal up, and no field holding the focus: `askingOn` asks it with no modal of its own up. */
function quiet(): boolean {
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

  return pageStore.getState().editing === null && !popoverUp() && !dialogUp() && !typing;
}

/** What a proposal nobody waits on says: the pick is not lost, it reaches Claude another way. */
const PAUSED = "Paused · Claude stopped waiting; your pick reaches it as a message";

/**
 * A dot while a proposal was put off, marked Paused when Claude's call stopped waiting on it;
 * greyed for the reasons no step is taken now, in its title.
 */
export function NextStepButton(props: {
  readonly state: WindowState | null;
  readonly why: string | null;
}): JSX.Element {
  const asking = useWindow((s) => s.asking);
  const waiting = dotOf(props.state, asking);
  const paused = waiting !== null && props.state?.paused === true;
  const told = paused ? PAUSED : "Claude proposes the next step";

  return (
    <>
      <Button
        variant="grill"
        className={waiting === null ? undefined : "proposal-later"}
        disabled={props.why !== null}
        title={props.why ?? (waiting === null ? undefined : told)}
        onClick={() => {
          setAsking({ kind: "asked", on: pendingOf(props.state) });
        }}
      >
        Next step
      </Button>
      {paused && <Tag>Paused</Tag>}
    </>
  );
}

export type WindowProps = {
  readonly state: WindowState | null;
  readonly approved: boolean;
  /** Why Choose, or Decline, is greyed, the Next step button's reason; `null` while a step can be taken. */
  readonly why: string | null;
  /** `true` once the proposal no longer waits: answered, or already answered or replaced. */
  readonly onAnswer: (id: string | null, answer: StepAnswer) => Promise<boolean>;
};

/**
 * Claude's proposal, or a step of the reviewer's own from the Next step button: a modal over the
 * page, nothing picked until the reviewer picks, the move Claude recommends marked, never checked.
 * A proposal that lands on a typing is put off before it opens, onto the button's dot.
 */
export function StepWindow(props: WindowProps): JSX.Element | null {
  const { state, why } = props;
  const landed = pendingOf(state)?.id ?? null;
  const asking = useWindow((s) => s.asking);
  const picked = useWindow((s) => s.picked);

  useEffect(() => {
    setAsking(askingOn(state, windowStore.getState().asking, quiet()));
  }, [state?.held, landed]);

  const modal = modalOf(state, asking, props.approved);

  if (modal.kind === "hidden") return null;
  const pending = modal.kind === "proposal" ? modal.pending : null;
  const id = pending?.id ?? null;
  const moves = pending?.proposal.moves ?? [];
  const kept = picked?.id === id ? picked : null;
  const pick = kept?.pick ?? (id === null ? OWN_GRILL : NO_PICK);
  const own = kept?.other ?? OWN_GRILL;
  const declined = kept?.decline ?? DECLINE;
  const answer = answerOf(pick, moves);
  const title = id === null ? "Next step" : "Claude proposes the next step";

  const choose = (next: Pick): void => {
    windowStore.setState({
      picked: {
        id,
        pick: next,
        other: next.kind === "other" ? next : own,
        decline: next.kind === "decline" ? next : declined,
      },
    });
  };

  const later = (): void => {
    setAsking(putOff(state));
  };

  const send = (): void => {
    if (why !== null || answer === null) return;
    setAsking(answering(state, id));

    void props.onAnswer(id, answer).then((settled) => {
      if (settled) windowStore.setState({ picked: null });
      else if (id !== null) setAsking(answerFailed(windowStore.getState().asking, id));
    });
  };

  const other = pick.kind === "other" ? pick : null;
  const declining = pick.kind === "decline" ? pick : null;

  return (
    <Dialog
      label={title}
      className="proposal-dialog"
      onCancel={later}
      below={
        <>
          <kbd>Esc</kbd> {id === null ? "to cancel" : "for later"}
        </>
      }
    >
      <h2 className="proposal-who">{title}</h2>
      {pending !== null && state?.paused === true && <p className="proposal-who">{PAUSED}</p>}
      {pending !== null && <p className="proposal-why">{pending.proposal.reason}</p>}
      {pending !== null && (
        <div className="proposal-moves" role="radiogroup" aria-label="Next step">
          {moves.map((move, index) => {
            const recommended = index === pending.proposal.recommended;

            return (
              <label className="proposal-move" key={index}>
                <input
                  type="radio"
                  name="proposal-move"
                  checked={pick.kind === "move" && pick.index === index}
                  onChange={() => choose({ kind: "move", index })}
                />
                <span className="kind">{KIND_LABELS[move.kind]}</span>
                {recommended && <span className="proposal-rec">Recommended</span>}
                <span className="what">{detailOf(move)}</span>
                {move.kind === "grill" && move.choices.length > 0 && (
                  <span className="choices">{move.choices.join(" · ")}</span>
                )}
              </label>
            );
          })}
          <label className="proposal-move">
            <input
              type="radio"
              name="proposal-move"
              checked={other !== null}
              onChange={() => choose(own)}
            />
            <span className="kind">Something else…</span>
          </label>
          <label className="proposal-move">
            <input
              type="radio"
              name="proposal-move"
              checked={declining !== null}
              onChange={() => choose(declined)}
            />
            <span className="kind">None of these</span>
          </label>
        </div>
      )}
      {other !== null && (
        <div className="proposal-other">
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
              className="proposal-text"
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
      {declining !== null && (
        <div className="proposal-note">
          <textarea
            className="proposal-text"
            rows={3}
            aria-label={NOTE_HINT}
            placeholder={NOTE_HINT}
            value={declining.note}
            onInput={(event) => choose({ kind: "decline", note: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !event.ctrlKey) return;
              event.preventDefault();
              send();
            }}
          />
        </div>
      )}
      <div className="row">
        <Button onClick={later}>{id === null ? "Cancel" : "Later"}</Button>
        <Button
          variant="grill"
          className="lit"
          disabled={why !== null || answer === null}
          title={why ?? undefined}
          onClick={send}
        >
          {declining === null ? "Choose" : "Decline"}
        </Button>
      </div>
    </Dialog>
  );
}
