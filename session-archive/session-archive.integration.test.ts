import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  archiveProjects,
  unarchiveSession,
  acquireLock,
  releaseLock,
  lastMessageTime,
  lastTimestampIn,
  mainProjectsRoot,
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

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function setMtime(path: string, date: Date): void {
  const seconds = Math.floor(date.getTime() / 1000);
  utimesSync(path, seconds, seconds);
}

function messageLine(date: Date): string {
  return `${JSON.stringify({ type: "user", timestamp: date.toISOString(), message: { role: "user" } })}\n`;
}

interface FakeProject {
  dir: string;
  /** The vault root, holding a copy of each transcript under `project/`. */
  vault: string;
  uuids: { withJsonl: string; withJsonlAndDir: string; withDir: string };
}

async function writeVaultCopy(vault: string, project: string, uuid: string, data: string) {
  mkdirSync(join(vault, project), { recursive: true });
  await Bun.write(join(vault, project, `${uuid}.jsonl`), data);
}

async function createFakeProject(baseDir: string): Promise<FakeProject> {
  const dir = join(baseDir, "project");
  const vault = join(baseDir, "vault");
  mkdirSync(dir, { recursive: true });

  // UUID_A: JSONL only
  await Bun.write(join(dir, `${UUID_A}.jsonl`), JSONL_CONTENT);
  await writeVaultCopy(vault, "project", UUID_A, JSONL_CONTENT);

  // UUID_B: JSONL + directory
  await Bun.write(join(dir, `${UUID_B}.jsonl`), LARGE_JSONL);
  await writeVaultCopy(vault, "project", UUID_B, LARGE_JSONL);
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
  for (const name of [`${UUID_A}.jsonl`, `${UUID_B}.jsonl`, UUID_B, UUID_C]) {
    setMtime(join(dir, name), OLD_DATE);
  }

  return {
    dir,
    vault,
    uuids: { withJsonl: UUID_A, withJsonlAndDir: UUID_B, withDir: UUID_C },
  };
}

