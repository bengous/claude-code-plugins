import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isHeld, rename } from "./fs.ts";
import type { Argv } from "./process.ts";
import { run } from "./process.ts";

const BUN = process.execPath;

function bun(script: string): Argv {
  return [BUN, "-e", script];
}

const FS_TS = JSON.stringify(pathToFileURL(join(import.meta.dir, "fs.ts")).href);

const READY = "ready";

type Child = Bun.Subprocess<"pipe", "pipe", "pipe">;

async function spawnReady(script: string, cwd: string): Promise<Child> {
  const proc = Bun.spawn([...bun(script)], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const { value } = await proc.stdout.getReader().read();
  const said = new TextDecoder().decode(value);

  if (said !== READY) {
    proc.kill("SIGKILL");
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`the child wrote ${JSON.stringify(said)}, not ${READY}: ${stderr}`);
  }

  return proc;
}

async function spawnAllReady(scripts: readonly string[], cwd: string): Promise<Child[]> {
  const started = await Promise.allSettled(scripts.map((script) => spawnReady(script, cwd)));
  const children = started.flatMap((child) => (child.status === "fulfilled" ? [child.value] : []));
  const failed = started.find((child) => child.status === "rejected");

  if (failed !== undefined) {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    throw failed.reason;
  }

  return children;
}

function folderState(folder: string, file: string): string {
  return `${readdirSync(folder).toSorted().join("/")} ${statSync(file).size}`;
}

/**
 * Spins, never yielding, until a write shows in `folder`: a new entry, or `file` changing size.
 * Answers the folder's entries at that moment, so the caller acts on them at once.
 */
function firstWriteIn(folder: string, file: string, deadline: number): string[] | undefined {
  const before = folderState(folder, file);

  while (Date.now() < deadline) {
    if (folderState(folder, file) !== before) return readdirSync(folder);
  }

  return undefined;
}

async function exitOf(proc: Child): Promise<{ code: number; stderr: string }> {
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  return { code, stderr };
}

function payload(tag: string, lines: number): string {
  return `${tag}\n`.repeat(lines) + "end\n";
}

function wholePayloadIn(file: string, wholes: ReadonlyMap<string, string>): string {
  const content = readFileSync(file, "utf8");

  return wholes.get(content) ?? `torn (${content.length} bytes)`;
}

function holdFolder(folder: string, holdMs: number): Promise<Child> {
  mkdirSync(folder);
  const held = join(folder, "held.txt");
  writeFileSync(held, "held");

  const script = `
    const { openSync } = await import("node:fs");
    openSync(${JSON.stringify(held)}, "r");
    process.stdout.write(${JSON.stringify(READY)});
    await Bun.sleep(${holdMs});
  `;

  return spawnReady(script, dir);
}

async function refusedAsHeld(attempt: Promise<void>): Promise<boolean> {
  try {
    await attempt;
  } catch (cause) {
    if (isHeld(cause)) return true;
    throw cause;
  }

  return false;
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "platform-fs-race-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("races between processes", () => {
  test("createExclusiveSync lets exactly one of many creators win", async () => {
    const target = join(dir, "id.json");

    const script = `
      const { createExclusiveSync } = await import(${FS_TS});
      await Bun.sleep(100);
      process.stdout.write(String(createExclusiveSync(${JSON.stringify(target)}, String(process.pid))));
    `;

    const results = await Promise.all(Array.from({ length: 8 }, () => run(bun(script))));
    const answers = results.map((result) => (result.kind === "exited" ? result.stdout : "none"));

    expect(answers.filter((answer) => answer === "true")).toHaveLength(1);
    expect(answers.filter((answer) => answer === "false")).toHaveLength(7);
    expect(readdirSync(dir)).toEqual(["id.json"]);
  });

  test("writeAtomic shows readers, and leaves, whole payloads while many write one file", async () => {
    const target = join(dir, "state.txt");
    const previous = payload("previous", 1);
    writeFileSync(target, previous);

    const writerPayloads = Array.from({ length: 8 }, (_, writer) => ({
      label: `writer ${writer}`,
      lines: (writer + 1) * 40_000,
    }));

    const wholes = new Map([
      [previous, "previous"],
      ...writerPayloads.map(({ label, lines }): [string, string] => [payload(label, lines), label]),
    ]);

    const writers = await spawnAllReady(
      writerPayloads.map(
        ({ label, lines }) => `
          const { writeAtomic } = await import(${FS_TS});
          const data = (${String(payload)})(${JSON.stringify(label)}, ${lines});
          process.stdout.write(${JSON.stringify(READY)});
          await Bun.stdin.text();
          for (let round = 0; round < 20; round++) {
            await writeAtomic(${JSON.stringify(target)}, data, { heldRetryMs: 5000 });
          }
        `,
      ),
      dir,
    );

    const writersDone = new AbortController();
    const seen = new Set<string>();

    const reading = (async (): Promise<void> => {
      while (!writersDone.signal.aborted) {
        try {
          seen.add(wholePayloadIn(target, wholes));
        } catch (cause) {
          if (!isHeld(cause)) throw cause;
        }

        await Bun.sleep(1);
      }
    })();

    for (const writer of writers) await writer.stdin.end();

    const exits = Promise.all(writers.map((writer) => exitOf(writer))).finally(() =>
      writersDone.abort(),
    );

    const [outcomes] = await Promise.all([exits, reading]);

    expect(outcomes).toEqual(writers.map(() => ({ code: 0, stderr: "" })));
    const labels = new Set(wholes.values());
    expect([...seen].filter((read) => !labels.has(read))).toEqual([]);
    expect([...seen].some((read) => read !== "previous")).toBe(true);
    expect(wholePayloadIn(target, wholes)).toBeOneOf(writerPayloads.map(({ label }) => label));
    expect(readdirSync(dir)).toEqual(["state.txt"]);
  });
});

