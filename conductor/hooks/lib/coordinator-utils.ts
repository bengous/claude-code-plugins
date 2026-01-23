/**
 * Coordinator Utility Functions
 *
 * Pure functions extracted from t-plan-coordinator.ts for testability.
 * These functions contain no side effects (no filesystem, no stdin).
 */

import { PHASE_MARKER_REGEX, CONTRACT_OUTPUT_REGEX, type Phase, type TPlanState } from "./types";

/**
 * Detect phase from a Task description containing [T-PLAN PHASE=...] marker.
 * Returns null if no valid phase marker found.
 */
export function detectPhase(description: string): Phase | null {
  const match = description.match(PHASE_MARKER_REGEX);
  if (!match) {
    return null;
  }
  return match[1] as Phase;
}

/**
 * Extract and resolve the contract output path from a prompt string.
 * Substitutes session ID variable and removes leading ./
 * Returns null if no CONTRACT_OUTPUT marker found.
 */
export function resolveContractOutputPath(
  prompt: string,
  sessionId: string
): string | null {
  const match = prompt.match(CONTRACT_OUTPUT_REGEX);
  if (!match?.[1]) {
    return null;
  }

  return match[1]
    .replace("${CLAUDE_SESSION_ID}", sessionId)
    .replace(/^\.\/?/, ""); // Remove leading ./ if present
}

/**
 * Create initial state for a new t-plan session.
 */
export function createInitialState(
  sessionId: string,
  phase: Phase,
  timestamp: string
): TPlanState {
  return {
    schema_version: 1,
    session_id: sessionId,
    phase,
    draft_version: 0,
    validation_version: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/**
 * Update existing state for a new phase dispatch.
 * Returns a new state object (does not mutate input).
 */
export function updateStateForPhase(
  state: TPlanState,
  phase: Phase,
  timestamp: string
): TPlanState {
  const updated: TPlanState = {
    ...state,
    phase,
    updated_at: timestamp,
  };

  // VALIDATE phase: increment validation_version to match draft_version
  if (phase === "VALIDATE") {
    updated.validation_version = state.draft_version;
  }

  return updated;
}
