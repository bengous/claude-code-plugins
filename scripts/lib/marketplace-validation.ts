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
 * Validate that descriptions are present and synchronized.
 */
export function validateDescriptionSync(
  mpDescription: string | undefined,
  pluginDescription: string | undefined,
): ValidationResult {
  if (!mpDescription) {
    return { passed: false, message: "Description missing in marketplace.json" };
  }

  if (!pluginDescription) {
    return { passed: false, message: "Description missing in plugin.json" };
  }

  if (mpDescription === pluginDescription) {
    return { passed: true, message: "Description synced" };
  }

  return {
    passed: false,
    message: `Description mismatch: marketplace=${mpDescription}\n    plugin=${pluginDescription}`,
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
 * `types/` is what Claude Code writes, and git-ignores, beside a mod it loads
 * from `--plugin-dir`.
 */
const PLUGIN_DIR_ENTRIES: ReadonlySet<string> = new Set(["plugin.json", "types"]);

/**
 * Validate that a plugin's `.claude-plugin/` holds nothing but `plugin.json`
 * and the types Claude Code writes there.
 * Callers check that `plugin.json` itself exists before reading the directory.
 */
export function validatePluginDirContents(entries: ReadonlyArray<string>): ValidationResult {
  const extras = entries.filter((entry) => !PLUGIN_DIR_ENTRIES.has(entry)).toSorted();

  if (extras.length === 0) {
    return { passed: true, message: "Only plugin.json and types/ in .claude-plugin/" };
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

const escapeForRegex = (name: string) => name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Extract version number from README markdown table for a given plugin.
 * Returns null if plugin not found in README.
 */
export function extractVersionFromReadme(content: string, pluginName: string): string | null {
  // Match pattern: [plugin-name]... | X.Y.Z
  const pattern = new RegExp(
    `\\[${escapeForRegex(pluginName)}\\][^|]+\\|\\s*([0-9]+\\.[0-9]+\\.[0-9]+)`,
    "u",
  );

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
  const pattern = new RegExp(
    `(\\[${escapeForRegex(pluginName)}\\][^|]+\\|\\s*)[0-9]+\\.[0-9]+\\.[0-9]+`,
    "u",
  );

  return content.replace(pattern, `$1${version}`);
}

/**
 * The description is the third cell of the row: [plugin-name](src/) | X.Y.Z | text.
 * The match starts at a line that opens a table row, so a link to the plugin in
 * the README's prose is no candidate; no cell crosses a line break, so a row
 * whose description cell is empty reads as an empty string, and a plugin that
 * prose names but the table does not reads as no row at all.
 */
const readmeDescriptionPattern = (pluginName: string) =>
  new RegExp(
    `(^[ \\t]*\\|\\s*\\[${escapeForRegex(pluginName)}\\][^|\\n]*\\|[^|\\n]*\\|)([^|\\n]*)`,
    "mu",
  );

/**
 * Extract the description from the README markdown table for a given plugin.
 * Returns null if plugin not found in README.
 */
export function extractDescriptionFromReadme(content: string, pluginName: string): string | null {
  const match = content.match(readmeDescriptionPattern(pluginName));

  return match?.[2]?.trim() ?? null;
}

/**
 * Rewrite the description in the README markdown table row for a given plugin.
 * Returns the content unchanged if the plugin has no matching row. A function
 * replacement, so a `$&` or a `$1` inside the description stays literal.
 */
export function setDescriptionInReadme(
  content: string,
  pluginName: string,
  description: string,
): string {
  return content.replace(
    readmeDescriptionPattern(pluginName),
    (_match, prefix: string) => `${prefix} ${description} `,
  );
}

const CELL_FLAWS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\|/u, 'holds a "|"'],
  [/[\r\n]/u, "holds a line break"],
  [/^\s|\s$/u, "opens or ends on whitespace"],
];

/**
 * A README row is one line of a Markdown table: a `|` would close the cell early
 * and shift every column after it, a line break would split the row in two, and
 * edge whitespace never survives the read back, so the sync would rewrite the
 * row at every run. Such a description is refused rather than repaired: the
 * author rewords it in plugin.json, where consumers read the text as well.
 */
export function validateDescriptionCell(pluginName: string, description: string): ValidationResult {
  const flaw = CELL_FLAWS.find(([pattern]) => pattern.test(description));

  if (!flaw) {
    return { passed: true, message: "Description fits a README cell" };
  }

  return {
    passed: false,
    message: `Description of ${pluginName} ${flaw[1]}, which no README table cell can carry`,
  };
}

/**
 * Validate that README description matches expected description.
 */
export function validateReadmeDescription(
  readmeDescription: string,
  expectedDescription: string,
  pluginName: string,
): ValidationResult {
  if (readmeDescription === expectedDescription) {
    return { passed: true, message: "Descriptions match marketplace.json" };
  }

  return {
    passed: false,
    message: `README description mismatch: ${pluginName} (README=${readmeDescription}\n    marketplace=${expectedDescription})`,
  };
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
