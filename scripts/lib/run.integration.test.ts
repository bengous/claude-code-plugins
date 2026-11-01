import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { run, runRaw } from "./run.ts";

describe("run", () => {
  test("answers whether the command exited 0, its stdout as bytes and trimmed, its stderr trimmed", () => {
    const result = run(["sh", "-c", "printf ' out \\n'; printf ' err \\n' >&2; exit 3"], tmpdir());

    expect(result.ok).toBe(false);
    expect(new TextDecoder().decode(result.raw)).toBe(" out \n");
    expect([result.out, result.err]).toEqual(["out", "err"]);
  });

  test("feeds stdin to the command", () => {
    const result = run(["cat"], tmpdir(), new TextEncoder().encode("fed\n"));

    expect([result.ok, result.out]).toEqual([true, "fed"]);
  });

  test("throws for a program the PATH lacks, naming it", () => {
    expect(() => run(["no-such-program-on-the-path"], tmpdir())).toThrow(
      'Executable not found in $PATH: "no-such-program-on-the-path"',
    );
  });
});

describe("runRaw", () => {
  test("answers the exit code, stdout as bytes and stderr as they came, a string stdin fed", () => {
    const ran = runRaw(["sh", "-c", "cat; printf ' err \\n' >&2; exit 3"], tmpdir(), " in \n");

    expect([ran.code, ran.raw.toString(), ran.err]).toEqual([3, " in \n", " err \n"]);
  });

  test("throws for an empty command and for a program the PATH lacks", () => {
    expect(() => runRaw([], tmpdir())).toThrow("cmd must not be empty");
    expect(() => runRaw(["no-such-program-on-the-path"], tmpdir())).toThrow(
      'Executable not found in $PATH: "no-such-program-on-the-path"',
    );
  });
});
