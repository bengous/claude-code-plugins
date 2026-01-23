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
  schema_version: 1;
  session_id: string;
  phase: Phase;
  draft_version: number;
  validation_version: number;
  created_at: string;
  updated_at: string;
}

export type Phase = "EXPLORE" | "SCOUT" | "VALIDATE";

/** Contract output file expected for each phase */
export const PHASE_CONTRACTS: Record<Phase, string> = {
  EXPLORE: "explore.md",
  SCOUT: "scout.md",
  VALIDATE: "validation-v{version}.json",
} as const;

/** Protocol markers for automated hook detection */
export const PHASE_MARKER_REGEX = /\[T-PLAN PHASE=(EXPLORE|SCOUT|VALIDATE)\]/;
export const CONTRACT_OUTPUT_REGEX = /CONTRACT_OUTPUT:\s*(\S+)/;
