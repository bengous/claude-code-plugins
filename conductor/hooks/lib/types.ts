/**
 * T-Plan Hook Types
 *
 * Shared type definitions for t-plan state management and hook coordination.
 * Self-contained within conductor for marketplace portability.
 */

/** Hook input from Claude Code stdin */
export interface HookInput {
  session_id: string;
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** T-plan session state stored in .t-plan/{session_id}/state.json */
export interface TPlanState {
  schema_version: 2;
  session_id: string;
  phase: Phase;
  draft_version: number;
  // validation_version removed in schema v2 - derive from draft_version instead
  created_at: string;
  updated_at: string;
}

export type Phase = "INTENT" | "EXPLORE" | "SCOUT" | "VALIDATE";

/** Subagent phases that have contract output requirements */
export type SubagentPhase = "EXPLORE" | "SCOUT" | "VALIDATE";

/** Contract output file expected for each subagent phase */
export const PHASE_CONTRACTS: Record<SubagentPhase, string> = {
  EXPLORE: "explore.md",
  SCOUT: "scout.md",
  VALIDATE: "validation-v{version}.json",
} as const;

/** Check if a phase is a subagent phase with contract requirements */
export function isSubagentPhase(phase: Phase): phase is SubagentPhase {
  return phase in PHASE_CONTRACTS;
}

/** Protocol markers for automated hook detection */
export const PHASE_MARKER_REGEX = /\[T-PLAN PHASE=(INTENT|EXPLORE|SCOUT|VALIDATE)\]/;
export const CONTRACT_OUTPUT_REGEX = /CONTRACT_OUTPUT:\s*(\S+)/;
