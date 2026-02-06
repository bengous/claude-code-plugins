#!/usr/bin/env bun

import { readdir, stat, rename, mkdir, readlink, readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { $ } from "bun";

// === Constants ===
const CLAUDE_DIR = join(homedir(), ".claude", "projects");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const SKIP_NAMES = new Set(["memory", "archive", "sessions-index.json"]);
const DEFAULT_DAYS = 30;
const HOOK_MAX_DEFAULT = 20;
const RECENT_MINUTES = 5;

// Diagnostic log -- stderr in hook mode (stdout reserved for JSON response), stdout otherwise
let log = console.log;
function useStderrLog() {
  log = (...args: unknown[]) => console.error(...args);
}

// === Types ===
interface SessionInfo {
  sessionId: string;
  jsonlPath?: string;
  dirPath?: string;
  mtime: Date;
  sizeBytes: number;
}

interface ArchiveEntry {
  sessionId: string;
  archivedAt: string;
  originalMtime: string;
  sizeBytes: number;
  compressedSizeBytes: number;
  hasDirectory: boolean;
  hasJsonl: boolean;
}

interface ArchiveIndex {
  version: 1;
  entries: ArchiveEntry[];
}

interface Options {
  days: number;
  project?: string;
  dryRun: boolean;
  unarchive?: string;
  list: boolean;
  stats: boolean;
  hook: boolean;
  max: number;
  verbose: boolean;
}

// === Pure Functions ===
export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    days: DEFAULT_DAYS,
    dryRun: false,
    list: false,
    stats: false,
    hook: false,
    max: 0, // 0 = unlimited (resolved later for hook mode)
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--days":
        opts.days = parseInt(argv[++i], 10);
        if (isNaN(opts.days) || opts.days < 0) {
          console.error("--days requires a non-negative integer");
          process.exit(1);
        }
        break;
      case "--project":
        opts.project = argv[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--unarchive":
        opts.unarchive = argv[++i];
        break;
      case "--list":
        opts.list = true;
        break;
      case "--stats":
        opts.stats = true;
        break;
      case "--hook":
        opts.hook = true;
        break;
      case "--max":
        opts.max = parseInt(argv[++i], 10);
        if (isNaN(opts.max) || opts.max < 0) {
          console.error("--max requires a non-negative integer");
          process.exit(1);
        }
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        console.error(`Unknown option: ${argv[i]}`);
        process.exit(1);
    }
  }

  // In hook mode, default max to 20 if not explicitly set
  if (opts.hook && opts.max === 0) {
    opts.max = HOOK_MAX_DEFAULT;
  }

  return opts;
}

export function isSessionUuid(name: string): boolean {
  return UUID_RE.test(name);
}

export function shouldArchive(
  session: SessionInfo,
  cutoffDate: Date,
  protectedIds: Set<string>,
): boolean {
  if (protectedIds.has(session.sessionId)) return false;

  // Skip recently modified files (within RECENT_MINUTES)
  const recentCutoff = new Date(Date.now() - RECENT_MINUTES * 60 * 1000);
  if (session.mtime > recentCutoff) return false;

  // Skip sessions newer than cutoff
  if (session.mtime > cutoffDate) return false;

  return true;
}

// === IO Functions ===

async function discoverSessions(projectDir: string): Promise<SessionInfo[]> {
  const entries = await readdir(projectDir, { withFileTypes: true });
  const sessionMap = new Map<string, SessionInfo>();

  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;

    // JSONL files
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const sessionId = entry.name.replace(/\.jsonl$/, "");
      if (!isSessionUuid(sessionId)) continue;

      const filePath = join(projectDir, entry.name);
      const fileStat = await stat(filePath);
      const existing = sessionMap.get(sessionId);
      if (existing) {
        existing.jsonlPath = filePath;
        existing.sizeBytes = fileStat.size;
        // Use JSONL mtime as primary
        existing.mtime = fileStat.mtime;
      } else {
        sessionMap.set(sessionId, {
          sessionId,
          jsonlPath: filePath,
          mtime: fileStat.mtime,
          sizeBytes: fileStat.size,
        });
      }
    }

    // UUID-named directories
    if (entry.isDirectory() && isSessionUuid(entry.name)) {
      const dirPath = join(projectDir, entry.name);
      const existing = sessionMap.get(entry.name);
      if (existing) {
        existing.dirPath = dirPath;
      } else {
        const dirStat = await stat(dirPath);
        sessionMap.set(entry.name, {
          sessionId: entry.name,
          dirPath,
          mtime: dirStat.mtime,
          sizeBytes: 0,
        });
      }
    }
  }

  return Array.from(sessionMap.values());
}