async function projectWith(root: string, content: string, mtime: Date): Promise<string> {
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${UUID_A}.jsonl`);
  await Bun.write(file, content);
  setMtime(file, mtime);

  return dir;
}

/** A transcript, its `.zst` destination and its vault copy, side by side in `root`. */
function files(root: string, content: string) {
  const src = join(root, "test.jsonl");
  const dst = join(root, "test.jsonl.zst");
  const vaultCopy = join(root, "vault-test.jsonl");

  return {
    src,
    dst,
    vaultCopy,
    async write() {
      await Bun.write(src, content);
      await Bun.write(vaultCopy, content);
    },
  };
}

function sessionOpts(vaultRoot: string, overrides: { dryRun?: boolean; copy?: boolean } = {}) {
  return { dryRun: false, copy: false, verbose: false, vaultRoot, ...overrides };
}

// === Unit Tests ===

describe("isSessionUuid", () => {
  test("valid full UUID returns true", () => {
    expect(isSessionUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  test("valid UUID with trailing content returns true (regex not end-anchored)", () => {
    expect(isSessionUuid("123e4567-e89b-12d3-a456-426614174000.jsonl")).toBe(true);
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
    expect(opts.days).toBe(90);
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

  // parseArgs exits the process on a bad value, so these run out of process.
  // An empty value must stay a rejection: read as 0 it would mean "archive
  // everything now" for --days and "no limit" for --max.
  test.each([
    ["--days", "--days requires a non-negative integer"],
    ["--max", "--max requires a non-negative integer"],
  ])("%s with an empty value exits 1", async (flag, message) => {
    const scriptPath = join(import.meta.dir, "session-archive.ts");

    const source = `import { parseArgs } from ${JSON.stringify(scriptPath)};
      parseArgs([${JSON.stringify(flag)}, ""]);`;

    const proc = Bun.spawn(["bun", "-e", source], { stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain(message);
  });
});

describe("shouldArchive", () => {
  const cutoff = new Date("2024-06-01");

  test("old session not protected returns true", () => {
    const session = {
      sessionId: UUID_A,
      mtime: OLD_DATE,
      lastActivity: OLD_DATE,
      sizeBytes: 100,
    };

    expect(shouldArchive(session, cutoff, new Set())).toBe(true);
  });

  test("protected session returns false", () => {
    const session = {
      sessionId: UUID_A,
      mtime: OLD_DATE,
      lastActivity: OLD_DATE,
      sizeBytes: 100,
    };

    expect(shouldArchive(session, cutoff, new Set([UUID_A]))).toBe(false);
  });

  test("recently modified session returns false, whatever its last message", () => {
    const session = {
      sessionId: UUID_A,
      mtime: new Date(), // now
      lastActivity: OLD_DATE,
      sizeBytes: 100,
    };

    expect(shouldArchive(session, cutoff, new Set())).toBe(false);
  });

  test("session with a message after the cutoff returns false", () => {
    const session = {
      sessionId: UUID_A,
      mtime: OLD_DATE,
      lastActivity: new Date("2024-07-01"), // after cutoff
      sizeBytes: 100,
    };

    expect(shouldArchive(session, cutoff, new Set())).toBe(false);
  });
});

describe("last message rule", () => {
  test("lastTimestampIn takes the last valid timestamp and ignores escaped ones", () => {
    const quoted = JSON.stringify({ text: '{"timestamp":"2099-01-01T00:00:00.000Z"}' });
    const text = `${messageLine(new Date("2024-01-01T00:00:00.000Z"))}${messageLine(new Date("2024-02-01T00:00:00.000Z"))}${quoted}\n`;

    expect(lastTimestampIn(text)?.toISOString()).toBe("2024-02-01T00:00:00.000Z");
    expect(lastTimestampIn('{"timestamp":"2024-13-45Tnot-a-date"}')).toBeUndefined();
    expect(lastTimestampIn("{}")).toBeUndefined();
  });

  test("lastMessageTime widens past a last line larger than its first window", async () => {
    using tmp = tempDir("tail-widen");
    const file = join(tmp.path, `${UUID_A}.jsonl`);
    const last = new Date("2024-03-01T00:00:00.000Z");
    const bigLine = `${JSON.stringify({ type: "summary", payload: "x".repeat(300_000) })}\n`;
    await Bun.write(file, `${messageLine(new Date("2024-01-01"))}${messageLine(last)}${bigLine}`);

    const found = await lastMessageTime(file, Bun.file(file).size);
    expect(found?.toISOString()).toBe(last.toISOString());
  });

  test("old mtime but a recent last timestamp is kept", async () => {
    using tmp = tempDir("rule-recent-message");
    const dir = await projectWith(tmp.path, messageLine(daysAgo(10)), daysAgo(200));

    const [session] = await discoverSessions(dir);
    expect(session?.lastActivity.getTime()).toBeGreaterThan(daysAgo(11).getTime());
    expect(shouldArchive(session!, daysAgo(90), new Set())).toBe(false);
  });

  test("recent mtime but a last timestamp older than 90 days is eligible", async () => {
    using tmp = tempDir("rule-old-message");

    const dir = await projectWith(
      tmp.path,
      `${messageLine(daysAgo(150))}${messageLine(daysAgo(120))}`,
      daysAgo(2),
    );

    const [session] = await discoverSessions(dir);
    expect(session?.lastActivity.getTime()).toBeLessThan(daysAgo(119).getTime());
    expect(shouldArchive(session!, daysAgo(90), new Set())).toBe(true);
  });

  test("a transcript without any timestamp falls back to its mtime", async () => {
    using tmp = tempDir("rule-no-timestamp");
    const oldDir = await projectWith(join(tmp.path, "old"), JSONL_CONTENT, daysAgo(100));
    const recentDir = await projectWith(join(tmp.path, "recent"), JSONL_CONTENT, daysAgo(80));

    const [old] = await discoverSessions(oldDir);
    const [recent] = await discoverSessions(recentDir);

    expect(shouldArchive(old!, daysAgo(90), new Set())).toBe(true);
    expect(shouldArchive(recent!, daysAgo(90), new Set())).toBe(false);
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
    const ids = sessions.map((s) => s.sessionId).toSorted();

    expect(ids).toContain(uuids.withJsonl);
    expect(ids).toContain(uuids.withJsonlAndDir);
    expect(ids).toContain(uuids.withDir);
  });

  test("merges JSONL and dir for same session", async () => {
    using tmp = tempDir("merge");
    const { dir, uuids } = await createFakeProject(tmp.path);

    const sessions = await discoverSessions(dir);
    const merged = sessions.find((s) => s.sessionId === uuids.withJsonlAndDir);

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
  test("compresses and returns size, deletes original once the vault copy matches", async () => {
    using tmp = tempDir("compress");
    const f = files(tmp.path, LARGE_JSONL);
    await f.write();

    const compressedSize = await compressSession(f.src, f.dst, {
      deleteWithVaultCopy: f.vaultCopy,
    });

    expect(compressedSize).toBeGreaterThan(0);
    expect(compressedSize).toBeLessThan(LARGE_JSONL.length);
    expect(existsSync(f.dst)).toBe(true);
    expect(existsSync(f.src)).toBe(false); // deleted
  });

  test("without a vault copy to check, the source is preserved", async () => {
    using tmp = tempDir("keep");
    const f = files(tmp.path, LARGE_JSONL);
    await Bun.write(f.src, LARGE_JSONL);

    await compressSession(f.src, f.dst);

    expect(existsSync(f.src)).toBe(true);
    expect(existsSync(f.dst)).toBe(true);
  });

  test("roundtrip: decompress matches original", async () => {
    using tmp = tempDir("roundtrip");
    const f = files(tmp.path, JSONL_CONTENT);
    await f.write();

    await compressSession(f.src, f.dst, { deleteWithVaultCopy: f.vaultCopy });

    const compressed = await Bun.file(f.dst).arrayBuffer();
    const decompressed = Bun.zstdDecompressSync(new Uint8Array(compressed));
    expect(new TextDecoder().decode(decompressed)).toBe(JSONL_CONTENT);
  });

  test("a .zst corrupted on disk before its read-back keeps the original and is removed", async () => {
    using tmp = tempDir("corrupt-zst");
    const f = files(tmp.path, LARGE_JSONL);
    await f.write();

    const run = compressSession(f.src, f.dst, {
      deleteWithVaultCopy: f.vaultCopy,
      seams: {
        afterWrite: async (zstPath) => {
          const bytes = new Uint8Array(await Bun.file(zstPath).arrayBuffer());
          await Bun.write(zstPath, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
        },
      },
    });

    await expect(run).rejects.toThrow("does not decompress");
    expect(await Bun.file(f.src).text()).toBe(LARGE_JSONL);
    expect(existsSync(f.dst)).toBe(false);
  });

  test("a .zst that decompresses to other bytes keeps the original", async () => {
    using tmp = tempDir("wrong-zst");
    const f = files(tmp.path, LARGE_JSONL);
    await f.write();

    const run = compressSession(f.src, f.dst, {
      deleteWithVaultCopy: f.vaultCopy,
      seams: {
        afterWrite: async (zstPath) => {
          await Bun.write(zstPath, Bun.zstdCompressSync(new TextEncoder().encode("other")));
        },
      },
    });

    await expect(run).rejects.toThrow("does not restore");
    expect(await Bun.file(f.src).text()).toBe(LARGE_JSONL);
    expect(existsSync(f.dst)).toBe(false);
  });

  test("an append between verification and deletion keeps the original", async () => {
    using tmp = tempDir("append");
    const f = files(tmp.path, LARGE_JSONL);
    await f.write();
    const appended = messageLine(new Date());

    const run = compressSession(f.src, f.dst, {
      deleteWithVaultCopy: f.vaultCopy,
      seams: {
        beforeDelete: async (jsonlPath) => {
          await appendFile(jsonlPath, appended);
        },
      },
    });

    await expect(run).rejects.toThrow("changed since it was read");
    expect(await Bun.file(f.src).text()).toBe(LARGE_JSONL + appended);
    expect(existsSync(f.dst)).toBe(false);
  });

  test("an absent vault copy keeps the original and writes no .zst", async () => {
    using tmp = tempDir("vault-absent");
    const f = files(tmp.path, LARGE_JSONL);
    await Bun.write(f.src, LARGE_JSONL);

    const run = compressSession(f.src, f.dst, { deleteWithVaultCopy: f.vaultCopy });

    await expect(run).rejects.toThrow("no vault copy");
    expect(existsSync(f.src)).toBe(true);
    expect(existsSync(f.dst)).toBe(false);
  });

  test.each([
    ["of another size", `${LARGE_JSONL}extra`],
    ["of the same size", LARGE_JSONL.replace("user", "resu")],
  ])("a vault copy with other bytes %s keeps the original", async (_label, vaultContent) => {
    using tmp = tempDir("vault-different");
    const f = files(tmp.path, LARGE_JSONL);
    await Bun.write(f.src, LARGE_JSONL);
    await Bun.write(f.vaultCopy, vaultContent);

    const run = compressSession(f.src, f.dst, { deleteWithVaultCopy: f.vaultCopy });

    await expect(run).rejects.toThrow("differs from the transcript");
    expect(await Bun.file(f.src).text()).toBe(LARGE_JSONL);
    expect(existsSync(f.dst)).toBe(false);
  });
});

describe("archiveSession", () => {
  test("move mode: compresses JSONL, moves dir, originals gone", async () => {
    using tmp = tempDir("archive-move");
    const { dir, vault, uuids } = await createFakeProject(tmp.path);
    const sessions = await discoverSessions(dir);
    const session = sessions.find((s) => s.sessionId === uuids.withJsonlAndDir)!;
    const archiveDir = join(dir, "archive");

    const entry = await archiveSession(session, dir, sessionOpts(vault));

    expect(entry.format).toBe("zstd");
    expect(entry.compressedSizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(archiveDir, `${UUID_B}.jsonl.zst`))).toBe(true);
    expect(existsSync(join(archiveDir, UUID_B, "subagent.jsonl"))).toBe(true);
    // originals gone
    expect(existsSync(join(dir, `${UUID_B}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, UUID_B))).toBe(false);
  });

  test("move mode: a failed transcript check keeps the session directory in place", async () => {
    using tmp = tempDir("archive-move-no-vault");
    const { dir, uuids } = await createFakeProject(tmp.path);
    const sessions = await discoverSessions(dir);
    const session = sessions.find((s) => s.sessionId === uuids.withJsonlAndDir)!;

    const run = archiveSession(session, dir, sessionOpts(join(tmp.path, "empty-vault")));

    await expect(run).rejects.toThrow("no vault copy");
    expect(existsSync(join(dir, `${UUID_B}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, UUID_B, "subagent.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "archive", `${UUID_B}.jsonl.zst`))).toBe(false);
  });

  test("copy mode: originals still present", async () => {
    using tmp = tempDir("archive-copy");
    const { dir, uuids } = await createFakeProject(tmp.path);
    const sessions = await discoverSessions(dir);
    const session = sessions.find((s) => s.sessionId === uuids.withJsonlAndDir)!;
    const archiveDir = join(dir, "archive");

    // No vault: copy mode deletes nothing, so it needs none
    await archiveSession(session, dir, sessionOpts(join(tmp.path, "empty-vault"), { copy: true }));

    // archive exists
    expect(existsSync(join(archiveDir, `${UUID_B}.jsonl.zst`))).toBe(true);
    // originals still present
    expect(existsSync(join(dir, `${UUID_B}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, UUID_B))).toBe(true);
  });

  test("copy mode: a vanished directory rejects instead of half-archiving", async () => {
    using tmp = tempDir("archive-copy-missing");
    const dir = join(tmp.path, "project");
    mkdirSync(dir, { recursive: true });

    const session = {
      sessionId: UUID_C,
      dirPath: join(dir, UUID_C),
      mtime: OLD_DATE,
      lastActivity: OLD_DATE,
      sizeBytes: 0,
    };

    await expect(
      archiveSession(session, dir, sessionOpts(join(tmp.path, "vault"), { copy: true })),
    ).rejects.toThrow();
  });

  test("dry-run: no files created", async () => {
    using tmp = tempDir("archive-dry");
    const { dir, vault, uuids } = await createFakeProject(tmp.path);
    const sessions = await discoverSessions(dir);
    const session = sessions.find((s) => s.sessionId === uuids.withJsonl)!;
    const archiveDir = join(dir, "archive");

    const entry = await archiveSession(session, dir, sessionOpts(vault, { dryRun: true }));

    expect(entry.sessionId).toBe(UUID_A);
    expect(existsSync(archiveDir)).toBe(false);
  });

  test("dry-run: a session without a vault copy is reported as kept", async () => {
    using tmp = tempDir("archive-dry-no-vault");
    const { dir, uuids } = await createFakeProject(tmp.path);
    const sessions = await discoverSessions(dir);
    const session = sessions.find((s) => s.sessionId === uuids.withJsonl)!;

    const run = archiveSession(
      session,
      dir,
      sessionOpts(join(tmp.path, "empty-vault"), { dryRun: true }),
    );

    await expect(run).rejects.toThrow("no vault copy");
    expect(existsSync(join(dir, "archive"))).toBe(false);
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
      lastActivity: OLD_DATE,
      sizeBytes: 0,
    };

    const entry = await archiveSession(session, dir, sessionOpts(join(tmp.path, "vault")));

    expect(existsSync(join(archiveDir, `${UUID_D}.jsonl`))).toBe(true);
    expect(existsSync(join(archiveDir, `${UUID_D}.jsonl.zst`))).toBe(false);
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
    expect(loaded.entries[0]?.sessionId).toBe(UUID_A);
    expect(loaded.entries[0]?.sizeBytes).toBe(1000);
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
    expect(index.entries[0]?.sessionId).toBe(UUID_A);
  });
});

