import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOURCE_CAP_BYTES, sourceFile, sourceText, sourceTextAt, textLines } from "./sources.ts";

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

// The file sourceFile finds at `path`, a text of its own, before the spec swaps it.
function found(path: string): string {
  writeFileSync(join(ROOT, path), "swap\n");
  const source = sourceFile(ROOT, path);

  if (source.kind === "refused") {
    throw new Error(source.reason);
  }

  return source.file;
}

describe("sourceTextAt, once sourceFile found the file", () => {
  test("reads the file the path still names", () => {
    expect(sourceTextAt(ROOT, "kept.txt", found("kept.txt"))).toEqual({
      kind: "text",
      lines: ["swap"],
    });
  });

  test("refuses the file swapped for a link out of the root between the check and the open", () => {
    const file = found("swapped.txt");
    rmSync(file);
    symlinkSync(join(top, "elsewhere", "secret.txt"), file);
    const read = sourceTextAt(ROOT, "swapped.txt", file);

    expect(read).toMatchObject({ kind: "refused", why: "unreadable" });
    expect(JSON.stringify(read)).not.toContain("a secret");
  });

  test("refuses a folder on the path swapped for a link out of the root between the check and the open", () => {
    mkdirSync(join(ROOT, "flip"));
    writeFileSync(join(top, "elsewhere", "flipped.txt"), "a secret too\n");
    const file = found("flip/flipped.txt");
    renameSync(join(ROOT, "flip"), join(ROOT, "flip-was"));
    symlinkSync(join(top, "elsewhere"), join(ROOT, "flip"));
    const read = sourceTextAt(ROOT, "flip/flipped.txt", file);

    expect(read).toMatchObject({ kind: "refused", why: "outside" });
    expect(JSON.stringify(read)).not.toContain("a secret");
  });

  test("refuses the file swapped for another under the root between the check and the open", () => {
    const file = found("moved.txt");
    renameSync(file, join(ROOT, "moved-was.txt"));
    writeFileSync(join(ROOT, "other.txt"), "another\n");
    renameSync(join(ROOT, "other.txt"), file);

    expect(sourceTextAt(ROOT, "moved.txt", join(ROOT, "moved-was.txt"))).toEqual({
      kind: "refused",
      why: "outside",
      reason: "moved.txt named another file while it was opened",
    });
  });

  // Opened for reading without O_NONBLOCK, a FIFO waits for a writer and blocks the thread for
  // good: the read runs in a process of its own, which the spec ends after a deadline.
  test("refuses a FIFO swapped in between the check and the open, at once, waiting for no writer", async () => {
    const file = found("pipe.txt");
    rmSync(file);

    expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);

    const call = `sourceTextAt(${JSON.stringify(ROOT)}, "pipe.txt", ${JSON.stringify(file)})`;

    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { sourceTextAt } from ${JSON.stringify(join(import.meta.dir, "sources.ts"))};\nconsole.log(JSON.stringify(${call}));`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );

    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => "hung")]);

    if (code === "hung") {
      child.kill("SIGKILL");
    }

    expect(code).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({
      kind: "refused",
      why: "missing",
    });
  }, 10_000);

  test.skipIf(process.getuid?.() === 0)(
    "refuses a file the filesystem will not read, as a refusal and not a throw",
    () => {
      const file = found("locked.txt");
      chmodSync(file, 0o000);

      const read = sourceText(ROOT, "locked.txt");

      expect(read).toMatchObject({ kind: "refused", why: "unreadable" });
      expect(read.kind === "refused" ? read.reason : "").toStartWith("locked.txt cannot be read: ");

      chmodSync(file, 0o600);
    },
  );
});

describe("sourceText", () => {
  test("reads bytes that are not UTF-8 as U+FFFD, and refuses a NUL byte", () => {
    writeFileSync(join(ROOT, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78]));
    writeFileSync(join(ROOT, "nul.bin"), Buffer.from([0x61, 0x00, 0x0a]));

    expect(sourceText(ROOT, "latin1.txt")).toEqual({ kind: "text", lines: ["caf�", "x"] });
    expect(sourceText(ROOT, "nul.bin")).toEqual({
      kind: "refused",
      why: "binary",
      reason: "nul.bin is a binary file: it holds a NUL byte",
    });
  });

  test("refuses a file over the cap it takes, SOURCE_CAP_BYTES unless told, and reads it under a larger one", () => {
    writeFileSync(join(ROOT, "big.txt"), `${"a".repeat(SOURCE_CAP_BYTES)}\nlast\n`);

    expect(sourceText(ROOT, "big.txt")).toEqual({
      kind: "refused",
      why: "large",
      reason: `big.txt is over ${SOURCE_CAP_BYTES} bytes`,
    });

    const read = sourceText(ROOT, "big.txt", Number.POSITIVE_INFINITY);

    expect(read.kind === "text" ? read.lines.length : read.reason).toBe(2);
  });
});

test("textLines counts a last line with or without its newline, and none in an empty text", () => {
  expect(textLines("one\ntwo\n")).toEqual(["one", "two"]);
  expect(textLines("one\r\ntwo")).toEqual(["one", "two"]);
  expect(textLines("one\n\n")).toEqual(["one", ""]);
  expect(textLines("")).toEqual([]);
});
