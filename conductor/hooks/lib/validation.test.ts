/**
 * Tests for validation.ts pure functions
 */

import { describe, test, expect } from "bun:test";
import {
  resolveContractFilename,
  validateDraftVersion,
  validateValidationJson,
  buildPathCandidates,
} from "./validation";

describe("resolveContractFilename", () => {
  describe("EXPLORE phase", () => {
    test("returns explore.md without version", () => {
      const result = resolveContractFilename("EXPLORE");
      expect(result).toEqual({ filename: "explore.md" });
    });

    test("ignores version parameter", () => {
      const result = resolveContractFilename("EXPLORE", 5);
      expect(result).toEqual({ filename: "explore.md" });
    });
  });

  describe("SCOUT phase", () => {
    test("returns scout.md without version", () => {
      const result = resolveContractFilename("SCOUT");
      expect(result).toEqual({ filename: "scout.md" });
    });

    test("ignores version parameter", () => {
      const result = resolveContractFilename("SCOUT", 3);
      expect(result).toEqual({ filename: "scout.md" });
    });
  });

  describe("VALIDATE phase", () => {
    test("returns error when draft_version is undefined", () => {
      const result = resolveContractFilename("VALIDATE");
      expect("error" in result).toBe(true);
      expect((result as { error: string }).error).toContain("draft_version must be >= 1");
    });

    test("returns error when draft_version is 0", () => {
      const result = resolveContractFilename("VALIDATE", 0);
      expect("error" in result).toBe(true);
    });

    test("returns error when draft_version is negative", () => {
      const result = resolveContractFilename("VALIDATE", -1);
      expect("error" in result).toBe(true);
    });

    test("zero-pads single digit versions", () => {
      const result = resolveContractFilename("VALIDATE", 1);
      expect(result).toEqual({ filename: "validation-v001.json" });
    });

    test("zero-pads double digit versions", () => {
      const result = resolveContractFilename("VALIDATE", 42);
      expect(result).toEqual({ filename: "validation-v042.json" });
    });

    test("handles triple digit versions", () => {
      const result = resolveContractFilename("VALIDATE", 999);
      expect(result).toEqual({ filename: "validation-v999.json" });
    });

    test("handles versions over 999", () => {
      const result = resolveContractFilename("VALIDATE", 1234);
      expect(result).toEqual({ filename: "validation-v1234.json" });
    });
  });
});

describe("validateDraftVersion", () => {
  describe("matching versions", () => {
    test("valid when both are equal numbers", () => {
      const result = validateDraftVersion(5, 5);
      expect(result).toEqual({ valid: true });
    });

    test("valid when both are zero", () => {
      const result = validateDraftVersion(0, 0);
      expect(result).toEqual({ valid: true });
    });

    test("valid when string matches number", () => {
      const result = validateDraftVersion("5", 5);
      expect(result).toEqual({ valid: true });
    });

    test("valid when number matches string", () => {
      const result = validateDraftVersion(5, "5");
      expect(result).toEqual({ valid: true });
    });

    test("valid when both are numeric strings", () => {
      const result = validateDraftVersion("10", "10");
      expect(result).toEqual({ valid: true });
    });
  });

  describe("mismatched versions", () => {
    test("invalid when numbers differ", () => {
      const result = validateDraftVersion(5, 6);
      expect(result.valid).toBe(false);
      expect("error" in result && result.error).toContain("5");
      expect("error" in result && result.error).toContain("6");
    });

    test("invalid when file is higher", () => {
      const result = validateDraftVersion(10, 5);
      expect(result.valid).toBe(false);
    });

    test("invalid when state is higher", () => {
      const result = validateDraftVersion(5, 10);
      expect(result.valid).toBe(false);
    });
  });

  describe("NaN handling", () => {
    test("invalid when file version is NaN string", () => {
      const result = validateDraftVersion("not-a-number", 5);
      expect(result.valid).toBe(false);
      expect("error" in result && result.error).toContain("must be an integer");
    });

    test("invalid when state version is NaN string", () => {
      const result = validateDraftVersion(5, "invalid");
      expect(result.valid).toBe(false);
    });

    test("invalid when both are NaN strings", () => {
      const result = validateDraftVersion("foo", "bar");
      expect(result.valid).toBe(false);
    });

    test("invalid when file version is null", () => {
      const result = validateDraftVersion(null, 5);
      expect(result.valid).toBe(false);
    });

    test("invalid when file version is undefined", () => {
      const result = validateDraftVersion(undefined, 5);
      expect(result.valid).toBe(false);
    });
  });
});

