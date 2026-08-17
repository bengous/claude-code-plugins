/**
 * Pure validation functions for YAML frontmatter validation. No side effects.
 */

import { parse, YAMLParseError } from "yaml";

export type ComponentType = "agent" | "skill" | "command" | "rule";

export interface KeyViolation {
  key: string;
  suggestion?: string;
}

export interface KeyCheckResult {
  unknown: KeyViolation[];
  missing: string[];
}

// Source: code.claude.com/docs/en/sub-agents#supported-frontmatter-fields
// (observer* keys ship in the CLI schema but are not yet documented).
const AGENT_KEYS = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "maxTurns",
  "skills",
  "mcpServers",
  "hooks",
  "memory",
  "background",
  "effort",
  "isolation",
  "color",
  "initialPrompt",
  "observer",
  "observerMessage",
  "observeSubagents",
]);

// Skills and commands share one schema since commands merged into skills.
// Source: code.claude.com/docs/en/skills#frontmatter-reference
// (`disallowedTools` is a CLI-accepted camelCase alias of `disallowed-tools`).
const SKILL_COMMAND_KEYS = new Set([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "allowed-tools",
  "disallowed-tools",
  "disallowedTools",
  "model",
  "effort",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
  "metadata",
  "license",
  "compatibility",
]);

// Source: code.claude.com/docs/en/memory#path-specific-rules
const RULE_KEYS = new Set(["paths"]);

const KEYS_BY_TYPE: Record<ComponentType, Set<string>> = {
  agent: AGENT_KEYS,
  skill: SKILL_COMMAND_KEYS,
  command: SKILL_COMMAND_KEYS,
  rule: RULE_KEYS,
};

const REQUIRED_BY_TYPE: Record<ComponentType, string[]> = {
  agent: ["name", "description"],
  skill: [],
  command: [],
  rule: [],
};

// Wrong key -> the fix, per component type. These are the drift patterns that
// motivated key validation; a bare "unknown key" message would not stop them.
const SUGGESTIONS: Record<ComponentType, Record<string, string>> = {
  agent: {
    "allowed-tools": "agents use `tools:` (bare tool names; Bash scopes are discarded)",
    "disallowed-tools": "agents use camelCase `disallowedTools:`",
    "subagent-type": "not a frontmatter key (it is the Agent tool call parameter) — remove it",
  },
  skill: {
    tools: "skills/commands use `allowed-tools:` (permission rules)",
  },
  command: {
    tools: "skills/commands use `allowed-tools:` (permission rules)",
  },
  rule: {},
};

/**
 * Map a repo-relative path to the component type whose key schema applies.
 * Returns null for files with no key contract (archive, skill reference docs,
 * hook markdown) — those still get YAML syntax validation, nothing more.
 */
export function classifyComponent(filePath: string): ComponentType | null {
  if (filePath.startsWith("archive/")) return null;
  if (/^\.claude\/rules\/.*\.md$/.test(filePath)) return "rule";
  if (/(^|\/)agents\/[^/]+\.md$/.test(filePath)) return "agent";
  if (/(^|\/)skills\/.*\/SKILL\.md$/.test(filePath)) return "skill";
  if (/(^|\/)commands\/.*\.md$/.test(filePath)) return "command";
  return null;
}

/**
 * Check parsed frontmatter keys against the component type's allow-list.
 * Claude Code silently ignores unknown keys, so this is the only gate that
 * catches them.
 */
export function checkKeys(
  type: ComponentType,
  frontmatter: Record<string, unknown>
): KeyCheckResult {
  const allowed = KEYS_BY_TYPE[type];
  const suggestions = SUGGESTIONS[type];
  const unknown: KeyViolation[] = [];

  for (const key of Object.keys(frontmatter)) {
    if (allowed.has(key)) continue;
    unknown.push({ key, suggestion: suggestions[key] });
  }

  const missing = REQUIRED_BY_TYPE[type].filter(
    (key) => !(key in frontmatter)
  );

  return { unknown, missing };
}

export interface FrontmatterResult {
  valid: boolean;
  filePath: string;
  error?: {
    message: string;
    line?: number;
    col?: number;
    code?: string;
  };
  frontmatter?: Record<string, unknown>;
}

/**
 * Extract YAML frontmatter from markdown content.
 * Returns null if no frontmatter is present.
 */
export function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/**
 * Validate YAML frontmatter in a file's content.
 * Returns validation result with parsed frontmatter or error details.
 */
export function validateFrontmatter(
  filePath: string,
  content: string
): FrontmatterResult {
  const yaml = extractFrontmatter(content);

  if (!yaml) {
    return { valid: true, filePath }; // No frontmatter = skip
  }

  try {
    const frontmatter = parse(yaml, { strict: true });
    return { valid: true, filePath, frontmatter };
  } catch (e) {
    if (e instanceof YAMLParseError) {
      return {
        valid: false,
        filePath,
        error: {
          message: e.message,
          line: e.linePos?.[0]?.line,
          col: e.linePos?.[0]?.col,
          code: e.code,
        },
      };
    }
    return {
      valid: false,
      filePath,
      error: { message: String(e) },
    };
  }
}
