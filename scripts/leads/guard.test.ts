import { describe, expect, test } from "bun:test";

import { decideTool, guard, type Mode } from "./guard.ts";

const ROOT = "/work/claude-code-plugins";

function bash(mode: Mode, command: string) {
  return decideTool(mode, { tool_name: "Bash", tool_input: { command }, cwd: ROOT }, ROOT);
}

function tool(mode: Mode, name: string, input: Readonly<Record<string, string>>) {
  return decideTool(mode, { tool_name: name, tool_input: input, cwd: ROOT }, ROOT);
}

describe("the gate's mode", () => {
  test.each([
    "bun ./scripts/leads/gate.ts collect",
    "bun ./scripts/leads/gate.ts collect --since 30d --stats",
    "bun ./scripts/leads/gate.ts decide --file .leads/verdicts.json",
    "  bun  ./scripts/leads/gate.ts   collect  ",
  ])("%s passes", (command) => {
    expect(bash("gate", command)).toEqual({ kind: "allow" });
  });

  test.each([
    "bun ./scripts/leads/gate.ts collect --max 999",
    "bun ./scripts/leads/gate.ts collect --since 999d",
    "bun ./scripts/leads/gate.ts collect; gh issue create",
    "bun ./scripts/leads/gate.ts collect && git push",
    "bun ./scripts/leads/gate.ts collect | tee x",
    "bun ./scripts/leads/gate.ts collect `id`",
    "bun ./scripts/leads/gate.ts collect $(id)",
    "bun ./scripts/leads/gate.ts collect > .leads/gate.json",
    "bun ./scripts/leads/gate.ts collect\ngh issue create",
    "bun ./scripts/leads/gate.ts decide --file '.leads/verdicts.json'",
    "bun ./scripts/leads/gate.ts decide --file /tmp/verdicts.json",
    "bun ./scripts/leads/scan.ts claim --tier minor",
    "bun ./scripts/leads/scan.ts release --issue 412 --file .leads/412-release.json",
    "LEADS_DRY_RUN=0 bun ./scripts/leads/gate.ts collect",
    "gh api -X POST repos/o/r/issues",
    "git push origin dev",
    "curl https://example.com",
    "cat /proc/self/environ",
  ])("%s is denied", (command) => {
    expect(bash("gate", command).kind).toBe("deny");
  });

  test("it writes the verdicts alone and reads nothing", () => {
    expect(tool("gate", "Write", { file_path: ".leads/verdicts.json" })).toEqual({ kind: "allow" });
    expect(tool("gate", "Write", { file_path: ".leads/gate.json" }).kind).toBe("deny");
    expect(tool("gate", "Write", { file_path: ".leads/412-leads.json" }).kind).toBe("deny");
    expect(tool("gate", "Read", { file_path: ".leads/gate.json" }).kind).toBe("deny");
    expect(tool("gate", "Read", { file_path: "README.md" }).kind).toBe("deny");
  });

  test("it invokes its own skill alone", () => {
    expect(tool("gate", "Skill", { skill: "leads-gate" })).toEqual({ kind: "allow" });
    expect(tool("gate", "Skill", { skill: "leads-scan" }).kind).toBe("deny");
  });
});

