/** Where the verdicts land, under the working directory, listed in the rail as any file there. */
export const REVIEWS_DIR = "reviews/";

/** A resolved model id as a file name keeps it: `claude-opus-5-5[1m]` is `claude-opus-5-51m`. */
function modelPart(model: string): string {
  return model.toLowerCase().replaceAll(/[^a-z0-9.-]/gu, "");
}

/**
 * The file a verdict is written to, under the working directory: `reviews/v<n>-<model>.md`, then
 * `-2`, `-3` for the next reviews of that version by that model. `taken` holds the names already
 * in `reviews/`.
 */
export function reviewFile(version: number, model: string, taken: ReadonlySet<string>): string {
  const stem = `v${version}-${modelPart(model)}`;
  let name = `${stem}.md`;

  for (let k = 2; taken.has(name); k += 1) name = `${stem}-${k}.md`;

  return `${REVIEWS_DIR}${name}`;
}
