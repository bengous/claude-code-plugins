#!/usr/bin/env bun

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";

import { createExclusiveSync, rename, writeAtomic } from "./lib/platform/fs.ts";
import { isErrno, messageOf } from "./lib/platform/pure.ts";

// === Constants ===
const CLAUDE_DIR = join(homedir(), ".claude", "projects");

const DEFAULT_VAULT = join(homedir(), ".claude-archives", "miroir", "claude", "projects");

const ERROR_LOG_PATH = join(homedir(), ".claude", ".session-archive-errors.log");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

const SKIP_NAMES = new Set(["memory", "archive", "sessions-index.json"]);

const DEFAULT_DAYS = 90;

const TAIL_WINDOW_BYTES = 64 * 1024;

// The unescaped `":"` cannot match inside a JSON string, where quotes are escaped, so a transcript
// quoted in a tool result never supplies the date.
const TIMESTAMP_RE = /"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"/gu;

const HOOK_MAX_DEFAULT = 20;

const RECENT_MINUTES = 5;

const DEFAULT_LOCKFILE = join("/tmp", `session-archive-${process.getuid?.() ?? 1000}.lock`);

const LOCK_STALE_MS = 120_000; // 2 minutes

const THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 hours

const MARKER_PATH = join(homedir(), ".claude", ".session-archive-last-run");

// Diagnostic log -- stderr in hook mode (stdout reserved for JSON response), stdout otherwise
let log = console.log;

function useStderrLog() {
  log = (...args: unknown[]) => console.error(...args);
}

// Why a session was kept or a pass failed -- stderr in CLI mode, a log file in background mode,
// whose stderr nobody reads
let reportError = (message: string): void => {
  console.error(message);
};

function useErrorLogFile(path: string) {
  reportError = (message) => {
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
  };
}

// === Types ===
interface SessionInfo {
  sessionId: string;
  jsonlPath?: string;
  dirPath?: string;
  mtime: Date;
  /** The transcript's last `"timestamp"`, else its mtime (the directory's for a session without one). */
  lastActivity: Date;
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
  format?: "gzip" | "zstd";
}

interface ArchiveIndex {
  version: 1;
  entries: ArchiveEntry[];
}

export interface Options {
  days: number;
  project?: string;
  dryRun: boolean;
  copy: boolean;
  unarchive?: string;
  list: boolean;
  stats: boolean;
  hook: boolean;
  backgroundWorker?: string; // base64-encoded HookInput JSON
  max: number;
  verbose: boolean;
  /** Mirror of the projects tree; an original is deleted only once it holds the same bytes. */
  vaultRoot: string;
}

// === Lockfile ===

export async function acquireLock(
  lockfile = DEFAULT_LOCKFILE,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pid = process.pid.toString();

  while (Date.now() < deadline) {
    try {
      // FIXME: a lock judged stale (too old, a dead pid, unreadable) is removed by path, so a worker that judged it so can remove the lock another worker created since, and both then hold it; remove it only while it is still the lock judged stale (rename it aside, then check its pid), and never take over one older than LOCK_STALE_MS whose pid still runs.
      // Check for stale lock
      if (existsSync(lockfile)) {
        const lockStat = await stat(lockfile);
        const age = Date.now() - lockStat.mtimeMs;

        if (age > LOCK_STALE_MS) {
          // Stale lock — remove it
          await unlink(lockfile).catch(() => {});
        } else {
          // Lock held by another process — check if PID is alive
          try {
            const lockPid = parseInt(await readFile(lockfile, "utf-8"), 10);

            if (!isNaN(lockPid)) {
              try {
                process.kill(lockPid, 0); // signal 0 = check existence
                // Process alive, wait and retry
                await Bun.sleep(100);
                continue;
              } catch {
                // Process dead — stale lock
                await unlink(lockfile).catch(() => {});
              }
            }
          } catch {
            // Can't read lock, remove it
            await unlink(lockfile).catch(() => {});
          }
        }
      }

      if (createExclusiveSync(lockfile, pid)) return true;
      await Bun.sleep(100);
    } catch {
      await Bun.sleep(100);
    }
  }

  return false;
}

