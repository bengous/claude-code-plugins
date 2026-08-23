/**
 * Pure validation functions for marketplace plugin validation. No side effects.
 */

export interface PluginEntry {
  name: string;
  source: string;
  version?: string;
  description?: string;
}

export interface PluginJson {
  name?: string;
  version?: string;
  description?: string;
}

export interface ValidationResult {
  passed: boolean;
  message: string;
}

/**
 * Validate that marketplace name matches plugin.json name.
 */
export function validateNameMatch(
  mpName: string,
  pluginName: string | undefined,
): ValidationResult {
  if (mpName === pluginName) {
    return { passed: true, message: "Name matches" };
  }
  return {
    passed: false,
    message: `Name mismatch: marketplace=${mpName}, plugin=${pluginName}`,
  };
}

/**
 * Validate that versions are present and synchronized.
 */
export function validateVersionSync(
  mpVersion: string | undefined,
  pluginVersion: string | undefined,
): ValidationResult {
  if (!mpVersion) {
    return { passed: false, message: "Version missing in marketplace.json" };
  }
  if (!pluginVersion) {
    return { passed: false, message: "Version missing in plugin.json" };
  }
  if (mpVersion === pluginVersion) {
    return { passed: true, message: `Version synced (${mpVersion})` };
  }
  return {
    passed: false,
    message: `Version mismatch: marketplace=${mpVersion}, plugin=${pluginVersion}`,
  };
}

/**
 * Validate that all required fields are present in both marketplace entry and plugin.json.
 */
export function validateRequiredFields(mp: PluginEntry, pluginJson: PluginJson): ValidationResult {
  const missingFields: string[] = [];

  if (!mp.name) missingFields.push("marketplace:name");
  if (!mp.version) missingFields.push("marketplace:version");
  if (!mp.description) missingFields.push("marketplace:description");
  if (!pluginJson.name) missingFields.push("plugin:name");
  if (!pluginJson.version) missingFields.push("plugin:version");
  if (!pluginJson.description) missingFields.push("plugin:description");

  if (missingFields.length === 0) {
    return { passed: true, message: "Required fields present" };
  }
  return {
    passed: false,
    message: `Missing fields: ${missingFields.join(", ")}`,
  };
}

/**
 * Validate that a plugin's `.claude-plugin/` holds nothing but `plugin.json`.
 * Callers check that `plugin.json` itself exists before reading the directory.
 */
export function validatePluginDirContents(entries: ReadonlyArray<string>): ValidationResult {
  const extras = entries.filter((entry) => entry !== "plugin.json").toSorted();
  if (extras.length === 0) {
    return { passed: true, message: "Only plugin.json in .claude-plugin/" };
  }
  return {
    passed: false,
    message: `Extra files in .claude-plugin/: ${extras.join(", ")}`,
  };
}

export interface HardcodedPath {
  line: number;
  text: string;
}

const HARDCODED_HOME_RE = /(?:\/home\/|\/Users\/)[a-zA-Z]+/u;

/**
 * Find machine-specific home paths in shipped plugin code. A plugin carrying
 * one works only on the author's machine, and consumers install the source
 * verbatim.
 */
export function findHardcodedPaths(content: string): ReadonlyArray<HardcodedPath> {
  const found: HardcodedPath[] = [];
  for (const [index, text] of content.split("\n").entries()) {
    if (HARDCODED_HOME_RE.test(text)) {
      found.push({ line: index + 1, text: text.trim() });
    }
  }
  return found;
}

/**
 * Extract version number from README markdown table for a given plugin.
 * Returns null if plugin not found in README.
 */
export function extractVersionFromReadme(content: string, pluginName: string): string | null {
  // Match pattern: [plugin-name]... | X.Y.Z
  const escapedName = pluginName.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`\\[${escapedName}\\][^|]+\\|\\s*([0-9]+\\.[0-9]+\\.[0-9]+)`, "u");
  const match = content.match(pattern);
  return match?.[1] ?? null;
}

/**
 * Rewrite the version in the README markdown table row for a given plugin.
 * Mirrors extractVersionFromReadme's pattern, capturing the prefix (name cell +
 * column separator) so only the version token is replaced. Returns the content
 * unchanged if the plugin has no matching row.
 */
export function setVersionInReadme(content: string, pluginName: string, version: string): string {
  const escapedName = pluginName.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(\\[${escapedName}\\][^|]+\\|\\s*)[0-9]+\\.[0-9]+\\.[0-9]+`, "u");
  return content.replace(pattern, `$1${version}`);
}

/**
 * Validate that README version matches expected version.
 */
export function validateReadmeVersion(
  readmeVersion: string,
  expectedVersion: string,
  pluginName: string,
): ValidationResult {
  if (readmeVersion === expectedVersion) {
    return { passed: true, message: "Versions match marketplace.json" };
  }
  return {
    passed: false,
    message: `README version mismatch: ${pluginName} (${readmeVersion} != ${expectedVersion})`,
  };
}
