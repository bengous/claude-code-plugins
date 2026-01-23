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
import {
  resolveContractFilename,
  validateValidationJson,
  buildPathCandidates,
} from "./lib/validation";

function main(): never {
  const input = readHookInput();

  // Require session_id
  if (!input?.session_id) {
    return allow();
  }

  // Build path candidates using extracted function
  const inputRecord = input as unknown as Record<string, unknown>;
  const pathCandidates = buildPathCandidates(inputRecord, process.cwd());

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

  // Resolve contract filename using extracted function
  const contractResult = resolveContractFilename(phase as Phase, validation_version);
  if ("error" in contractResult) {
    return block(contractResult.error);
  }

  const expected = contractResult.filename;
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

    // Use extracted validation function
    const validationResult = validateValidationJson(validation, draft_version);
    if (!validationResult.valid) {
      return block(validationResult.error);
    }
  }

  return allow();
}

main();
