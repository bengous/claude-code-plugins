import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionFiles } from "./files.ts";

const SESSION = "session-a";

const WRITES = 8;

const SERVERS = 8;

const ROUNDS = 50;

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

test("a server and the one started again on its session numbering a batch at once keep both", async () => {
  const servers = [sessionFiles(dir, SESSION), sessionFiles(dir, SESSION)];

  const seqs = await Promise.all(servers.map((files) => files.nextSeq(0)));

  expect(new Set(seqs).size).toBe(servers.length);

  await Promise.all(
    servers.map((files, n) => files.keepPending({ seq: seqs[n] ?? 0, text: `batch ${n}` })),
  );

  const kept = await servers[0]?.pending();

  expect(kept?.map(({ text }) => text).toSorted()).toEqual(["batch 0", "batch 1"]);
});

test("a number given and settled is not given again, seq left behind it", async () => {
  const files = sessionFiles(dir, SESSION);
  let last = 0;

  while (last < 6) {
    last = await files.nextSeq(last);
    await files.keepPending({ seq: last, text: `batch ${last}` });
    await files.settle({ seq: last, outcome: "delivered" });
  }

  writeFileSync(join(dir, "sessions", SESSION, "seq"), "5\n");

  expect(await files.nextSeq(5)).toBe(7);
  expect(await files.outcomes([6])).toEqual([{ seq: 6, outcome: "delivered" }]);
});

test("servers of one session numbering at once, each batch settled before the next, never give a number twice", async () => {
  // Two servers race too rarely in one process to show a number given twice; eight do every time.
  const servers = Array.from({ length: SERVERS }, () => sessionFiles(dir, SESSION));
  const last = servers.map(() => 0);
  const given: number[] = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    const seqs = await Promise.all(servers.map((files, n) => files.nextSeq(last[n] ?? 0)));

    given.push(...seqs);
    seqs.forEach((seq, n) => {
      last[n] = seq;
    });
    await Promise.all(
      servers.map((files, n) => files.keepPending({ seq: seqs[n] ?? 0, text: "" })),
    );
    await Promise.all(
      servers.map((files, n) => files.settle({ seq: seqs[n] ?? 0, outcome: "delivered" })),
    );
  }

  expect(given.filter((seq, n) => given.indexOf(seq) !== n)).toEqual([]);
});

test("a number taken by a server that never kept its batch is not pending, and not given again", async () => {
  const files = sessionFiles(dir, SESSION);
  const orphan = await files.nextSeq(0);

  expect(await files.outcomes([orphan])).toEqual([{ seq: orphan, outcome: "unknown" }]);
  expect(await files.pending()).toEqual([]);
  expect(await sessionFiles(dir, SESSION).nextSeq(0)).toBe(orphan + 1);
});
