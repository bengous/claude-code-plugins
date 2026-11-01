import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Argv } from "./process.ts";
import { run } from "./process.ts";

const BUN = process.execPath;

function bun(script: string): Argv {
  return [BUN, "-e", script];
}

const FS_TS = JSON.stringify(pathToFileURL(join(import.meta.dir, "fs.ts")).href);

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
});
