import { describe, expect, test } from "bun:test";

import { GitError } from "./git.ts";

describe("GitError", () => {
  test("names the command, the exit code and the trimmed stderr", () => {
    const error = new GitError(["rev-parse", "nope"], {
      kind: "exited",
      code: 128,
      stdout: "",
      stderr: "fatal: bad revision\n",
    });

    expect(error.message).toBe("git rev-parse nope failed (exit 128): fatal: bad revision");
    expect(error.name).toBe("GitError");
  });

  test("names a timeout", () => {
    const error = new GitError(["fetch"], {
      kind: "timedOut",
      timeoutMs: 50,
      stdout: "",
      stderr: "",
    });

    expect(error.message).toBe("git fetch timed out after 50 ms: ");
  });

  test("names an output let go of after the grace, an exit 0 or a timeout", () => {
    const exited = new GitError(["commit-tree", "-S"], {
      kind: "exited",
      code: 0,
      stdout: "",
      stderr: "",
      outputLost: true,
    });

    const timedOut = new GitError(["fetch"], {
      kind: "timedOut",
      timeoutMs: 50,
      stdout: "",
      stderr: "",
      outputLost: true,
    });

    expect(exited.message).toBe("git commit-tree -S exited 0, its output let go of after 1000 ms");
    expect(timedOut.message).toBe(
      "git fetch timed out after 50 ms, its output let go of after 1000 ms",
    );
  });
});
