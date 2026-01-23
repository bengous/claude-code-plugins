#!/usr/bin/env bun
/**
 * T-Plan Session Init Hook (PreToolUse:Skill)
 *
 * Fires when Skill tool is called. Filters to only act on t-plan skill.
 * Creates session directory and initial state.
 *
 * This hook ensures the session directory exists before the orchestrator
 * writes intent.md.
 *
 * Workaround for GitHub #17688: Skill-scoped hooks don't work in plugins.
 * Once fixed, migrate back to skill-scoped hooks in SKILL.md frontmatter.
 */

import { join } from "path";
import { readHookInput, allow } from "./lib/hooks";
import { writeState, ensureGitignore, getSessionDir } from "./lib/state";

function main(): never {
  const input = readHookInput();

  if (!input) {
    return allow();
  }

  // Only process Skill tool calls
  if (input.tool_name !== "Skill") {
    return allow();
  }

  // Check if this is the t-plan skill
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const skillName = typeof toolInput.skill === "string" ? toolInput.skill : "";

  // Only init for t-plan skill (handles "t-plan" and "conductor:t-plan")
  if (!skillName.includes("t-plan")) {
    return allow();
  }

  const { cwd, session_id: sessionId } = input;

  // Require both cwd and session_id
  if (!cwd || !sessionId) {
    return allow();
  }

  const tplanDir = join(cwd, ".t-plan");
  const sessionDir = getSessionDir(cwd, sessionId);

  // Ensure .gitignore exists (creates directory if needed)
  ensureGitignore(tplanDir);

  // Initialize state with INTENT phase
  const now = new Date().toISOString();
  writeState(sessionDir, {
    schema_version: 2,
    session_id: sessionId,
    phase: "INTENT",
    draft_version: 0,
    created_at: now,
    updated_at: now,
  });

  return allow();
}

main();