export async function releaseLock(lockfile = DEFAULT_LOCKFILE): Promise<void> {
  try {
    const lockPid = parseInt(await readFile(lockfile, "utf-8"), 10);

    if (lockPid === process.pid) {
      await unlink(lockfile);
    }
  } catch {
    // Lock already gone
  }
}

// === Pure Functions ===
export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    days: DEFAULT_DAYS,
    dryRun: false,
    copy: false,
    list: false,
    stats: false,
    hook: false,
    max: 0, // 0 = unlimited (resolved later for hook mode)
    verbose: false,
    vaultRoot: process.env["SESSION_ARCHIVE_VAULT"] || DEFAULT_VAULT,
  };

  function requireArg(flag: string, i: number): string {
    const value = argv[i];

    if (value === undefined || value.startsWith("--")) {
      console.error(`${flag} requires a value`);
      process.exit(1);
    }

    return value;
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--days":
        opts.days = parseInt(requireArg("--days", ++i), 10);

        if (isNaN(opts.days) || opts.days < 0) {
          console.error("--days requires a non-negative integer");
          process.exit(1);
        }

        break;
      case "--project":
        opts.project = requireArg("--project", ++i);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--copy":
        opts.copy = true;
        break;
      case "--unarchive":
        opts.unarchive = requireArg("--unarchive", ++i);
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
      case "--background-worker":
        opts.backgroundWorker = requireArg("--background-worker", ++i);
        break;
      case "--max":
        opts.max = parseInt(requireArg("--max", ++i), 10);

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

  // Skip sessions with a message after the cutoff
  if (session.lastActivity > cutoffDate) return false;

  return true;
}

/** The last valid `"timestamp"` in `text`, or `undefined` when it holds none. */
export function lastTimestampIn(text: string): Date | undefined {
  const matches = Array.from(text.matchAll(TIMESTAMP_RE));

  for (let i = matches.length - 1; i >= 0; i--) {
    const date = new Date(matches[i]?.[1] ?? "");

    if (!Number.isNaN(date.getTime())) return date;
  }

  return undefined;
}

// === IO Functions ===

/**
 * The last `"timestamp"` of a transcript, read from its tail: a window that doubles until it holds
 * one or reaches the start of the file. `undefined` when the transcript has none.
 */
export async function lastMessageTime(jsonlPath: string, size: number): Promise<Date | undefined> {
  if (size === 0) return undefined;
  const handle = await open(jsonlPath, "r");

  try {
    let window = Math.min(TAIL_WINDOW_BYTES, size);

    for (;;) {
      const start = size - window;
      const buffer = Buffer.alloc(window);
      const { bytesRead } = await handle.read(buffer, 0, window, start);
      const found = lastTimestampIn(buffer.subarray(0, bytesRead).toString("utf-8"));

      if (found !== undefined) return found;

      if (start === 0) return undefined;
      window = Math.min(window * 2, size);
    }
  } finally {
    await handle.close();
  }
}

