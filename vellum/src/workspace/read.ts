import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { FinalDir, ParseResult, Version, WipDir } from "./paths.ts";
import { parseVersion, parseWipDir } from "./paths.ts";

export const REVIEW_DIR = ".review";

/** What the directory says on its own; `approvedPending` and `finalizing` live in the server's memory. */
export type DiskWorkspace =
  | { readonly kind: "drafting"; readonly dir: WipDir }
  | {
      readonly kind: "inReview";
      readonly dir: WipDir;
      readonly version: Version;
      readonly finalizeError: string | null;
    }
  | { readonly kind: "changesRequested"; readonly dir: WipDir; readonly version: Version }
  | { readonly kind: "approved"; readonly dir: FinalDir; readonly version: Version };

export function versionFile(version: Version): string {
  return `${REVIEW_DIR}/v${version}.md`;
}

export function feedbackFile(version: Version): string {
  return `${REVIEW_DIR}/v${version}.feedback.md`;
}

type ReviewFiles = { readonly latest: Version | null; readonly names: ReadonlySet<string> };

async function listReview(project: string, dir: string): Promise<ReviewFiles> {
  const names = new Set(await readdir(join(project, dir, REVIEW_DIR)).catch((): string[] => []));

  let latest: Version | null = null;

  for (const name of names) {
    const match = /^v(\d+)\.md$/u.exec(name);
    const parsed = match?.[1] === undefined ? null : parseVersion(Number(match[1]));

    if (parsed?.ok === true && (latest === null || parsed.value > latest)) latest = parsed.value;
  }

  return { latest, names };
}

export async function readWorkspace(
  project: string,
  dir: WipDir | FinalDir,
): Promise<ParseResult<DiskWorkspace>> {
  const { latest, names } = await listReview(project, dir);
  const wip = parseWipDir(dir);

  if (!wip.ok) {
    // SAFETY: `dir` is `WipDir | FinalDir` and `parseWipDir` just refused it, so it is the FinalDir.
    return latest === null
      ? { ok: false, error: `${dir} holds no .review/vN.md` }
      : { ok: true, value: { kind: "approved", dir: dir as FinalDir, version: latest } };
  }

  if (latest === null) return { ok: true, value: { kind: "drafting", dir: wip.value } };

  return names.has(`v${latest}.feedback.md`)
    ? { ok: true, value: { kind: "changesRequested", dir: wip.value, version: latest } }
    : {
        ok: true,
        value: { kind: "inReview", dir: wip.value, version: latest, finalizeError: null },
      };
}