async function getActiveSessionIds(projectDir: string): Promise<Set<string>> {
  const activeIds = new Set<string>();
  const uid = process.getuid?.() ?? 1000;
  const projectName = basename(projectDir);
  const tasksDir = join("/tmp", `claude-${uid}`, projectName, "tasks");

  if (!existsSync(tasksDir)) return activeIds;

  try {
    const entries = await readdir(tasksDir);
    for (const entry of entries) {
      try {
        const target = await readlink(join(tasksDir, entry));
        // Target looks like: .../projects/<project-name>/<session-uuid>/subagents/...
        // Extract UUID: everything after the project name, first path segment
        const projectIdx = target.indexOf(projectName);
        if (projectIdx === -1) continue;
        const afterProject = target.substring(projectIdx + projectName.length + 1);
        const uuid = afterProject.split("/")[0];
        if (isSessionUuid(uuid)) {
          activeIds.add(uuid);
        }
      } catch {
        // Broken symlink, skip
      }
    }
  } catch {
    // Tasks dir not readable, skip
  }

  return activeIds;
}

async function compressSession(jsonlPath: string, archivePath: string): Promise<number> {
  const result = await $`zstd --rm -q ${jsonlPath} -o ${archivePath}`.nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`zstd failed: ${result.stderr.toString()}`);
  }
  const archiveStat = await stat(archivePath);
  return archiveStat.size;
}

async function archiveSession(
  session: SessionInfo,
  archiveDir: string,
  dryRun: boolean,
  verbose: boolean,
): Promise<ArchiveEntry> {
  const entry: ArchiveEntry = {
    sessionId: session.sessionId,
    archivedAt: new Date().toISOString(),
    originalMtime: session.mtime.toISOString(),
    sizeBytes: session.sizeBytes,
    compressedSizeBytes: 0,
    hasDirectory: !!session.dirPath,
    hasJsonl: !!session.jsonlPath,
  };

  if (dryRun) {
    if (verbose) {
      const parts: string[] = [];
      if (session.jsonlPath) parts.push(`${formatBytes(session.sizeBytes)} JSONL`);
      if (session.dirPath) parts.push("+ dir");
      log(`  [dry-run] Would archive ${session.sessionId} (${parts.join(" ")})`);
    }
    return entry;
  }

  await mkdir(archiveDir, { recursive: true });

  // Compress or move JSONL
  if (session.jsonlPath) {
    if (session.sizeBytes > 0) {
      const archivePath = join(archiveDir, `${session.sessionId}.jsonl.zst`);
      try {
        entry.compressedSizeBytes = await compressSession(session.jsonlPath, archivePath);
        if (verbose) {
          const ratio = (entry.compressedSizeBytes / session.sizeBytes * 100).toFixed(1);
          log(`  Compressed ${session.sessionId}.jsonl (${formatBytes(session.sizeBytes)} → ${formatBytes(entry.compressedSizeBytes)}, ${ratio}%)`);
        }
      } catch (err) {
        console.error(`  Failed to compress ${session.sessionId}: ${err}`);
        throw err;
      }
    } else {
      // Empty file: just move it
      const archivePath = join(archiveDir, `${session.sessionId}.jsonl`);
      await rename(session.jsonlPath, archivePath);
      if (verbose) {
        log(`  Moved ${session.sessionId}.jsonl (empty)`);
      }
    }
  }

  // Move session directory
  if (session.dirPath) {
    const archiveDirPath = join(archiveDir, session.sessionId);
    await rename(session.dirPath, archiveDirPath);
    if (verbose) {
      log(`  Moved ${session.sessionId}/ directory`);
    }
  }

  return entry;
}

async function loadArchiveIndex(archiveDir: string): Promise<ArchiveIndex> {
  const indexPath = join(archiveDir, "sessions-index.json");
  try {
    const data = await readFile(indexPath, "utf-8");
    return JSON.parse(data) as ArchiveIndex;
  } catch {
    return { version: 1, entries: [] };
  }
}