function makeOptions(
  overrides: Partial<import("./session-archive").Options> = {},
): import("./session-archive").Options {
  return {
    days: 0,
    dryRun: false,
    copy: false,
    list: false,
    stats: false,
    hook: false,
    max: 0,
    verbose: false,
    vaultRoot: join(tmpdir(), "sa-test-no-vault"),
    ...overrides,
  };
}

describe("archiveProjects", () => {
  test("archives eligible sessions and updates index", async () => {
    using tmp = tempDir("project-archive");
    const { dir, vault } = await createFakeProject(tmp.path);

    const result = await archiveProjects([dir], makeOptions({ vaultRoot: vault }), new Set());

    expect(result.archived).toBe(3);
    expect(result.errors).toBe(0);

    const index = await loadArchiveIndex(join(dir, "archive"));
    expect(index.entries.length).toBe(result.archived);
  });

  test("a session without a vault copy stays in place, out of the index", async () => {
    using tmp = tempDir("project-partial-vault");
    const { dir, vault } = await createFakeProject(tmp.path);
    rmSync(join(vault, "project", `${UUID_A}.jsonl`));

    const result = await archiveProjects([dir], makeOptions({ vaultRoot: vault }), new Set());

    expect(result.errors).toBe(1);
    expect(existsSync(join(dir, `${UUID_A}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, "archive", `${UUID_A}.jsonl.zst`))).toBe(false);
    const index = await loadArchiveIndex(join(dir, "archive"));
    expect(index.entries.map((e) => e.sessionId).toSorted()).toEqual([UUID_B, UUID_C]);
  });

  test("scans every project, oldest last activity first, under one limit", async () => {
    using tmp = tempDir("project-all");
    const root = join(tmp.path, "projects");
    const vault = join(tmp.path, "vault");

    const sessions = [
      { project: "-p-one", uuid: UUID_A, last: daysAgo(100) },
      { project: "-p-two", uuid: UUID_B, last: daysAgo(300) },
      { project: "-p-two", uuid: UUID_C, last: daysAgo(200) },
    ];

    for (const { project, uuid, last } of sessions) {
      mkdirSync(join(root, project), { recursive: true });
      const content = messageLine(last);
      await Bun.write(join(root, project, `${uuid}.jsonl`), content);
      setMtime(join(root, project, `${uuid}.jsonl`), daysAgo(1));
      await writeVaultCopy(vault, project, uuid, content);
    }

    const dirs = [join(root, "-p-one"), join(root, "-p-two")];

    const result = await archiveProjects(
      dirs,
      makeOptions({ days: 90, max: 2, vaultRoot: vault }),
      new Set(),
    );

    expect(result.archived).toBe(2);
    expect(existsSync(join(root, "-p-two", "archive", `${UUID_B}.jsonl.zst`))).toBe(true);
    expect(existsSync(join(root, "-p-two", "archive", `${UUID_C}.jsonl.zst`))).toBe(true);
    expect(existsSync(join(root, "-p-one", `${UUID_A}.jsonl`))).toBe(true);
  });

  test("respects --max limit", async () => {
    using tmp = tempDir("project-max");
    const { dir, vault } = await createFakeProject(tmp.path);

    const result = await archiveProjects(
      [dir],
      makeOptions({ max: 1, vaultRoot: vault }),
      new Set(),
    );

    expect(result.archived).toBe(1);
  });

  test("dedup: running twice with --copy does not create duplicate entries", async () => {
    using tmp = tempDir("project-dedup");
    const { dir } = await createFakeProject(tmp.path);
    const opts = makeOptions({ copy: true });

    const first = await archiveProjects([dir], opts, new Set());
    const second = await archiveProjects([dir], opts, new Set());

    expect(first.archived).toBeGreaterThan(0);
    expect(second.archived).toBe(0); // all already archived

    const index = await loadArchiveIndex(join(dir, "archive"));
    expect(index.entries.length).toBe(first.archived);
  });

  test("protects given session IDs", async () => {
    using tmp = tempDir("project-protect");
    const { dir, vault, uuids } = await createFakeProject(tmp.path);

    const protectedIds = new Set([uuids.withJsonl, uuids.withJsonlAndDir]);
    await archiveProjects([dir], makeOptions({ vaultRoot: vault }), protectedIds);

    const index = await loadArchiveIndex(join(dir, "archive"));
    const archivedIds = index.entries.map((e) => e.sessionId);
    expect(archivedIds).not.toContain(uuids.withJsonl);
    expect(archivedIds).not.toContain(uuids.withJsonlAndDir);
  });

  test("dry-run does not modify files", async () => {
    using tmp = tempDir("project-dry");
    const { dir, vault } = await createFakeProject(tmp.path);

    await archiveProjects([dir], makeOptions({ dryRun: true, vaultRoot: vault }), new Set());

    expect(existsSync(join(dir, "archive"))).toBe(false);
    expect(existsSync(join(dir, `${UUID_A}.jsonl`))).toBe(true);
  });
});

describe("unarchiveSession", () => {
  test("restores zstd-compressed session", async () => {
    using tmp = tempDir("unarchive-zst");
    const { dir, vault, uuids } = await createFakeProject(tmp.path);

    // Archive first
    const sessions = await discoverSessions(dir);
    const session = sessions.find((s) => s.sessionId === uuids.withJsonl)!;
    const archiveDir = join(dir, "archive");
    const entry = await archiveSession(session, dir, sessionOpts(vault));
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

  test("restores a legacy gzip archive", async () => {
    using tmp = tempDir("unarchive-legacy-gz");
    const dir = join(tmp.path, "project");
    mkdirSync(dir, { recursive: true });
    const archiveDir = join(dir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    const compressed = Bun.gzipSync(JSONL_CONTENT);
    await Bun.write(join(archiveDir, `${UUID_C}.jsonl.gz`), compressed);
    await saveArchiveIndex(archiveDir, {
      version: 1,
      entries: [
        {
          sessionId: UUID_C,
          archivedAt: new Date().toISOString(),
          originalMtime: OLD_DATE.toISOString(),
          sizeBytes: JSONL_CONTENT.length,
          compressedSizeBytes: compressed.byteLength,
          hasDirectory: false,
          hasJsonl: true,
          format: "gzip",
        },
      ],
    });

    await unarchiveSession(UUID_C, dir);

    const content = await Bun.file(join(dir, `${UUID_C}.jsonl`)).text();
    expect(content).toBe(JSONL_CONTENT);
    expect(existsSync(join(archiveDir, `${UUID_C}.jsonl.gz`))).toBe(false);
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

    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

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

// === Profile ===

describe("profile", () => {
  test("mainProjectsRoot accepts only a transcript under the main projects root", async () => {
    using tmp = tempDir("profile-root");
    const main = join(tmp.path, ".claude", "projects");
    const other = join(tmp.path, ".claudex", "projects");
    mkdirSync(join(main, "-p"), { recursive: true });
    mkdirSync(join(other, "-p"), { recursive: true });

    expect(await mainProjectsRoot(join(main, "-p", `${UUID_A}.jsonl`), main)).toBe(main);
    expect(await mainProjectsRoot(join(other, "-p", `${UUID_A}.jsonl`), main)).toBeUndefined();
    expect(await mainProjectsRoot(join(tmp.path, "gone", "-p", "x.jsonl"), main)).toBeUndefined();
    expect(await mainProjectsRoot(undefined, main)).toBeUndefined();
  });

  test("a background worker for a transcript under .claudex/projects reads and writes nothing", async () => {
    using tmp = tempDir("profile-claudex");
    const home = tmp.path;
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const project = join(home, ".claudex", "projects", "-p");
    mkdirSync(project, { recursive: true });
    const old = join(project, `${UUID_A}.jsonl`);
    await Bun.write(old, messageLine(OLD_DATE));
    setMtime(old, OLD_DATE);
    const vault = join(home, "vault");
    await writeVaultCopy(vault, "-p", UUID_A, messageLine(OLD_DATE));

    const payload = Buffer.from(
      JSON.stringify({ session_id: UUID_B, transcript_path: join(project, `${UUID_B}.jsonl`) }),
    ).toString("base64");

    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "session-archive.ts"), "--background-worker", payload],
      env: { ...process.env, HOME: home, SESSION_ARCHIVE_VAULT: vault },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(await Bun.file(old).text()).toBe(messageLine(OLD_DATE));
    expect(existsSync(join(project, "archive"))).toBe(false);
    expect(existsSync(join(home, ".claude", ".session-archive-last-run"))).toBe(false);
    expect(existsSync(join(home, ".claude", ".session-archive-errors.log"))).toBe(false);
  });

  test("a background worker for the main profile scans every project and logs what it kept", async () => {
    using tmp = tempDir("profile-main");
    const home = tmp.path;
    const root = join(home, ".claude", "projects");
    const vault = join(home, "vault");
    const current = join(root, "-current");
    const other = join(root, "-other");
    mkdirSync(current, { recursive: true });
    mkdirSync(other, { recursive: true });

    const archivable = join(other, `${UUID_A}.jsonl`);
    await Bun.write(archivable, messageLine(OLD_DATE));
    setMtime(archivable, OLD_DATE);
    await writeVaultCopy(vault, "-other", UUID_A, messageLine(OLD_DATE));

    const unmirrored = join(other, `${UUID_C}.jsonl`);
    await Bun.write(unmirrored, messageLine(OLD_DATE));
    setMtime(unmirrored, OLD_DATE);

    const payload = Buffer.from(
      JSON.stringify({ session_id: UUID_B, transcript_path: join(current, `${UUID_B}.jsonl`) }),
    ).toString("base64");

    const proc = Bun.spawn({
      cmd: ["bun", join(import.meta.dir, "session-archive.ts"), "--background-worker", payload],
      env: { ...process.env, HOME: home, SESSION_ARCHIVE_VAULT: vault },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    expect(existsSync(archivable)).toBe(false);
    expect(existsSync(join(other, "archive", `${UUID_A}.jsonl.zst`))).toBe(true);
    expect(existsSync(unmirrored)).toBe(true);
    const errorLog = await Bun.file(join(home, ".claude", ".session-archive-errors.log")).text();
    expect(errorLog).toContain(UUID_C);
    expect(errorLog).toContain("no vault copy");
  });
});
