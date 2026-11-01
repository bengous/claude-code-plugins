import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Argv } from "./process.ts";
import { run } from "./process.ts";

const BUN = process.execPath;

function bun(script: string): Argv {
  return [BUN, "-e", script];
}

const LOCK_TS = JSON.stringify(pathToFileURL(join(import.meta.dir, "lock.ts")).href);

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "platform-lock-race-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("races between processes", () => {
  test("withLock lets one holder at a time read, change and write a file", async () => {
    const counter = join(dir, "counter");
    writeFileSync(counter, "0");

    const script = `
      const { withLock } = await import(${LOCK_TS});
      const { readFileSync, writeFileSync } = await import("node:fs");
      await withLock(${JSON.stringify(`${counter}.lock`)}, async () => {
        const seen = Number(readFileSync(${JSON.stringify(counter)}, "utf8"));
        await Bun.sleep(20);
        writeFileSync(${JSON.stringify(counter)}, String(seen + 1));
      }, { timeoutMs: 10000 });
    `;

    const results = await Promise.all(Array.from({ length: 8 }, () => run(bun(script))));

    expect(results.map((result) => result.kind === "exited" && result.code)).toEqual(
      Array.from({ length: 8 }, () => 0),
    );
    expect(readFileSync(counter, "utf8")).toBe("8");
    expect(readdirSync(dir)).toEqual(["counter"]);
  });
});
