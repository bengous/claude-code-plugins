#!/usr/bin/env bun
/**
 * T-Plan Coordinator Hook (PreToolUse:Task)
 *
 * Automates state management for t-plan subagent dispatches:
 * 1. Detects Task calls with [T-PLAN PHASE=...] marker
 * 2. Updates .t-plan/{session_id}/state.json for phase transitions
 * 3. Truncates stale contract output files
 *
 * NOTE: Session initialization is handled by t-plan-init.ts (PreToolUse:* once:true).
 * This hook only handles state updates for phase transitions.
 */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { readHookInput, allow } from "./lib/hooks";
import { readState, writeState, getSessionDir } from "./lib/state";
import { detectPhase, resolveContractOutputPath, updateStateForPhase } from "./lib/coordinator-utils";

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
  const sessionDir = getSessionDir(cwd, sessionId);

  // Read existing state (should be created by t-plan-init.ts)
  const state = readState(sessionDir);

  if (!state) {
    // Init hook should have created state - allow but warn
    // This can happen if init hook hasn't run yet or session directory doesn't exist
    console.error("Warning: state.json not found, init hook may not have run");
    return allow();
  }

  // Update state for the new phase
  const now = new Date().toISOString();
  const updatedState = updateStateForPhase(state, phase, now);
  writeState(sessionDir, updatedState);

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
