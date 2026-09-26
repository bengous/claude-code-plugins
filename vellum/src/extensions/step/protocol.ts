/** What crosses `/api/x/step/*` between the hooks module, the server and the page; JSON. */

/** The tool Claude proposes the next step with: the engine half serves it, the server names it. */
export const PROPOSE_TOOL = "mcp__vellum__propose";

/** A step Claude may take next; for a grill, `choices` are the titles of the choices it would settle. */
export type Move =
  | { readonly kind: "grill"; readonly subject: string; readonly choices: readonly string[] }
  | { readonly kind: "mockup"; readonly screen: string }
  | { readonly kind: "prototype"; readonly question: string }
  | { readonly kind: "plan" };

/** What `propose` sends: why a step is needed now, the moves offered, and the index of the one Claude would take. */
export type Proposal = {
  readonly reason: string;
  readonly moves: readonly Move[];
  readonly recommended: number;
};

/** The reviewer's answer: a move, one of the proposal's or one of their own, or their own words. */
export type StepAnswer =
  | { readonly kind: "move"; readonly move: Move }
  | { readonly kind: "own"; readonly text: string };

/** The proposal waiting for the reviewer, under the id the server gave it. */
export type Pending = { readonly id: string; readonly proposal: Proposal };

/** What `GET state` answers: the proposal waiting, if any. What holds the review is the core's `ReviewView.held`. */
export type StepState = { readonly pending: Pending | null };

/** What `POST propose` answers: the id the proposal waits under. */
export type Proposed = { readonly id: string };

/**
 * Why a proposal stopped waiting unanswered: a newer one took its place, the plan was approved,
 * or `plan.md` was written and the plan was its one move.
 */
export type Dropped = "replaced" | "approved" | "written";

/**
 * `.review/step.json`: the proposal waiting, the last one answered under the entry that told it,
 * and the last one dropped and why, for the waits on them. Whether Claude's call still waits is
 * the server's memory, never written: a restarted server reads it paused.
 */
export type StepFile = {
  readonly pending: Pending | null;
  readonly answered: { readonly id: string; readonly seq: number; readonly text: string } | null;
  readonly dropped: { readonly id: string; readonly why: Dropped } | null;
};

/**
 * What `POST wait` answers: the reviewer's answer, its entry's number and the text `propose`
 * returns; the proposal dropped unanswered, and why; an id the server does not know, as after a
 * restart; or the proposal still waiting once the hold ran out.
 */
export type StepWaited =
  | { readonly kind: "answered"; readonly seq: number; readonly text: string }
  | { readonly kind: "ended"; readonly why: Dropped }
  | { readonly kind: "gone" }
  | { readonly kind: "open" };

/** The body each `POST /api/x/step/<name>` takes, by route name. */
export type StepPosts = {
  readonly propose: Proposal;
  /** Held until the proposal `id` is answered or gone, or for the hold at most. */
  readonly wait: { readonly id: string };
  /**
   * The proposal the window showed, `null` for the window opened blank: an answer to one no
   * longer waiting is refused, so a tab kept since cannot answer a newer one.
   */
  readonly answer: { readonly id: string | null; readonly answer: StepAnswer };
};
