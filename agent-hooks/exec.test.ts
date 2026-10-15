import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";

import type { RunResult } from "./exec.ts";
import {
  deadlineIn,
  formatFailure,
  outputOf,
  resolveProgram,
  run,
  succeeded,
  tail,
} from "./exec.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  removeTempRepo,
  scrubGitEnv,
  writeRepoFile,
} from "./test-support.ts";

let temp: TempRepo;

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo("agent-hooks-exec-");
});

afterEach(() => {
  delete process.env["AGENT_HOOKS_TEST_X"];
  removeTempRepo(temp);
});

function sh(
  script: string,
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<RunResult> {
  return run(["sh", "-c", script], { cwd: temp.repo, timeoutMs: 5000, ...options });
}

describe("run", () => {
  test("captures stdout, stderr and the exit code", async () => {
    expect(await sh("echo out; echo err >&2; exit 3")).toEqual({
      kind: "exited",
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  test("runs in cwd", async () => {
    expect(await sh("pwd")).toMatchObject({ kind: "exited", code: 0, stdout: `${temp.repo}\n` });
  });

  test("transmits stdin", async () => {
    expect(
      await run(["cat"], { cwd: temp.repo, timeoutMs: 5000, stdin: "hello\nworld" }),
    ).toMatchObject({
      kind: "exited",
      code: 0,
      stdout: "hello\nworld",
    });
  });

  test("passes the current process env", async () => {
    process.env["AGENT_HOOKS_TEST_X"] = "1";

    expect(await sh("echo $AGENT_HOOKS_TEST_X")).toMatchObject({ kind: "exited", stdout: "1\n" });
  });

  test("the env option overrides the process env", async () => {
    process.env["AGENT_HOOKS_TEST_X"] = "1";

    expect(
      await sh("echo $AGENT_HOOKS_TEST_X", { env: { AGENT_HOOKS_TEST_X: "2" } }),
    ).toMatchObject({
      kind: "exited",
      stdout: "2\n",
    });
  });

  test("a timeout returns timedOut within the grace period while the shell's child keeps running", async () => {
    const start = Date.now();

    const result = await run(["sh", "-c", "sleep 3; echo late"], {
      cwd: temp.repo,
      timeoutMs: 300,
    });

    expect(result.kind).toBe("timedOut");
    expect(result).toMatchObject({ timeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(2500);
  });

  test("a timeout keeps the output printed before the kill", async () => {
    const result = await run(["sh", "-c", "echo early; exec sleep 3"], {
      cwd: temp.repo,
      timeoutMs: 300,
    });

    expect(result).toMatchObject({ kind: "timedOut", stdout: "early\n" });
  });

  test("timeoutMs <= 0 is timedOut without spawning", async () => {
    const timeouts = [0, -5];

    const results = await Promise.all(
      timeouts.map((timeoutMs) => run(["no-such-binary-xyz"], { cwd: temp.repo, timeoutMs })),
    );

    expect(results).toEqual(
      timeouts.map((timeoutMs) => ({ kind: "timedOut", timeoutMs, stdout: "", stderr: "" })),
    );
  });

  test("a missing binary is missing", async () => {
    expect(await run(["no-such-binary-xyz"], { cwd: temp.repo, timeoutMs: 5000 })).toEqual({
      kind: "missing",
      program: "no-such-binary-xyz",
    });
  });

  test("succeeded only for exit code 0", async () => {
    expect(succeeded(await sh("exit 0"))).toBe(true);
    expect(succeeded(await sh("exit 1"))).toBe(false);
    expect(succeeded({ kind: "missing", program: "x" })).toBe(false);
  });
});

describe("resolveProgram", () => {
  test("the package bin dir wins over the root's, which wins over PATH", () => {
    const pkg = path.join(temp.repo, "apps", "web");
    const inPkg = fakeTool(pkg, "sh", "exit 0");
    const inRoot = fakeTool(temp.repo, "sh", "exit 0");

    expect(resolveProgram("sh", pkg, temp.repo)).toBe(inPkg);

    rmSync(inPkg);

    expect(resolveProgram("sh", pkg, temp.repo)).toBe(inRoot);

    rmSync(inRoot);

    expect(resolveProgram("sh", pkg, temp.repo)).toBe(Bun.which("sh"));
  });

  test("an unknown name is null", () => {
    expect(resolveProgram("no-such-binary-xyz", temp.repo, temp.repo)).toBeNull();
  });

  test("a name with a slash resolves against the root", () => {
    writeRepoFile(temp.repo, "scripts/check.sh", "#!/bin/sh\n");
    const pkg = path.join(temp.repo, "apps", "web");

    expect(resolveProgram("scripts/check.sh", pkg, temp.repo)).toBe(
      path.join(temp.repo, "scripts/check.sh"),
    );
    expect(resolveProgram("./scripts/check.sh", pkg, temp.repo)).toBe(
      path.join(temp.repo, "scripts/check.sh"),
    );
    expect(resolveProgram("scripts/missing.sh", pkg, temp.repo)).toBeNull();
  });
});

describe("formatFailure", () => {
  test("exited with output shows the label and the output, stderr first", () => {
    expect(
      formatFailure("lint", { kind: "exited", code: 1, stdout: "out\n", stderr: "err\n" }),
    ).toBe("lint\nerr\nout");
  });

  test("exited without output shows the code", () => {
    expect(formatFailure("lint", { kind: "exited", code: 2, stdout: "", stderr: "  \n" })).toBe(
      "lint exited with code 2",
    );
  });

  test("timedOut shows the timeout, then the output when there is one", () => {
    expect(
      formatFailure("test", { kind: "timedOut", timeoutMs: 300, stdout: "", stderr: "" }),
    ).toBe("test timed out after 300 ms");
    expect(
      formatFailure("test", { kind: "timedOut", timeoutMs: 300, stdout: "partial\n", stderr: "" }),
    ).toBe("test timed out after 300 ms\npartial");
  });

  test("missing shows the program", () => {
    expect(formatFailure("lint", { kind: "missing", program: "oxlint" })).toBe(
      "lint: command not found: oxlint",
    );
    expect(outputOf({ kind: "missing", program: "oxlint" })).toBe("command not found: oxlint");
  });

  test("keeps the last N lines of the output", () => {
    const stdout = ["1", "2", "3", "4", "5"].join("\n");

    expect(formatFailure("lint", { kind: "exited", code: 1, stdout, stderr: "" }, 2)).toBe(
      "lint\n4\n5",
    );
  });
});

describe("tail", () => {
  test("keeps the last N non-empty lines", () => {
    expect(tail("a\n\nb\r\nc\nd\n", 3)).toBe("b\nc\nd");
  });

  test("keeps every line when there are fewer than N", () => {
    expect(tail("a\nb", 10)).toBe("a\nb");
  });
});

describe("deadlineIn", () => {
  test("remaining counts down from the start", () => {
    const remaining = deadlineIn(10_000).remaining();

    expect(remaining).toBeGreaterThan(9000);
    expect(remaining).toBeLessThanOrEqual(10_000);
  });

  test("remaining is never negative", () => {
    expect(deadlineIn(100, Date.now() - 5000).remaining()).toBe(0);
    expect(deadlineIn(-100).remaining()).toBe(0);
  });
});