describe("validateValidationJson", () => {
  test("valid with matching draft_version and status", () => {
    const result = validateValidationJson(
      { draft_version: 1, status: "pass" },
      1
    );
    expect(result).toEqual({ valid: true });
  });

  test("valid with string draft_version matching number", () => {
    const result = validateValidationJson(
      { draft_version: "5", status: "fail" },
      5
    );
    expect(result).toEqual({ valid: true });
  });

  test("invalid when content is not an object", () => {
    const result = validateValidationJson("not an object", 1);
    expect(result.valid).toBe(false);
    expect("error" in result && result.error).toContain("must be a JSON object");
  });

  test("invalid when content is null", () => {
    const result = validateValidationJson(null, 1);
    expect(result.valid).toBe(false);
  });

  test("invalid when content is an array", () => {
    const result = validateValidationJson([1, 2, 3], 1);
    expect(result.valid).toBe(false);
  });

  test("invalid when draft_version is missing", () => {
    const result = validateValidationJson({ status: "pass" }, 1);
    expect(result.valid).toBe(false);
    expect("error" in result && result.error).toContain("draft_version");
  });

  test("invalid when draft_version does not match", () => {
    const result = validateValidationJson(
      { draft_version: 2, status: "pass" },
      1
    );
    expect(result.valid).toBe(false);
  });

  test("invalid when status is missing", () => {
    const result = validateValidationJson({ draft_version: 1 }, 1);
    expect(result.valid).toBe(false);
    expect("error" in result && result.error).toContain("missing required field 'status'");
  });

  test("valid with additional fields", () => {
    const result = validateValidationJson(
      {
        draft_version: 1,
        status: "pass",
        extra_field: "allowed",
        nested: { data: true },
      },
      1
    );
    expect(result).toEqual({ valid: true });
  });
});

describe("buildPathCandidates", () => {
  test("extracts cwd from input", () => {
    const candidates = buildPathCandidates({ cwd: "/home/user/project" }, "/fallback");
    expect(candidates[0]).toBe("/home/user/project");
  });

  test("extracts project_root from input", () => {
    const candidates = buildPathCandidates({ project_root: "/project" }, "/fallback");
    expect(candidates).toContain("/project");
  });

  test("extracts repo_root from input", () => {
    const candidates = buildPathCandidates({ repo_root: "/repo" }, "/fallback");
    expect(candidates).toContain("/repo");
  });

  test("extracts workspace_root from input", () => {
    const candidates = buildPathCandidates({ workspace_root: "/workspace" }, "/fallback");
    expect(candidates).toContain("/workspace");
  });

  test("maintains priority order", () => {
    const candidates = buildPathCandidates(
      {
        workspace_root: "/workspace",
        repo_root: "/repo",
        project_root: "/project",
        cwd: "/cwd",
      },
      "/fallback"
    );
    expect(candidates).toEqual(["/cwd", "/project", "/repo", "/workspace", "/fallback"]);
  });

  test("always includes processCwd as last candidate", () => {
    const candidates = buildPathCandidates({}, "/my/cwd");
    expect(candidates[candidates.length - 1]).toBe("/my/cwd");
  });

  test("filters out non-string values", () => {
    const candidates = buildPathCandidates(
      {
        cwd: 123,
        project_root: null,
        repo_root: undefined,
        workspace_root: { nested: true },
      },
      "/fallback"
    );
    expect(candidates).toEqual(["/fallback"]);
  });

  test("filters out empty strings", () => {
    const candidates = buildPathCandidates(
      {
        cwd: "",
        project_root: "/valid",
      },
      "/fallback"
    );
    expect(candidates).not.toContain("");
    expect(candidates).toContain("/valid");
  });

  test("preserves only valid path fields", () => {
    const candidates = buildPathCandidates(
      {
        cwd: "/cwd",
        unknown_field: "/ignored",
        random: "/also-ignored",
      },
      "/fallback"
    );
    expect(candidates).toEqual(["/cwd", "/fallback"]);
  });
});
