import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyOf, main, mutated, mutantOf } from "./mutant.ts";

/** The start of each command: the file it is given, and whether that file holds the mutant. */
const READ =
  "const fs = require('node:fs'); const file = process.argv[1]; const mutant = fs.readFileSync(file, 'utf8').includes('limit = 4');";

/** Passes on the file as it is and fails on the mutant: the test a mutant runs. */
const FAILS_ON_THE_MUTANT = `${READ} process.exit(mutant ? 1 : 0)`;

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
  let copy = "";
  let out: string[] = [];
  let err: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mutant-"));
    file = join(root, "limit.ts");
    writeFileSync(file, ORIGINAL);
    copy = copyOf(realpathSync(file));
    out = [];
    err = [];
    spyOn(console, "log").mockImplementation((line: string) => out.push(line));
    spyOn(console, "error").mockImplementation((line: string) => err.push(line));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { force: true });
  });

  const run = (script: string, from = "limit = 3", to = "limit = 4"): Promise<number> =>
    main([file, "--from", from, "--to", to, "--", process.execPath, "-e", script, file]);

  test("a command that fails on the mutant kills it, and the file comes back byte for byte", async () => {
    expect(await run(FAILS_ON_THE_MUTANT)).toBe(0);
    expect(out.at(-1)).toBe(`killed    ${file}: the command exited 1 on the mutant`);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    expect(existsSync(copy)).toBe(false);
  });

  test("a command that passes on the mutant lets it survive", async () => {
    expect(await run(FAILS_ON_THE_MUTANT, "name = 'limit'", "name = 'other'")).toBe(1);
    expect(out.at(-1)).toBe(`survived  ${file}: the command passed on the mutant`);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test("the last lines printed are those of the run on the mutant", async () => {
    const script = `${READ} console.log(fs.readFileSync(file, 'utf8').split(';')[0]); process.exit(mutant ? 1 : 0)`;

    expect(await run(script)).toBe(0);
    expect(out[0]).toBe("const limit = 4");
  });

  test("a command that fails on the file as it is proves nothing, and no mutant is written", async () => {
    const script = `${READ} console.log(mutant ? 'on the mutant' : 'on the file as it is'); process.exit(1)`;

    expect(await run(script)).toBe(2);
    expect(err).toEqual([
      "mutant: the command fails without the mutant (exit 1):\non the file as it is",
    ]);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test("a command that fails with a high exit code of its own kills the mutant", async () => {
    expect(await run(`${READ} process.exit(mutant ? 255 : 0)`)).toBe(0);
    expect(out.at(-1)).toBe(`killed    ${file}: the command exited 255 on the mutant`);
  });

  test("a text the file holds twice or not at all plays no mutant and leaves the file", async () => {
    expect(await run(FAILS_ON_THE_MUTANT, "limit", "cap")).toBe(2);
    expect(await run(FAILS_ON_THE_MUTANT, "absent", "cap")).toBe(2);
    expect(err).toEqual([
      `mutant: ${file} holds the text of --from more than once`,
      `mutant: ${file} does not hold the text of --from`,
    ]);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test("a program the PATH lacks plays no mutant", async () => {
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

  test("a command that outlasts the timeout on the mutant is killed, and the file comes back", async () => {
    const argv = [file, "--from", "limit = 3", "--to", "limit = 4", "--", process.execPath, "-e"];
    const hangs = `${READ} if (mutant) setTimeout(() => {}, 60_000)`;

    expect(await main([...argv, hangs, file], 1000)).toBe(2);
    expect(err).toEqual([`mutant: the command ran past ${1000 / 60_000} minutes`]);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    expect(existsSync(copy)).toBe(false);
  });

  test("a file that already holds a mutant gets no second one", async () => {
    writeFileSync(copy, "the bytes of a run that was killed");

    expect(await run(FAILS_ON_THE_MUTANT)).toBe(2);
    expect(err).toEqual([
      `mutant: ${file} already holds a mutant, played by another run or left by one that was killed: its bytes from before are in ${copy}`,
    ]);
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    expect(readFileSync(copy, "utf8")).toBe("the bytes of a run that was killed");
  });

  test("a file edited while the command ran is left as it is, and its bytes from before are kept", async () => {
    const edits = `${READ} if (mutant) { fs.appendFileSync(file, ' // edited'); process.exit(1); }`;

    expect(await run(edits)).toBe(2);
    expect(err).toEqual([
      `mutant: ${file} changed while the command ran and is left as it is: its bytes from before the mutant are in ${copy}`,
    ]);
    expect(readFileSync(file, "utf8")).toBe(
      `${ORIGINAL.replace("limit = 3", "limit = 4")} // edited`,
    );
    expect(readFileSync(copy, "utf8")).toBe(ORIGINAL);
  });

  test.skipIf(process.platform === "win32")(
    "a command a signal ended proves nothing about the test",
    async () => {
      expect(await run(`${READ} if (mutant) process.kill(process.pid, 'SIGINT')`)).toBe(2);
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
          FAILS_ON_THE_MUTANT,
          file,
        ]),
      ).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    },
  );

  test.skipIf(process.platform === "win32")(
    "the mutant has the file's mode while the command runs, and the file keeps it",
    async () => {
      chmodSync(file, 0o755);

      const executable = `${READ} process.exit(mutant && (fs.statSync(file).mode & 0o777) === 0o755 ? 1 : 0)`;

      expect(await run(executable)).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o755);
    },
  );

  test.skipIf(process.platform === "win32").each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "a %s while the command runs on the mutant restores the file and its mode, and exits %i",
    async (signal, code) => {
      chmodSync(file, 0o755);

      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "mutant.ts"),
          file,
          "--from",
          "limit = 3",
          "--to",
          "limit = 4",
          "--",
          process.execPath,
          "-e",
          `${READ} if (mutant) setTimeout(() => {}, 3000)`,
          file,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );

      while (!readFileSync(file, "utf8").includes("limit = 4")) await Bun.sleep(20);

      child.kill(signal);

      expect(await child.exited).toBe(code);
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
      expect(statSync(file).mode & 0o777).toBe(0o755);
      expect(existsSync(copy)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a mutant that cannot be written leaves the file and no copy of it",
    async () => {
      chmodSync(root, 0o555);

      try {
        expect(await run(FAILS_ON_THE_MUTANT)).toBe(2);
      } finally {
        chmodSync(root, 0o755);
      }

      expect(err.join("\n")).toContain("mutant: EACCES");
      expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
      expect(existsSync(copy)).toBe(false);
    },
  );

  test("a missing file and a bad argv exit 2", async () => {
    expect(
      await main([join(root, "none.ts"), "--from", "a", "--to", "b", "--", process.execPath]),
    ).toBe(2);
    expect(err.join("\n")).toContain("mutant: ");
    expect(await main(["f.ts"])).toBe(2);
    expect(err.at(-1)).toContain("usage: mutant.ts <file> --from <text> --to <text> --");
  });
});
