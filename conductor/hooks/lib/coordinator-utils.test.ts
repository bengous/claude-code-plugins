/**
 * Tests for coordinator-utils.ts pure functions
 */

import { describe, test, expect } from "bun:test";
import {
  detectPhase,
  resolveContractOutputPath,
  createInitialState,
  updateStateForPhase,
} from "./coordinator-utils";
import { createTestState } from "./test-utils";

describe("detectPhase", () => {
  test("detects EXPLORE phase", () => {
    const result = detectPhase("[T-PLAN PHASE=EXPLORE] architect");
    expect(result).toBe("EXPLORE");
  });

  test("detects SCOUT phase", () => {
    const result = detectPhase("[T-PLAN PHASE=SCOUT] implementation");
    expect(result).toBe("SCOUT");
  });

  test("detects VALIDATE phase", () => {
    const result = detectPhase("[T-PLAN PHASE=VALIDATE] verify");
    expect(result).toBe("VALIDATE");
  });

  test("returns null for no marker", () => {
    const result = detectPhase("regular task description");
    expect(result).toBeNull();
  });

  test("returns null for invalid phase", () => {
    const result = detectPhase("[T-PLAN PHASE=INVALID] task");
    expect(result).toBeNull();
  });

  test("returns null for lowercase phase", () => {
    const result = detectPhase("[T-PLAN PHASE=explore] task");
    expect(result).toBeNull();
  });

  test("extracts phase from middle of description", () => {
    const result = detectPhase("Start [T-PLAN PHASE=SCOUT] the process");
    expect(result).toBe("SCOUT");
  });

  test("handles multiple phase markers (first match wins)", () => {
    // Regex only returns first match with match()
    const result = detectPhase("[T-PLAN PHASE=EXPLORE] then [T-PLAN PHASE=SCOUT]");
    expect(result).toBe("EXPLORE");
  });

  test("returns null for empty string", () => {
    const result = detectPhase("");
    expect(result).toBeNull();
  });
});

describe("resolveContractOutputPath", () => {
  test("extracts and resolves path with session ID", () => {
    const prompt = "CONTRACT_OUTPUT: .t-plan/${CLAUDE_SESSION_ID}/explore.md";
    const result = resolveContractOutputPath(prompt, "session-123");
    // Leading . is removed as it's relative path notation
    expect(result).toBe("t-plan/session-123/explore.md");
  });

  test("removes leading ./ from path", () => {
    const prompt = "CONTRACT_OUTPUT: ./output/file.json";
    const result = resolveContractOutputPath(prompt, "session-456");
    expect(result).toBe("output/file.json");
  });

  test("removes leading . from path", () => {
    const prompt = "CONTRACT_OUTPUT: .output/file.json";
    const result = resolveContractOutputPath(prompt, "session-456");
    expect(result).toBe("output/file.json");
  });

  test("returns null when no CONTRACT_OUTPUT marker", () => {
    const prompt = "No contract output in this prompt";
    const result = resolveContractOutputPath(prompt, "session-789");
    expect(result).toBeNull();
  });

  test("handles path without session ID variable", () => {
    const prompt = "CONTRACT_OUTPUT: output/static-file.md";
    const result = resolveContractOutputPath(prompt, "session-123");
    expect(result).toBe("output/static-file.md");
  });

  test("extracts path from multiline prompt", () => {
    const prompt = `
Some instructions here.

CONTRACT_OUTPUT: .t-plan/\${CLAUDE_SESSION_ID}/scout.md

More instructions follow.
    `;
    const result = resolveContractOutputPath(prompt, "my-session");
    // Leading . is removed as it's relative path notation
    expect(result).toBe("t-plan/my-session/scout.md");
  });

  test("returns null for malformed marker", () => {
    const prompt = "CONTRACT OUTPUT: file.md";
    const result = resolveContractOutputPath(prompt, "session");
    expect(result).toBeNull();
  });

  test("handles complex session IDs", () => {
    const prompt = "CONTRACT_OUTPUT: .t-plan/${CLAUDE_SESSION_ID}/validation.json";
    const result = resolveContractOutputPath(prompt, "abc-123-def-456");
    // Leading . is removed as it's relative path notation
    expect(result).toBe("t-plan/abc-123-def-456/validation.json");
  });
});

