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
  detectPhase,
  resolveContractOutputPath,
  createInitialState,
  updateStateForPhase,
} from "./lib/coordinator-utils";

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
  const phase = detectPhase(description);
  if (!phase) {
    // Not a t-plan Task dispatch
    return allow();
  }

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
    state = createInitialState(sessionId, phase, now);
  } else {
    // Update existing state
    state = updateStateForPhase(state, phase, now);
  }

  writeState(sessionDir, state);

  // Truncate stale contract output if CONTRACT_OUTPUT marker is present
  const contractPath = resolveContractOutputPath(prompt, sessionId);
  if (contractPath) {
    const fullPath = join(cwd, contractPath);

    // Truncate (create empty file) so subagent must write fresh output
    if (existsSync(fullPath)) {
      writeFileSync(fullPath, "");
    }
  }

  return allow();
}

main();
