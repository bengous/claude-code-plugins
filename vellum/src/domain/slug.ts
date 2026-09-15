import type { ParseResult, Slug } from "./paths.ts";

const MAX_SLUG_LENGTH = 60;

export function slugFromTitle(plan: string): ParseResult<Slug> {
  const heading = /^#\s+(.+?)\s*$/mu.exec(plan)?.[1];

  if (heading === undefined) return { ok: false, error: "the plan has no # heading" };

  const slug = heading
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/\p{M}/gu, "")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, MAX_SLUG_LENGTH)
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
