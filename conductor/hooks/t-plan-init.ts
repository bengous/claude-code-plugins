#!/usr/bin/env bun
/**
 * T-Plan Session Init Hook (PreToolUse:* with once:true)
 *
 * Fires on first tool use when t-plan skill is active.
 * Creates session directory and initial state.
 *
 * This hook runs ONCE at the start of a t-plan session, ensuring
 * the session directory exists before the orchestrator writes intent.md.
 */

import { join } from "path";
import { readHookInput, allow } from "./lib/hooks";
import { writeState, ensureGitignore, getSessionDir } from "./lib/state";

function main(): never {
  const input = readHookInput();

  // No input - allow (this shouldn't happen with once:true)
  if (!input) {
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
