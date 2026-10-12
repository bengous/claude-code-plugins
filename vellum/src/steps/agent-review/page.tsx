import type { JSX } from "react";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { PageHalf } from "../../runtime/extension.ts";
import { extensionRequest } from "../../runtime/page/api.ts";
import { Banner, Button } from "../../runtime/page/kit.tsx";
import { fail, patchStore, succeed, usePage } from "../../runtime/page/state.ts";
import type { BodyOf } from "../../workshop/plugs.ts";
import type { AgentReviewPlugs, ReviewState } from "./contract.ts";
import { failedText, reviewWhy } from "./labels.ts";

const ID: AgentReviewPlugs["id"] = "agent-review";

/** The routes the page posts, by name, and the body each takes. */
type Asks = {
  readonly [Name in "request" | "forget"]: BodyOf<AgentReviewPlugs["server"], `POST ${Name}`>;
};

/** The part's own state: what the server said of the runs, a request on its way, a failure dismissed. */
type ReviewPage = {
  /** The server's last word on the runs, loaded again at every workspace event; `null` before the first answer. */
  readonly reviews: ReviewState | null;
  /** A request of the button's on its way: a second click waits for the server's answer. */
  readonly asking: boolean;
  /** The failure the reviewer dismissed, by its run's number: page state, gone with a reload. */
  readonly dismissed: number | null;
};

const reviewStore = createStore<ReviewPage>(() => ({
  reviews: null,
  asking: false,
  dismissed: null,
}));

function useReview<T>(pick: (s: ReviewPage) => T): T {
  return useStore(reviewStore, pick);
}

async function loadState(): Promise<void> {
  const response = await extensionRequest(ID, "state").catch(() => null);

  if (response?.ok !== true) return;

  // SAFETY: the server's own `ReviewState`, the answer of `GET state` in contract.ts, serialized by `Response.json`.
  reviewStore.setState({ reviews: (await response.json()) as ReviewState });
}

async function post<Name extends keyof Asks>(name: Name, body: Asks[Name]): Promise<void> {
  patchStore(reviewStore, { asking: true });

  const response = await extensionRequest(ID, name, {
    method: "POST",
    body: JSON.stringify(body),
  }).catch(() => null);

  if (response === null) fail("send", "The review did not reach the server.");
  else if (response.ok) succeed("send");
  else {
    // SAFETY: a refusal of the server half's, `{ error }` serialized by `Response.json`.
    const refusal = (await response.json().catch(() => null)) as { readonly error?: string } | null;
    fail(
      "send",
      `The review was refused: ${refusal?.error ?? `the server answered ${response.status}`}.`,
    );
  }

  await loadState();
  patchStore(reviewStore, { asking: false });
}

/** Why the button is greyed besides the plan's stage; `null` when nothing else holds it. */
function pageWhy(connection: "up" | "down", reviews: ReviewState | null): string | null {
  if (connection === "down") return "The connection to the review server is lost";

  return reviews === null ? "Loading the review" : null;
}

/** Active in review alone, greyed with its reason otherwise, running with a ✕ while a run is under way; gone once approved. */
function ReviewAction(): JSX.Element | null {
  const view = usePage((s) => s.review);
  const connection = usePage((s) => s.connection);
  const reviews = useReview((s) => s.reviews);
  const asking = useReview((s) => s.asking);

  useEffect(() => {
    void loadState();
  }, [view]);

  const button =
    view === null ? null : reviewWhy(view.workspace, reviews?.run ?? null, view.workflow.held);

  if (button === null) return null;
  const why = pageWhy(connection, reviews);

  if (button.kind === "running") {
    return (
      <span className="agent-review-run">
        <Button variant="grill" disabled title={button.title}>
          <span className="agent-review-dot" aria-hidden="true" />
          Review running…
        </Button>
        <Button
          title="Forget this run"
          aria-label="Forget this run"
          disabled={why !== null || asking}
          onClick={() => void post("forget", { seq: button.seq })}
        >
          ✕
        </Button>
      </span>
    );
  }

  const greyed = button.kind === "greyed" ? button.title : why;

  return (
    <Button
      variant="grill"
      disabled={greyed !== null || asking}
      title={greyed ?? button.title}
      onClick={() => {
        if (button.kind === "ready") void post("request", { version: button.version });
      }}
    >
      Review
    </Button>
  );
}

/** A run that ended without a verdict, until dismissed or the next one; none once approved. */
function ReviewFailed(): JSX.Element | null {
  const failed = useReview((s) => s.reviews?.failed ?? null);
  const dismissed = useReview((s) => s.dismissed);
  const approved = usePage((s) => s.review?.workspace.kind === "approved");

  if (failed === null || dismissed === failed.seq) return null;

  if (approved) return null;

  return (
    <Banner
      kind="err"
      role="alert"
      action={{
        label: "Dismiss",
        run: () => {
          patchStore(reviewStore, { dismissed: failed.seq });
        },
      }}
    >
      <strong>Review failed</strong>
      <span>{failedText(failed)}</span>
    </Banner>
  );
}

export const page: PageHalf<AgentReviewPlugs> = {
  id: "agent-review",
  actions: [ReviewAction],
  notices: [ReviewFailed],
};
