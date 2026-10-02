import { describe, expect, test } from "bun:test";

import {
  validateNameMatch,
  validateVersionSync,
  validateDescriptionSync,
  validateRequiredFields,
  validatePluginDirContents,
  findHardcodedPaths,
  extractVersionFromReadme,
  setVersionInReadme,
  validateReadmeVersion,
  extractDescriptionFromReadme,
  setDescriptionInReadme,
  validateDescriptionCell,
  validateReadmeDescription,
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

describe("validatePluginDirContents", () => {
  test("passes when only plugin.json is present", () => {
    const result = validatePluginDirContents(["plugin.json"]);
    expect(result.passed).toBe(true);
  });

  test("passes with the types/ Claude Code writes beside a mod it loads", () => {
    const result = validatePluginDirContents(["plugin.json", "types"]);
    expect(result.passed).toBe(true);
  });

  test("fails and names every extra file", () => {
    const result = validatePluginDirContents(["plugin.json", "marketplace.json", "notes.md"]);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("marketplace.json");
    expect(result.message).toContain("notes.md");
  });

  test("does not report plugin.json as an extra", () => {
    const result = validatePluginDirContents(["plugin.json", "notes.md"]);
    expect(result.message).not.toContain("plugin.json,");
  });
});

describe("findHardcodedPaths", () => {
  test("finds a Linux home path with its line number", () => {
    const hits = findHardcodedPaths('const root = "/home/alice/work";');
    expect(hits).toEqual([{ line: 1, text: 'const root = "/home/alice/work";' }]);
  });

  test("finds a macOS home path", () => {
    expect(findHardcodedPaths("cd /Users/bob/repo")).toHaveLength(1);
  });

  test("reports the line number of a later match", () => {
    const hits = findHardcodedPaths("const a = 1;\nconst b = 2;\ncd /home/carol");
    expect(hits[0]?.line).toBe(3);
  });

  test("finds every offending line", () => {
    expect(findHardcodedPaths("/home/alice\nok\n/Users/bob")).toHaveLength(2);
  });

  test("ignores portable paths", () => {
    const content = [
      "const root = process.env.HOME;",
      'const dir = join(repoRoot, "plugins");',
      "cd ${CLAUDE_PLUGIN_ROOT}",
      "~/.claude/settings.json",
    ].join("\n");

    expect(findHardcodedPaths(content)).toEqual([]);
  });

  test("ignores /home and /Users without a user segment", () => {
    expect(findHardcodedPaths("mkdir /home\nls /Users/")).toEqual([]);
  });

  test("returns nothing for empty content", () => {
    expect(findHardcodedPaths("")).toEqual([]);
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

describe("setVersionInReadme", () => {
  test("rewrites the version in a table row", () => {
    const content = "| [git-tools](git-tools/) | 1.9.0 | Description here |";
    const result = setVersionInReadme(content, "git-tools", "2.0.0");
    expect(result).toBe("| [git-tools](git-tools/) | 2.0.0 | Description here |");
  });

  test("leaves content unchanged when plugin row is absent", () => {
    const content = "| [other-plugin](other/) | 1.0.0 | Desc |";
    const result = setVersionInReadme(content, "git-tools", "2.0.0");
    expect(result).toBe(content);
  });

  test("rewrites only the targeted row in a multi-line README", () => {
    const content = `| Plugin | Version | Description |
|--------|---------|-------------|
| [plugin-a](a/) | 1.0.0 | Desc A |
| [plugin-b](b/) | 2.0.0 | Desc B |
| [plugin-c](c/) | 3.5.1 | Desc C |`;

    const result = setVersionInReadme(content, "plugin-b", "2.1.0");
    expect(result).toContain("| [plugin-b](b/) | 2.1.0 | Desc B |");
    expect(result).toContain("| [plugin-a](a/) | 1.0.0 | Desc A |");
    expect(result).toContain("| [plugin-c](c/) | 3.5.1 | Desc C |");
  });

  test("handles plugin names with special regex characters", () => {
    const content = "| [my-plugin.js](my-plugin/) | 1.0.0 | Desc |";
    const result = setVersionInReadme(content, "my-plugin.js", "1.2.3");
    expect(result).toBe("| [my-plugin.js](my-plugin/) | 1.2.3 | Desc |");
  });

  test("round-trips with extractVersionFromReadme", () => {
    const content = "| [git-tools](git-tools/) | 1.9.0 | Desc |";
    const updated = setVersionInReadme(content, "git-tools", "3.1.4");
    expect(extractVersionFromReadme(updated, "git-tools")).toBe("3.1.4");
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

describe("validateDescriptionSync", () => {
  test("passes when descriptions match", () => {
    const result = validateDescriptionSync("A plugin", "A plugin");
    expect(result.passed).toBe(true);
    expect(result.message).toBe("Description synced");
  });

  test("fails when descriptions differ, naming both", () => {
    const result = validateDescriptionSync("An older blurb", "A plugin");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("An older blurb");
    expect(result.message).toContain("A plugin");
  });

  test("fails when either side is missing", () => {
    expect(validateDescriptionSync(undefined, "A plugin").passed).toBe(false);
    expect(validateDescriptionSync("A plugin", undefined).passed).toBe(false);
  });
});

describe("extractDescriptionFromReadme", () => {
  test("extracts the description cell from a table row", () => {
    const content = "| [git-tools](git-tools/) | 1.9.0 | Description here |";
    expect(extractDescriptionFromReadme(content, "git-tools")).toBe("Description here");
  });

  test("returns null when plugin not in README", () => {
    const content = "| [other-plugin](other/) | 1.0.0 | Desc |";
    expect(extractDescriptionFromReadme(content, "git-tools")).toBeNull();
  });

  test("reads the row of each plugin in a multi-line README", () => {
    const content = `
| Plugin | Version | Description |
|--------|---------|-------------|
| [plugin-a](a/) | 1.0.0 | Desc A |
| [plugin-b](b/) | 2.0.0 | Desc B |
| [plugin-c](c/) | 3.5.1 | Desc C |
`;

    expect(extractDescriptionFromReadme(content, "plugin-a")).toBe("Desc A");
    expect(extractDescriptionFromReadme(content, "plugin-b")).toBe("Desc B");
    expect(extractDescriptionFromReadme(content, "plugin-c")).toBe("Desc C");
  });

  test("stops at the line break of a row whose cell is empty", () => {
    const content = `| [plugin-a](a/) | 1.0.0 |
| [plugin-b](b/) | 2.0.0 | Desc B |`;

    expect(extractDescriptionFromReadme(content, "plugin-a")).toBe("");
  });

  test("skips a prose link and reads the table row", () => {
    const content = `Start with [plugin-a](plugin-a/), the core one.

| Plugin | Version | Description |
|--------|---------|-------------|
| [plugin-a](plugin-a/) | 1.0.0 | Desc A |`;

    expect(extractDescriptionFromReadme(content, "plugin-a")).toBe("Desc A");
  });

  test("returns null for a plugin only prose names", () => {
    const content = `Start with [plugin-a](plugin-a/), the core one.

| Plugin | Version | Description |
|--------|---------|-------------|
| [plugin-b](b/) | 2.0.0 | Desc B |`;

    expect(extractDescriptionFromReadme(content, "plugin-a")).toBeNull();
  });

  test("reads an indented row with padded cells", () => {
    const content = "  | [plugin-a](a/)  |  1.0.0  |   Desc A   |";
    expect(extractDescriptionFromReadme(content, "plugin-a")).toBe("Desc A");
  });

  test("handles plugin names with special regex characters", () => {
    const content = "| [my-plugin.js](my-plugin/) | 1.0.0 | Desc |";
    expect(extractDescriptionFromReadme(content, "my-plugin.js")).toBe("Desc");
  });
});

describe("setDescriptionInReadme", () => {
  test("rewrites the description in a table row", () => {
    const content = "| [git-tools](git-tools/) | 1.9.0 | Old blurb |";
    const result = setDescriptionInReadme(content, "git-tools", "New blurb");
    expect(result).toBe("| [git-tools](git-tools/) | 1.9.0 | New blurb |");
  });

  test("leaves content unchanged when plugin row is absent", () => {
    const content = "| [other-plugin](other/) | 1.0.0 | Desc |";
    expect(setDescriptionInReadme(content, "git-tools", "New blurb")).toBe(content);
  });

  test("rewrites only the targeted row in a multi-line README", () => {
    const content = `| Plugin | Version | Description |
|--------|---------|-------------|
| [plugin-a](a/) | 1.0.0 | Desc A |
| [plugin-b](b/) | 2.0.0 | Desc B |
| [plugin-c](c/) | 3.5.1 | Desc C |`;

    const result = setDescriptionInReadme(content, "plugin-b", "Rewritten");
    expect(result).toContain("| [plugin-b](b/) | 2.0.0 | Rewritten |");
    expect(result).toContain("| [plugin-a](a/) | 1.0.0 | Desc A |");
    expect(result).toContain("| [plugin-c](c/) | 3.5.1 | Desc C |");
  });

  test("keeps a dollar sign of the description literal", () => {
    const content = "| [git-tools](git-tools/) | 1.9.0 | Old blurb |";
    const result = setDescriptionInReadme(content, "git-tools", "Reads $& and $1");
    expect(result).toBe("| [git-tools](git-tools/) | 1.9.0 | Reads $& and $1 |");
  });

  test("round-trips with extractDescriptionFromReadme", () => {
    const content = "| [git-tools](git-tools/) | 1.9.0 | Old blurb |";
    const updated = setDescriptionInReadme(content, "git-tools", "New blurb");
    expect(extractDescriptionFromReadme(updated, "git-tools")).toBe("New blurb");
  });

  test("leaves the header a prose link would match first", () => {
    const content = `Start with [plugin-a](plugin-a/), the core one.

| Plugin | Version | Description |
|--------|---------|-------------|
| [plugin-a](plugin-a/) | 1.0.0 | Desc A |`;

    const result = setDescriptionInReadme(content, "plugin-a", "New blurb");
    expect(result).toContain("| Plugin | Version | Description |");
    expect(result).toContain("| [plugin-a](plugin-a/) | 1.0.0 | New blurb |");
  });

  test("leaves content unchanged for a plugin only prose names", () => {
    const content = `Start with [plugin-a](plugin-a/), the core one.

| Plugin | Version | Description |
|--------|---------|-------------|
| [plugin-b](b/) | 2.0.0 | Desc B |`;

    expect(setDescriptionInReadme(content, "plugin-a", "New blurb")).toBe(content);
  });
});

describe("validateDescriptionCell", () => {
  test("passes a description without a pipe", () => {
    expect(validateDescriptionCell("git-tools", "Local history without an editor").passed).toBe(
      true,
    );
  });

  test("refuses a description holding a pipe", () => {
    const result = validateDescriptionCell("git-tools", "Pipes a | through the row");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("git-tools");
    expect(result.message).toContain('holds a "|"');
    expect(result.message).toContain("README table cell");
  });

  test("refuses a description holding a line break", () => {
    for (const description of ["Line one\nline two", "Line one\r\nline two"]) {
      const result = validateDescriptionCell("git-tools", description);
      expect(result.passed).toBe(false);
      expect(result.message).toContain("holds a line break");
    }
  });

  test("refuses a description that opens or ends on whitespace", () => {
    for (const description of ["Ends on a space ", " Opens on a space"]) {
      const result = validateDescriptionCell("git-tools", description);
      expect(result.passed).toBe(false);
      expect(result.message).toContain("opens or ends on whitespace");
    }
  });
});

describe("validateReadmeDescription", () => {
  test("passes when descriptions match", () => {
    expect(validateReadmeDescription("A plugin", "A plugin", "git-tools").passed).toBe(true);
  });

  test("fails when descriptions differ, naming both", () => {
    const result = validateReadmeDescription("An older blurb", "A plugin", "git-tools");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("git-tools");
    expect(result.message).toContain("An older blurb");
    expect(result.message).toContain("A plugin");
  });
});
