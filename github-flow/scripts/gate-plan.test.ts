import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planDigest, statePath, verdict } from "./gate-plan.ts";
import { lintPlan } from "./plan-lint.ts";

const FAULTY = "# Plan\n\n- Storage: TBD\n";

const CLEAN = "# Plan\n\n- Storage: SQLite, the one the app ships.\n";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeTmp(): string {
  const tmp = mkdtempSync(join(tmpdir(), "gate-plan-"));
  tmpDirs.push(tmp);

  return tmp;
}

describe("verdict", () => {
  test("a clean plan passes", () => {
    expect(verdict([], planDigest(CLEAN), null)).toEqual({ kind: "pass" });
  });

  test("a faulty plan is denied with its findings and the way out", () => {
    const result = verdict(lintPlan(FAULTY), planDigest(FAULTY), null);

    expect(result.kind).toBe("deny");
    expect(result.kind === "deny" && result.reason).toContain("line 3: placeholder:");
    expect(result.kind === "deny" && result.reason).toContain("with the plan unchanged");
  });

  test("the plan last denied, submitted again, is waived", () => {
    const digest = planDigest(FAULTY);

    expect(verdict(lintPlan(FAULTY), digest, digest)).toEqual({ kind: "waive" });
  });

  test("another faulty plan after a denial is denied again", () => {
    const other = `${FAULTY}- Port: TBC\n`;

    expect(verdict(lintPlan(other), planDigest(other), planDigest(FAULTY)).kind).toBe("deny");
  });
});

describe("planDigest", () => {
  test("ignores the session line capture-plan.ts may add between two calls", () => {
    expect(planDigest(`<!-- session_id: abc -->\n${FAULTY}`)).toBe(planDigest(FAULTY));
  });
});

describe("statePath", () => {
  test("one file per session, and per agent inside it", () => {
    expect(statePath("/s", "abc")).toBe("/s/abc");
    expect(statePath("/s", "abc", "a1")).toBe("/s/abc.a1");
  });

  test("an id that is no file name yields null", () => {
    expect(statePath("/s", "../x")).toBeNull();
    expect(statePath("/s", "abc", "a/b")).toBeNull();
  });
});

describe("hook", () => {
  const hook = join(import.meta.dir, "gate-plan.ts");

  function run(tmp: string, stdin: string) {
    const result = Bun.spawnSync(["bun", hook], {
      stdin: Buffer.from(stdin),
      env: { ...process.env, TMPDIR: tmp },
    });

    return { stdout: result.stdout.toString(), exitCode: result.exitCode };
  }

  function submit(tmp: string, plan: string) {
    return run(tmp, JSON.stringify({ session_id: "s1", tool_input: { plan } }));
  }

  test("denies a faulty plan once, then lets the same plan through every time", () => {
    const tmp = makeTmp();
    const first = submit(tmp, FAULTY);

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("line 3: placeholder:"),
      },
    });

    expect(submit(tmp, FAULTY)).toEqual({ stdout: "", exitCode: 0 });
    expect(submit(tmp, FAULTY)).toEqual({ stdout: "", exitCode: 0 });
  });

  test("a clean plan passes in silence and clears the session's state", () => {
    const tmp = makeTmp();
    submit(tmp, FAULTY);

    expect(submit(tmp, CLEAN)).toEqual({ stdout: "", exitCode: 0 });
    expect(readdirSync(join(tmp, "github-flow-plan-lint"))).toEqual([]);
    expect(JSON.parse(submit(tmp, FAULTY).stdout)).toHaveProperty("hookSpecificOutput");
  });

  test("malformed input, no plan or no session lets the call through", () => {
    const tmp = makeTmp();

    expect(run(tmp, "{oops")).toEqual({ stdout: "", exitCode: 0 });
    expect(run(tmp, JSON.stringify({ session_id: "s1", tool_input: {} }))).toEqual({
      stdout: "",
      exitCode: 0,
    });
    expect(run(tmp, JSON.stringify({ tool_input: { plan: FAULTY } }))).toEqual({
      stdout: "",
      exitCode: 0,
    });
  });
});