export async function discoverSessions(projectDir: string): Promise<SessionInfo[]> {
  const entries = await readdir(projectDir, { withFileTypes: true });
  const sessionMap = new Map<string, SessionInfo>();

  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;

    // JSONL files
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const sessionId = entry.name.replace(/\.jsonl$/u, "");

      if (!isSessionUuid(sessionId)) continue;

      const filePath = join(projectDir, entry.name);
      const fileStat = await stat(filePath);
      const existing = sessionMap.get(sessionId);

      if (existing) {
        existing.jsonlPath = filePath;
        existing.sizeBytes = fileStat.size;
        existing.mtime = fileStat.mtime;
      } else {
        sessionMap.set(sessionId, {
          sessionId,
          jsonlPath: filePath,
          mtime: fileStat.mtime,
          lastActivity: fileStat.mtime,
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
          lastActivity: dirStat.mtime,
          sizeBytes: 0,
        });
      }
    }
  }

  const sessions = Array.from(sessionMap.values());

  for (const session of sessions) {
    if (session.jsonlPath === undefined) continue;
    session.lastActivity =
      (await lastMessageTime(session.jsonlPath, session.sizeBytes)) ?? session.mtime;
  }

  return sessions;
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
        const projectIdx = target.indexOf(projectName);

        if (projectIdx === -1) continue;
        const afterProject = target.slice(projectIdx + projectName.length + 1);
        const uuid = afterProject.split("/")[0];

        if (uuid !== undefined && isSessionUuid(uuid)) {
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

interface FileState {
  ino: number;
  size: number;
  mtimeMs: number;
}

async function fileState(path: string): Promise<FileState> {
  const { ino, size, mtimeMs } = await stat(path);

  return { ino, size, mtimeMs };
}

function sameState(a: FileState, b: FileState): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** The vault's copy of a session: same project directory name, same file name. */
function vaultCopyPath(vaultRoot: string, projectDir: string, sessionId: string): string {
  return join(vaultRoot, basename(projectDir), `${sessionId}.jsonl`);
}

/** Throws unless `vaultCopy` holds exactly `data`, compared by sha256. */
export async function checkVaultCopy(vaultCopy: string, data: Uint8Array): Promise<void> {
  let copy: Uint8Array;

  try {
    copy = new Uint8Array(await readFile(vaultCopy));
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) throw new Error(`no vault copy at ${vaultCopy}`, { cause });
    throw cause;
  }

  if (copy.byteLength !== data.byteLength || sha256(copy) !== sha256(data)) {
    throw new Error(`the vault copy at ${vaultCopy} differs from the transcript`);
  }
}

/** The dry-run's cheap stand-in for `checkVaultCopy`: existence and size, no hash. */
async function checkVaultCopySize(vaultCopy: string, size: number): Promise<void> {
  let copySize: number;

  try {
    copySize = (await stat(vaultCopy)).size;
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) throw new Error(`no vault copy at ${vaultCopy}`, { cause });
    throw cause;
  }

  if (copySize !== size) {
    throw new Error(`the vault copy at ${vaultCopy} has another size than the transcript`);
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * `writeAtomic` with fsync: the data is synced to a scratch file beside `file` before the rename,
 * and the directory after it, so a power loss leaves the old file or the whole new one.
 */
async function writeDurable(file: string, data: Uint8Array): Promise<void> {
  const scratch = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    const handle = await open(scratch, "wx");

    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(scratch, file);
  } catch (cause) {
    await rm(scratch, { force: true });
    throw cause;
  }

  await syncDirectory(dirname(file));
}

/** Throws unless the `.zst` on disk decompresses to exactly `expected`. */
async function verifyArchive(zstPath: string, expected: Uint8Array): Promise<void> {
  const onDisk = new Uint8Array(await readFile(zstPath));
  let restored: Uint8Array;

  try {
    restored = Bun.zstdDecompressSync(onDisk);
  } catch (cause) {
    throw new Error(`${zstPath} does not decompress`, { cause });
  }

  const same = Buffer.from(restored.buffer, restored.byteOffset, restored.byteLength).equals(
    Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
  );

  if (!same) throw new Error(`${zstPath} does not restore the transcript's bytes`);
}

/** Test seams into the archive of one transcript, at the two points a check must catch a fault. */
export interface ArchiveSeams {
  /** Runs once the `.zst` is synced to disk, before it is read back. */
  readonly afterWrite?: (zstPath: string) => Promise<void>;
  /** Runs once the `.zst` is verified, before the original's state is compared a last time. */
  readonly beforeDelete?: (jsonlPath: string) => Promise<void>;
}

export interface CompressOptions {
  /** Deletes the original once verified, provided this vault copy holds its bytes. Absent: the original stays. */
  readonly deleteWithVaultCopy?: string | undefined;
  readonly seams?: ArchiveSeams | undefined;
}

/**
 * Compresses `jsonlPath` to `archivePath`, synced and read back. The original is deleted only
 * with `deleteWithVaultCopy`, once the vault copy matched its bytes, the `.zst` restored them, and
 * the original kept its inode, size and mtime since it was read. Any failure removes the `.zst`
 * and keeps the original.
 */
