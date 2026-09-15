import { isAbsolute, join, normalize, relative } from "node:path";

import type { DocRef, LinkRoots, ServerPlugin } from "../../src/protocol.ts";
import { mediaTypeOf } from "../../src/protocol.ts";
import { parseProjectPath } from "../../src/workspace/paths.ts";

/** A Markdown link target, an `<img src>`, or a path in backticks: the skill lists artifacts by path. */
const LINK_TARGETS = /(?:\]\(|<img[^>]*\ssrc="|`)([^)"`\s]+)/gu;

function isLocal(target: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/iu.test(target) && !target.startsWith("#");
}

function decoded(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

/** Every local link of the plan, resolved from the project root and from the plan's directory. */
export function linkedDocs(plan: string, roots: LinkRoots): readonly DocRef[] {
  const docs: DocRef[] = [];

  for (const match of plan.matchAll(LINK_TARGETS)) {
    const target = decoded(match[1] ?? "").split(/[#?]/u)[0] ?? "";

    if (target === "" || !isLocal(target)) continue;
    const mediaType = mediaTypeOf(target);

    if (mediaType === null) continue;

    const candidates = isAbsolute(target)
      ? [relative(roots.project, target)]
      : [".", roots.planDir].map((base) => normalize(join(base, target)));

    for (const candidate of candidates) {
      const parsed = parseProjectPath(candidate);

      if (parsed.ok) docs.push({ path: parsed.value, mediaType });
    }
  }

  return docs;
}

export const markdownServer: ServerPlugin = { id: "markdown", linkedDocs };
