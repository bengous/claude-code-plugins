import type { ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type { SendShare } from "../extension.ts";
import type { Annotation, Choices, Decision } from "../protocol.ts";
import { choicesIn, countChanges, refOf } from "../protocol.ts";
import { Badge, Banner, Button, Chip, Gear, Popover, Tag } from "./kit.tsx";
import type { Notice, RefusedLine } from "./notices.ts";
import { decisionsOf, statusOf } from "./notices.ts";
import { Settings } from "./settings/settings.tsx";
import type { Unsent } from "./state.ts";
import {
  annotations,
  choices,
  connection,
  edited,
  editing,
  planChanges,
  planText,
  review,
  sendableChoices,
  sending,
  strayTyped,
  unsentTyped,
} from "./state.ts";
import { approve, held, notices, send, workflow } from "./workflow.ts";

function titleOf(plan: string | null): string {
  return /^#\s+(.+?)\s*$/mu.exec(plan ?? "")?.[1] ?? "Plan";
}

/**
 * The notes popover: the note typed so far, and the unsent comments, choices and typed texts as
 * they were when the reviewer agreed to lose them, or when the popover opened on none. What
 * changed since brings the warning back.
 */
type Notes = {
  readonly kind: "notes";
  readonly text: string;
  readonly agreed: readonly Annotation[];
  readonly choicesAgreed: Choices;
  readonly typedAgreed: Unsent;
  /** The hold the reviewer was warned of on the way here; another one brings the warning back. */
  readonly warned: string | null;
};

/**
 * What "anyway" goes on to: the approval at once, the notes popover, the approval the notes
 * popover asked for, where Cancel returns with the note intact, or the Send, which leaves each
 * question it names unanswered to its recommendation.
 */
type Next =
  | { readonly kind: "approve" }
  | { readonly kind: "notes" }
  | { readonly kind: "noted"; readonly notes: Notes }
  | { readonly kind: "send"; readonly unanswered: readonly string[] };

/** The two ways to an approval: at once, or from the notes popover. */
type Approving = Extract<Next, { readonly kind: "approve" | "noted" }>;

/** The one popover under the bar: the notes, or the warning that stands before `next`. */
type BarPopover =
  | { readonly kind: "closed" }
  | Notes
  | { readonly kind: "warn"; readonly next: Next };

const CLOSED: BarPopover = { kind: "closed" };

type NotesProps = {
  readonly text: string;
  readonly disabled: boolean;
  readonly onInput: (text: string) => void;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
};

function ApprovalNotes(props: NotesProps): preact.JSX.Element {
  return (
    <Popover
      label="Approval notes"
      class="pop-bar"
      onClose={props.onCancel}
      onSubmit={props.onApprove}
    >
      <label for="approval-notes">Notes for Claude, read before its first action</label>
      <textarea
        id="approval-notes"
        rows={3}
        autofocus
        value={props.text}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <div class="row">
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
function Warning(props: WarningProps): preact.JSX.Element {
  const one = props.count === 1;
  const approving = props.action === "approve";
  const verb = approving ? "Approving" : "Sending";
  const typedFate = approving ? "Approving discards it." : "It stays here, unsent.";

  return (
    <Popover
      label={props.action === "approve" ? "Before approving" : "Before sending"}
      class="pop-bar"
      onClose={props.onCancel}
    >
      {props.count > 0 && (
        <>
          <div class="warn-text">
            {one ? "1 comment is not sent." : `${props.count} comments are not sent.`}
          </div>
          <div>
            {verb} discards {one ? "it" : "them"}.
          </div>
        </>
      )}
      {props.chosen > 0 && (
        <>
          <div class="warn-text">
            {props.chosen === 1 ? "1 choice is not sent." : `${props.chosen} choices are not sent.`}
          </div>
          <div>
            {verb} discards {props.chosen === 1 ? "it" : "them"}.
          </div>
        </>
      )}
      {props.unanswered > 0 && (
        <>
          <div class="warn-text">
            {props.unanswered === 1
              ? "1 question has no answer."
              : `${props.unanswered} questions have no answer.`}
          </div>
          <div>Sending takes the recommendation for {props.unanswered === 1 ? "it" : "each"}.</div>
        </>
      )}
      {props.typed.map((entry) => (
        <div class="warn-text" key={entry.where}>
          What you typed in {entry.where} is not added.
        </div>
      ))}
      {props.typed.length > 0 && <div>{typedFate}</div>}
      {props.hold !== null && (
        <>
          <div class="warn-text">The review is held: {props.hold}.</div>
          <div>Approving ends it, and what it was doing is lost.</div>
        </>
      )}
      <div class="row">
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
function RefusedNow(props: {
  readonly lines: readonly RefusedLine[];
  readonly left: number;
  readonly onClose: () => void;
}): preact.JSX.Element {
  return (
    <Popover label="Refused now" class="pop-bar" left={props.left} onClose={props.onClose}>
      {props.lines.map((line) => (
        <div key={line.what}>
          {line.what} <Tag>{line.effect}</Tag>
          <div class="quote">{line.reason}</div>
        </div>
      ))}
    </Popover>
  );
}

type BarProps = {
  /** The extensions' actions, handed down by `app.tsx`: the one file that reads the registry. */
  readonly actions: readonly ComponentType[];
  /** The extensions' parts of the Send, handed down by `app.tsx` too. */
  readonly shares: readonly (() => SendShare)[];
};

export function DecisionBar(props: BarProps): preact.JSX.Element {
  const view = review.value;
  const workspace = view?.workspace;
  const hold = held.value;
  const read = workflow.value;
  const status = workspace === undefined || read === null ? null : statusOf(workspace, read);
  const refused = status?.refused ?? [];
  /** The refused list open, at its chip's offset in the bar; `null` while shut. */
  const [refusedAt, setRefusedAt] = useState<number | null>(null);
  /** A press on the chip while the list is open: the list's own outside press has shut it, and the click must not open it again. */
  const shutting = useRef(false);
  const count = annotations.value.length;
  const chosen = choicesIn(choices.value);
  const since = view?.plan?.previous?.version;
  const changed = planChanges.value === null ? null : countChanges(planChanges.value);
  const [popover, setPopover] = useState<BarPopover>(CLOSED);
  /** An approval in flight: the notes popover stays open and its Approve waits, so nothing is sent twice. */
  const [approving, setApproving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const close = (): void => setPopover(CLOSED);
  const title = titleOf(planText.value);
  const parts = props.shares.map((share) => share());
  const unanswered = parts.flatMap((part) => part.unanswered);
  const sendable = sendableChoices.value;
  const counted = count + sendable.length + (edited.value === null ? 0 : 1);
  const sendCount = parts.reduce((sum, part) => sum + part.count, counted);

  useEffect(() => {
    document.title = `${title} · Vellum`;
  }, [title]);

  // A list emptied shuts, so it never opens again by itself when something is refused anew.
  useEffect(() => {
    if (refused.length === 0) setRefusedAt(null);
  }, [refused.length === 0]);

  const live = decisionsOf({
    workspace: workspace ?? null,
    connection: connection.value,
    editing: editing.value !== null,
    sending: sending.value,
    count: sendCount,
    unanswered: unanswered.length,
    more: parts.some((part) => part.more),
    strayTyped: strayTyped.value.length,
  });

  const drawn = workspace !== undefined && workspace.kind !== "approved";

  /**
   * The notes popover closes on success alone: a failure leaves the note where it was typed. A
   * hold other than the one confirmed puts the warning up again, on the hold that holds now.
   */
  const approveNow = (next: Approving): void => {
    if (approving) return;
    setApproving(true);
    const notes = next.kind === "noted" ? next.notes.text : "";

    // The reviewer was warned of the hold on the way here: the approval confirms that one (P4).
    const decision: Decision =
      hold === null
        ? { kind: "approve", edit: edited.value, notes }
        : { kind: "approve", edit: edited.value, notes, confirmed: hold };

    void approve(decision).then((approval) => {
      setApproving(false);

      if (approval.kind === "taken") close();
      else if (approval.kind === "held") setPopover({ kind: "warn", next });
    });
  };

  const notesLive = { disabled: live.notes.disabled || approving, title: live.notes.title };

  const proceed = (next: Next): void => {
    if (next.kind === "send") {
      close();

      // What the reviewer sees now is what goes; questions the page had not read yet come back
      // from the server, and the warning asks about them all.
      void send({
        annotations: annotations.value.map(({ id }) => id),
        edit: edited.value,
        choices: sendable.map((choice) => refOf(choice)),
        parts: props.shares.map((share) => share()),
        takeDefaults: next.unanswered,
      }).then((sent) => {
        if (sent.kind === "unanswered") {
          setPopover({ kind: "warn", next: { kind: "send", unanswered: sent.ids } });
        }
      });
    } else if (next.kind === "notes") {
      setPopover({
        kind: "notes",
        text: "",
        agreed: annotations.value,
        choicesAgreed: choices.value,
        typedAgreed: unsentTyped.value,
        warned: hold,
      });
    } else if (next.kind === "noted") {
      setPopover(next.notes);
      approveNow(next);
    } else {
      close();
      approveNow(next);
    }
  };

  /**
   * Every way to a decision: unsent comments or choices an approval would lose, a hold it would end, a typed
   * text either would throw, or questions a Send would take by default, none of which the reviewer
   * agreed to, put the warning first.
   */
  const ask = (next: Next): void => {
    const unsent = annotations.value;
    const approval = next.kind !== "send";
    const stray = approval ? unsentTyped.value : strayTyped.value;
    const notes = next.kind === "noted" ? next.notes : null;
    const agreed = !approval || unsent.length === 0 || notes?.agreed === unsent;
    const chosenAgreed = !approval || chosen.length === 0 || notes?.choicesAgreed === choices.value;
    const warned = !approval || hold === null || notes?.warned === hold;
    const typedAgreed = stray.length === 0 || notes?.typedAgreed === stray;
    const answered = next.kind !== "send" || next.unanswered.length === 0;

    if (agreed && chosenAgreed && warned && typedAgreed && answered) proceed(next);
    else setPopover({ kind: "warn", next });
  };

  return (
    <header class="bar">
      <span class="brand">Vellum</span>
      <span class="title" title={title}>
        {title}
      </span>
      {workspace !== undefined && workspace.kind !== "drafting" && (
        <span class="version">v{workspace.version}</span>
      )}
      {changed !== null && since !== undefined && (
        <span class="stat" title={`Lines changed since v${since}`}>
          <span class="plus">+{changed.added}</span> <span class="minus">−{changed.removed}</span>
        </span>
      )}
      {status !== null && (
        <span class={status.tone === "neutral" ? "status" : `status ${status.tone}`}>
          {status.text}
        </span>
      )}
      {refused.length > 0 && (
        <Chip
          aria-haspopup="dialog"
          aria-expanded={refusedAt !== null}
          onPointerDown={() => {
            shutting.current = refusedAt !== null;
          }}
          onClick={(event) => {
            const shut = shutting.current || refusedAt !== null;
            shutting.current = false;
            setRefusedAt(shut ? null : event.currentTarget.offsetLeft);
          }}
        >
          Refused now
        </Chip>
      )}
      {refusedAt !== null && refused.length > 0 && (
        <RefusedNow lines={refused} left={refusedAt} onClose={() => setRefusedAt(null)} />
      )}
      <span class="spacer" />
      {props.actions.map((Action, index) => (
        <Action key={index} />
      ))}
      {drawn && workspace.kind !== "drafting" && (
        <>
          <Button
            disabled={live.approve.disabled}
            title={live.approve.title ?? undefined}
            onClick={() => ask({ kind: "approve" })}
          >
            Approve
          </Button>
          <Button
            disabled={live.notes.disabled}
            title={live.notes.title ?? undefined}
            onClick={() => ask({ kind: "notes" })}
          >
            Approve with notes…
          </Button>
        </>
      )}
      {drawn && (
        <Button
          variant="send"
          disabled={live.send.disabled}
          title={live.send.title ?? undefined}
          onClick={() => ask({ kind: "send", unanswered })}
        >
          Send {sendCount > 0 && <Badge>{sendCount}</Badge>}
        </Button>
      )}
      {drawn && (
        <Button
          aria-label="Settings"
          aria-haspopup="dialog"
          title="Settings"
          onClick={() => {
            close();
            setSettingsOpen(true);
          }}
        >
          <Gear />
        </Button>
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {popover.kind === "notes" && editing.value === null && (
        <ApprovalNotes
          text={popover.text}
          disabled={notesLive.disabled}
          onInput={(text) => setPopover({ ...popover, text })}
          onApprove={() => {
            if (!notesLive.disabled) ask({ kind: "noted", notes: popover });
          }}
          onCancel={close}
        />
      )}
      {popover.kind === "warn" && editing.value === null && (
        <Warning
          action={popover.next.kind === "send" ? "send" : "approve"}
          count={popover.next.kind === "send" ? 0 : count}
          chosen={popover.next.kind === "send" ? 0 : chosen.length}
          unanswered={popover.next.kind === "send" ? popover.next.unanswered.length : 0}
          hold={popover.next.kind === "send" ? null : hold}
          typed={popover.next.kind === "send" ? strayTyped.value : unsentTyped.value}
          onProceed={() => proceed(popover.next)}
          onCancel={() => setPopover(popover.next.kind === "noted" ? popover.next.notes : CLOSED)}
        />
      )}
    </header>
  );
}

function NoticeText(props: { readonly notice: Notice }): preact.JSX.Element {
  return (
    <span>
      {props.notice.text.map((part, index) =>
        part instanceof Object ? <code key={index}>{part.code}</code> : part,
      )}
    </span>
  );
}

type NoticesProps = {
  /** The extensions' notices, handed down by `app.tsx`, drawn after the core's. */
  readonly extensions: readonly ComponentType[];
};

/** The column under the bar: every notice the state derives, then what the extensions add. */
export function Notices(props: NoticesProps): preact.JSX.Element {
  return (
    <>
      {notices.value.map((notice) => (
        <Banner
          key={notice.key}
          kind={notice.kind}
          role={notice.kind === "err" ? "alert" : "status"}
          action={notice.action}
        >
          <NoticeText notice={notice} />
        </Banner>
      ))}
      {props.extensions.map((Extra, index) => (
        <Extra key={index} />
      ))}
    </>
  );
}
