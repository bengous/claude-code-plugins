import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { rewriteLinks } from "../domain/links.ts";
import type { FinalDir, ParseResult, ProjectPath, Slug, WipDir } from "../domain/paths.ts";
import { dateOf, parseFinalDir } from "../domain/paths.ts";
import type { DiskWorkspace } from "../domain/workspace.ts";
import { REVIEW_DIR, workspaceFromListing } from "../domain/workspace.ts";

/** The file system under the project root: every read and write of the review lives here. */

const TEXT_PROBE_BYTES = 8192;

export async function readWorkspace(
  project: string,
  dir: WipDir | FinalDir,
): Promise<ParseResult<DiskWorkspace>> {
  const names = await readdir(join(project, dir, REVIEW_DIR)).catch((): string[] => []);

  return workspaceFromListing(dir, new Set(names));
}

export function readText(project: string, path: ProjectPath): Promise<string> {
  return Bun.file(join(project, path)).text();
}

export async function writeText(project: string, path: ProjectPath, text: string): Promise<void> {
  await Bun.write(join(project, path), text);
}

export function exists(project: string, path: ProjectPath): Promise<boolean> {
  return Bun.file(join(project, path)).exists();
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
