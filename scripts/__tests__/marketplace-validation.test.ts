import { describe, expect, test } from "bun:test";
import {
  validateNameMatch,
  validateVersionSync,
  validateRequiredFields,
  extractVersionFromReadme,
  validateReadmeVersion,
  type PluginEntry,
  type PluginJson,
} from "../lib/marketplace-validation";

describe("validateNameMatch", () => {
  test("passes when names match exactly", () => {
    const result = validateNameMatch("git-tools", "git-tools");
    expect(result.passed).toBe(true);
    expect(result.message).toBe("Name matches");
  });

  test("fails when names differ", () => {
    const result = validateNameMatch("git-tools", "git-tool");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("mismatch");
    expect(result.message).toContain("git-tools");
    expect(result.message).toContain("git-tool");
  });

  test("fails when plugin name is undefined", () => {
    const result = validateNameMatch("git-tools", undefined);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("undefined");
  });
});

describe("validateVersionSync", () => {
  test("passes when versions match", () => {
    const result = validateVersionSync("1.0.0", "1.0.0");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("1.0.0");
  });

  test("fails when versions differ", () => {
    const result = validateVersionSync("1.0.0", "2.0.0");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("mismatch");
    expect(result.message).toContain("1.0.0");
    expect(result.message).toContain("2.0.0");
  });

  test("fails when marketplace version is missing", () => {
    const result = validateVersionSync(undefined, "1.0.0");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("marketplace.json");
  });

  test("fails when plugin version is missing", () => {
    const result = validateVersionSync("1.0.0", undefined);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("plugin.json");
  });

  test("fails when both versions are missing (marketplace first)", () => {
    const result = validateVersionSync(undefined, undefined);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("marketplace.json");
  });
});

describe("validateRequiredFields", () => {
  test("passes when all required fields present", () => {
    const mp: PluginEntry = {
      name: "test",
      source: "./test",
      version: "1.0.0",
      description: "A test plugin",
    };
    const plugin: PluginJson = {
      name: "test",
      version: "1.0.0",
      description: "A test plugin",
    };
    const result = validateRequiredFields(mp, plugin);
    expect(result.passed).toBe(true);
    expect(result.message).toBe("Required fields present");
  });

  test("fails when marketplace fields missing", () => {
    const mp: PluginEntry = {
      name: "test",
      source: "./test",
    };
    const plugin: PluginJson = {
      name: "test",
      version: "1.0.0",
      description: "A test plugin",
    };
    const result = validateRequiredFields(mp, plugin);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("marketplace:version");
    expect(result.message).toContain("marketplace:description");
  });

  test("fails when plugin fields missing", () => {
    const mp: PluginEntry = {
      name: "test",
      source: "./test",
      version: "1.0.0",
      description: "A test plugin",
    };
    const plugin: PluginJson = {
      name: "test",
    };
    const result = validateRequiredFields(mp, plugin);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("plugin:version");
    expect(result.message).toContain("plugin:description");
  });

  test("fails and lists all missing fields", () => {
    const mp: PluginEntry = {
      name: "test",
      source: "./test",
    };
    const plugin: PluginJson = {};
    const result = validateRequiredFields(mp, plugin);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("marketplace:version");
    expect(result.message).toContain("marketplace:description");
    expect(result.message).toContain("plugin:name");
    expect(result.message).toContain("plugin:version");
    expect(result.message).toContain("plugin:description");
  });
});

describe("extractVersionFromReadme", () => {
  test("extracts version from markdown table row", () => {
    const content = "| [git-tools](git-tools/) | 1.9.0 | Description here |";
    const version = extractVersionFromReadme(content, "git-tools");
    expect(version).toBe("1.9.0");
  });

  test("returns null when plugin not in README", () => {
    const content = "| [other-plugin](other/) | 1.0.0 | Desc |";
    const version = extractVersionFromReadme(content, "git-tools");
    expect(version).toBeNull();
  });

  test("handles multi-line README", () => {
    const content = `
| Plugin | Version | Description |
|--------|---------|-------------|
| [plugin-a](a/) | 1.0.0 | Desc A |
| [plugin-b](b/) | 2.0.0 | Desc B |
| [plugin-c](c/) | 3.5.1 | Desc C |
`;
    expect(extractVersionFromReadme(content, "plugin-a")).toBe("1.0.0");
    expect(extractVersionFromReadme(content, "plugin-b")).toBe("2.0.0");
    expect(extractVersionFromReadme(content, "plugin-c")).toBe("3.5.1");
  });

  test("handles plugin names with special regex characters", () => {
    const content = "| [my-plugin.js](my-plugin/) | 1.0.0 | Desc |";
    const version = extractVersionFromReadme(content, "my-plugin.js");
    expect(version).toBe("1.0.0");
  });

  test("returns null for empty content", () => {
    const version = extractVersionFromReadme("", "git-tools");
    expect(version).toBeNull();
  });
});

describe("validateReadmeVersion", () => {
  test("passes when versions match", () => {
    const result = validateReadmeVersion("1.9.0", "1.9.0", "git-tools");
    expect(result.passed).toBe(true);
  });

  test("fails when versions differ", () => {
    const result = validateReadmeVersion("1.8.0", "1.9.0", "git-tools");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("git-tools");
    expect(result.message).toContain("1.8.0");
    expect(result.message).toContain("1.9.0");
  });
});
