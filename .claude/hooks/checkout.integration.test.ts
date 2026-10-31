import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { placeOf } from "./checkout.ts";
import { git } from "./git.fixture.ts";

let project = "";

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "checkout-"));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("placeOf", () => {
  // A git hook up the process tree exports GIT_DIR, which would root every
  // directory at itself.
  test("a GIT_DIR this process exports leaves a nested repository its own", async () => {
    await git(["init", "-q"], project);
    const nested = join(project, "plans");
    mkdirSync(nested);
    await git(["init", "-q"], nested);
    const inherited = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(project, ".git");

    try {
      expect(await placeOf(nested, project)).toEqual({ kind: "other-repository" });
    } finally {
      if (inherited === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = inherited;
    }
  });
});
