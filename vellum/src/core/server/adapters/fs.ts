import { watch } from "node:fs";
import { appendFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { DocRef } from "../../protocol.ts";
import { mediaTypeOf } from "../../protocol.ts";
import { rewriteLinks } from "../domain/links.ts";
import type { FinalDir, ParseResult, ProjectPath, Slug, WipDir } from "../domain/paths.ts";
import { dateOf, parseFinalDir } from "../domain/paths.ts";
import type { PlanWorkspace } from "../domain/workspace.ts";
import {
  PLAN_FILE,
  projectPath,
  REVIEW_DIR,
  underReviewDir,
  workspaceFromListing,
} from "../domain/workspace.ts";

/** The file system under the project root: every read and write of the review lives here. */

const TEXT_PROBE_BYTES = 8192;

/** A write is several events; the page hears of it once they stop. */
const WATCH_SETTLE_MS = 100;

export async function readWorkspace(
  project: string,
  dir: WipDir | FinalDir,
): Promise<ParseResult<PlanWorkspace>> {
  const names = await readdir(join(project, dir, REVIEW_DIR)).catch((): string[] => []);

  return workspaceFromListing(dir, new Set(names));
}

/**
 * Every file of the plan's directory the page can render, `.review/` left out, sorted. The
 * page lists these in all states, so the reviewer can comment before the first version. The
 * server created the directory, so a listing that fails is an error to answer, not an empty list.
 */
export async function listFiles(project: string, dir: WipDir | FinalDir): Promise<DocRef[]> {
  const root = join(project, dir);
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const docs: DocRef[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const path = relative(project, file);
    const mediaType = underReviewDir(path) ? null : mediaTypeOf(path);

    if (mediaType === null) continue;
    docs.push({ path: projectPath(path), mediaType, modified: (await stat(file)).mtimeMs });
  }

  return docs.toSorted((a, b) => a.path.localeCompare(b.path));
}

/**
 * Calls `onChange` once a write under the working directory settles, so the page learns of
 * a file Claude wrote; `.review/` is the server's own and already announced.
 */
export function watchFiles(project: string, workdir: WipDir, onChange: () => void): () => void {
  let settle: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(join(project, workdir), { recursive: true }, (_event, name) => {
    if (name?.split("/")[0] === REVIEW_DIR) return;

    if (settle !== null) clearTimeout(settle);
    settle = setTimeout(onChange, WATCH_SETTLE_MS);
  });

  return () => {
    if (settle !== null) clearTimeout(settle);
    watcher.close();
  };
}

/** The plan the model writes at the working directory's root; `null` when it wrote none yet. */
export function readPlan(project: string, workdir: WipDir): Promise<string | null> {
  return readTextIfAny(project, projectPath(`${workdir}${PLAN_FILE}`));
}

/** The file's text, `null` when there is no such file. */
export async function readTextIfAny(project: string, path: ProjectPath): Promise<string | null> {
  const file = Bun.file(join(project, path));

  return (await file.exists()) ? await file.text() : null;
}

/** A file that is not there is already removed. */
export async function removeFile(project: string, path: ProjectPath): Promise<void> {
  await rm(join(project, path), { force: true });
}

export function readText(project: string, path: ProjectPath): Promise<string> {
  return Bun.file(join(project, path)).text();
}

export async function writeText(project: string, path: ProjectPath, text: string): Promise<void> {
  await Bun.write(join(project, path), text);
}

export async function appendText(project: string, path: ProjectPath, text: string): Promise<void> {
  await appendFile(join(project, path), text);
}

/** The file's mtime in ms, `null` when there is no such file. */
export async function modifiedAt(project: string, path: ProjectPath): Promise<number | null> {
  const found = await stat(join(project, path)).catch(() => null);

  return found?.isFile() === true ? found.mtimeMs : null;
}

async function isDir(project: string, path: string): Promise<boolean> {
  return (await stat(join(project, path)).catch(() => null))?.isDirectory() ?? false;
}

async function freeTarget(
  project: string,
  from: WipDir,
  slug: Slug,
): Promise<ParseResult<FinalDir>> {
  const base = `plans/${dateOf(from)}/${slug}`;

  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${base}/` : `${base}-${n}/`;
    const parsed = parseFinalDir(candidate);

    if (!parsed.ok) return parsed;

    if (
      !(await Bun.file(join(project, candidate)).exists()) &&
      !(await isDir(project, candidate))
    ) {
      return parsed;
    }
  }
}

async function isText(path: string): Promise<boolean> {
  const head = await Bun.file(path).slice(0, TEXT_PROBE_BYTES).bytes();

  return !head.includes(0);
}

async function rewriteTree(root: string, from: WipDir, to: FinalDir): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);

    if (!(await isText(path))) continue;
    const text = await Bun.file(path).text();
    const rewritten = rewriteLinks(text, from, to);

    if (rewritten !== text) await Bun.write(path, rewritten);
  }
}

/**
 * Rewrites the links of every text file to the slug's directory (`-2`, `-3` on collision), then
 * renames the working directory. Links first: a rewrite that fails leaves the directory where the
 * review can still read it, and a second attempt rewrites nothing twice.
 */
export async function finalize(
  project: string,
  from: WipDir,
  slug: Slug,
): Promise<ParseResult<FinalDir>> {
  if (!(await isDir(project, from))) return { ok: false, error: `${from} is not a directory` };
  const target = await freeTarget(project, from, slug);

  if (!target.ok) return target;
  const to = target.value;

  try {
    await rewriteTree(join(project, from), from, to);
  } catch (cause) {
    return { ok: false, error: `rewriting links in ${from} failed: ${String(cause)}` };
  }

  try {
    await rename(join(project, from), join(project, to));
  } catch (cause) {
    return { ok: false, error: `rename ${from} → ${to} failed: ${String(cause)}` };
  }

  return { ok: true, value: to };
}
