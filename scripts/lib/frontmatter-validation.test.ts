import { describe, expect, test } from "bun:test";
import { checkKeys, classifyComponent, validateFrontmatter } from "./frontmatter-validation";

describe("classifyComponent", () => {
  test("excludes archive/ entirely", () => {
    expect(classifyComponent("archive/effect-tooling/agents/refactorlib-infra.md")).toBeNull();
    expect(classifyComponent("archive/effect-tooling/skills/foo/SKILL.md")).toBeNull();
  });

  test("classifies .claude/rules/ before the agents/ pattern", () => {
    expect(classifyComponent(".claude/rules/agents/agent-patterns.md")).toBe("rule");
    expect(classifyComponent(".claude/rules/publishing/marketplace.md")).toBe("rule");
  });

  test("classifies plugin and repo-level agents", () => {
    expect(classifyComponent("orchestration/agents/architect.md")).toBe("agent");
    expect(classifyComponent(".claude/agents/plan-reference-auditor.md")).toBe("agent");
  });

  test("classifies only SKILL.md as a skill under skills/", () => {
    expect(classifyComponent("clean-comments/skills/clean-comments/SKILL.md")).toBe("skill");
    expect(classifyComponent(".claude/skills/validate-plugins/SKILL.md")).toBe("skill");
    expect(
      classifyComponent("context-management/skills/context-audit/references/templates.md"),
    ).toBeNull();
  });

  test("classifies commands, nested included", () => {
    expect(classifyComponent("git-tools/commands/bisect-ci/bisect-ci.md")).toBe("command");
    expect(classifyComponent(".claude/commands/commit-plugin.md")).toBe("command");
  });

  test("returns null for hook markdown and unrelated files", () => {
    expect(classifyComponent("orchestration/hooks/notes.md")).toBeNull();
    expect(classifyComponent("README.md")).toBeNull();
  });
});

describe("checkKeys — agent", () => {
  test("rejects allowed-tools with the corrective suggestion", () => {
    const result = checkKeys("agent", {
      name: "a",
      description: "d",
      "allowed-tools": ["Read"],
    });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].key).toBe("allowed-tools");
    expect(result.unknown[0].suggestion).toContain("tools:");
  });

  test("rejects subagent-type with a removal suggestion", () => {
    const result = checkKeys("agent", {
      name: "a",
      description: "d",
      "subagent-type": "general-purpose",
    });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0].key).toBe("subagent-type");
  });

  test("rejects hyphenated disallowed-tools, suggests camelCase", () => {
    const result = checkKeys("agent", {
      name: "a",
      description: "d",
      "disallowed-tools": "WebSearch",
    });
    expect(result.unknown[0].suggestion).toContain("disallowedTools");
  });

  test("accepts the full documented key set", () => {
    const result = checkKeys("agent", {
      name: "a",
      description: "d",
      tools: "Read, Grep",
      disallowedTools: "WebSearch",
      model: "opus",
      permissionMode: "default",
      maxTurns: 5,
      skills: "x",
      mcpServers: ["s"],
      hooks: {},
      memory: "project",
      background: true,
      effort: "high",
      isolation: "worktree",
      color: "blue",
      initialPrompt: "go",
      observer: "watcher",
      observerMessage: "m",
      observeSubagents: false,
    });
    expect(result.unknown).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });

  test("reports missing required name and description", () => {
    const result = checkKeys("agent", { model: "opus" });
    expect(result.missing).toEqual(["name", "description"]);
  });
});

describe("checkKeys — skill and command (shared schema)", () => {
  test("accepts allowed-tools and disallowed-tools", () => {
    const result = checkKeys("command", {
      description: "d",
      "allowed-tools": "Bash(gh:*), Write",
      "disallowed-tools": "WebSearch",
      "argument-hint": "[x]",
      metadata: { tags: ["git"] },
    });
    expect(result.unknown).toHaveLength(0);
  });

  test("rejects tools with the corrective suggestion", () => {
    const result = checkKeys("skill", {
      name: "s",
      description: "d",
      tools: "Read",
    });
    expect(result.unknown[0].key).toBe("tools");
    expect(result.unknown[0].suggestion).toContain("allowed-tools");
  });

  test("rejects tags at the top level", () => {
    const result = checkKeys("command", {
      description: "d",
      tags: ["git"],
    });
    expect(result.unknown[0].key).toBe("tags");
  });

  test("skills and commands do not require name", () => {
    const result = checkKeys("command", { description: "d" });
    expect(result.missing).toHaveLength(0);
  });
});

describe("checkKeys — rule", () => {
  test("accepts paths only", () => {
    expect(checkKeys("rule", { paths: "**/agents/**" }).unknown).toHaveLength(0);
    const bad = checkKeys("rule", { paths: "**", model: "opus" });
    expect(bad.unknown[0].key).toBe("model");
  });
});

describe("validateFrontmatter (existing YAML behavior)", () => {
  test("no frontmatter stays valid with no parsed keys", () => {
    const result = validateFrontmatter("x.md", "# Just a doc\n");
    expect(result.valid).toBe(true);
    expect(result.frontmatter).toBeUndefined();
  });

  test("broken YAML stays an error", () => {
    const result = validateFrontmatter("x.md", "---\nkey: [unclosed\n---\n");
    expect(result.valid).toBe(false);
  });
});
