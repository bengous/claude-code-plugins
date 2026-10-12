import type { JSX } from "react";

import { Button, Popover, Tag } from "../runtime/page/kit.tsx";
import type { RefusedLine } from "../runtime/page/notices.ts";
import type { Unsent } from "../runtime/page/state.ts";

/** The popovers the decision bar opens: the approval's notes, the warning before a decision, and what is refused now. */

export type NotesProps = {
  readonly text: string;
  readonly disabled: boolean;
  readonly onInput: (text: string) => void;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
};

export function ApprovalNotes(props: NotesProps): JSX.Element {
  return (
    <Popover
      label="Approval notes"
      className="pop-bar"
      onClose={props.onCancel}
      onSubmit={props.onApprove}
    >
      <label htmlFor="approval-notes">Notes for Claude, read before its first action</label>
      <textarea
        id="approval-notes"
        rows={3}
        data-autofocus=""
        value={props.text}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <div className="row">
        <Button size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="send" disabled={props.disabled} onClick={props.onApprove}>
          Approve <kbd>Ctrl</kbd> <kbd>↵</kbd>
        </Button>
      </div>
    </Popover>
  );
}

type WarningProps = {
  /** The decision the warning stands before: what it discards is said in its words. */
  readonly action: "approve" | "send";
  readonly count: number;
  /** The choices made in mockups and not sent, which the approval discards. */
  readonly chosen: number;
  /** The questions a Send takes by default, which the reviewer did not answer. */
  readonly unanswered: number;
  /** What holds the review, which the approval ends; `null` when nothing does. */
  readonly hold: string | null;
  /** The texts typed and not added, which the decision throws away. */
  readonly typed: Unsent;
  readonly onProceed: () => void;
  readonly onCancel: () => void;
};

/** Each reason on two lines: what is there, in red, then what the decision does with it. */
export function Warning(props: WarningProps): JSX.Element {
  const one = props.count === 1;
  const approving = props.action === "approve";
  const verb = approving ? "Approving" : "Sending";
  const typedFate = approving ? "Approving discards it." : "It stays here, unsent.";

  return (
    <Popover
      label={props.action === "approve" ? "Before approving" : "Before sending"}
      className="pop-bar"
      onClose={props.onCancel}
    >
      {props.count > 0 && (
        <>
          <div className="warn-text">
            {one ? "1 comment is not sent." : `${props.count} comments are not sent.`}
          </div>
          <div>
            {verb} discards {one ? "it" : "them"}.
          </div>
        </>
      )}
      {props.chosen > 0 && (
        <>
          <div className="warn-text">
            {props.chosen === 1 ? "1 choice is not sent." : `${props.chosen} choices are not sent.`}
          </div>
          <div>
            {verb} discards {props.chosen === 1 ? "it" : "them"}.
          </div>
        </>
      )}
      {props.unanswered > 0 && (
        <>
          <div className="warn-text">
            {props.unanswered === 1
              ? "1 question has no answer."
              : `${props.unanswered} questions have no answer.`}
          </div>
          <div>Sending takes the recommendation for {props.unanswered === 1 ? "it" : "each"}.</div>
        </>
      )}
      {props.typed.map((entry) => (
        <div className="warn-text" key={entry.where}>
          What you typed in {entry.where} is not added.
        </div>
      ))}
      {props.typed.length > 0 && <div>{typedFate}</div>}
      {props.hold !== null && (
        <>
          <div className="warn-text">The review is held: {props.hold}.</div>
          <div>Approving ends it, and what it was doing is lost.</div>
        </>
      )}
      <div className="row">
        <Button size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="send" onClick={props.onProceed}>
          {props.action === "approve" ? "Approve anyway" : "Send anyway"}
        </Button>
      </div>
    </Popover>
  );
}

/** What is refused now, opened from the pill under its chip, `left` from the bar's edge: each event, whether it is refused or asks first, and why. */
export function RefusedNow(props: {
  readonly lines: readonly RefusedLine[];
  readonly left: number;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Popover label="Refused now" className="pop-bar" left={props.left} onClose={props.onClose}>
      {props.lines.map((line) => (
        <div key={line.what}>
          {line.what} <Tag>{line.effect}</Tag>
          <div className="quote">{line.reason}</div>
        </div>
      ))}
    </Popover>
  );
}