describe("a writer killed mid-write", () => {
  test("writeAtomic leaves the previous whole content or the new, never a torn file", async () => {
    const lines = 4_000_000;
    const previous = payload("previous", 1);

    const wholes = new Map([
      [previous, "previous"],
      [payload("a", lines), "a"],
      [payload("b", lines), "b"],
    ]);

    const deadline = Date.now() + 10_000;
    let killedMidWrite = false;

    for (let attempt = 0; !killedMidWrite && Date.now() < deadline; attempt++) {
      const attemptDir = join(dir, String(attempt));
      mkdirSync(attemptDir);
      const target = join(attemptDir, "state.txt");
      writeFileSync(target, previous);

      const script = `
        const { writeAtomic } = await import(${FS_TS});
        const payload = ${String(payload)};
        const encoder = new TextEncoder();
        const data = [encoder.encode(payload("a", ${lines})), encoder.encode(payload("b", ${lines}))];
        process.stdout.write(${JSON.stringify(READY)});
        for (let round = 0; ; round++) {
          await writeAtomic(${JSON.stringify(target)}, data[round % 2], { heldRetryMs: 5000 });
        }
      `;

      const writer = await spawnReady(script, dir);
      const writing = firstWriteIn(attemptDir, target, deadline);
      writer.kill("SIGKILL");
      await writer.exited;

      expect(writing).toBeDefined();
      expect(writer.signalCode).toBe("SIGKILL");
      expect(wholePayloadIn(target, wholes)).toBeOneOf(["previous", "a", "b"]);
      const others = readdirSync(attemptDir).filter((name) => name !== "state.txt");

      for (const name of others) {
        expect(name).toMatch(
          new RegExp(String.raw`^\.state\.txt\.${writer.pid}\.[0-9a-f-]{36}\.tmp$`, "u"),
        );
      }

      const scratch = writing?.find((name) => name !== "state.txt");
      killedMidWrite = scratch !== undefined && others.includes(scratch);
    }

    expect(killedMidWrite).toBe(true);
  });
});

describe.skipIf(process.platform !== "win32")("a folder another process holds on Windows", () => {
  test("rename waits out a holder that lets go within heldRetryMs", async () => {
    const from = join(dir, "from");
    const to = join(dir, "to");
    const holder = await holdFolder(from, 2000);

    try {
      expect(await refusedAsHeld(rename(from, to))).toBe(true);
      await rename(from, to, { heldRetryMs: 5000 });
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }

    expect(readdirSync(dir)).toEqual(["to"]);
  });

  test("rename throws the held errno once heldRetryMs runs out", async () => {
    const from = join(dir, "from");
    const to = join(dir, "to");
    const holder = await holdFolder(from, 10_000);

    try {
      const startedAt = Date.now();
      expect(await refusedAsHeld(rename(from, to, { heldRetryMs: 300 }))).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }

    expect(readdirSync(dir)).toEqual(["from"]);
  });
});