export async function compressSession(
  jsonlPath: string,
  archivePath: string,
  options: CompressOptions = {},
): Promise<number> {
  const read = await fileState(jsonlPath);
  const data = new Uint8Array(await readFile(jsonlPath));

  if (!sameState(read, await fileState(jsonlPath))) {
    throw new Error(`${jsonlPath} changed while it was read`);
  }

  const vaultCopy = options.deleteWithVaultCopy;

  if (vaultCopy !== undefined) await checkVaultCopy(vaultCopy, data);
  const compressed = Bun.zstdCompressSync(data);

  try {
    await writeDurable(archivePath, compressed);
    await options.seams?.afterWrite?.(archivePath);
    await verifyArchive(archivePath, data);

    if (vaultCopy !== undefined) {
      await options.seams?.beforeDelete?.(jsonlPath);

      if (!sameState(read, await fileState(jsonlPath))) {
        throw new Error(`${jsonlPath} changed since it was read`);
      }

      await unlink(jsonlPath);
    }
  } catch (cause) {
    await rm(archivePath, { force: true });
    throw cause;
  }

  return compressed.byteLength;
}

export interface ArchiveSessionOptions {
  readonly dryRun: boolean;
  readonly copy: boolean;
  readonly verbose: boolean;
  readonly vaultRoot: string;
  readonly seams?: ArchiveSeams | undefined;
}

/** Archives one session of `projectDir` into its `archive/`; throws, leaving the original, on any failed check. */
export async function archiveSession(
  session: SessionInfo,
  projectDir: string,
  options: ArchiveSessionOptions,
): Promise<ArchiveEntry> {
  const { dryRun, copy, verbose } = options;
  const archiveDir = join(projectDir, "archive");
  const vaultCopy = vaultCopyPath(options.vaultRoot, projectDir, session.sessionId);

  const entry: ArchiveEntry = {
    sessionId: session.sessionId,
    archivedAt: new Date().toISOString(),
    originalMtime: session.mtime.toISOString(),
    sizeBytes: session.sizeBytes,
    compressedSizeBytes: 0,
    hasDirectory: !!session.dirPath,
    hasJsonl: !!session.jsonlPath,
    format: "zstd",
  };

  if (dryRun) {
    const vaultChecked = !copy && session.jsonlPath !== undefined && session.sizeBytes > 0;

    if (vaultChecked) await checkVaultCopySize(vaultCopy, session.sizeBytes);

    if (verbose) {
      const parts: string[] = [];

      if (session.jsonlPath) parts.push(`${formatBytes(session.sizeBytes)} JSONL`);

      if (session.dirPath) parts.push("+ dir");
      parts.push(`last activity ${session.lastActivity.toISOString()}`);

      if (vaultChecked) parts.push("vault copy of the same size");
      log(`  [dry-run] Would archive ${session.sessionId} (${parts.join(", ")})`);
    }

    return entry;
  }

  await mkdir(archiveDir, { recursive: true });

  // Compress or move JSONL
  if (session.jsonlPath) {
    if (session.sizeBytes > 0) {
      const archivePath = join(archiveDir, `${session.sessionId}.jsonl.zst`);

      entry.compressedSizeBytes = await compressSession(session.jsonlPath, archivePath, {
        deleteWithVaultCopy: copy ? undefined : vaultCopy,
        seams: options.seams,
      });

      if (verbose) {
        const ratio = ((entry.compressedSizeBytes / session.sizeBytes) * 100).toFixed(1);
        log(
          `  Compressed ${session.sessionId}.jsonl (${formatBytes(session.sizeBytes)} -> ${formatBytes(entry.compressedSizeBytes)}, ${ratio}%)`,
        );
      }
    } else {
      // Empty file: move or copy
      const archivePath = join(archiveDir, `${session.sessionId}.jsonl`);

      if (copy) {
        await writeAtomic(archivePath, "");
      } else {
        await rename(session.jsonlPath, archivePath);
      }

      if (verbose) {
        const verb = copy ? "Copied" : "Moved";
        log(`  ${verb} ${session.sessionId}.jsonl (empty)`);
      }
    }
  }

  // Move or copy session directory
  if (session.dirPath) {
    const archiveDirPath = join(archiveDir, session.sessionId);

    if (copy) {
      await cp(session.dirPath, archiveDirPath, { recursive: true });
    } else {
      await rename(session.dirPath, archiveDirPath);
    }

    if (verbose) {
      const verb = copy ? "Copied" : "Moved";
      log(`  ${verb} ${session.sessionId}/ directory`);
    }
  }

  return entry;
}