describe("createInitialState", () => {
  test("creates state with correct session_id", () => {
    const state = createInitialState("session-abc", "EXPLORE", "2025-01-01T00:00:00Z");
    expect(state.session_id).toBe("session-abc");
  });

  test("creates state with correct phase", () => {
    const state = createInitialState("session-abc", "SCOUT", "2025-01-01T00:00:00Z");
    expect(state.phase).toBe("SCOUT");
  });

  test("initializes draft_version to 0", () => {
    const state = createInitialState("session-abc", "EXPLORE", "2025-01-01T00:00:00Z");
    expect(state.draft_version).toBe(0);
  });

  test("initializes validation_version to 0", () => {
    const state = createInitialState("session-abc", "EXPLORE", "2025-01-01T00:00:00Z");
    expect(state.validation_version).toBe(0);
  });

  test("sets schema_version to 1", () => {
    const state = createInitialState("session-abc", "EXPLORE", "2025-01-01T00:00:00Z");
    expect(state.schema_version).toBe(1);
  });

  test("sets created_at and updated_at to provided timestamp", () => {
    const timestamp = "2025-06-15T12:30:00.000Z";
    const state = createInitialState("session-abc", "EXPLORE", timestamp);
    expect(state.created_at).toBe(timestamp);
    expect(state.updated_at).toBe(timestamp);
  });

  test("handles VALIDATE as initial phase", () => {
    const state = createInitialState("session-abc", "VALIDATE", "2025-01-01T00:00:00Z");
    expect(state.phase).toBe("VALIDATE");
    expect(state.validation_version).toBe(0); // Not auto-incremented on create
  });
});

describe("updateStateForPhase", () => {
  test("updates phase", () => {
    const original = createTestState({ phase: "EXPLORE" });
    const updated = updateStateForPhase(original, "SCOUT", "2025-01-02T00:00:00Z");
    expect(updated.phase).toBe("SCOUT");
  });

  test("updates updated_at timestamp", () => {
    const original = createTestState({ updated_at: "2025-01-01T00:00:00Z" });
    const newTime = "2025-01-02T12:00:00Z";
    const updated = updateStateForPhase(original, "SCOUT", newTime);
    expect(updated.updated_at).toBe(newTime);
  });

  test("preserves created_at", () => {
    const original = createTestState({
      created_at: "2025-01-01T00:00:00Z",
    });
    const updated = updateStateForPhase(original, "SCOUT", "2025-01-02T00:00:00Z");
    expect(updated.created_at).toBe("2025-01-01T00:00:00Z");
  });

  test("preserves session_id", () => {
    const original = createTestState({ session_id: "original-session" });
    const updated = updateStateForPhase(original, "SCOUT", "2025-01-02T00:00:00Z");
    expect(updated.session_id).toBe("original-session");
  });

  test("preserves draft_version for non-VALIDATE phases", () => {
    const original = createTestState({ draft_version: 5 });
    const updated = updateStateForPhase(original, "SCOUT", "2025-01-02T00:00:00Z");
    expect(updated.draft_version).toBe(5);
  });

  test("VALIDATE sets validation_version to draft_version", () => {
    const original = createTestState({
      draft_version: 3,
      validation_version: 0,
    });
    const updated = updateStateForPhase(original, "VALIDATE", "2025-01-02T00:00:00Z");
    expect(updated.validation_version).toBe(3);
  });

  test("VALIDATE preserves draft_version", () => {
    const original = createTestState({ draft_version: 7 });
    const updated = updateStateForPhase(original, "VALIDATE", "2025-01-02T00:00:00Z");
    expect(updated.draft_version).toBe(7);
  });

  test("does not mutate original state", () => {
    const original = createTestState({ phase: "EXPLORE" });
    const originalPhase = original.phase;

    updateStateForPhase(original, "SCOUT", "2025-01-02T00:00:00Z");

    expect(original.phase).toBe(originalPhase);
  });

  test("non-VALIDATE does not modify validation_version", () => {
    const original = createTestState({
      validation_version: 2,
      phase: "VALIDATE",
    });
    const updated = updateStateForPhase(original, "EXPLORE", "2025-01-02T00:00:00Z");
    expect(updated.validation_version).toBe(2);
  });
});
