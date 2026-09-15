/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWipDir } from "../domain/paths.ts";
import { slugFromTitle } from "../domain/slug.ts";
import { finalize, readWorkspace } from "./fs.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "vellum-finalize-"));
  mkdirSync(join(root, WIP, ".review"), { recursive: true });
  writeFileSync(join(root, WIP, ".review/v1.md"), `# Notification\n\n![shot](${WIP}shot.png)\n`);
  writeFileSync(join(root, WIP, "mockup.html"), `<img src="${WIP}shot.png">`);
  writeFileSync(join(root, WIP, "shot.png"), PNG);

  return root;
}

function run(root: string): ReturnType<typeof finalize> {
  const from = parseWipDir(WIP);
  const slug = slugFromTitle("# Notification");

  if (!from.ok || !slug.ok) throw new Error("fixture");

  return finalize(root, from.value, slug.value);
}

describe("readWorkspace", () => {
  test("reads the state off the .review/ listing; a missing listing is drafting", async () => {
    const root = fixture();
    const from = parseWipDir(WIP);

    if (!from.ok) throw new Error(from.error);
    expect(await readWorkspace(root, from.value)).toMatchObject({ value: { kind: "inReview" } });
    const empty = mkdtempSync(join(tmpdir(), "vellum-empty-"));
    expect(await readWorkspace(empty, from.value)).toMatchObject({ value: { kind: "drafting" } });
  });
});

describe("finalize", () => {
  test("renames to the slug and rewrites links in text files, binaries intact", async () => {
    const root = fixture();
    const result = await run(root);
    expect(result).toEqual({ ok: true, value: "plans/2026-09-15/notification/" as never });
    const to = join(root, "plans/2026-09-15/notification");
    expect(existsSync(join(root, WIP))).toBe(false);
    expect(readFileSync(join(to, ".review/v1.md"), "utf8")).toContain(
      "plans/2026-09-15/notification/shot.png",
    );
    expect(readFileSync(join(to, "mockup.html"), "utf8")).toBe(
      '<img src="plans/2026-09-15/notification/shot.png">',
    );
    expect(new Uint8Array(readFileSync(join(to, "shot.png")))).toEqual(PNG);
  });

  test("a taken slug gets -2, then -3", async () => {
    const root = fixture();
    mkdirSync(join(root, "plans/2026-09-15/notification"));
    mkdirSync(join(root, "plans/2026-09-15/notification-2"));
    const result = await run(root);
    expect(result).toEqual({ ok: true, value: "plans/2026-09-15/notification-3/" as never });
  });

  test("a file that cannot be rewritten fails before the rename, so a retry finds the directory", async () => {
    const root = fixture();
    chmodSync(join(root, WIP, "mockup.html"), 0o444);
    const result = await run(root);
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, WIP))).toBe(true);
    expect(existsSync(join(root, "plans/2026-09-15/notification"))).toBe(false);
  });

  test("a missing working directory is an error, not a throw", async () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-finalize-"));
    const result = await run(root);
    expect(result.ok).toBe(false);
  });
});
