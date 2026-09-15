/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WipDir } from "./paths.ts";
import { parseFinalDir, parseWipDir } from "./paths.ts";
import { readWorkspace } from "./read.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

function project(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "vellum-read-"));

  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "x");
  }

  return root;
}

function wip(): WipDir {
  const parsed = parseWipDir(WIP);

  if (!parsed.ok) throw new Error(parsed.error);

  return parsed.value;
}

describe("readWorkspace", () => {
  test("no .review is drafting", async () => {
    const root = project([`${WIP}mockup.html`]);
    const result = await readWorkspace(root, wip());
    expect(result).toEqual({ ok: true, value: { kind: "drafting", dir: WIP as never } });
  });

  test("latest vN.md without feedback is inReview", async () => {
    const root = project([
      `${WIP}.review/v1.md`,
      `${WIP}.review/v1.feedback.md`,
      `${WIP}.review/v2.md`,
    ]);

    const result = await readWorkspace(root, wip());
    expect(result).toEqual({
      ok: true,
      value: { kind: "inReview", dir: WIP as never, version: 2 as never, finalizeError: null },
    });
  });

  test("latest vN.md with feedback is changesRequested; v10 sorts after v9", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `${WIP}.review/v${i + 1}.md`);
    const root = project([...files, `${WIP}.review/v10.feedback.md`]);
    const result = await readWorkspace(root, wip());
    expect(result).toEqual({
      ok: true,
      value: { kind: "changesRequested", dir: WIP as never, version: 10 as never },
    });
  });

  test("a final directory is approved", async () => {
    const dir = parseFinalDir("plans/2026-09-15/notification/");

    if (!dir.ok) throw new Error(dir.error);
    const root = project([`${dir.value}.review/v3.md`]);
    const result = await readWorkspace(root, dir.value);
    expect(result).toEqual({
      ok: true,
      value: { kind: "approved", dir: dir.value, version: 3 as never },
    });
  });
});
