#!/usr/bin/env bun
/**
 * Subagent Contract Hook (SubagentStop)
 *
 * Verifies that t-plan subagents fulfilled their contracts:
 * - EXPLORE must write explore.md
 * - SCOUT must write scout.md
 * - VALIDATE must write validation-vNNN.json with valid structure
 *
 * The expected contract is determined by .t-plan/{session_id}/state.json.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { readHookInput, allow, block } from "./lib/hooks";
import { findSessionDir, readState } from "./lib/state";
import { PHASE_CONTRACTS, type Phase } from "./lib/types";

function main(): never {
  const input = readHookInput();

  // Require session_id
  if (!input?.session_id) {
    return allow();
  }

  // Try to find session directory from various path candidates
  // Check multiple possible path fields (cwd is in HookInput, others may be added by Claude Code)
  const pathCandidates: string[] = [];
  const inputRecord = input as unknown as Record<string, unknown>;
  for (const key of ["cwd", "project_root", "repo_root", "workspace_root"]) {
    const value = inputRecord[key];
    if (typeof value === "string" && value) {
      pathCandidates.push(value);
    }
  }
  pathCandidates.push(process.cwd());

  let sessionDir: string | null = null;
  for (const candidate of pathCandidates) {
    sessionDir = findSessionDir(candidate, input.session_id);
    if (sessionDir) break;
  }

  // No t-plan session found - not a t-plan subagent
  if (!sessionDir) {
    return allow();
  }

  // Read state
  const state = readState(sessionDir);
  if (!state) {
    return allow();
  }

  const { phase, draft_version, validation_version } = state;

  // Unknown phase - allow
  if (!(phase in PHASE_CONTRACTS)) {
    return allow();
  }

  // Determine expected contract output
  let expected = PHASE_CONTRACTS[phase as Phase];
  if (expected.includes("{version}")) {
    if (typeof validation_version !== "number" || validation_version < 1) {
      return block(
        "CONTRACT UNFULFILLED: state.validation_version must be >= 1 for VALIDATE"
      );
    }
    expected = expected.replace(
      "{version}",
      String(validation_version).padStart(3, "0")
    );
  }

  const contractPath = join(sessionDir, expected);

  // Check file exists and is non-empty
  if (!existsSync(contractPath)) {
    return block(`CONTRACT UNFULFILLED: ${phase} must write ${expected}`);
  }

  const stats = statSync(contractPath);
  if (stats.size === 0) {
    return block(`CONTRACT UNFULFILLED: ${expected} is empty`);
  }

  // VALIDATE phase: additional JSON validation
  if (phase === "VALIDATE") {
    let validation: Record<string, unknown>;

    try {
      const content = readFileSync(contractPath, "utf8");
      validation = JSON.parse(content);
    } catch {
      return block(`CONTRACT UNFULFILLED: ${expected} is not valid JSON`);
    }

    // Check draft_version match
    const fileDraftVersion = validation.draft_version;
    const fileDraft =
      typeof fileDraftVersion === "number"
        ? fileDraftVersion
        : parseInt(String(fileDraftVersion), 10);
    const expectedDraft =
      typeof draft_version === "number"
        ? draft_version
        : parseInt(String(draft_version), 10);

    // parseInt returns NaN for invalid input (never throws)
    if (isNaN(fileDraft) || isNaN(expectedDraft)) {
      return block(
        `CONTRACT UNFULFILLED: draft_version must be an integer ` +
          `(got ${fileDraftVersion} vs ${draft_version})`
      );
    }

    if (fileDraft !== expectedDraft) {
      return block(
        `CONTRACT UNFULFILLED: validation draft_version (${fileDraft}) != state (${expectedDraft})`
      );
    }

    // Check required 'status' field
    if (!("status" in validation)) {
      return block(
        "CONTRACT UNFULFILLED: validation JSON missing required field 'status'"
      );
    }
  }

  return allow();
}

main();
