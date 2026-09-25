import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

import type { PageExtension } from "../../core/extension.ts";
import { extensionRequest } from "../../core/page/api.ts";
import { Banner, Button } from "../../core/page/kit.tsx";
import { connection, fail, review, succeed } from "../../core/page/state.ts";
import { failedText, reviewWhy } from "./labels.ts";
import type { ReviewPosts, ReviewState } from "./protocol.ts";

const ID = "review";

/** The server's last word on the runs, loaded again at every workspace event; `null` before the first answer. */
const reviews = signal<ReviewState | null>(null);

/** A request of the button's on its way: a second click waits for the server's answer. */
const asking = signal(false);

/** The failure the reviewer dismissed, by its run's number: page state, gone with a reload. */
const dismissed = signal<number | null>(null);

async function loadState(): Promise<void> {
  const response = await extensionRequest(ID, "state").catch(() => null);

  if (response?.ok !== true) return;

  // SAFETY: the server's own `ReviewState`, serialized by `Response.json` in review/server.ts.
  reviews.value = (await response.json()) as ReviewState;
}

async function post<Name extends "request" | "forget">(
  name: Name,
  body: ReviewPosts[Name],
): Promise<void> {
  asking.value = true;

  const response = await extensionRequest(ID, name, {
    method: "POST",
    body: JSON.stringify(body),
  }).catch(() => null);

  if (response === null) fail("send", "The review did not reach the server.");
  else if (response.ok) succeed("send");
  else {
    // SAFETY: a refusal of review/server.ts, `{ error }` serialized by `Response.json`.
    const refusal = (await response.json().catch(() => null)) as { readonly error?: string } | null;
    fail(
      "send",
      `The review was refused: ${refusal?.error ?? `the server answered ${response.status}`}.`,
    );
  }

  await loadState();
  asking.value = false;
}

/** Why the button is greyed besides the plan's stage; `null` when nothing else holds it. */
function pageWhy(): string | null {
  if (connection.value === "down") return "The connection to the review server is lost";

  return reviews.value === null ? "Loading the review" : null;
}

/** Active in review alone, greyed with its reason otherwise, running with a ✕ while a run is under way; gone once approved. */
function ReviewAction(): preact.JSX.Element | null {
  const view = review.value;

  useEffect(() => {
    void loadState();
  }, [view]);

  const button = view === null ? null : reviewWhy(view.workspace, reviews.value?.run ?? null);

  if (button === null) return null;
  const why = pageWhy();

  if (button.kind === "running") {
    return (
      <span class="review-run">
        <Button variant="grill" disabled title={button.title}>
          <span class="review-dot" aria-hidden="true" />
          Review running…
        </Button>
        <Button
          title="Forget this run"
          aria-label="Forget this run"
          disabled={why !== null || asking.value}
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
      disabled={greyed !== null || asking.value}
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
function ReviewFailed(): preact.JSX.Element | null {
  const failed = reviews.value?.failed ?? null;

  if (failed === null || dismissed.value === failed.seq) return null;

  if (review.value?.workspace.kind === "approved") return null;

  return (
    <Banner
      kind="err"
      role="alert"
      action={{
        label: "Dismiss",
        run: () => {
          dismissed.value = failed.seq;
        },
      }}
    >
      <strong>Review failed</strong>
      <span>{failedText(failed)}</span>
    </Banner>
  );
}

export const reviewPage: PageExtension = {
  id: "review",
  actions: [ReviewAction],
  notices: [ReviewFailed],
};
