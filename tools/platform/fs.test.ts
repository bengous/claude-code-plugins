import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createExclusiveSync,
  isHeld,
  rename,
  renameSync,
  writeAtomic,
  writeAtomicSync,
} from "./fs.ts";
import { errnoOf } from "./pure.ts";

const WINDOWS = process.platform === "win32";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "platform-fs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Holds a file of `folder` open, which on Windows refuses the folder's rename; answers the release. */
function holdFolder(folder: string): () => void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "held.txt"), "held");
  const fd = openSync(join(folder, "held.txt"), "r");

  return () => closeSync(fd);
}

describe("writeAtomic and writeAtomicSync", () => {
  test.each([
    ["async", (file: string, data: string | Uint8Array) => writeAtomic(file, data)],
    ["sync", (file: string, data: string | Uint8Array) => writeAtomicSync(file, data)],
  ] as const)("%s: replace the file whole and leave no scratch file", async (_, write) => {
    const file = join(dir, "state.json");
    writeFileSync(file, "old");

    await write(file, "new");
    await write(join(dir, "bytes.bin"), new Uint8Array([0, 255, 10]));

    expect(readFileSync(file, "utf8")).toBe("new");
    expect([...readFileSync(join(dir, "bytes.bin"))]).toEqual([0, 255, 10]);
    expect(readdirSync(dir).toSorted()).toEqual(["bytes.bin", "state.json"]);
  });

  test("mkdir creates the file's missing directories", async () => {
    await writeAtomic(join(dir, "a", "b", "x.txt"), "x", { mkdir: true });
    writeAtomicSync(join(dir, "c", "y.txt"), "y", { mkdir: true });

    expect(readFileSync(join(dir, "a", "b", "x.txt"), "utf8")).toBe("x");
    expect(readFileSync(join(dir, "c", "y.txt"), "utf8")).toBe("y");
  });

  test("without mkdir, a missing directory fails the write", async () => {
    expect(
      errnoOf(await writeAtomic(join(dir, "none", "x"), "x").catch((cause: unknown) => cause)),
    ).toBe("ENOENT");
    expect(() => writeAtomicSync(join(dir, "none", "x"), "x")).toThrow(/ENOENT/u);
  });

  test("a rename that fails removes the scratch file and leaves the target", async () => {
    const target = join(dir, "taken");
    mkdirSync(target);
    writeFileSync(join(target, "inside"), "kept");

    await expect(writeAtomic(target, "x")).rejects.toThrow();
    expect(() => writeAtomicSync(target, "x")).toThrow();
    expect(readdirSync(dir)).toEqual(["taken"]);
    expect(readFileSync(join(target, "inside"), "utf8")).toBe("kept");
  });
});

describe("rename and renameSync", () => {
  test("move a file", async () => {
    writeFileSync(join(dir, "a"), "a");
    await rename(join(dir, "a"), join(dir, "b"));
    renameSync(join(dir, "b"), join(dir, "c"));

    expect(readdirSync(dir)).toEqual(["c"]);
  });

  test("a missing source throws its errno at once", async () => {
    const started = Date.now();

    expect(
      errnoOf(
        await rename(join(dir, "none"), join(dir, "x"), { heldRetryMs: 2000 }).catch(
          (cause: unknown) => cause,
        ),
      ),
    ).toBe("ENOENT");
    expect(() => renameSync(join(dir, "none"), join(dir, "x"), { heldRetryMs: 2000 })).toThrow(
      /ENOENT/u,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test.if(WINDOWS)(
    "a folder Windows holds is renamed again until it lets go, within heldRetryMs",
    async () => {
      const release = holdFolder(join(dir, "from"));
      setTimeout(release, 300);
      await rename(join(dir, "from"), join(dir, "to"), { heldRetryMs: 2000 });

      expect(existsSync(join(dir, "to", "held.txt"))).toBe(true);
    },
  );

  test.if(WINDOWS)("a folder held past heldRetryMs throws what isHeld names", async () => {
    const release = holdFolder(join(dir, "from"));
    const started = Date.now();

    const thrown = await rename(join(dir, "from"), join(dir, "to"), {
      heldRetryMs: 200,
    }).catch((cause: unknown) => cause);

    release();

    expect(isHeld(thrown)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  test.if(WINDOWS)("renameSync retries a held folder for heldRetryMs, then throws", () => {
    const release = holdFolder(join(dir, "from"));
    const started = Date.now();

    const thrown = (() => {
      try {
        renameSync(join(dir, "from"), join(dir, "to"), { heldRetryMs: 200 });

        return null;
      } catch (cause) {
        return cause;
      } finally {
        release();
      }
    })();

    expect(isHeld(thrown)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});

describe("isHeld", () => {
  test.if(!WINDOWS)("is false off Windows, where a held folder renames", () => {
    expect(isHeld(coded("EBUSY"))).toBe(false);
    expect(isHeld(coded("EPERM"))).toBe(false);
  });

  test.if(WINDOWS)("on Windows, EBUSY, EPERM and EACCES are held, nothing else", () => {
    expect(["EBUSY", "EPERM", "EACCES", "ENOENT"].map((code) => isHeld(coded(code)))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  test("a value with no code is never held", () => {
    expect(isHeld(new Error("EBUSY"))).toBe(false);
    expect(isHeld("EBUSY")).toBe(false);
  });
});

describe("createExclusiveSync", () => {
  test("creates the file, true, and leaves no scratch file", () => {
    expect(createExclusiveSync(join(dir, "id.json"), "first")).toBe(true);
    expect(readFileSync(join(dir, "id.json"), "utf8")).toBe("first");
    expect(readdirSync(dir)).toEqual(["id.json"]);
  });

  test("false when the file exists, which keeps its content", () => {
    writeFileSync(join(dir, "id.json"), "first");

    expect(createExclusiveSync(join(dir, "id.json"), "second")).toBe(false);
    expect(readFileSync(join(dir, "id.json"), "utf8")).toBe("first");
    expect(readdirSync(dir)).toEqual(["id.json"]);
  });

  test("any other failure throws", () => {
    expect(() => createExclusiveSync(join(dir, "none", "id.json"), "x")).toThrow(/ENOENT/u);
  });
});
