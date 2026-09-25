#!/usr/bin/env bun

import { cpSync, existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { startServer } from "./adapters/http/serve.ts";
import type { FinalDir, WipDir } from "./domain/paths.ts";
import { dateOf, parseWipDir } from "./domain/paths.ts";
import { DRAFT_FILE, PLAN_FILE } from "./domain/workspace.ts";

/** The page alone on any directory of documents: a working copy, served, taken away on the way out. */

const DEFAULT_MINUTES = 30;

const WATCHDOG_PERIOD_MS = 5_000;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function scratchId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

/** The copy lives where `serve` accepts it, and nowhere a plan of the project could be taken for one. */
export function scratchDir(date: string, id: string): WipDir {
  const parsed = parseWipDir(`plans/${date}/wip-${id}/`);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}

/**
 * Copied, never linked: `listFiles` keeps an entry its listing calls a file, and a symbolic link
 * is not one, so a linked document reaches no page. The server writes in its working directory
 * too, `.review/draft.json` and an edited `plan.md`, which a link would carry to the source. The
 * source's own draft stays there: its comments name the paths of a directory nobody serves here.
 */
export function stage(source: string, project: string, dir: WipDir): void {
  const draft = resolve(source, DRAFT_FILE);

  cpSync(source, join(project, dir), {
    recursive: true,
    filter: (from) => resolve(from) !== draft,
  });
}

export function discard(project: string, dir: WipDir | FinalDir): void {
  rmSync(join(project, dir), { recursive: true, force: true });
  removeIfEmpty(join(project, "plans", dateOf(dir)));
  removeIfEmpty(join(project, "plans"));
}

/** Two previews on one project stop together: the other one may empty or remove the folder first. */
function removeIfEmpty(path: string): void {
  try {
    if (readdirSync(path).length === 0) rmdirSync(path);
  } catch (cause) {
    if (!isErrnoException(cause) || !["ENOENT", "ENOTEMPTY"].includes(cause.code ?? ""))
      throw cause;
  }
}

function isErrnoException(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { port: { type: "string" }, minutes: { type: "string" } },
  });

  const [source] = positionals;

  if (source === undefined) {
    console.error("usage: preview.ts <dir holding plan.md> [--minutes <n>] [--port <n>]");
    process.exit(2);
  }

  const from = resolve(source);

  if (!existsSync(join(from, PLAN_FILE))) {
    console.error(`no ${PLAN_FILE} in ${from}`);
    process.exit(2);
  }

  const minutes = Number(values.minutes ?? DEFAULT_MINUTES);

  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error(`--minutes wants a positive number: ${values.minutes}`);
    process.exit(2);
  }

  const project = process.cwd();
  const dir = scratchDir(today(), scratchId());

  // Registered before the copy: one that fails halfway leaves the files it did write.
  let served: () => WipDir | FinalDir = () => dir;

  process.on("exit", () => discard(project, served()));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => process.exit(0));
  }

  stage(from, project, dir);

  // No module beats this server, so the watchdog is its lifetime: a tab holds it no longer.
  const ttlMs = minutes * 60_000;

  const started = await startServer({
    project,
    workdir: dir,
    port: Number(values.port ?? 0),
    watchdog: {
      graceMs: ttlMs,
      tabHoldMs: ttlMs,
      periodMs: WATCHDOG_PERIOD_MS,
      expire: () => process.exit(0),
    },
  });

  served = started.dir;

  console.log(started.url);
  console.error(
    `${from} copied to ${join(project, dir)}; pid ${process.pid}; gone on Ctrl-C, on kill ${process.pid}, or in ${minutes} min`,
  );
}
