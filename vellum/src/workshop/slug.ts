import type { ParseResult, Slug } from "./paths.ts";

const MAX_SLUG_LENGTH = 60;

/** `folded` cut to the limit, between two words: a word the limit falls inside goes whole. */
function shortened(folded: string): string {
  if (folded.length <= MAX_SLUG_LENGTH) return folded;
  const cut = folded.slice(0, MAX_SLUG_LENGTH);

  return folded[MAX_SLUG_LENGTH] === "-" ? cut : cut.replace(/-[^-]*$/u, "");
}

export function slugFromTitle(plan: string): ParseResult<Slug> {
  const heading = /^#\s+(.+?)\s*$/mu.exec(plan)?.[1];

  if (heading === undefined) return { ok: false, error: "the plan has no # heading" };

  const slug = shortened(
    heading
      .toLowerCase()
      .normalize("NFD")
      .replaceAll(/\p{M}/gu, "")
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, ""),
  )
    .replace(/-+$/u, "")
    .replace(/^(?:wip-)+/u, "");

  // SAFETY: the brand is granted by the non-empty check on the line below; the characters are [a-z0-9-] by construction.
  return slug === ""
    ? { ok: false, error: `the heading "${heading}" leaves no slug` }
    : { ok: true, value: slug as Slug };
}

export function slugFromFileName(planFilePath: string): ParseResult<Slug> {
  const base = planFilePath.split("/").at(-1)?.replace(/\.md$/u, "") ?? "";

  return slugFromTitle(`# ${base}`);
}