export async function loadArchiveIndex(archiveDir: string): Promise<ArchiveIndex> {
  const indexPath = join(archiveDir, "sessions-index.json");

  try {
    const parsed = await Bun.file(indexPath).json();

    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, entries: [] };
    }

    parsed.entries = parsed.entries.filter(
      (e: ArchiveEntry) => e.sessionId && isSessionUuid(e.sessionId),
    );

    // SAFETY: `version === 1` and `Array.isArray(entries)` are checked above,
    // and every entry passed isSessionUuid on its sessionId.
    return parsed as ArchiveIndex;
  } catch {
    return { version: 1, entries: [] };
  }
}

export async function saveArchiveIndex(archiveDir: string, index: ArchiveIndex): Promise<void> {
  const indexPath = join(archiveDir, "sessions-index.json");
  await writeAtomic(indexPath, JSON.stringify(index, null, 2) + "\n", { mkdir: true });
}

export async function unarchiveSession(uuid: string, projectDir: string): Promise<void> {
  const archiveDir = join(projectDir, "archive");
  const index = await loadArchiveIndex(archiveDir);

  const entryIdx = index.entries.findIndex((e) => e.sessionId === uuid);
  const entry = index.entries[entryIdx];

  if (entry === undefined) {
    console.error(`Session ${uuid} not found in archive`);
    process.exit(1);
  }

  // Restore JSONL — handle both gzip (new) and zstd (legacy)
  if (entry.hasJsonl) {
    const gzPath = join(archiveDir, `${uuid}.jsonl.gz`);
    const zstPath = join(archiveDir, `${uuid}.jsonl.zst`);
    const emptyPath = join(archiveDir, `${uuid}.jsonl`);
    const targetPath = join(projectDir, `${uuid}.jsonl`);

    if (existsSync(zstPath)) {
      const compressed = await Bun.file(zstPath).arrayBuffer();
      const decompressed = Bun.zstdDecompressSync(new Uint8Array(compressed));
      await writeAtomic(targetPath, decompressed);
      await unlink(zstPath);
      log(`Restored ${uuid}.jsonl (${formatBytes(entry.sizeBytes)})`);
    } else if (existsSync(gzPath)) {
      const compressed = await Bun.file(gzPath).arrayBuffer();
      const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
      await writeAtomic(targetPath, decompressed);
      await unlink(gzPath);
      log(`Restored ${uuid}.jsonl (${formatBytes(entry.sizeBytes)}, gzip)`);
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

interface ProjectScan {
  projectDir: string;
  sessionCount: number;
  activeCount: number;
  index: ArchiveIndex;
  candidates: SessionInfo[];
}

async function scanProject(
  projectDir: string,
  cutoffDate: Date,
  protectedIds: Set<string>,
): Promise<ProjectScan> {
  const sessions = await discoverSessions(projectDir);
  const activeIds = await getActiveSessionIds(projectDir);

  // Load existing archive index to skip already-archived sessions
  const index = await loadArchiveIndex(join(projectDir, "archive"));
  const alreadyArchived = new Set(index.entries.map((e) => e.sessionId));
  const allProtected = new Set([...protectedIds, ...activeIds]);

  const candidates = sessions.filter(
    (s) => shouldArchive(s, cutoffDate, allProtected) && !alreadyArchived.has(s.sessionId),
  );

  return {
    projectDir,
    sessionCount: sessions.length,
    activeCount: activeIds.size,
    index,
    candidates,
  };
}

/**
 * Archives the eligible sessions of every project in `projectDirs`, oldest last activity first,
 * at most `options.max` in all (0: no limit). A session that fails a check stays in place, out of
 * the index, and is reported.
 */
export async function archiveProjects(
  projectDirs: string[],
  options: Options,
  protectedIds: Set<string>,
  seams?: ArchiveSeams,
): Promise<{ archived: number; skipped: number; errors: number }> {
  const cutoffDate = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
  const scans: ProjectScan[] = [];
  let sessionCount = 0;
  let errors = 0;

  for (const projectDir of projectDirs) {
    try {
      const scan = await scanProject(projectDir, cutoffDate, protectedIds);
      scans.push(scan);
      sessionCount += scan.sessionCount;
    } catch (err) {
      reportError(`session-archive: cannot scan ${projectDir}: ${messageOf(err)}`);
      errors++;
    }
  }

  const ordered = scans
    .flatMap((scan) => scan.candidates.map((session) => ({ scan, session })))
    .toSorted((a, b) => a.session.lastActivity.getTime() - b.session.lastActivity.getTime());

  const limited = options.max > 0 ? ordered.slice(0, options.max) : ordered;
  let archived = 0;

  for (const scan of scans) {
    const chosen = limited.filter((c) => c.scan === scan).map((c) => c.session);

    if (chosen.length === 0) continue;

    if (options.verbose || options.dryRun) {
      log(
        `\n${basename(scan.projectDir)}: ${chosen.length} session(s) to archive (${scan.sessionCount - chosen.length} kept)`,
      );

      if (scan.activeCount > 0) {
        log(`  Active sessions protected: ${scan.activeCount}`);
      }
    }

    let projectArchived = 0;

    for (const session of chosen) {
      try {
        const entry = await archiveSession(session, scan.projectDir, {
          dryRun: options.dryRun,
          copy: options.copy,
          verbose: options.verbose,
          vaultRoot: options.vaultRoot,
          seams,
        });

        if (!options.dryRun) {
          scan.index.entries.push(entry);
        }

        projectArchived++;
      } catch (err) {
        reportError(
          `session-archive: kept ${join(scan.projectDir, session.sessionId)}: ${messageOf(err)}`,
        );
        errors++;
      }
    }

    if (!options.dryRun && projectArchived > 0) {
      await saveArchiveIndex(join(scan.projectDir, "archive"), scan.index);
    }

    archived += projectArchived;
  }

  return { archived, skipped: sessionCount - archived, errors };
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
    const fmt = entry.format ?? "zstd";
    log(`  ${entry.sessionId}  ${parts.join("  ")}  [${fmt}]`);
  }
}

async function showStats(
  projectDir: string,
): Promise<{ totalOriginal: number; totalCompressed: number; count: number }> {
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

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);

  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function listProjectDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });

  return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
}

