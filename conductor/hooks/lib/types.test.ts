/**
 * Tests for types.ts regex patterns and constants
 */

import { describe, test, expect } from "bun:test";
import { PHASE_MARKER_REGEX, CONTRACT_OUTPUT_REGEX, PHASE_CONTRACTS, type Phase } from "./types";

describe("PHASE_MARKER_REGEX", () => {
  test("matches EXPLORE phase marker", () => {
    const match = "[T-PLAN PHASE=EXPLORE]".match(PHASE_MARKER_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("EXPLORE");
  });

  test("matches SCOUT phase marker", () => {
    const match = "[T-PLAN PHASE=SCOUT]".match(PHASE_MARKER_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("SCOUT");
  });

  test("matches VALIDATE phase marker", () => {
    const match = "[T-PLAN PHASE=VALIDATE]".match(PHASE_MARKER_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("VALIDATE");
  });

  test("extracts phase when embedded in text", () => {
    const text = "Starting phase [T-PLAN PHASE=SCOUT] for implementation";
    const match = text.match(PHASE_MARKER_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("SCOUT");
  });

  test("does not match invalid phases", () => {
    expect("[T-PLAN PHASE=INVALID]".match(PHASE_MARKER_REGEX)).toBeNull();
    expect("[T-PLAN PHASE=explore]".match(PHASE_MARKER_REGEX)).toBeNull();
    expect("[T-PLAN PHASE=]".match(PHASE_MARKER_REGEX)).toBeNull();
  });

  test("does not match malformed markers", () => {
    expect("[T-PLAN PHASE EXPLORE]".match(PHASE_MARKER_REGEX)).toBeNull();
    expect("T-PLAN PHASE=EXPLORE".match(PHASE_MARKER_REGEX)).toBeNull();
    expect("[PHASE=EXPLORE]".match(PHASE_MARKER_REGEX)).toBeNull();
  });
});

describe("CONTRACT_OUTPUT_REGEX", () => {
  test("extracts path from CONTRACT_OUTPUT marker", () => {
    const match = "CONTRACT_OUTPUT: .t-plan/${CLAUDE_SESSION_ID}/explore.md".match(CONTRACT_OUTPUT_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(".t-plan/${CLAUDE_SESSION_ID}/explore.md");
  });

  test("handles paths without whitespace after colon", () => {
    const match = "CONTRACT_OUTPUT:./output/file.json".match(CONTRACT_OUTPUT_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("./output/file.json");
  });

  test("stops at whitespace in path", () => {
    const match = "CONTRACT_OUTPUT: path/to/file.md and more text".match(CONTRACT_OUTPUT_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("path/to/file.md");
  });

  test("extracts path when embedded in text", () => {
    const text = "Expected output CONTRACT_OUTPUT: output.json for validation";
    const match = text.match(CONTRACT_OUTPUT_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("output.json");
  });

  test("does not match without path", () => {
    expect("CONTRACT_OUTPUT:".match(CONTRACT_OUTPUT_REGEX)).toBeNull();
    expect("CONTRACT_OUTPUT: ".match(CONTRACT_OUTPUT_REGEX)).toBeNull();
  });

  test("does not match malformed markers", () => {
    expect("CONTRACT OUTPUT: file.md".match(CONTRACT_OUTPUT_REGEX)).toBeNull();
    expect("CONTRACT_OUTPUT file.md".match(CONTRACT_OUTPUT_REGEX)).toBeNull();
  });
});

describe("PHASE_CONTRACTS", () => {
  test("defines correct contract for EXPLORE", () => {
    expect(PHASE_CONTRACTS.EXPLORE).toBe("explore.md");
  });

  test("defines correct contract for SCOUT", () => {
    expect(PHASE_CONTRACTS.SCOUT).toBe("scout.md");
  });

  test("defines correct contract for VALIDATE with version placeholder", () => {
    expect(PHASE_CONTRACTS.VALIDATE).toBe("validation-v{version}.json");
  });

  test("covers all Phase types", () => {
    const phases: Phase[] = ["EXPLORE", "SCOUT", "VALIDATE"];
    for (const phase of phases) {
      expect(PHASE_CONTRACTS[phase]).toBeDefined();
    }
  });

  test("all contracts have file extensions", () => {
    for (const contract of Object.values(PHASE_CONTRACTS)) {
      expect(contract).toMatch(/\.[a-z]+$/);
    }
  });
});
