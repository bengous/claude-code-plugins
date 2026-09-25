/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WipDir } from "../domain/paths.ts";
import { parseWipDir } from "../domain/paths.ts";
import { slugFromTitle } from "../domain/slug.ts";
import { finalize, listFiles, readTextIfAny, readWorkspace, removeFile, watchFiles } from "./fs.ts";

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

function wip(): WipDir {
  const from = parseWipDir(WIP);

  if (!from.ok) throw new Error(from.error);

  return from.value;
}

function run(root: string): ReturnType<typeof finalize> {
  const slug = slugFromTitle("# Notification");

  if (!slug.ok) throw new Error(slug.error);

  return finalize(root, wip(), slug.value);
}

/** The changes a watcher reported after `write` ran, once its writes settled. */
async function watched(root: string, write: () => void): Promise<number> {
  let changes = 0;

  const unwatch = watchFiles(root, wip(), () => {
    changes += 1;
  });

  await Bun.sleep(50);
  write();
  await Bun.sleep(300);
  unwatch();

  return changes;
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

describe("readTextIfAny and removeFile", () => {
  const mockup = `${WIP}mockup.html` as never;

  test("a file reads as its text, and as null once removed", async () => {
    const root = fixture();
    expect(await readTextIfAny(root, mockup)).toBe(`<img src="${WIP}shot.png">`);
    await removeFile(root, mockup);
    expect(await readTextIfAny(root, mockup)).toBeNull();
    expect(existsSync(join(root, WIP, "mockup.html"))).toBe(false);
  });

  test("removing a file that is not there is no error", async () => {
    const root = fixture();
    await removeFile(root, `${WIP}nope.json` as never);
    expect(existsSync(join(root, WIP, "shot.png"))).toBe(true);
  });
});

describe("listFiles", () => {
  test("each file carries its mtime, so the page sees a rewrite", async () => {
    const root = fixture();
    const [mockup] = await listFiles(root, wip());
    expect(mockup).toEqual({
      path: `${WIP}mockup.html` as never,
      mediaType: "text/html",
      modified: statSync(join(root, WIP, "mockup.html")).mtimeMs,
    });
  });

  test("a directory that cannot be read is an error, not an empty list", async () => {
    const root = mkdtempSync(join(tmpdir(), "vellum-nodir-"));
    await expect(listFiles(root, wip())).rejects.toThrow("ENOENT");
  });
});

describe("watchFiles", () => {
  test("a write under the working directory, in a new subdirectory too, is one change", async () => {
    const root = fixture();

    const changes = await watched(root, () => {
      mkdirSync(join(root, WIP, "sub"));
      writeFileSync(join(root, WIP, "sub", "notes.md"), "# notes\n");
    });

    expect(changes).toBe(1);
  });

  test("a write under .review/ is the server's own and reports nothing", async () => {
    const root = fixture();

    const changes = await watched(root, () => {
      writeFileSync(join(root, WIP, ".review/v1.feedback-1.md"), "# Feedback\n");
    });

    expect(changes).toBe(0);
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
