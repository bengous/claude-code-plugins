import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideTool, guard, type Mode } from "./guard.ts";

const ROOT = "/work/claude-code-plugins";

function bash(mode: Mode, command: string) {
  return decideTool(mode, { tool_name: "Bash", tool_input: { command }, cwd: ROOT }, ROOT);
}

function tool(mode: Mode, name: string, input: Readonly<Record<string, string>>) {
  return decideTool(mode, { tool_name: name, tool_input: input, cwd: ROOT }, ROOT);
}

const SKILLS: readonly (readonly [Mode, string])[] = [
  ["gate", "leads-gate"],
  ["scan", "leads-scan"],
];

function skillText(name: string): string {
  return readFileSync(join(import.meta.dir, "../../.claude/skills", name, "SKILL.md"), "utf8");
}

/** The commands a skill shows, fenced or inline, their placeholders filled as the model fills them. */
function commandsOf(text: string): string[] {
  const fenced = [...text.matchAll(/```bash\n([\s\S]*?)```/gu)].flatMap((block) =>
    (block[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );

  const inline = [...text.matchAll(/(?<!`)`(bun [^`\n]+)`(?!`)/gu)].map((match) => match[1] ?? "");

  return [...fenced, ...inline].map((command) =>
    command.replaceAll("<tier>", "minor").replaceAll("<n>", "412"),
  );
}

/** What each rule of one tool in the skill's `allowed-tools` names. */
function rulesOf(text: string, name: "Bash" | "Edit" | "Read"): string[] {
  const line = /^allowed-tools: (.+)$/mu.exec(text)?.[1] ?? "";

  return [...line.matchAll(new RegExp(String.raw`\b${name}\(([^)]+)\)`, "gu"))].map(
    (match) => match[1] ?? "",
  );
}

/** A Bash rule as Claude Code matches it: the exact command, or a prefix when it ends in ` *`. */
function bashRule(rule: string): RegExp {
  const escaped = rule.replaceAll(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`);

  return new RegExp(`^${escaped.replace(/ \\\*$/u, "(?: .*)?")}$`, "u");
}

/** A path the file rule covers, its wildcards filled. */
function pathUnder(rule: string): string {
  return rule.replaceAll("**", "vellum/a.ts").replaceAll("*", "412");
}

function writeIn(root: string, path: string) {
  return decideTool(
    "scan",
    { tool_name: "Write", tool_input: { file_path: path }, cwd: root },
    root,
  );
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
    ["Glob", { pattern: "src/*.{ts,tsx}", path: ".leads/412/vellum" }],
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
    ["Glob", { pattern: "{..,x}/*", path: ".leads/412" }],
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

describe("each leads skill against its guard", () => {
  test.each(SKILLS)("the %s mode lets through every command the %s skill shows", (mode, name) => {
    const commands = commandsOf(skillText(name));

    expect(commands.length).toBeGreaterThan(1);
    expect(commands.filter((command) => command.includes("<"))).toEqual([]);
    expect(commands.filter((command) => bash(mode, command).kind !== "allow")).toEqual([]);
  });

  test.each(SKILLS)("the %s skill's allowed-tools hold each command of %s", (_, name) => {
    const text = skillText(name);
    const rules = rulesOf(text, "Bash").map((rule) => bashRule(rule));

    expect(commandsOf(text).filter((command) => !rules.some((rule) => rule.test(command)))).toEqual(
      [],
    );
  });

  test.each(SKILLS)(
    "the %s mode lets through each file rule of %s's allowed-tools",
    (mode, name) => {
      const text = skillText(name);

      const refused = [
        ...rulesOf(text, "Edit").filter(
          (rule) => tool(mode, "Write", { file_path: pathUnder(rule) }).kind !== "allow",
        ),
        ...rulesOf(text, "Read").filter(
          (rule) => tool(mode, "Read", { file_path: pathUnder(rule) }).kind !== "allow",
        ),
      ];

      expect(rulesOf(text, "Edit").length).toBeGreaterThan(0);
      expect(refused).toEqual([]);
    },
  );
});

describe("a checkout reached through a link", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leads-guard-"));
    mkdirSync(join(dir, "checkout"));
    symlinkSync(join(dir, "checkout"), join(dir, "link"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a file not written yet resolves inside it, whichever path names it", () => {
    const link = join(dir, "link");

    expect(writeIn(link, ".leads/412-leads.json")).toEqual({ kind: "allow" });
    expect(writeIn(link, join(link, ".leads/412-query.txt"))).toEqual({ kind: "allow" });
    expect(writeIn(link, join(dir, "checkout/.leads/412-query.txt"))).toEqual({ kind: "allow" });
  });

  test("a link inside it that leads out takes a file not written yet out with it", () => {
    const checkout = join(dir, "checkout");

    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(checkout, ".leads"));

    expect(writeIn(checkout, ".leads/412-leads.json").kind).toBe("deny");
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
