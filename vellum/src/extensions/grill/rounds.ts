import type { Block } from "./protocol.ts";

export type QuestionBlock = Extract<Block, { kind: "question" }>;

/**
 * Answered: sent with the reviewer's words or the recommendation chosen, or so in the draft.
 * Taken by default: sent untouched. Waiting: open and untouched, so a send takes it by default.
 */
export type ChipState = "answered" | "default" | "waiting";

export type Chip = { readonly id: string; readonly state: ChipState };

export type Round = { readonly n: number; readonly chips: readonly Chip[] };

/** The grill's questions as the panel draws them, one at a time under the chips of every round. */
export type Rounds = {
  readonly rounds: readonly Round[];
  /** The one picked, else the first still open; `null` between rounds. */
  readonly current: QuestionBlock | null;
  readonly previous: string | null;
  readonly next: string | null;
  /** The questions no reply closed yet, in order: what a send or End grill closes. */
  readonly open: readonly string[];
  /** The open questions the draft leaves untouched, the chips still waiting: what a send takes as recommended. */
  readonly waiting: number;
  /** The send button's words: how many open questions it takes as recommended. */
  readonly send: string;
};

function stateOf(block: QuestionBlock, answers: Readonly<Record<string, string>>): ChipState {
  switch (block.answer.kind) {
    case "open":
      return (answers[block.id]?.trim() ?? "") === "" ? "waiting" : "answered";
    case "default":
      return "default";
    case "recommended":
    case "typed":
      return "answered";
  }
}

function sendOf(open: number, byDefault: number): string {
  if (open === 0) return "Send note";

  return byDefault === 0 ? "Send round" : `Send round · ${byDefault} taken as recommended`;
}

/**
 * The blocks as served, with the draft's typing by question id: absent or blank takes the
 * recommendation by default, `As recommended.` chooses it, any other text is the reviewer's own.
 */
export function roundsOf(
  blocks: readonly Block[],
  answers: Readonly<Record<string, string>>,
  picked: string | null,
): Rounds {
  const questions = blocks.filter((block) => block.kind === "question");
  const rounds: { readonly n: number; readonly chips: Chip[] }[] = [];

  for (const block of questions) {
    const chip = { id: block.id, state: stateOf(block, answers) };
    const last = rounds.at(-1);

    if (last?.n === block.round) last.chips.push(chip);
    else rounds.push({ n: block.round, chips: [chip] });
  }

  const current =
    questions.find((block) => block.id === picked) ??
    questions.find((block) => block.answer.kind === "open") ??
    null;

  const at = current === null ? -1 : questions.indexOf(current);
  const open = questions.filter((block) => block.answer.kind === "open");
  const waiting = open.filter((block) => stateOf(block, answers) === "waiting");

  return {
    rounds,
    current,
    previous: at > 0 ? (questions[at - 1]?.id ?? null) : null,
    next: at === -1 ? null : (questions[at + 1]?.id ?? null),
    open: open.map((block) => block.id),
    waiting: waiting.length,
    send: sendOf(open.length, waiting.length),
  };
}

/** The round the grill stands in: the last one asked, 0 before the first. */
export function roundNow(blocks: readonly Block[]): number {
  return blocks.findLast((block) => block.kind === "question")?.round ?? 0;
}
