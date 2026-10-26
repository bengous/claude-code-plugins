import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sourceFile, textLines } from "./sources.ts";

// A sources root beside a folder outside it, as a map folder's repository and the rest of the disk.
const top = realpathSync(mkdtempSync(join(tmpdir(), "atlas-sources-")));

const ROOT = join(top, "repo");

beforeAll(() => {
  mkdirSync(join(ROOT, "src", "deep"), { recursive: true });
  mkdirSync(join(top, "elsewhere"));
  writeFileSync(join(ROOT, "src", "a.ts"), "one\ntwo\n");
  writeFileSync(join(top, "elsewhere", "secret.txt"), "a secret\n");
  symlinkSync(join(top, "elsewhere", "secret.txt"), join(ROOT, "src", "out.txt"));
  symlinkSync(join(top, "elsewhere"), join(ROOT, "linked"));
  symlinkSync(join(ROOT, "src", "a.ts"), join(ROOT, "src", "deep", "in.ts"));
});

afterAll(() => {
  rmSync(top, { recursive: true, force: true });
});

describe("sourceFile", () => {
  test("finds a file under the root, through a link that stays in it", () => {
    expect(sourceFile(ROOT, "src/a.ts")).toEqual({ kind: "file", file: join(ROOT, "src", "a.ts") });
    expect(sourceFile(ROOT, "src/deep/in.ts")).toEqual({
      kind: "file",
      file: join(ROOT, "src", "a.ts"),
    });
  });

  test.each([
    ["a .. segment", "../elsewhere/secret.txt"],
    ["a .. segment that comes back in", "src/../src/a.ts"],
    ["an absolute path", join(top, "elsewhere", "secret.txt")],
    ["an absolute path inside the root", join(ROOT, "src", "a.ts")],
    ["a link to a file out of the root", "src/out.txt"],
    ["a path through a link to a folder out of the root", "linked/secret.txt"],
  ])("refuses %s as outside the root", (_, path) => {
    expect(sourceFile(ROOT, path)).toMatchObject({ kind: "refused", why: "outside" });
  });

  test("refuses a path to nothing, or to a folder, as no file", () => {
    expect(sourceFile(ROOT, "src/gone.ts")).toEqual({
      kind: "refused",
      why: "missing",
      reason: `no file src/gone.ts under the sources root ${ROOT}`,
    });
    expect(sourceFile(ROOT, "src")).toMatchObject({ kind: "refused", why: "missing" });
  });

  test("refuses every path under a root that is no folder", () => {
    for (const root of [join(top, "nowhere"), join(ROOT, "src", "a.ts")]) {
      expect(sourceFile(root, "src/a.ts")).toEqual({
        kind: "refused",
        why: "root",
        reason: `the sources root ${root} is not a folder`,
      });
    }
  });
});

test("textLines counts a last line with or without its newline, and none in an empty text", () => {
  expect(textLines("one\ntwo\n")).toEqual(["one", "two"]);
  expect(textLines("one\r\ntwo")).toEqual(["one", "two"]);
  expect(textLines("one\n\n")).toEqual(["one", ""]);
  expect(textLines("")).toEqual([]);
});
