import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, mutated, mutantOf } from "./mutant.ts";

/** Exits 0 when the file it is given holds `limit = 3`, 1 otherwise: the test a mutant runs. */
const HOLDS_THE_LIMIT =
  "process.exit(require('node:fs').readFileSync(process.argv[1], 'utf8').includes('limit = 3') ? 0 : 1)";

const ORIGINAL = "const limit = 3;\r\nconst name = 'limit';";

describe("mutated", () => {
  test("replaces the one occurrence, and takes the replacement as text", () => {
    expect(mutated("a = 1; b = 2;", "a = 1", "a = $&")).toEqual({
      kind: "text",
      text: "a = $&; b = 2;",
    });
  });

  test.each([
    ["z", "x", "y", "does not hold the text of --from"],
    ["a a", "a", "b", "holds the text of --from more than once"],
    ["a === b", "==", "!=", "holds the text of --from more than once"],
    ["a", "a", "a", "--from and --to are the same text"],
    ["a", "", "b", "--from is empty"],
  ])("refuses %p with --from %p and --to %p", (text, from, to, why) => {
    expect(mutated(text, from, to)).toEqual({ kind: "none", why });
  });
});

describe("mutantOf", () => {
  test("reads the file, the two texts and the command after --", () => {
    expect(
      mutantOf(["f.ts", "--from", "a", "--to", "b", "--", "bun", "test", "f.test.ts"]),
    ).toEqual({
      file: "f.ts",
      from: "a",
      to: "b",
      command: ["bun", "test", "f.test.ts"],
    });
  });

  test.each([
    [["f.ts", "--from", "a", "--to", "b", "--"]],
    [["f.ts", "--from", "a", "--to", "b", "bun", "test"]],
    [["f.ts", "--to", "b", "--from", "a", "--", "bun"]],
    [[]],
  ])("names no mutant for %p", (argv) => {
    expect(mutantOf(argv)).toBeNull();
  });
});

describe("main", () => {
  let root = "";
  let file = "";
  let out: string[] = [];
  let err: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mutant-"));
    file = join(root, "limit.ts");
    writeFileSync(file, ORIGINAL);
    out = [];
    err = [];
    spyOn(console, "log").mockImplementation((line: string) => out.push(line));
    spyOn(console, "error").mockImplementation((line: string) => err.push(line));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (from: string, to: string, script: string): Promise<number> =>
    main([file, "--from", from, "--to", to, "--", process.execPath, "-e", script, file]);

  test("a command that fails on the mutant kills it, and the file comes back byte for byte", async () => {
    expect(await run("limit = 3", "limit = 4", HOLDS_THE_LIMIT)).toBe(0);
    expect(out.at(-1)).toBe(`killed    ${file}: the command exited 1 on the mutant`);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test("a command that passes on the mutant lets it survive", async () => {
    expect(await run("name = 'limit'", "name = 'other'", HOLDS_THE_LIMIT)).toBe(1);
    expect(out.at(-1)).toBe(`survived  ${file}: the command passed on the mutant`);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test("the command runs on the mutant, and its last lines are printed", async () => {
    const script =
      "console.log(require('node:fs').readFileSync(process.argv[1], 'utf8').split(';')[0]); process.exit(1)";

    expect(await run("limit = 3", "limit = 4", script)).toBe(0);
    expect(out[0]).toBe("const limit = 4");
  });

  test("a text the file holds twice or not at all plays no mutant and leaves the file", async () => {
    expect(await run("limit", "cap", HOLDS_THE_LIMIT)).toBe(2);
    expect(await run("absent", "cap", HOLDS_THE_LIMIT)).toBe(2);
    expect(err).toEqual([
      `mutant: ${file} holds the text of --from more than once`,
      `mutant: ${file} does not hold the text of --from`,
    ]);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test("a program the PATH lacks plays no mutant, and the file comes back", async () => {
    expect(
      await main([
        file,
        "--from",
        "limit = 3",
        "--to",
        "limit = 4",
        "--",
        "no-such-program-mutant",
      ]),
    ).toBe(2);
    expect(err).toEqual(["mutant: no-such-program-mutant is not on the PATH"]);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test("a command that outlasts the timeout is killed, proves nothing, and the file comes back", async () => {
    const argv = [file, "--from", "limit = 3", "--to", "limit = 4", "--", process.execPath, "-e"];

    expect(await main([...argv, "setTimeout(() => {}, 60_000)"], 300)).toBe(2);
    expect(err).toEqual(["mutant: the command ran past 0.005 minutes"]);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test.skipIf(process.platform === "win32")(
    "a command a signal ended proves nothing about the test",
    async () => {
      expect(await run("limit = 3", "limit = 4", "process.kill(process.pid, 'SIGINT')")).toBe(2);
      expect(err).toEqual(["mutant: a signal ended the command (exit 130)"]);
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a link is followed: the file it names is mutated, and the link stays a link",
    async () => {
      const link = join(root, "link.ts");

      symlinkSync(file, link);

      expect(
        await main([
          link,
          "--from",
          "limit = 3",
          "--to",
          "limit = 4",
          "--",
          process.execPath,
          "-e",
          HOLDS_THE_LIMIT,
          file,
        ]),
      ).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    },
  );

  test.skipIf(process.platform === "win32")("the file keeps its mode", async () => {
    chmodSync(file, 0o755);

    expect(await run("limit = 3", "limit = 4", HOLDS_THE_LIMIT)).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  test("a missing file and a bad argv exit 2", async () => {
    expect(
      await main([join(root, "none.ts"), "--from", "a", "--to", "b", "--", process.execPath]),
    ).toBe(2);
    expect(err.join("\n")).toContain("mutant: ");
    expect(await main(["f.ts"])).toBe(2);
    expect(err.at(-1)).toContain("usage: mutant.ts <file> --from <text> --to <text> --");
  });
});
