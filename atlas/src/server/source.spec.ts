import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOURCE_CAP_BYTES } from "../model/sources.ts";
import type { Sources } from "./source.ts";
import { sourceAnswer } from "./source.ts";

// A sources root among other files of the disk, every path below named by the map but `src/b.go`:
// what the route refuses is refused for the file itself, not for a path the map never named.
const top = realpathSync(mkdtempSync(join(tmpdir(), "atlas-source-")));

const ROOT = join(top, "repo");

const SECRET = join(top, "secret.txt");

const NAMED = [
  "src/a.go",
  "src/b.go",
  "exact.txt",
  "big.txt",
  "nul.bin",
  "latin1.txt",
  "out.txt",
  "linked/secret.txt",
  "../secret.txt",
  SECRET,
  join(ROOT, "src", "a.go"),
  "gone.go",
  "src",
] as const;

const SOURCES: Sources = { root: ROOT, paths: new Set(NAMED.filter((p) => p !== "src/b.go")) };

beforeAll(() => {
  mkdirSync(join(ROOT, "src"), { recursive: true });
  const numbered = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  writeFileSync(join(ROOT, "src", "a.go"), `${numbered.join("\n")}\n`);
  writeFileSync(join(ROOT, "src", "b.go"), "not cited\n");
  writeFileSync(join(ROOT, "exact.txt"), "a".repeat(SOURCE_CAP_BYTES));
  writeFileSync(join(ROOT, "big.txt"), "a".repeat(SOURCE_CAP_BYTES + 1));
  writeFileSync(join(ROOT, "nul.bin"), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
  writeFileSync(join(ROOT, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  writeFileSync(SECRET, "a secret\n");
  symlinkSync(SECRET, join(ROOT, "out.txt"));
  symlinkSync(top, join(ROOT, "linked"));
});

afterAll(() => {
  rmSync(top, { recursive: true, force: true });
});

const ask = (query: Record<string, string>, sources: Sources | null = SOURCES): Response =>
  sourceAnswer(sources, new URLSearchParams(query));

const lines = (path: string, from: number, to: number): Response =>
  ask({ path, from: String(from), to: String(to) });

const status = (response: Response): number => response.status;

describe("the source route answers", () => {
  test("the lines asked of a file a citation names, from `from`", async () => {
    const answer = lines("src/a.go", 3, 5);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toStartWith("application/json");
    expect(await answer.json()).toEqual({
      path: "src/a.go",
      from: 3,
      lines: ["line 3", "line 4", "line 5"],
    });
  });

  test("up to the file's last line when `to` runs past it", async () => {
    expect(await lines("src/a.go", 29, 40).json()).toEqual({
      path: "src/a.go",
      from: 29,
      lines: ["line 29", "line 30"],
    });
  });

  test("a text file of exactly the cap", () => {
    expect(status(lines("exact.txt", 1, 1))).toBe(200);
  });
});

describe("the source route refuses", () => {
  test("every request when the map's Config names no sources root", async () => {
    const answer = ask({ path: "src/a.go", from: "1", to: "1" }, null);

    expect(answer.status).toBe(404);
    expect(await answer.text()).toBe("this map names no sources: its Config sets no sources root");
  });

  test("a path no citation or src of the map names, a file under the root among them", async () => {
    const answer = lines("src/b.go", 1, 1);

    expect(answer.status).toBe(403);
    expect(await answer.text()).toBe("no citation or src of this map names src/b.go");

    for (const spelling of ["./src/a.go", "src//a.go", "src/a.go/", "SRC/A.GO", ""]) {
      expect(`${spelling} ${status(lines(spelling, 1, 1))}`).toBe(`${spelling} 403`);
    }
  });

  test.each([
    ["a .. segment", "../secret.txt"],
    ["an absolute path out of the root", SECRET],
    ["an absolute path, even into the root", join(ROOT, "src", "a.go")],
    ["a link to a file out of the root", "out.txt"],
    ["a path through a link to a folder out of the root", "linked/secret.txt"],
  ])("a path that leads out of the root, even when the map names it: %s", async (_, path) => {
    const answer = lines(path, 1, 1);

    expect(answer.status).toBe(403);
    expect(await answer.text()).not.toContain("a secret");
  });

  test("a path to nothing, or to a folder", () => {
    expect(status(lines("gone.go", 1, 1))).toBe(404);
    expect(status(lines("src", 1, 1))).toBe(404);
  });

  test("every path under a root that is not a folder", () => {
    const missing = { ...SOURCES, root: join(top, "nowhere") };

    expect(status(ask({ path: "src/a.go", from: "1", to: "1" }, missing))).toBe(404);
  });

  test("a file over the cap", async () => {
    const answer = lines("big.txt", 1, 1);

    expect(answer.status).toBe(413);
    expect(await answer.text()).toBe(`big.txt is over ${SOURCE_CAP_BYTES} bytes`);
  });

  test("a binary file: a NUL byte, or bytes that are not UTF-8", () => {
    expect(status(lines("nul.bin", 1, 1))).toBe(415);
    expect(status(lines("latin1.txt", 1, 1))).toBe(415);
  });

  test.each([
    ["line 0", { from: "0", to: "1" }],
    ["a from after its to", { from: "5", to: "3" }],
    ["a word", { from: "one", to: "2" }],
    ["a sign", { from: "+1", to: "2" }],
    ["an exponent", { from: "1e3", to: "2000" }],
    ["a space", { from: " 1", to: "2" }],
    ["ten digits", { from: "1", to: "1000000000" }],
    ["no to", { from: "1" }],
    ["no lines", {}],
  ])("lines that are not lines from 1, from no later than to: %s", async (_, range) => {
    const answer = ask({ path: "src/a.go", ...range });

    expect(answer.status).toBe(400);
    expect(await answer.text()).toBe(
      "from and to are line numbers from 1, of at most 9 digits, from no later than to",
    );
  });

  test("a first line past the file's end", async () => {
    const answer = lines("src/a.go", 31, 40);

    expect(answer.status).toBe(416);
    expect(await answer.text()).toBe("src/a.go has 30 lines: line 31 is past its end");
  });
});
