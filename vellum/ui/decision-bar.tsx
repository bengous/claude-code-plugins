import type { PlanWorkspace } from "../src/protocol.ts";
import { annotations, decide, error, locked, review } from "./state.ts";

type Status = { readonly label: string; readonly tone: "" | "sent" | "ok" | "err" };

type Banner = {
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
    case "approvedPending":
      return { label: "Approved, waiting for Claude", tone: "ok" };
    case "finalizing":
      return { label: "Approved, renaming", tone: "ok" };
    case "approved":
      return { label: "Approved", tone: "ok" };
  }
}

function bannerOf(workspace: PlanWorkspace): Banner | null {
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
    case "approvedPending":
    case "finalizing":
      return {
        text: "Approved. Waiting for Claude to leave plan mode.",
        tone: "ok",
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

export function DecisionBar(): preact.JSX.Element {
  const view = review.value;
  const workspace = view?.workspace;
  const status = workspace === undefined ? null : statusOf(workspace);
  const banner = workspace === undefined ? null : bannerOf(workspace);
  const count = annotations.value.length;

  return (
    <>
      <div class="bar">
        <span class="brand">Vellum</span>
        <span class="title">{titleOf(view?.plan?.text)}</span>
        {workspace !== undefined && workspace.kind !== "drafting" && (
          <span class="version">v{workspace.version}</span>
        )}
        {status !== null && <span class={`status ${status.tone}`}>{status.label}</span>}
        <span class="spacer" />
        <button
          class="btn"
          type="button"
          disabled={locked.value}
          onClick={() => void decide({ kind: "approve" })}
        >
          Approve
        </button>
        <button
          class="btn send"
          type="button"
          disabled={locked.value || count === 0}
          onClick={() => void decide({ kind: "feedback", annotations: annotations.value })}
        >
          Send feedback {count > 0 && <span class="badge">{count}</span>}
        </button>
      </div>
      {banner !== null && (
        <div class={`banner ${banner.tone}`}>
          <span>{banner.text}</span>
          {banner.retry && (
            <button
              class="btn small"
              type="button"
              onClick={() => void decide({ kind: "approve" })}
            >
              Retry approval
            </button>
          )}
        </div>
      )}
      {error.value !== null && (
        <div class="banner err">
          <span>{error.value}</span>
          <button
            class="btn small"
            type="button"
            onClick={() => {
              error.value = null;
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
