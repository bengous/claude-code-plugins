/**
 * Pure validation functions for marketplace plugin validation.
 * No side effects - all functions return ValidationResult objects.
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
  pluginName: string | undefined
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
  pluginVersion: string | undefined
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
export function validateRequiredFields(
  mp: PluginEntry,
  pluginJson: PluginJson
): ValidationResult {
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
 * Extract version number from README markdown table for a given plugin.
 * Returns null if plugin not found in README.
 */
export function extractVersionFromReadme(
  content: string,
  pluginName: string
): string | null {
  // Match pattern: [plugin-name]... | X.Y.Z
  const escapedName = pluginName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\[${escapedName}\\][^|]+\\|\\s*([0-9]+\\.[0-9]+\\.[0-9]+)`
  );
  const match = content.match(pattern);
  return match ? match[1] : null;
}

/**
 * Validate that README version matches expected version.
 */
export function validateReadmeVersion(
  readmeVersion: string,
  expectedVersion: string,
  pluginName: string
): ValidationResult {
  if (readmeVersion === expectedVersion) {
    return { passed: true, message: "Versions match marketplace.json" };
  }
  return {
    passed: false,
    message: `README version mismatch: ${pluginName} (${readmeVersion} != ${expectedVersion})`,
  };
}
