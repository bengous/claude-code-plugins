#!/usr/bin/env bun
/**
 * T-Plan Coordinator Hook (PreToolUse)
 *
 * Automates state management for t-plan subagent dispatches:
 * 1. Detects Task calls with [T-PLAN PHASE=...] marker
 * 2. Creates/updates .t-plan/{session_id}/state.json
 * 3. Ensures .gitignore exists
 * 4. Truncates stale contract output files
 *
 * This removes manual state management from SKILL.md instructions.
 */

import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readHookInput, allow } from "./lib/hooks";
import {
  readState,
  writeState,
  ensureGitignore,
  getSessionDir,
} from "./lib/state";
import {
  PHASE_MARKER_REGEX,
  CONTRACT_OUTPUT_REGEX,
  type Phase,
} from "./lib/types";

function main(): never {
  const input = readHookInput();

  // Only process Task tool calls
  if (!input || input.tool_name !== "Task") {
    return allow();
  }

  const toolInput = input.tool_input ?? {};
  const description =
    typeof toolInput.description === "string" ? toolInput.description : "";
  const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";

  // Check for t-plan phase marker in description
  const phaseMatch = description.match(PHASE_MARKER_REGEX);
  if (!phaseMatch) {
    // Not a t-plan Task dispatch
    return allow();
  }

  const phase = phaseMatch[1] as Phase;
  const sessionId = input.session_id;
  const cwd = input.cwd;

  // Determine session directory
  const sessionDir = getSessionDir(cwd, sessionId);
  const tplanDir = join(cwd, ".t-plan");

  // Ensure directories exist
  mkdirSync(sessionDir, { recursive: true });
  ensureGitignore(tplanDir);

  // Read or create state
  const now = new Date().toISOString();
  let state = readState(sessionDir);

  if (!state) {
    // First t-plan dispatch in this session
    state = {
      schema_version: 1,
      session_id: sessionId,
      phase,
      draft_version: 0,
      validation_version: 0,
      created_at: now,
      updated_at: now,
    };
  } else {
    // Update existing state
    state.phase = phase;
    state.updated_at = now;

    // VALIDATE phase: increment validation_version to match draft_version
    if (phase === "VALIDATE") {
      state.validation_version = state.draft_version;
    }
  }

  writeState(sessionDir, state);

  // Truncate stale contract output if CONTRACT_OUTPUT marker is present
  const contractMatch = prompt.match(CONTRACT_OUTPUT_REGEX);
  if (contractMatch?.[1]) {
    const contractPath = contractMatch[1]
      .replace("${CLAUDE_SESSION_ID}", sessionId)
      .replace(/^\.\/?/, ""); // Remove leading ./ if present

    const fullPath = join(cwd, contractPath);

    // Truncate (create empty file) so subagent must write fresh output
    if (existsSync(fullPath)) {
      writeFileSync(fullPath, "");
    }
  }

  return allow();
}

main();
