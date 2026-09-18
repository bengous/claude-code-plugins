import type { ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import type { Annotation, PlanWorkspace } from "../protocol.ts";
import { countChanges } from "../protocol.ts";
import { Badge, Banner, Button, Popover } from "./kit.tsx";
import {
  annotations,
  connection,
  decide,
  edited,
  editing,
  error,
  locked,
  planChanges,
  review,
} from "./state.ts";

type Status = { readonly label: string; readonly tone: "" | "sent" | "ok" | "err" };

type Notice = {
  readonly text: string;
  readonly tone: "sent" | "ok" | "err";
  readonly retry: boolean;
};

function statusOf(workspace: PlanWorkspace): Status {
  switch (workspace.kind) {
    case "drafting":
      return { label: "Drafting", tone: "" };
    case "inReview":
      return workspace.finalizeError === null
        ? { label: "In review", tone: "" }
        : { label: "In review", tone: "err" };
    case "changesRequested":
      return { label: "Feedback sent", tone: "sent" };
    case "approved":
      return { label: "Approved", tone: "ok" };
  }
}

function noticeOf(workspace: PlanWorkspace): Notice | null {
  switch (workspace.kind) {
    case "drafting":
      return null;
    case "inReview":
      return workspace.finalizeError === null
        ? null
        : {
            text: `Could not rename the folder: ${workspace.finalizeError}. Nothing was sent to Claude.`,
            tone: "err",
            retry: true,
          };
    case "changesRequested":
      return {
        text: "Feedback sent to Claude. Waiting for the next version of the plan.",
        tone: "sent",
        retry: false,
      };
    case "approved":
      return {
        text: `Plan approved. Folder renamed to ${workspace.dir}.`,
        tone: "ok",
        retry: false,
      };
  }
}

function titleOf(plan: string | undefined): string {
  return /^#\s+(.+?)\s*$/mu.exec(plan ?? "")?.[1] ?? "Plan";
}

/**
 * The notes popover: the note typed so far, and the unsent comments as they were when the
 * reviewer agreed to lose them, or when the popover opened on none. Comments that changed since
 * bring the warning back.
 */
type Notes = {
  readonly kind: "notes";
  readonly text: string;
  readonly agreed: readonly Annotation[];
  /** The hold the reviewer was warned of on the way here; another one brings the warning back. */
  readonly warned: string | null;
};

/**
 * What "Approve anyway" goes on to: the approval at once, the notes popover, or the approval the
 * notes popover asked for, where Cancel returns with the note intact.
 */
type Next =
  | { readonly kind: "approve" }
  | { readonly kind: "notes" }
  | { readonly kind: "noted"; readonly notes: Notes };

/** The one popover under the bar: the notes, or the warning that stands before `next`. */
type BarPopover =
  | { readonly kind: "closed" }
  | Notes
  | { readonly kind: "warn"; readonly next: Next };

const CLOSED: BarPopover = { kind: "closed" };

type NotesProps = {
  readonly text: string;
  readonly onInput: (text: string) => void;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
};

function ApprovalNotes(props: NotesProps): preact.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null);

  // `autofocus` is honoured once per document, and the composer may have taken it already.
  useEffect(() => textarea.current?.focus(), []);

  return (
    <Popover label="Approval notes" class="pop-bar">
      <label for="approval-notes">Notes for Claude, read before its first action</label>
      <textarea
        id="approval-notes"
        rows={3}
        ref={textarea}
        value={props.text}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) props.onApprove();
        }}
      />
      <div class="row">
        <Button size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={props.onApprove}>
          Approve <kbd>Ctrl</kbd> <kbd>↵</kbd>
        </Button>
      </div>
    </Popover>
  );
}

type WarningProps = {
  readonly count: number;
  /** What holds the review, which the approval ends; `null` when nothing does. */
  readonly hold: string | null;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
};

function ApprovalWarning(props: WarningProps): preact.JSX.Element {
  const one = props.count === 1;

  return (
    <Popover label="Before approving" class="pop-bar">
      {props.count > 0 && (
        <>
          <div class="warn-text">
            {one ? "1 comment is not sent." : `${props.count} comments are not sent.`}
          </div>
          <div>Approving discards {one ? "it" : "them"}.</div>
        </>
      )}
      {props.hold !== null && <div class="warn-text">{props.hold}; approving ends it.</div>}
      <div class="row">
        <Button size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="send" onClick={props.onApprove}>
          Approve anyway
        </Button>
      </div>
    </Popover>
  );
}

// A server revived on another port never answers this tab again: past this, only a new link does.
const NEW_LINK_HINT_MS = 30_000;

