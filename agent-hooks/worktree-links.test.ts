import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { linkUnlessPresent } from "./worktree-links.ts";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-hooks-links-")));
  mkdirSync(path.join(dir, "main/node_modules"), { recursive: true });
  mkdirSync(path.join(dir, "other/node_modules"), { recursive: true });
  mkdirSync(path.join(dir, "worktree"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("linkUnlessPresent", () => {
  test("keeps the link a session starting beside this one made first", () => {
    const link = path.join(dir, "worktree/node_modules");
    symlinkSync(path.join(dir, "other/node_modules"), link);

    linkUnlessPresent(path.join(dir, "main/node_modules"), link);

    expect(readlinkSync(link)).toBe(path.join(dir, "other/node_modules"));
  });

  test("any other failure still throws", () => {
    expect(() =>
      linkUnlessPresent(
        path.join(dir, "main/node_modules"),
        path.join(dir, "worktree/missing/node_modules"),
      ),
    ).toThrow("ENOENT");
  });
});