async function saveArchiveIndex(archiveDir: string, index: ArchiveIndex): Promise<void> {
  const indexPath = join(archiveDir, "sessions-index.json");
  const tmpPath = indexPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  await rename(tmpPath, indexPath);
}

async function unarchiveSession(uuid: string, projectDir: string): Promise<void> {
  const archiveDir = join(projectDir, "archive");
  const index = await loadArchiveIndex(archiveDir);

  const entryIdx = index.entries.findIndex((e) => e.sessionId === uuid);
  if (entryIdx === -1) {
    console.error(`Session ${uuid} not found in archive`);
    process.exit(1);
  }

  const entry = index.entries[entryIdx];

  // Restore JSONL
  if (entry.hasJsonl) {
    const zstPath = join(archiveDir, `${uuid}.jsonl.zst`);
    const emptyPath = join(archiveDir, `${uuid}.jsonl`);
    const targetPath = join(projectDir, `${uuid}.jsonl`);

    if (existsSync(zstPath)) {
      const result = await $`zstd -d --rm -q ${zstPath} -o ${targetPath}`.nothrow().quiet();
      if (result.exitCode !== 0) {
        console.error(`Failed to decompress ${uuid}: ${result.stderr.toString()}`);
        process.exit(1);
      }
      log(`Restored ${uuid}.jsonl (${formatBytes(entry.sizeBytes)})`);
    } else if (existsSync(emptyPath)) {
      await rename(emptyPath, targetPath);
      log(`Restored ${uuid}.jsonl (empty)`);
    } else {
      console.error(`Archive file for ${uuid} not found`);
      process.exit(1);
    }
  }

  // Restore directory
  if (entry.hasDirectory) {
    const archiveDirPath = join(archiveDir, uuid);
    const targetDirPath = join(projectDir, uuid);
    if (existsSync(archiveDirPath)) {
      await rename(archiveDirPath, targetDirPath);
      log(`Restored ${uuid}/ directory`);
    }
  }

  // Remove from index
  index.entries.splice(entryIdx, 1);
  await saveArchiveIndex(archiveDir, index);
  log(`Unarchived ${uuid}`);
}

async function archiveProject(
  projectDir: string,
  options: Options,
  protectedIds: Set<string>,
): Promise<{ archived: number; skipped: number; errors: number }> {
  const sessions = await discoverSessions(projectDir);
  const activeIds = await getActiveSessionIds(projectDir);

  // Merge active IDs into protected set
  const allProtected = new Set([...protectedIds, ...activeIds]);

  const cutoffDate = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);

  const toArchive = sessions
    .filter((s) => shouldArchive(s, cutoffDate, allProtected))
    .sort((a, b) => a.mtime.getTime() - b.mtime.getTime()); // Oldest first

  const limited = options.max > 0 ? toArchive.slice(0, options.max) : toArchive;

  if (limited.length === 0) {
    return { archived: 0, skipped: sessions.length, errors: 0 };
  }

  const archiveDir = join(projectDir, "archive");

  if (options.verbose || options.dryRun) {
    const projectName = basename(projectDir);
    log(`\n${projectName}: ${limited.length} session(s) to archive (${sessions.length - limited.length} kept)`);
    if (activeIds.size > 0) {
      log(`  Active sessions protected: ${activeIds.size}`);
    }
  }

  const index = options.dryRun ? { version: 1 as const, entries: [] } : await loadArchiveIndex(archiveDir);
  let archived = 0;
  let errors = 0;

  for (const session of limited) {
    try {
      const entry = await archiveSession(session, archiveDir, options.dryRun, options.verbose);
      if (!options.dryRun) {
        index.entries.push(entry);
      }
      archived++;
    } catch {
      errors++;
    }
  }

  if (!options.dryRun && archived > 0) {
    await saveArchiveIndex(archiveDir, index);
  }

  return { archived, skipped: sessions.length - archived, errors };
}

// === List & Stats ===

async function listArchived(projectDir: string): Promise<void> {
  const archiveDir = join(projectDir, "archive");
  const index = await loadArchiveIndex(archiveDir);

  if (index.entries.length === 0) {
    log(`No archived sessions in ${basename(projectDir)}`);
    return;
  }

  log(`\n${basename(projectDir)}: ${index.entries.length} archived session(s)`);
  for (const entry of index.entries) {
    const date = new Date(entry.originalMtime).toLocaleDateString();
    const parts: string[] = [date];
    if (entry.hasJsonl) parts.push(formatBytes(entry.sizeBytes));
    if (entry.hasDirectory) parts.push("+dir");
    log(`  ${entry.sessionId}  ${parts.join("  ")}`);
  }
}