function ConnectionLost(): preact.JSX.Element {
  const [late, setLate] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLate(true), NEW_LINK_HINT_MS);

    return () => clearTimeout(timer);
  }, []);

  return (
    <Banner kind="err">
      <span>
        Connection to the review server lost. Retrying…
        {late && " Run /vellum:start for a new link."}
      </span>
    </Banner>
  );
}

type BarProps = {
  /** The extensions' actions, handed down by `app.tsx`: the one file that reads the registry. */
  readonly actions: readonly ComponentType[];
};

export function DecisionBar(props: BarProps): preact.JSX.Element {
  const view = review.value;
  const workspace = view?.workspace;
  const status = workspace === undefined ? null : statusOf(workspace);
  const notice = workspace === undefined ? null : noticeOf(workspace);
  const count = annotations.value.length;
  const since = view?.plan?.previous?.version;
  const changed = planChanges.value === null ? null : countChanges(planChanges.value);
  const [popover, setPopover] = useState<BarPopover>(CLOSED);
  const close = (): void => setPopover(CLOSED);
  const frozen = locked.value || editing.value !== null;
  const hold = view?.held ?? null;
  // After a failed rename the first attempt's files stand: "Retry approval" is the one approve left.
  const stuck = workspace?.kind === "inReview" && workspace.finalizeError !== null;

  const approve = (notes: string): void => {
    close();
    void decide({ kind: "approve", edit: edited.value, notes });
  };

  const proceed = (next: Next): void => {
    if (next.kind === "notes")
      setPopover({ kind: "notes", text: "", agreed: annotations.value, warned: hold });
    else approve(next.kind === "noted" ? next.notes.text : "");
  };

  /**
   * Every way to an approval: unsent comments the reviewer has not agreed to lose, or a hold the
   * approval would end, put the warning first.
   */
  const ask = (next: Next): void => {
    const unsent = annotations.value;
    const agreed = next.kind === "noted" && next.notes.agreed === unsent;
    const warned = hold === null || (next.kind === "noted" && next.notes.warned === hold);

    if ((agreed || unsent.length === 0) && warned) proceed(next);
    else setPopover({ kind: "warn", next });
  };

  return (
    <>
      <div class="bar">
        <span class="brand">Vellum</span>
        <span class="title">{titleOf(view?.plan?.text)}</span>
        {workspace !== undefined && workspace.kind !== "drafting" && (
          <span class="version">v{workspace.version}</span>
        )}
        {changed !== null && since !== undefined && (
          <span class="stat" title={`Lines changed since v${since}`}>
            <span class="plus">+{changed.added}</span> <span class="minus">−{changed.removed}</span>
          </span>
        )}
        {status !== null && <span class={`status ${status.tone}`}>{status.label}</span>}
        <span class="spacer" />
        {props.actions.map((Action, index) => (
          <Action key={index} />
        ))}
        {workspace?.kind !== "drafting" && (
          <>
            <Button disabled={frozen || stuck} onClick={() => ask({ kind: "approve" })}>
              Approve
            </Button>
            <Button disabled={frozen || stuck} onClick={() => ask({ kind: "notes" })}>
              Approve with notes…
            </Button>
          </>
        )}
        <Button
          variant="send"
          disabled={frozen || hold !== null || (count === 0 && edited.value === null)}
          title={hold === null ? undefined : `${hold}; end it first`}
          onClick={() =>
            void decide({ kind: "feedback", edit: edited.value, annotations: annotations.value })
          }
        >
          Send feedback {count > 0 && <Badge>{count}</Badge>}
        </Button>
        {popover.kind === "notes" && !frozen && (
          <ApprovalNotes
            text={popover.text}
            onInput={(text) => setPopover({ ...popover, text })}
            onApprove={() => ask({ kind: "noted", notes: popover })}
            onCancel={close}
          />
        )}
        {popover.kind === "warn" && !frozen && (
          <ApprovalWarning
            count={count}
            hold={hold}
            onApprove={() => proceed(popover.next)}
            onCancel={() => setPopover(popover.next.kind === "noted" ? popover.next.notes : CLOSED)}
          />
        )}
      </div>
      {connection.value === "down" && <ConnectionLost />}
      {notice !== null && (
        <Banner kind={notice.tone}>
          <span>{notice.text}</span>
          {notice.retry && (
            <Button
              size="sm"
              disabled={editing.value !== null}
              onClick={() => void decide({ kind: "approve", edit: null, notes: "" })}
            >
              Retry approval
            </Button>
          )}
        </Banner>
      )}
      {error.value !== null && (
        <Banner kind="err">
          <span>{error.value}</span>
          <Button
            size="sm"
            onClick={() => {
              error.value = null;
            }}
          >
            Dismiss
          </Button>
        </Banner>
      )}
    </>
  );
}
