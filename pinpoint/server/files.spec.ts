import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionFiles } from "./files.ts";

const SESSION = "session-a";

const WRITES = 8;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pinpoint-files-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a server and the one started again on its session both writing a file leave it whole", async () => {
  const old = sessionFiles(dir, SESSION);
  const relaunched = sessionFiles(dir, SESSION);
  const texts = Array.from({ length: WRITES }, (_, n) => `${n}`.repeat(64 * 1024));

  const writes = await Promise.allSettled(
    texts.map((text, n) => (n % 2 === 0 ? old : relaunched).keepPending({ seq: 1, text })),
  );

  expect(writes.filter(({ status }) => status === "rejected")).toEqual([]);

  const kept = await relaunched.pending();

  expect(kept).toHaveLength(1);
  expect(texts).toContain(kept[0]?.text ?? "");
  expect(readdirSync(join(dir, "sessions", SESSION, "pending"))).toEqual(["1.json"]);
});