describe("the scan's mode", () => {
  test.each([
    "bun ./scripts/leads/scan.ts claim --tier minor",
    "bun ./scripts/leads/scan.ts claim --tier major --issue 412",
    "bun ./scripts/leads/scan.ts search --issue 412 --query .leads/412-query.txt",
    "bun ./scripts/leads/scan.ts publish --issue 412 --leads .leads/412-leads.json",
    "bun ./scripts/leads/scan.ts release --issue 412 --file .leads/412-release.json",
  ])("%s passes", (command) => {
    expect(bash("scan", command)).toEqual({ kind: "allow" });
  });

  test.each([
    "bun ./scripts/leads/scan.ts publish --issue 412 --leads .leads/413-leads.json",
    "bun ./scripts/leads/scan.ts search --issue 412 --query .leads/413-query.txt",
    "bun ./scripts/leads/gate.ts collect",
    "bun ./scripts/leads/gate.ts decide --file .leads/verdicts.json",
    "grep -rn useStore .leads/412",
    "find .leads/412 -name x",
    "sed -i s/a/b/ scripts/leads/guard.ts",
    "bun ./scripts/land.ts feature/x",
  ])("%s is denied", (command) => {
    expect(bash("scan", command).kind).toBe("deny");
  });

  test.each([
    ["Write", ".leads/412-leads.json"],
    ["Write", `${ROOT}/.leads/412-query.txt`],
    ["Edit", ".leads/412-release.json"],
  ])("%s %s passes", (name, path) => {
    expect(tool("scan", name, { file_path: path })).toEqual({ kind: "allow" });
  });

  test.each([
    ["Write", ".leads/verdicts.json"],
    ["Write", ".leads/412-claim.json"],
    ["Write", ".leads/412/vellum/a.ts"],
    ["Write", "scripts/leads/guard.ts"],
    ["Edit", ".claude/settings.json"],
    ["Write", "../elsewhere/.leads/412-leads.json"],
    ["Write", "/tmp/.leads/412-leads.json"],
    ["NotebookEdit", ".leads/412-leads.json"],
  ])("%s %s is denied", (name, path) => {
    expect(tool("scan", name, { file_path: path }).kind).toBe("deny");
  });

  test.each([
    ["Read", { file_path: ".leads/412/vellum/src/runtime/page/state.ts" }],
    ["Read", { file_path: `${ROOT}/.leads/412/vellum/a.ts` }],
    ["Read", { file_path: ".leads/412-notes.md" }],
    ["Read", { file_path: ".leads/412-types.diff" }],
    ["Grep", { pattern: "zustand", path: ".leads/412" }],
    ["Glob", { pattern: "**/*.ts", path: ".leads/412/vellum" }],
  ])("%s %o passes", (name, input) => {
    expect(tool("scan", name, input)).toEqual({ kind: "allow" });
  });

  test.each([
    ["Read", { file_path: "/proc/self/environ" }],
    ["Read", { file_path: "../../.config/gh/hosts.yml" }],
    ["Read", { file_path: ".git/config" }],
    ["Read", { file_path: ".leads/412/.git" }],
    ["Read", { file_path: ".leads/412/vellum/.git/config" }],
    ["Read", { file_path: ".private/plans/x.md" }],
    ["Read", { file_path: "TODO.md" }],
    ["Read", { file_path: ".leads/412-claim.json" }],
    ["Grep", { pattern: "token" }],
    ["Glob", { pattern: "/proc/**", path: ".leads/412" }],
    ["Glob", { pattern: "../**/*.yml", path: ".leads/412" }],
  ])("%s %o is denied", (name, input) => {
    expect(tool("scan", name, input).kind).toBe("deny");
  });

  test("it invokes its own skill alone; any other tool is denied", () => {
    expect(tool("scan", "Skill", { skill: "leads-scan" })).toEqual({ kind: "allow" });
    expect(tool("scan", "Skill", { skill: "leads-gate" }).kind).toBe("deny");
    expect(tool("scan", "Skill", { skill: "github-flow:dispatch" }).kind).toBe("deny");
    expect(tool("scan", "WebFetch", { url: "https://example.com" }).kind).toBe("deny");
    expect(tool("scan", "mcp__github__create_issue", { title: "x" }).kind).toBe("deny");
    expect(tool("scan", "Agent", { prompt: "x" }).kind).toBe("deny");
  });
});

describe("the hook's output", () => {
  test("a deny is PreToolUse's decision with its reason; an allow prints nothing", () => {
    const denied = guard(
      "gate",
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: ROOT }),
      ROOT,
      ROOT,
    );

    expect(JSON.parse(denied ?? "{}")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });

    expect(
      guard(
        "gate",
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "bun ./scripts/leads/gate.ts collect" },
          cwd: ROOT,
        }),
        ROOT,
        ROOT,
      ),
    ).toBeNull();
  });

  test("an input it cannot read, or a hook with no mode, is denied", () => {
    expect(guard("gate", "not json", undefined, ROOT)).toContain('"permissionDecision":"deny"');
    expect(guard(undefined, "{}", ROOT, ROOT)).toContain('"permissionDecision":"deny"');
  });

  test("the checkout is the project's, so a cwd moved elsewhere reads nothing outside it", () => {
    expect(
      guard(
        "scan",
        JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" }, cwd: "/tmp" }),
        ROOT,
        ROOT,
      ),
    ).toContain('"permissionDecision":"deny"');
  });
});
