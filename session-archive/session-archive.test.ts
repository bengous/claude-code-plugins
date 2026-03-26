import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";

import {
  parseArgs,
  isSessionUuid,
  shouldArchive,
  formatBytes,
  discoverSessions,
  compressSession,
  archiveSession,
  loadArchiveIndex,
  saveArchiveIndex,
  archiveProject,
  unarchiveSession,
  acquireLock,
  releaseLock,
} from "./session-archive";

// === Helpers ===

function tempDir(prefix: string): Disposable & { path: string } {
  const dir = mkdtempSync(join(tmpdir(), `sa-test-${prefix}-`));
  return {
    path: dir,
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const UUID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const UUID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const UUID_D = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const OLD_DATE = new Date("2024-01-01");
const JSONL_CONTENT = '{"type":"message","role":"user"}\n{"type":"message","role":"assistant"}\n';
const LARGE_JSONL = JSONL_CONTENT.repeat(500);

interface FakeProject {
  dir: string;
  uuids: { withJsonl: string; withJsonlAndDir: string; withDir: string };
}

async function createFakeProject(baseDir: string): Promise<FakeProject> {
  const dir = join(baseDir, "project");
  mkdirSync(dir, { recursive: true });

  // UUID_A: JSONL only
  await Bun.write(join(dir, `${UUID_A}.jsonl`), JSONL_CONTENT);

  // UUID_B: JSONL + directory
  await Bun.write(join(dir, `${UUID_B}.jsonl`), LARGE_JSONL);
  mkdirSync(join(dir, UUID_B), { recursive: true });
  await Bun.write(join(dir, UUID_B, "subagent.jsonl"), "sub-data");

  // UUID_C: directory only
  mkdirSync(join(dir, UUID_C), { recursive: true });
  await Bun.write(join(dir, UUID_C, "task.json"), '{"task":1}');

  // Non-UUID file (should be ignored)
  await Bun.write(join(dir, "not-a-uuid.jsonl"), "ignored");

  // memory/ dir (should be skipped)
  mkdirSync(join(dir, "memory"), { recursive: true });
  await Bun.write(join(dir, "memory", "MEMORY.md"), "# Memory");

  // Backdate files so they pass the "recent" check
  const old = Math.floor(OLD_DATE.getTime() / 1000);
  const { utimesSync } = await import("node:fs");
  for (const name of [`${UUID_A}.jsonl`, `${UUID_B}.jsonl`, UUID_B, UUID_C]) {
    utimesSync(join(dir, name), old, old);
  }

  return {
    dir,
    uuids: { withJsonl: UUID_A, withJsonlAndDir: UUID_B, withDir: UUID_C },
  };
}

// === Unit Tests ===

describe("isSessionUuid", () => {
  test("valid full UUID returns true", () => {
    expect(isSessionUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  test("valid UUID with trailing content returns true (regex not end-anchored)", () => {
    expect(isSessionUuid("123e4567-e89b-12d3-a456-426614174000.jsonl")).toBe(
      true,
    );
  });

  test("returns false for non-UUID strings", () => {
    expect(isSessionUuid("memory")).toBe(false);
    expect(isSessionUuid("archive")).toBe(false);
    expect(isSessionUuid("")).toBe(false);
    expect(isSessionUuid("not-a-uuid")).toBe(false);
    expect(isSessionUuid("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe(false); // uppercase
  });
});

describe("parseArgs", () => {
  test("empty args returns defaults", () => {
    const opts = parseArgs([]);
    expect(opts.days).toBe(30);
    expect(opts.hook).toBe(false);
    expect(opts.max).toBe(0);
    expect(opts.copy).toBe(false);
    expect(opts.dryRun).toBe(false);
    expect(opts.verbose).toBe(false);
  });

  test("--hook sets hook and max defaults to 20", () => {
    const opts = parseArgs(["--hook"]);
    expect(opts.hook).toBe(true);
    expect(opts.max).toBe(20);
  });

  test("--days 14 sets days", () => {
    const opts = parseArgs(["--days", "14"]);
    expect(opts.days).toBe(14);
  });

  test("--copy sets copy", () => {
    const opts = parseArgs(["--copy"]);
    expect(opts.copy).toBe(true);
  });

  test("--max 50 sets max", () => {
    const opts = parseArgs(["--max", "50"]);
    expect(opts.max).toBe(50);
  });

  test("combined flags work together", () => {
    const opts = parseArgs(["--hook", "--copy", "--days", "7", "--verbose"]);
    expect(opts.hook).toBe(true);
    expect(opts.copy).toBe(true);
    expect(opts.days).toBe(7);
    expect(opts.verbose).toBe(true);
    expect(opts.max).toBe(20); // hook default
  });

  test("--hook with explicit --max overrides default", () => {
    const opts = parseArgs(["--hook", "--max", "5"]);
    expect(opts.hook).toBe(true);
    expect(opts.max).toBe(5);
  });
});

describe("shouldArchive", () => {
  const cutoff = new Date("2024-06-01");

  test("old session not protected returns true", () => {
    const session = {
      sessionId: UUID_A,
      mtime: OLD_DATE,
      sizeBytes: 100,
    };
    expect(shouldArchive(session, cutoff, new Set())).toBe(true);
  });

  test("protected session returns false", () => {
    const session = {
      sessionId: UUID_A,
      mtime: OLD_DATE,
      sizeBytes: 100,
    };
    expect(shouldArchive(session, cutoff, new Set([UUID_A]))).toBe(false);
  });

  test("recently modified session returns false", () => {
    const session = {
      sessionId: UUID_A,
      mtime: new Date(), // now
      sizeBytes: 100,
    };
    expect(shouldArchive(session, cutoff, new Set())).toBe(false);
  });

  test("session newer than cutoff returns false", () => {
    const session = {
      sessionId: UUID_A,
      mtime: new Date("2024-07-01"), // after cutoff
      sizeBytes: 100,
    };
    expect(shouldArchive(session, cutoff, new Set())).toBe(false);
  });
});

describe("formatBytes", () => {
  test("0 bytes", () => expect(formatBytes(0)).toBe("0 B"));
  test("512 bytes", () => expect(formatBytes(512)).toBe("512 B"));
  test("1 KB", () => expect(formatBytes(1024)).toBe("1.0 KB"));
  test("1 MB", () => expect(formatBytes(1048576)).toBe("1.0 MB"));
  test("1 GB", () => expect(formatBytes(1073741824)).toBe("1.0 GB"));
});

// === Integration Tests ===

describe("discoverSessions", () => {
  test("discovers JSONL files and UUID directories", async () => {
    using tmp = tempDir("discover");
    const { dir, uuids } = await createFakeProject(tmp.path);

    const sessions = await discoverSessions(dir);
    const ids = sessions.map((s) => s.sessionId).sort();

    expect(ids).toContain(uuids.withJsonl);
    expect(ids).toContain(uuids.withJsonlAndDir);
    expect(ids).toContain(uuids.withDir);
  });

  test("merges JSONL and dir for same session", async () => {
    using tmp = tempDir("merge");
    const { dir, uuids } = await createFakeProject(tmp.path);

    const sessions = await discoverSessions(dir);
    const merged = sessions.find(
      (s) => s.sessionId === uuids.withJsonlAndDir,
    );

    expect(merged).toBeDefined();
    expect(merged!.jsonlPath).toBeDefined();
    expect(merged!.dirPath).toBeDefined();
  });

  test("skips memory, archive, non-UUID files", async () => {
    using tmp = tempDir("skip");
    const { dir } = await createFakeProject(tmp.path);

    const sessions = await discoverSessions(dir);
    const ids = sessions.map((s) => s.sessionId);

    expect(ids).not.toContain("memory");
    expect(ids).not.toContain("not-a-uuid");
  });
});

describe("compressSession", () => {
  test("compresses and returns size, deletes original", async () => {
    using tmp = tempDir("compress");
    const src = join(tmp.path, "test.jsonl");
    const dst = join(tmp.path, "test.jsonl.gz");
    await Bun.write(src, LARGE_JSONL);

    const compressedSize = await compressSession(src, dst, false);

    expect(compressedSize).toBeGreaterThan(0);
    expect(compressedSize).toBeLessThan(LARGE_JSONL.length);
    expect(existsSync(dst)).toBe(true);
    expect(existsSync(src)).toBe(false); // deleted
  });

  test("keepOriginal=true preserves source", async () => {
    using tmp = tempDir("keep");
    const src = join(tmp.path, "test.jsonl");
    const dst = join(tmp.path, "test.jsonl.gz");
    await Bun.write(src, LARGE_JSONL);

    await compressSession(src, dst, true);

    expect(existsSync(src)).toBe(true);
    expect(existsSync(dst)).toBe(true);
  });

  test("roundtrip: decompress matches original", async () => {
    using tmp = tempDir("roundtrip");
    const src = join(tmp.path, "test.jsonl");
    const dst = join(tmp.path, "test.jsonl.gz");
    await Bun.write(src, JSONL_CONTENT);

    await compressSession(src, dst, false);

    const compressed = await Bun.file(dst).arrayBuffer();
    const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
    expect(new TextDecoder().decode(decompressed)).toBe(JSONL_CONTENT);
  });
});

describe("archiveSession", () => {
  test("move mode: compresses JSONL, moves dir, originals gone", async () => {
    using tmp = tempDir("archive-move");
    const { dir, uuids } = await createFakeProject(tmp.path);
    const sessions = await discoverSessions(dir);
    const session = sessions.find(
      (s) => s.sessionId === uuids.withJsonlAndDir,
    )!;
    const archiveDir = join(dir, "archive");

    const entry = await archiveSession(session, archiveDir, false, false, false);

    expect(entry.format).toBe("gzip");
    expect(entry.compressedSizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(archiveDir, `${UUID_B}.jsonl.gz`))).toBe(true);
    expect(existsSync(join(archiveDir, UUID_B, "subagent.jsonl"))).toBe(true);
    // originals gone
    expect(existsSync(join(dir, `${UUID_B}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, UUID_B))).toBe(false);
  });

  test("copy mode: originals still present", async () => {
    using tmp = tempDir("archive-copy");
    const { dir, uuids } = await createFakeProject(tmp.path);
    const sessions = await discoverSessions(dir);
    const session = sessions.find(
      (s) => s.sessionId === uuids.withJsonlAndDir,
    )!;
    const archiveDir = join(dir, "archive");

    await archiveSession(session, archiveDir, false, true, false);

    // archive exists
    expect(existsSync(join(archiveDir, `${UUID_B}.jsonl.gz`))).toBe(true);
    // originals still present
    expect(existsSync(join(dir, `${UUID_B}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, UUID_B))).toBe(true);
  });

  test("dry-run: no files created", async () => {
    using tmp = tempDir("archive-dry");
    const { dir, uuids } = await createFakeProject(tmp.path);
    const sessions = await discoverSessions(dir);
    const session = sessions.find((s) => s.sessionId === uuids.withJsonl)!;
    const archiveDir = join(dir, "archive");

    const entry = await archiveSession(session, archiveDir, true, false, false);

    expect(entry.sessionId).toBe(UUID_A);
    expect(existsSync(archiveDir)).toBe(false);
  });

  test("empty JSONL: moved as-is without compression", async () => {
    using tmp = tempDir("archive-empty");
    const dir = join(tmp.path, "project");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, `${UUID_D}.jsonl`), "");
    const archiveDir = join(dir, "archive");

    const session = {
      sessionId: UUID_D,
      jsonlPath: join(dir, `${UUID_D}.jsonl`),
      mtime: OLD_DATE,
      sizeBytes: 0,
    };

    const entry = await archiveSession(session, archiveDir, false, false, false);

    expect(existsSync(join(archiveDir, `${UUID_D}.jsonl`))).toBe(true);
    expect(existsSync(join(archiveDir, `${UUID_D}.jsonl.gz`))).toBe(false);
    expect(entry.compressedSizeBytes).toBe(0);
  });
});

describe("loadArchiveIndex / saveArchiveIndex", () => {
  test("returns empty index when file does not exist", async () => {
    using tmp = tempDir("index-missing");
    const index = await loadArchiveIndex(join(tmp.path, "nonexistent"));
    expect(index.version).toBe(1);
    expect(index.entries).toEqual([]);
  });

  test("returns empty index on invalid JSON", async () => {
    using tmp = tempDir("index-invalid");
    mkdirSync(tmp.path, { recursive: true });
    await Bun.write(join(tmp.path, "sessions-index.json"), "not json");

    const index = await loadArchiveIndex(tmp.path);
    expect(index.entries).toEqual([]);
  });

  test("roundtrip: save then load preserves entries", async () => {
    using tmp = tempDir("index-roundtrip");
    mkdirSync(tmp.path, { recursive: true });

    const original = {
      version: 1 as const,
      entries: [
        {
          sessionId: UUID_A,
          archivedAt: "2024-06-01T00:00:00.000Z",
          originalMtime: "2024-01-01T00:00:00.000Z",
          sizeBytes: 1000,
          compressedSizeBytes: 200,
          hasDirectory: false,
          hasJsonl: true,
          format: "gzip" as const,
        },
      ],
    };

    await saveArchiveIndex(tmp.path, original);
    const loaded = await loadArchiveIndex(tmp.path);

    expect(loaded.entries.length).toBe(1);
    expect(loaded.entries[0].sessionId).toBe(UUID_A);
    expect(loaded.entries[0].sizeBytes).toBe(1000);
  });

  test("filters out entries with invalid session IDs", async () => {
    using tmp = tempDir("index-filter");
    mkdirSync(tmp.path, { recursive: true });
    await Bun.write(
      join(tmp.path, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [
          { sessionId: UUID_A, sizeBytes: 100 },
          { sessionId: "bad-id", sizeBytes: 50 },
        ],
      }),
    );

    const index = await loadArchiveIndex(tmp.path);
    expect(index.entries.length).toBe(1);
    expect(index.entries[0].sessionId).toBe(UUID_A);
  });
});

describe("archiveProject", () => {
  function makeOptions(overrides: Partial<import("./session-archive").Options> = {}): import("./session-archive").Options {
    return {
      days: 0,
      dryRun: false,
      copy: false,
      list: false,
      stats: false,
      hook: false,
      max: 0,
      verbose: false,
      ...overrides,
    };
  }

  test("archives eligible sessions and updates index", async () => {
    using tmp = tempDir("project-archive");
    const { dir } = await createFakeProject(tmp.path);

    const result = await archiveProject(dir, makeOptions(), new Set());

    expect(result.archived).toBeGreaterThan(0);
    expect(result.errors).toBe(0);

    const index = await loadArchiveIndex(join(dir, "archive"));
    expect(index.entries.length).toBe(result.archived);
  });

  test("respects --max limit", async () => {
    using tmp = tempDir("project-max");
    const { dir } = await createFakeProject(tmp.path);

    const result = await archiveProject(dir, makeOptions({ max: 1 }), new Set());

    expect(result.archived).toBe(1);
  });

  test("dedup: running twice with --copy does not create duplicate entries", async () => {
    using tmp = tempDir("project-dedup");
    const { dir } = await createFakeProject(tmp.path);
    const opts = makeOptions({ copy: true });

    const first = await archiveProject(dir, opts, new Set());
    const second = await archiveProject(dir, opts, new Set());

    expect(first.archived).toBeGreaterThan(0);
    expect(second.archived).toBe(0); // all already archived

    const index = await loadArchiveIndex(join(dir, "archive"));
    expect(index.entries.length).toBe(first.archived);
  });

  test("protects given session IDs", async () => {
    using tmp = tempDir("project-protect");
    const { dir, uuids } = await createFakeProject(tmp.path);

    const protectedIds = new Set([uuids.withJsonl, uuids.withJsonlAndDir]);
    const result = await archiveProject(dir, makeOptions(), protectedIds);

    const index = await loadArchiveIndex(join(dir, "archive"));
    const archivedIds = index.entries.map((e) => e.sessionId);
    expect(archivedIds).not.toContain(uuids.withJsonl);
    expect(archivedIds).not.toContain(uuids.withJsonlAndDir);
  });

  test("dry-run does not modify files", async () => {
    using tmp = tempDir("project-dry");
    const { dir } = await createFakeProject(tmp.path);

    await archiveProject(dir, makeOptions({ dryRun: true }), new Set());

    expect(existsSync(join(dir, "archive"))).toBe(false);
    expect(existsSync(join(dir, `${UUID_A}.jsonl`))).toBe(true);
  });
});

describe("unarchiveSession", () => {
  test("restores gzip-compressed session", async () => {
    using tmp = tempDir("unarchive-gz");
    const { dir, uuids } = await createFakeProject(tmp.path);

    // Archive first
    const sessions = await discoverSessions(dir);
    const session = sessions.find((s) => s.sessionId === uuids.withJsonl)!;
    const archiveDir = join(dir, "archive");
    const entry = await archiveSession(session, archiveDir, false, false, false);
    await saveArchiveIndex(archiveDir, { version: 1, entries: [entry] });

    // Original should be gone
    expect(existsSync(join(dir, `${UUID_A}.jsonl`))).toBe(false);

    // Unarchive
    await unarchiveSession(UUID_A, dir);

    // Restored
    expect(existsSync(join(dir, `${UUID_A}.jsonl`))).toBe(true);
    const content = await Bun.file(join(dir, `${UUID_A}.jsonl`)).text();
    expect(content).toBe(JSONL_CONTENT);

    // Index updated
    const index = await loadArchiveIndex(archiveDir);
    expect(index.entries.length).toBe(0);
  });

  test("restores empty session", async () => {
    using tmp = tempDir("unarchive-empty");
    const dir = join(tmp.path, "project");
    mkdirSync(dir, { recursive: true });
    const archiveDir = join(dir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    // Create an empty archived file
    await Bun.write(join(archiveDir, `${UUID_D}.jsonl`), "");
    await saveArchiveIndex(archiveDir, {
      version: 1,
      entries: [
        {
          sessionId: UUID_D,
          archivedAt: new Date().toISOString(),
          originalMtime: OLD_DATE.toISOString(),
          sizeBytes: 0,
          compressedSizeBytes: 0,
          hasDirectory: false,
          hasJsonl: true,
        },
      ],
    });

    await unarchiveSession(UUID_D, dir);

    expect(existsSync(join(dir, `${UUID_D}.jsonl`))).toBe(true);
  });
});

// === Lockfile Tests ===

describe("acquireLock / releaseLock", () => {
  test("acquire succeeds and release cleans up", async () => {
    using tmp = tempDir("lock");
    const lockfile = join(tmp.path, "test.lock");

    const acquired = await acquireLock(lockfile, 1_000);
    expect(acquired).toBe(true);
    expect(existsSync(lockfile)).toBe(true);

    await releaseLock(lockfile);
    expect(existsSync(lockfile)).toBe(false);
  });

  test("stale lock from dead PID gets cleaned up", async () => {
    using tmp = tempDir("lock-stale");
    const lockfile = join(tmp.path, "test.lock");

    // Write a lock with a PID that doesn't exist (99999999)
    await writeFile(lockfile, "99999999");

    const acquired = await acquireLock(lockfile, 2_000);
    expect(acquired).toBe(true);

    await releaseLock(lockfile);
  });
});

// === Subprocess: Hook Mode ===

describe("hook mode (subprocess)", () => {
  test("outputs suppressOutput JSON and exits 0", async () => {
    using tmp = tempDir("hook");
    const { dir } = await createFakeProject(tmp.path);
    const scriptPath = join(import.meta.dir, "session-archive.ts");

    const proc = Bun.spawn({
      cmd: ["bun", scriptPath, "--hook", "--project", dir],
      stdin: new Blob([JSON.stringify({ session_id: UUID_A })]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('{"suppressOutput":true}');
  });

  test("exits 0 even with empty stdin", async () => {
    using tmp = tempDir("hook-empty");
    const { dir } = await createFakeProject(tmp.path);
    const scriptPath = join(import.meta.dir, "session-archive.ts");

    const proc = Bun.spawn({
      cmd: ["bun", scriptPath, "--hook", "--project", dir],
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
