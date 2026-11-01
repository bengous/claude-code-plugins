import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("a toplevel whose output git let go of past the grace throws its GitError", async () => {
    await git(["init", "-q"], project);
    const bin = join(project, ".git", "held-bin");
    const path = process.env["PATH"];
    // The real git, then a `sleep` that holds its pipes past the platform's grace on a --git-common-dir.
    const held = `'${Bun.which("git")}' "$@"\ncode=$?\ncase " $* " in *" --git-common-dir "*) sleep 3 & ;; esac\nexit $code\n`;
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\n${held}`, { mode: 0o755 });
    process.env["PATH"] = `${bin}:${path ?? ""}`;

    try {
      await expect(placeOf(project, project)).rejects.toThrow(
        `git -C ${project} rev-parse --path-format=absolute --show-toplevel --git-common-dir exited 0, its output let go of after 1000 ms`,
      );
    } finally {
      process.env["PATH"] = path;
    }
  });
});