async function showStats(projectDir: string): Promise<{ totalOriginal: number; totalCompressed: number; count: number }> {
  const archiveDir = join(projectDir, "archive");
  const index = await loadArchiveIndex(archiveDir);

  let totalOriginal = 0;
  let totalCompressed = 0;
  for (const entry of index.entries) {
    totalOriginal += entry.sizeBytes;
    totalCompressed += entry.compressedSizeBytes;
  }

  return { totalOriginal, totalCompressed, count: index.entries.length };
}

// === Helpers ===

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function getProjectDirs(options: Options): Promise<string[]> {
  if (options.project) {
    return [options.project.replace(/\/$/, "")];
  }

  if (!existsSync(CLAUDE_DIR)) {
    console.error(`Claude projects directory not found: ${CLAUDE_DIR}`);
    process.exit(1);
  }

  const entries = await readdir(CLAUDE_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(CLAUDE_DIR, e.name));
}

// === Hook Mode ===

interface HookInput {
  session_id?: string;
  transcript_path?: string;
}

async function runHookMode(options: Options): Promise<void> {
  useStderrLog();
  let input: HookInput = {};
  try {
    const stdinText = await Bun.stdin.text();
    input = JSON.parse(stdinText);
  } catch {
    // Invalid stdin, just archive all
  }

  const protectedIds = new Set<string>();
  let projectDir: string | undefined;

  if (input.session_id) {
    protectedIds.add(input.session_id);
  }

  if (input.transcript_path) {
    projectDir = dirname(input.transcript_path);
  }

  if (projectDir) {
    options.project = projectDir;
  }

  const dirs = await getProjectDirs(options);
  for (const dir of dirs) {
    try {
      await archiveProject(dir, options, protectedIds);
    } catch {
      // Silently continue in hook mode
    }
  }

  // Suppress output in hook mode
  console.log(JSON.stringify({ suppressOutput: true }));
}

// === CLI Entry ===

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));

  // Hook mode
  if (options.hook) {
    await runHookMode(options);
    process.exit(0);
  }

  // Unarchive mode
  if (options.unarchive) {
    if (!options.project) {
      console.error("--unarchive requires --project");
      process.exit(1);
    }
    await unarchiveSession(options.unarchive, options.project);
    process.exit(0);
  }

  const dirs = await getProjectDirs(options);

  // List mode
  if (options.list) {
    for (const dir of dirs) {
      await listArchived(dir);
    }
    process.exit(0);
  }

  // Stats mode
  if (options.stats) {
    let grandTotal = 0;
    let grandCompressed = 0;
    let grandCount = 0;

    for (const dir of dirs) {
      const s = await showStats(dir);
      if (s.count > 0) {
        grandTotal += s.totalOriginal;
        grandCompressed += s.totalCompressed;
        grandCount += s.count;
        const ratio = s.totalOriginal > 0
          ? ((1 - s.totalCompressed / s.totalOriginal) * 100).toFixed(1)
          : "0";
        log(`${basename(dir)}: ${s.count} sessions, ${formatBytes(s.totalOriginal)} → ${formatBytes(s.totalCompressed)} (${ratio}% saved)`);
      }
    }

    if (grandCount > 0) {
      const grandRatio = grandTotal > 0
        ? ((1 - grandCompressed / grandTotal) * 100).toFixed(1)
        : "0";
      log(`\nTotal: ${grandCount} sessions, ${formatBytes(grandTotal)} → ${formatBytes(grandCompressed)} (${grandRatio}% saved)`);
    } else {
      log("No archived sessions found.");
    }
    process.exit(0);
  }

  // Default: archive mode
  let totalArchived = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const dir of dirs) {
    try {
      const result = await archiveProject(dir, options, new Set());
      totalArchived += result.archived;
      totalSkipped += result.skipped;
      totalErrors += result.errors;
    } catch (err) {
      console.error(`Error processing ${basename(dir)}: ${err}`);
      totalErrors++;
    }
  }

  if (options.verbose || options.dryRun) {
    log(`\nDone: ${totalArchived} archived, ${totalSkipped} skipped, ${totalErrors} errors`);
  }
}
