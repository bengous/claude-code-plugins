/** What the plan reviewer's verdict says, read off its text by `parse.ts`; JSON. */

export type ReviewStatus = "approved" | "issuesFound";

export type Size = "overengineered" | "underengineered" | "right";

/** Where a finding points, as the reviewer wrote it: the quote is the truth, the lines where to look. */
export type Place = { readonly lines: readonly [number, number]; readonly quote: string };

export type Finding = {
  /** The `[section]` the finding names; `null` when it names none. */
  readonly section: string | null;
  readonly text: string;
  /** `null` for a finding about the plan as a whole, or one missing its lines or its quote. */
  readonly place: Place | null;
};

export type Verdict = {
  readonly status: ReviewStatus;
  readonly size: { readonly kind: Size; readonly why: string };
  readonly issues: readonly Finding[];
  readonly advisories: readonly Finding[];
};

/** What crosses `/api/x/review/*` between the hooks module, the server and the page; JSON. */

/** The agent the Review button launches. */
export const REVIEWER = "vellum:plan-reviewer";

/** A review asked from the page, numbered by the server: asked, then launched by the hooks module. */
export type Run =
  | { readonly kind: "requested"; readonly seq: number; readonly version: number }
  | {
      readonly kind: "running";
      readonly seq: number;
      readonly version: number;
      readonly agentId: string;
      readonly model: string;
    };

/** The last run that ended without a verdict, and why; `model` is `null` for one never launched. */
export type Failed = {
  readonly seq: number;
  readonly version: number;
  readonly model: string | null;
  readonly why: string;
};

/** What `GET state` answers: the run under way, and the last one that failed. */
export type ReviewState = { readonly run: Run | null; readonly failed: Failed | null };

/** What `.review/reviews.json` keeps: the state, and the last number a run took. */
export type Reviews = ReviewState & { readonly seq: number };

/** What `POST ended` carries: the agent's final text, or why the run gave none. */
export type Outcome =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "failed"; readonly why: string };

/** The body each `POST /api/x/review/<name>` takes, by route name. */
export type ReviewPosts = {
  readonly request: { readonly version: number };
  readonly launched: { readonly seq: number; readonly agentId: string; readonly model: string };
  readonly ended: { readonly seq: number; readonly outcome: Outcome };
  readonly forget: { readonly seq: number };
  readonly close: Readonly<Record<string, never>>;
};

/** What `POST request` answers: the number the run took. */
export type Requested = { readonly seq: number };
