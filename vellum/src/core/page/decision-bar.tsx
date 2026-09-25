import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

import type { SendShare } from "../extension.ts";
import type { Annotation } from "../protocol.ts";
import { countChanges } from "../protocol.ts";
import { Badge, Banner, Button, Gear, Popover } from "./kit.tsx";
import type { Notice } from "./notices.ts";
import { decisionsOf, statusOf } from "./notices.ts";
import { Settings } from "./settings/settings.tsx";
import type { Unsent } from "./state.ts";
import {
  annotations,
  connection,
  decide,
  edited,
  editing,
  notices,
  planChanges,
  planText,
  review,
  send,
  sending,
  strayTyped,
  unsentTyped,
} from "./state.ts";

function titleOf(plan: string | null): string {
  return /^#\s+(.+?)\s*$/mu.exec(plan ?? "")?.[1] ?? "Plan";
}

/**
 * The notes popover: the note typed so far, and the unsent comments and typed texts as they were
 * when the reviewer agreed to lose them, or when the popover opened on none. What changed since
 * brings the warning back.
 */
type Notes = {
  readonly kind: "notes";
  readonly text: string;
  readonly agreed: readonly Annotation[];
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
          <div>Approving ends it.</div>
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

type BarProps = {
  /** The extensions' actions, handed down by `app.tsx`: the one file that reads the registry. */
  readonly actions: readonly ComponentType[];
  /** The extensions' parts of the Send, handed down by `app.tsx` too. */
  readonly shares: readonly (() => SendShare)[];
};

export function DecisionBar(props: BarProps): preact.JSX.Element {
  const view = review.value;
  const workspace = view?.workspace;
  const hold = view?.held ?? null;
  const status = workspace === undefined ? null : statusOf(workspace, hold);
  const count = annotations.value.length;
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
  const counted = count + (edited.value === null ? 0 : 1);
  const sendCount = parts.reduce((sum, part) => sum + part.count, counted);

  useEffect(() => {
    document.title = `${title} · Vellum`;
  }, [title]);

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

  /** The notes popover closes on success alone: a failure leaves the note where it was typed. */
  const approve = (notes: string): void => {
    if (approving) return;
    setApproving(true);

    void decide({ kind: "approve", edit: edited.value, notes }).then((taken) => {
      setApproving(false);

      if (taken) close();
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
        typedAgreed: unsentTyped.value,
        warned: hold,
      });
    } else if (next.kind === "noted") {
      setPopover(next.notes);
      approve(next.notes.text);
    } else {
      close();
      approve("");
    }
  };

  /**
   * Every way to a decision: unsent comments an approval would lose, a hold it would end, a typed
   * text either would throw, or questions a Send would take by default, none of which the reviewer
   * agreed to, put the warning first.
   */
  const ask = (next: Next): void => {
    const unsent = annotations.value;
    const approval = next.kind !== "send";
    const stray = approval ? unsentTyped.value : strayTyped.value;
    const notes = next.kind === "noted" ? next.notes : null;
    const agreed = !approval || unsent.length === 0 || notes?.agreed === unsent;
    const warned = !approval || hold === null || notes?.warned === hold;
    const typedAgreed = stray.length === 0 || notes?.typedAgreed === stray;
    const answered = next.kind !== "send" || next.unanswered.length === 0;

    if (agreed && warned && typedAgreed && answered) proceed(next);
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
