/**
 * Contract Validation Functions
 *
 * Pure functions extracted from subagent-contract.ts for testability.
 * These functions contain no side effects (no filesystem, no stdin, no process.exit).
 */

import { PHASE_CONTRACTS, type Phase } from "./types";

/**
 * Resolve the expected contract filename for a phase.
 * For VALIDATE phase, version must be provided and is zero-padded to 3 digits.
 */
export function resolveContractFilename(
  phase: Phase,
  validationVersion?: number
): { filename: string } | { error: string } {
  const template = PHASE_CONTRACTS[phase];

  if (!template.includes("{version}")) {
    return { filename: template };
  }

  // VALIDATE phase requires version
  if (typeof validationVersion !== "number" || validationVersion < 1) {
    return {
      error: "CONTRACT UNFULFILLED: state.validation_version must be >= 1 for VALIDATE",
    };
  }

  const filename = template.replace(
    "{version}",
    String(validationVersion).padStart(3, "0")
  );

  return { filename };
}

/**
 * Validate that file and state draft versions match.
 * Handles type coercion for string/number inputs.
 */
export function validateDraftVersion(
  fileDraft: unknown,
  stateDraft: unknown
): { valid: true } | { valid: false; error: string } {
  const parsedFile =
    typeof fileDraft === "number"
      ? fileDraft
      : parseInt(String(fileDraft), 10);

  const parsedState =
    typeof stateDraft === "number"
      ? stateDraft
      : parseInt(String(stateDraft), 10);

  // parseInt returns NaN for invalid input (never throws)
  if (isNaN(parsedFile) || isNaN(parsedState)) {
    return {
      valid: false,
      error:
        `CONTRACT UNFULFILLED: draft_version must be an integer ` +
        `(got ${fileDraft} vs ${stateDraft})`,
    };
  }

  if (parsedFile !== parsedState) {
    return {
      valid: false,
      error: `CONTRACT UNFULFILLED: validation draft_version (${parsedFile}) != state (${parsedState})`,
    };
  }

  return { valid: true };
}

/**
 * Validate the structure of a validation JSON object.
 * Checks for required 'status' field and draft_version match.
 */
export function validateValidationJson(
  content: unknown,
  expectedDraft: number
): { valid: true } | { valid: false; error: string } {
  if (typeof content !== "object" || content === null) {
    return {
      valid: false,
      error: "CONTRACT UNFULFILLED: validation must be a JSON object",
    };
  }

  const obj = content as Record<string, unknown>;

  // Check draft_version match
  const draftResult = validateDraftVersion(obj.draft_version, expectedDraft);
  if (!draftResult.valid) {
    return draftResult;
  }

  // Check required 'status' field
  if (!("status" in obj)) {
    return {
      valid: false,
      error: "CONTRACT UNFULFILLED: validation JSON missing required field 'status'",
    };
  }

  return { valid: true };
}

/**
 * Build an ordered list of path candidates for session directory search.
 * Extracts string values from known path fields in the input.
 */
export function buildPathCandidates(
  input: Record<string, unknown>,
  processCwd: string
): string[] {
  const candidates: string[] = [];

  // Check known path fields in priority order
  const pathFields = ["cwd", "project_root", "repo_root", "workspace_root"];

  for (const key of pathFields) {
    const value = input[key];
    if (typeof value === "string" && value) {
      candidates.push(value);
    }
  }

  // Fallback to process.cwd()
  candidates.push(processCwd);

  return candidates;
}
