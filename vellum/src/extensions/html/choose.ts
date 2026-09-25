import type { Chosen } from "./messages.ts";

/**
 * What one element of a chain says of a choice, as Claude marks a decision in a mockup: whether it
 * is a « Choose » (`data-vellum-choose`), the option it is (`data-vellum-option`), the decision
 * it holds (`data-vellum-decision`). `null` for an attribute the element does not carry.
 */
export type Marks = {
  readonly choose: boolean;
  readonly option: string | null;
  readonly decision: string | null;
};

/** The option `chain[0]` is, in the nearest decision above it; `chain` runs from the element up. */
export function optionOf(chain: readonly Marks[]): Chosen | null {
  const [first, ...above] = chain;
  const option = first?.option ?? "";
  const decision = above.find((marks) => marks.decision !== null)?.decision ?? "";

  return option === "" || decision === "" ? null : { decision, option };
}

/**
 * The choice a click makes, off the chain from the clicked element up: the nearest « Choose »,
 * the nearest option from it up, in that option's decision. `button` is the « Choose »'s index,
 * the element Claude reads described: the heading before it is its option's own, where the
 * option's element would sit under the heading of the option before it. `option` is the option's
 * index, whose own heading names it on the page. `null` for a click outside a « Choose », or one
 * outside an option of a decision.
 */
export function choiceOf(
  chain: readonly Marks[],
): { readonly button: number; readonly option: number; readonly chosen: Chosen } | null {
  const button = chain.findIndex((marks) => marks.choose);

  const option = chain.findIndex(
    (marks, index) => button !== -1 && index >= button && marks.option !== null,
  );

  const chosen = option === -1 ? null : optionOf(chain.slice(option));

  return chosen === null ? null : { button, option, chosen };
}