async function getProjectDirs(options: Options): Promise<string[]> {
  if (options.project) {
    return [options.project.replace(/\/$/u, "")];
  }

  if (!existsSync(CLAUDE_DIR)) {
    console.error(`Claude projects directory not found: ${CLAUDE_DIR}`);
    process.exit(1);
  }

  return await listProjectDirs(CLAUDE_DIR);
}

/**
 * The projects root of the session that started the hook (the transcript's grandparent), when it
 * is the main profile's `~/.claude/projects` once both are resolved; `undefined` otherwise, for
 * another profile such as `~/.claudex`, whose sessions this tool must never touch.
 */
export async function mainProjectsRoot(
  transcriptPath: string | undefined,
  mainRoot = CLAUDE_DIR,
): Promise<string | undefined> {
  if (!transcriptPath) return undefined;

  try {
    const [root, main] = await Promise.all([
      realpath(dirname(dirname(transcriptPath))),
      realpath(mainRoot),
    ]);

    return root === main ? root : undefined;
  } catch (cause) {
    if (isErrno(cause, "ENOENT", "ENOTDIR")) return undefined;
    throw cause;
  }
}

// === Hook Mode ===

interface HookInput {
  session_id?: string;
  transcript_path?: string;
}

async function runHookMode(): Promise<void> {
  useStderrLog();

  // Read stdin payload (fast — small JSON)
  let input: HookInput = {};

  if (!process.stdin.isTTY) {
    try {
      const stdinText = await Bun.stdin.text();
      input = JSON.parse(stdinText);
    } catch {
      // Invalid stdin
    }
  }

  // Return immediately — Claude Code session unblocked
  console.log(JSON.stringify({ suppressOutput: true }));

  // Fork heavy work to a detached background process
  const payload = Buffer.from(JSON.stringify(input)).toString("base64");
  const scriptPath = new URL(import.meta.url).pathname;
  Bun.spawn(["bun", scriptPath, "--background-worker", payload], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  }).unref();
}

