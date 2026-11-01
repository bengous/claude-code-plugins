import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { command } from "./headless-run.ts";

describe("command", () => {
  test("answers the exit code and the output untrimmed", () => {
    expect(
      command(["sh", "-c", "printf ' out \\n'; printf ' err \\n' >&2; exit 3"], tmpdir()),
    ).toEqual({
      code: 3,
      out: " out \n",
      err: " err \n",
    });
  });

  test("answers 127 for a binary missing from PATH, as a shell does", () => {
    expect(command(["no-such-program-on-the-path", "x"], tmpdir())).toEqual({
      code: 127,
      out: "",
      err: 'no-such-program-on-the-path: Executable not found in $PATH: "no-such-program-on-the-path"',
    });
  });

  test("answers 127 for a program that cannot start in a directory gone from disk", () => {
    const result = command(["sh", "-c", "true"], join(tmpdir(), "no-such-directory-here"));

    expect([result.code, result.out]).toEqual([127, ""]);
    expect(result.err).toStartWith("sh: ENOENT");
  });
});
