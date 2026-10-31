import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readThreads } from "../model/threads.ts";

const WRITERS = 6;

const REPLIES = 10;

const ID = "backup-restore-untested";

const WAIT_MS = 10_000;

// Each writer is a process of its own, as each reply is: serve.ts and the mod's tool both run
// `cli.ts reply`. It says it is ready, waits for the go file, then appends its replies in turn.
const WRITER = [
  'import { existsSync, writeFileSync } from "node:fs";',
  `import { appendReply } from ${JSON.stringify(join(import.meta.dir, "reply.ts"))};`,
  "const [file, name, ready, go] = process.argv.slice(2);",
  'writeFileSync(ready, "");',
  "while (!existsSync(go)) await Bun.sleep(1);",
  `for (let i = 0; i < ${REPLIES}; i += 1) {`,
  `  await appendReply(file, new Set([${JSON.stringify(ID)}]), ${JSON.stringify(ID)}, "agent", \`\${name}-\${i}\`);`,
  "}",
].join("\n");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-replies-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function until(holds: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;

  while (!holds()) {
    if (Date.now() > deadline) {
      throw new Error(`no ${what} within ${WAIT_MS} ms`);
    }

    await Bun.sleep(10);
  }
}

test("replies that several processes append at once to one threads.json are all kept", async () => {
  const file = join(dir, "threads.json");
  const script = join(dir, "writer.ts");
  const go = join(dir, "go");
  writeFileSync(file, "{}\n");
  writeFileSync(script, WRITER);

  const names = Array.from({ length: WRITERS }, (_, n) => `w${n}`);
  const ready = names.map((name) => join(dir, `ready-${name}`));

  const writers = names.map((name, n) =>
    Bun.spawn([process.execPath, script, file, name, ready[n] ?? "", go], {
      cwd: dir,
      stdout: "ignore",
      stderr: "pipe",
    }),
  );

  await until(() => ready.every((path) => existsSync(path)), "writer ready");
  writeFileSync(go, "");

  const ends = await Promise.all(
    writers.map(async (writer) => {
      const [code, stderr] = await Promise.all([writer.exited, new Response(writer.stderr).text()]);

      return { code, stderr };
    }),
  );

  const { threads, errors } = readThreads(await Bun.file(file).json());
  const kept = (threads[ID] ?? []).map(({ text }) => text).toSorted();
  const sent = names.flatMap((name) => Array.from({ length: REPLIES }, (_, i) => `${name}-${i}`));

  expect({
    failed: ends.filter(({ code }) => code !== 0),
    lost: sent.filter((text) => !kept.includes(text)),
    errors,
  }).toEqual({ failed: [], lost: [], errors: [] });

  expect(kept).toEqual(sent.toSorted());
  expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);
});
