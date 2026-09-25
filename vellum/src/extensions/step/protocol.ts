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

/**
 * What the page draws the "Next step" window from: the proposal waiting, if any, and what holds
 * the review (an open grill), during which no step is taken.
 */
export type StepState = { readonly pending: Pending | null; readonly held: string | null };

/** What `POST propose` answers: the id the proposal waits under. */
export type Proposed = { readonly id: string };

/**
 * What `POST wait` answers: the reviewer's answer, its entry's number and the text `propose`
 * returns; the proposal gone unanswered (a restarted server, a newer proposal, the approval); or
 * still waiting once the hold ran out.
 */
export type StepWaited =
  | { readonly kind: "answered"; readonly seq: number; readonly text: string }
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
