import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lintStatePath, planDigest, verdict } from "./gate-plan.ts";
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
  test("ignores the session line the plan file may gain between two calls", () => {
    expect(planDigest(`<!-- session_id: abc -->\n${FAULTY}`)).toBe(planDigest(FAULTY));
  });

  test("ignores the blank lines around the plan, as harnessPlanFile does", () => {
    expect(planDigest(`\n${FAULTY}\n\n`)).toBe(planDigest(FAULTY));
  });
});

describe("lintStatePath", () => {
  test("lives in the user's own ~/.claude, one file per session and per agent", () => {
    expect(lintStatePath("/h", "abc")).toBe("/h/.claude/plans/lint/abc.sha256");
    expect(lintStatePath("/h", "abc", "a1")).toBe("/h/.claude/plans/lint/abc/a1.sha256");
  });

  test("an id that is no file name yields null", () => {
    expect(lintStatePath("/h", "../x")).toBeNull();
    expect(lintStatePath("/h", "abc", "a/b")).toBeNull();
  });
});

describe("hook", () => {
  const hook = join(import.meta.dir, "gate-plan.ts");

  function run(tmp: string, stdin: string) {
    const result = Bun.spawnSync(["bun", hook], {
      stdin: Buffer.from(stdin),
      env: { ...process.env, HOME: tmp },
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
    expect(readdirSync(join(tmp, ".claude", "plans", "lint"))).toEqual([]);
    expect(JSON.parse(submit(tmp, FAULTY).stdout)).toHaveProperty("hookSpecificOutput");
  });

  test("a plan the lint denies is not captured; the plan it lets through is", () => {
    const tmp = makeTmp();
    const stored = join(tmp, ".claude", "plans", "by-session", "s1.md");
    const payload = JSON.stringify({ session_id: "s1", cwd: tmp, tool_input: { plan: FAULTY } });

    expect(JSON.parse(run(tmp, payload).stdout)).toHaveProperty("hookSpecificOutput");
    expect(existsSync(stored)).toBe(false);

    expect(run(tmp, payload)).toEqual({ stdout: "", exitCode: 0 });
    expect(readFileSync(stored, "utf8")).toBe(`<!-- session_id: s1 -->\n${FAULTY}`);
  });

  test("ExitPlanMode runs one hook, so no capture runs beside a denial", async () => {
    const config = await Bun.file(join(import.meta.dir, "..", "hooks", "hooks.json")).text();
    const commands = config.match(/scripts\/[\w-]+\.ts/gu) ?? [];

    expect(commands).toContain("scripts/gate-plan.ts");
    expect(commands).not.toContain("scripts/capture-plan.ts");
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
