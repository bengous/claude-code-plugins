import type { FinalDir, ParseResult, ProjectPath, Version, WipDir } from "./paths.ts";
import { parseProjectPath, parseVersion, parseWipDir } from "./paths.ts";

/**
 * The plan's working directory as a state: what its `.review/` listing says, what the
 * server remembers between Approve and the rename, and what the two make together.
 */

export const REVIEW_DIR = ".review";

export function versionFile(version: Version): string {
  return `${REVIEW_DIR}/v${version}.md`;
}

export function feedbackFile(version: Version): string {
  return `${REVIEW_DIR}/v${version}.feedback.md`;
}

/** What the directory says on its own; `approvedPending` and `finalizing` live in memory. */
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

export type PlanWorkspace =
  | DiskWorkspace
  | { readonly kind: "approvedPending"; readonly dir: WipDir; readonly version: Version }
  | {
      readonly kind: "finalizing";
      readonly from: WipDir;
      readonly to: FinalDir;
      readonly version: Version;
    };

/** What the directory cannot say: the steps between Approve and the rename, and a rename that failed. */
export type Memory =
  | { readonly kind: "none" }
  | { readonly kind: "approvedPending"; readonly version: Version }
  | { readonly kind: "finalizing"; readonly version: Version; readonly to: FinalDir }
  | { readonly kind: "finalizeError"; readonly version: Version; readonly error: string }
  | { readonly kind: "approved"; readonly version: Version; readonly dir: FinalDir };

/** What the hooks module must relay to Claude. */
export type Pending =
  | { readonly kind: "none" }
  | { readonly kind: "feedback"; readonly version: Version; readonly path: ProjectPath }
  | { readonly kind: "approved"; readonly version: Version };

function latestVersion(names: ReadonlySet<string>): Version | null {
  let latest: Version | null = null;

  for (const name of names) {
    const match = /^v(\d+)\.md$/u.exec(name);
    const parsed = match?.[1] === undefined ? null : parseVersion(Number(match[1]));

    if (parsed?.ok === true && (latest === null || parsed.value > latest)) latest = parsed.value;
  }

  return latest;
}

/** The state a `.review/` listing spells: `names` are the entries of that directory, none when it is missing. */
export function workspaceFromListing(
  dir: WipDir | FinalDir,
  names: ReadonlySet<string>,
): ParseResult<DiskWorkspace> {
  const latest = latestVersion(names);
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

/** The workspace as the page and the hooks module see it: the directory, overlaid with the memory. */
export function workspaceOf(disk: DiskWorkspace, memory: Memory, workdir: WipDir): PlanWorkspace {
  if (memory.kind === "approved") {
    return { kind: "approved", dir: memory.dir, version: memory.version };
  }

  if (memory.kind === "finalizing") {
    return { kind: "finalizing", from: workdir, to: memory.to, version: memory.version };
  }

  if (disk.kind === "inReview" && memory.kind === "approvedPending") {
    return { kind: "approvedPending", dir: disk.dir, version: disk.version };
  }

  if (disk.kind === "inReview" && memory.kind === "finalizeError") {
    return { ...disk, finalizeError: memory.error };
  }

  return disk;
}

/** Read off the workspace; nothing is kept beside it. */
export function pendingOf(workspace: PlanWorkspace): Pending {
  if (workspace.kind === "changesRequested") {
    return {
      kind: "feedback",
      version: workspace.version,
      path: projectPath(`${workspace.dir}${feedbackFile(workspace.version)}`),
    };
  }

  if (workspace.kind === "approvedPending") {
    return { kind: "approved", version: workspace.version };
  }

  return { kind: "none" };
}

export function projectPath(path: string): ProjectPath {
  const parsed = parseProjectPath(path);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}
