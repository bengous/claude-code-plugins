import { isAbsolute, join, normalize, relative, sep } from "node:path";

import type { ServerExtension } from "../../core/extension.ts";
import type { DocLink, LinkRoots } from "../../core/protocol.ts";
import { mediaTypeOf } from "../../core/protocol.ts";
import { parseProjectPath } from "../../core/server/domain/paths.ts";

/** A Markdown link target, an `<img src>`, or a path in backticks: the skill lists artifacts by path. */
const LINK_TARGETS = /(?:\]\(|<img[^>]*\ssrc="|`)([^)"`\s]+)/gu;

/** On Windows a drive, `C:\` or `C:/`, is a path; elsewhere it stays the URL scheme it reads as. */
const DRIVE = sep === "\\" ? /^[a-z]:[\\/]/iu : null;

function isLocal(target: string): boolean {
  return (
    (DRIVE?.test(target) === true || !/^[a-z][a-z0-9+.-]*:/iu.test(target)) &&
    !target.startsWith("#")
  );
}

function decoded(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

/** Every local link of the plan, resolved from the project root and from the plan's directory. */
export function linkedDocs(plan: string, roots: LinkRoots): readonly DocLink[] {
  const docs: DocLink[] = [];

  for (const match of plan.matchAll(LINK_TARGETS)) {
    const target = decoded(match[1] ?? "").split(/[#?]/u)[0] ?? "";

    if (target === "" || !isLocal(target)) continue;
    const mediaType = mediaTypeOf(target);

    if (mediaType === null) continue;

    const candidates = isAbsolute(target)
      ? [relative(roots.project, target)]
      : [".", roots.planDir].map((base) => normalize(join(base, target)));

    // `relative` answers a path on another Windows drive whole: it lies outside the project.
    for (const candidate of candidates.filter((path) => !isAbsolute(path))) {
      // `node:path` answers in the platform's separator: `\` on Windows, where a project path holds `/`.
      const parsed = parseProjectPath(candidate.replaceAll(sep, "/"));

      if (parsed.ok) docs.push({ path: parsed.value, mediaType });
    }
  }

  return docs;
}

export const markdownServer: ServerExtension = { id: "markdown", linkedDocs };