function isThrottled(): boolean {
  try {
    if (!existsSync(MARKER_PATH)) return false;
    const raw = readFileSync(MARKER_PATH, "utf-8");
    const marker = JSON.parse(raw);
    const lastRun = new Date(marker.lastRunAt).getTime();

    if (Number.isNaN(lastRun)) return false;

    return Date.now() - lastRun < THROTTLE_MS;
  } catch {
    return false;
  }
}

async function writeMarker(archived: number): Promise<void> {
  const marker = { lastRunAt: new Date().toISOString(), archived };
  await writeAtomic(MARKER_PATH, JSON.stringify(marker) + "\n");
}

async function runBackgroundWorker(options: Options): Promise<void> {
  useStderrLog();

  // Decode hook input from base64 arg
  let input: HookInput = {};

  try {
    const raw = Buffer.from(options.backgroundWorker!, "base64").toString("utf-8");
    input = JSON.parse(raw);
  } catch {
    // Corrupt payload: no transcript_path, so the profile check below does nothing
  }

  // Not the main profile: no read, no write, not even the throttle marker
  const root = await mainProjectsRoot(input.transcript_path);

  if (root === undefined) return;
  useErrorLogFile(ERROR_LOG_PATH);

  // Throttle — skip if ran recently
  if (isThrottled()) return;

  // Acquire lock — if we can't, another instance is running, bail
  const lockfile = DEFAULT_LOCKFILE;
  const locked = await acquireLock(lockfile, 5_000);

  if (!locked) return;

  let totalArchived = 0;

  try {
    const protectedIds = new Set<string>();

    if (input.session_id) {
      protectedIds.add(input.session_id);
    }

    // In background mode, default max to 20 if not explicitly set
    if (options.max === 0) {
      options.max = HOOK_MAX_DEFAULT;
    }

    const result = await archiveProjects(await listProjectDirs(root), options, protectedIds);
    totalArchived = result.archived;
  } catch (err) {
    reportError(`session-archive: background pass failed: ${messageOf(err)}`);
  } finally {
    await releaseLock(lockfile);
  }

  await writeMarker(totalArchived);
}

// === CLI Entry ===

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));

    // Hook mode — fork to background, exit immediately
    if (options.hook) {
      await runHookMode();
      process.exit(0);
    }

    // Background worker — spawned by hook mode, runs detached
    if (options.backgroundWorker) {
      await runBackgroundWorker(options);
      process.exit(0);
    }

    // Unarchive mode
    if (options.unarchive) {
      if (!isSessionUuid(options.unarchive)) {
        console.error("--unarchive requires a valid session UUID");
        process.exit(1);
      }

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

          const ratio =
            s.totalOriginal > 0
              ? ((1 - s.totalCompressed / s.totalOriginal) * 100).toFixed(1)
              : "0";

          log(
            `${basename(dir)}: ${s.count} sessions, ${formatBytes(s.totalOriginal)} -> ${formatBytes(s.totalCompressed)} (${ratio}% saved)`,
          );
        }
      }

      if (grandCount > 0) {
        const grandRatio =
          grandTotal > 0 ? ((1 - grandCompressed / grandTotal) * 100).toFixed(1) : "0";

        log(
          `\nTotal: ${grandCount} sessions, ${formatBytes(grandTotal)} -> ${formatBytes(grandCompressed)} (${grandRatio}% saved)`,
        );
      } else {
        log("No archived sessions found.");
      }

      process.exit(0);
    }

    // Default: archive mode
    const result = await archiveProjects(dirs, options, new Set());

    if (options.verbose || options.dryRun) {
      log(
        `\nDone: ${result.archived} archived, ${result.skipped} skipped, ${result.errors} errors`,
      );
    }
  } catch (err) {
    // Top-level safety net — never crash the hook
    console.error(`session-archive fatal: ${err}`);
    process.exit(1);
  }
}
