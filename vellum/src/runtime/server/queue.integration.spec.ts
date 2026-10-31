import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Draft } from "../../review/review.ts";
import { EMPTY_DRAFT, EMPTY_TYPED } from "../../review/review.ts";
import { parseWipDir } from "../../workshop/paths.ts";
import { Queue } from "./queue.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

/** The largest file the child may write, in `ulimit -f` blocks: 512 bytes under a POSIX `sh`, 1024 under bash. */
const CAP_BLOCKS = 16;

function draftOf(general: string): Draft {
  return { ...EMPTY_DRAFT, typed: { ...EMPTY_TYPED, general } };
}

function queueOn(root: string): Queue {
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);

  return new Queue({ project: root, workdir: workdir.value, extensions: [] });
}

/** A child that saves each draft in turn through `Queue.saveDraft`, under a cap on the size of any file it writes. */
const SAVER = `
import { Queue } from ${JSON.stringify(join(import.meta.dir, "queue.ts"))};
import { parseWipDir } from ${JSON.stringify(join(import.meta.dir, "../../workshop/paths.ts"))};
const { root, drafts } = await Bun.stdin.json();
const workdir = parseWipDir(${JSON.stringify(WIP)});
if (!workdir.ok) throw new Error(workdir.error);
const queue = new Queue({ project: root, workdir: workdir.value, extensions: [] });
for (const draft of drafts) await queue.saveDraft(draft);
`;

/** Saves `drafts` in turn from a child whose writes stop at `CAP_BLOCKS`, as a full disk stops them; answers its stderr. */
async function savedCapped(root: string, drafts: readonly Draft[]): Promise<string> {
  const child = Bun.spawn(
    ["sh", "-c", `ulimit -f ${CAP_BLOCKS} && exec "$@"`, "sh", process.execPath, "-e", SAVER],
    { stdin: new Response(JSON.stringify({ root, drafts })), stdout: "ignore", stderr: "pipe" },
  );

  await child.exited;

  return await new Response(child.stderr).text();
}

function reviewRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vellum-queue-"));
  mkdirSync(join(root, WIP, ".review"), { recursive: true });

  return root;
}

describe("the draft", () => {
  // Windows has no `ulimit`: the write is cut short by the file size limit of a POSIX shell.
  test.skipIf(process.platform === "win32")(
    "a write cut short, as a full disk cuts it, leaves the draft saved before it whole",
    async () => {
      const root = reviewRoot();
      const saved = draftOf("Keep this comment.");
      const cut = draftOf("x".repeat(CAP_BLOCKS * 1024 * 4));

      expect(await savedCapped(root, [saved, cut])).toContain("EFBIG");
      expect(await queueOn(root).draft()).toEqual(saved);
    },
  );
});
