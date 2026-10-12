import type { ComponentType, JSX } from "react";
import { useEffect, useRef, useState } from "react";

import type { SendShare } from "../runtime/extension.ts";
import { Badge, Banner, Button, Chip, Gear } from "../runtime/page/kit.tsx";
import type { Notice } from "../runtime/page/notices.ts";
import { decisionsOf, statusOf } from "../runtime/page/notices.ts";
import { Settings } from "../runtime/page/settings/settings.tsx";
import type { Unsent } from "../runtime/page/state.ts";
import {
  pageStore,
  selectHeld,
  selectPlanChanges,
  selectPlanText,
  selectSendableChoices,
  selectStrayTyped,
  selectUnsentTyped,
  selectWorkflow,
  usePage,
} from "../runtime/page/state.ts";
import { approve, send, useNotices } from "../runtime/page/workflow.ts";
import { ApprovalNotes, RefusedNow, Warning } from "./bar-popovers.tsx";
import { countChanges } from "./diff.ts";
import type { Annotation } from "./feedback.ts";
import type { Choices, Decision } from "./review.ts";
import { choicesIn, refOf } from "./review.ts";

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

type BarProps = {
  /** The extensions' actions, handed down by `app.tsx`: the one file that reads the registry. */
  readonly actions: readonly ComponentType[];
  /** The extensions' parts of the Send, each a hook, handed down by `app.tsx` too. */
  readonly shares: readonly (() => SendShare)[];
};

export function DecisionBar(props: BarProps): JSX.Element {
  const view = usePage((s) => s.review);
  const hold = usePage(selectHeld);
  const read = usePage(selectWorkflow);
  const annotations = usePage((s) => s.annotations);
  const choices = usePage((s) => s.choices);
  const planChanges = usePage(selectPlanChanges);
  const planText = usePage(selectPlanText);
  const sendable = usePage(selectSendableChoices);
  const edited = usePage((s) => s.edited);
  const connection = usePage((s) => s.connection);
  const editing = usePage((s) => s.editing);
  const sending = usePage((s) => s.sending);
  const strayTyped = usePage(selectStrayTyped);
  const unsentTyped = usePage(selectUnsentTyped);
  // oxlint-disable-next-line react/rules-of-hooks -- `shares` is the registry's, fixed at load: the hooks are called in one order at every render.
  const parts = props.shares.map((useSend) => useSend());
  /** The refused list open, at its chip's offset in the bar; `null` while shut. */
  const [refusedAt, setRefusedAt] = useState<number | null>(null);
  /** A press on the chip while the list is open: the list's own outside press has shut it, and the click must not open it again. */
  const shutting = useRef(false);
  const [popover, setPopover] = useState<BarPopover>(CLOSED);
  /** An approval in flight: the notes popover stays open and its Approve waits, so nothing is sent twice. */
  const [approving, setApproving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const workspace = view?.workspace;
  const status = workspace === undefined || read === null ? null : statusOf(workspace, read);
  const refused = status?.refused ?? [];
  const count = annotations.length;
  const chosen = choicesIn(choices);
  const since = view?.plan?.previous?.version;
  const changed = planChanges === null ? null : countChanges(planChanges);
  const close = (): void => setPopover(CLOSED);
  const title = titleOf(planText);
  const unanswered = parts.flatMap((part) => part.unanswered);
  const counted = count + sendable.length + (edited === null ? 0 : 1);
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
    connection,
    editing: editing !== null,
    sending,
    count: sendCount,
    unanswered: unanswered.length,
    more: parts.some((part) => part.more),
    strayTyped: strayTyped.length,
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
    const s = pageStore.getState();
    const held = selectHeld(s);

    // The reviewer was warned of the hold on the way here: the approval confirms that one (P4).
    const decision: Decision =
      held === null
        ? { kind: "approve", edit: s.edited, notes }
        : { kind: "approve", edit: s.edited, notes, confirmed: held };

    void approve(decision).then((approval) => {
      setApproving(false);

      if (approval.kind === "taken") close();
      else if (approval.kind === "held") setPopover({ kind: "warn", next });
    });
  };

  const notesLive = { disabled: live.notes.disabled || approving, title: live.notes.title };

  const proceed = (next: Next): void => {
    const s = pageStore.getState();

    if (next.kind === "send") {
      close();

      // What the reviewer sees now is what goes; questions the page had not read yet come back
      // from the server, and the warning asks about them all.
      void send({
        annotations: s.annotations.map(({ id }) => id),
        edit: s.edited,
        choices: selectSendableChoices(s).map((choice) => refOf(choice)),
        parts,
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
        agreed: s.annotations,
        choicesAgreed: s.choices,
        typedAgreed: selectUnsentTyped(s),
        warned: selectHeld(s),
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
    const s = pageStore.getState();
    const unsent = s.annotations;
    const held = selectHeld(s);
    const approval = next.kind !== "send";
    const stray = approval ? selectUnsentTyped(s) : selectStrayTyped(s);
    const notes = next.kind === "noted" ? next.notes : null;
    const agreed = !approval || unsent.length === 0 || notes?.agreed === unsent;

    const chosenAgreed =
      !approval || choicesIn(s.choices).length === 0 || notes?.choicesAgreed === s.choices;

    const warned = !approval || held === null || notes?.warned === held;
    const typedAgreed = stray.length === 0 || notes?.typedAgreed === stray;
    const answered = next.kind !== "send" || next.unanswered.length === 0;

    if (agreed && chosenAgreed && warned && typedAgreed && answered) proceed(next);
    else setPopover({ kind: "warn", next });
  };

  return (
    <header className="bar">
      <span className="brand">Vellum</span>
      <span className="title" title={title}>
        {title}
      </span>
      {workspace !== undefined && workspace.kind !== "drafting" && (
        <span className="version">v{workspace.version}</span>
      )}
      {changed !== null && since !== undefined && (
        <span className="stat" title={`Lines changed since v${since}`}>
          <span className="plus">+{changed.added}</span>{" "}
          <span className="minus">−{changed.removed}</span>
        </span>
      )}
      {status !== null && (
        <span className={status.tone === "neutral" ? "status" : `status ${status.tone}`}>
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
      <span className="spacer" />
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
      {popover.kind === "notes" && editing === null && (
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
      {popover.kind === "warn" && editing === null && (
        <Warning
          action={popover.next.kind === "send" ? "send" : "approve"}
          count={popover.next.kind === "send" ? 0 : count}
          chosen={popover.next.kind === "send" ? 0 : chosen.length}
          unanswered={popover.next.kind === "send" ? popover.next.unanswered.length : 0}
          hold={popover.next.kind === "send" ? null : hold}
          typed={popover.next.kind === "send" ? strayTyped : unsentTyped}
          onProceed={() => proceed(popover.next)}
          onCancel={() => setPopover(popover.next.kind === "noted" ? popover.next.notes : CLOSED)}
        />
      )}
    </header>
  );
}

function NoticeText(props: { readonly notice: Notice }): JSX.Element {
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
export function Notices(props: NoticesProps): JSX.Element {
  const notices = useNotices();

  return (
    <>
      {notices.map((notice) => (
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
