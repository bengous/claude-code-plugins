/**
 * Configuration presets for common agent patterns.
 *
 * @example
 * ```typescript
 * import { spawn, withPreset, REVIEW_PRESET } from "./_shared/claude-cli";
 *
 * const result = spawn(withPreset(REVIEW_PRESET, {
 *   prompt: "Review this code for issues",
 * }));
 * ```
 */

import type { SpawnOptions } from "./types";

/**
 * Partial spawn options for presets.
 */
export type PresetOptions = Omit<Partial<SpawnOptions>, "prompt">;

/**
 * Preset for read-only exploration agents.
 * Safe for untrusted contexts - cannot modify files.
 */
export const EXPLORE_PRESET: PresetOptions = {
  allowedTools: ["Read", "Glob", "Grep"],
  disallowedTools: ["Edit", "Write", "Bash"],
  maxTurns: 10,
  model: "sonnet",
};

/**
 * Preset for code review agents.
 * Read-only access with limited turns for focused review.
 */
export const REVIEW_PRESET: PresetOptions = {
  allowedTools: ["Read", "Glob", "Grep"],
  disallowedTools: ["Edit", "Write", "Bash"],
  maxTurns: 5,
  model: "sonnet",
};

/**
 * Preset for quick validation agents.
 * Uses Haiku for fast, cheap validation checks.
 */
export const VALIDATE_PRESET: PresetOptions = {
  allowedTools: ["Read"],
  disallowedTools: ["Edit", "Write", "Bash"],
  maxTurns: 3,
  model: "haiku",
};

/**
 * Preset for analysis with web access.
 * Can search web and fetch URLs for documentation lookups.
 */
export const RESEARCH_PRESET: PresetOptions = {
  allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
  disallowedTools: ["Edit", "Write", "Bash"],
  maxTurns: 8,
  model: "sonnet",
};

/**
 * Preset for implementation agents.
 * Full tool access with Opus model for complex tasks.
 */
export const IMPLEMENT_PRESET: PresetOptions = {
  allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
  model: "opus",
  permissionMode: "acceptEdits",
};

/**
 * Preset for quick one-shot questions.
 * Single turn, no tools, fast response.
 */
export const QUICK_PRESET: PresetOptions = {
  allowedTools: [],
  maxTurns: 1,
  model: "haiku",
  noSessionPersistence: true,
};

/**
 * Merge a preset with custom options.
 * Custom options override preset values via spread.
 *
 * Tool arrays use nullish coalescing: if `options.allowedTools` is undefined,
 * the preset's tools are used. If explicitly set (even to []), options wins.
 *
 * @param preset - Base preset configuration
 * @param options - Custom options (prompt is required)
 * @returns Complete SpawnOptions
 *
 * @example
 * ```typescript
 * const result = spawn(withPreset(REVIEW_PRESET, {
 *   prompt: "Check for security issues",
 *   maxTurns: 3,  // Override preset's maxTurns
 * }));
 * ```
 */
export function withPreset(
  preset: PresetOptions,
  options: SpawnOptions
): SpawnOptions {
  return {
    ...preset,
    ...options,
    // Use nullish coalescing so undefined inherits preset, but [] overrides
    allowedTools: options.allowedTools ?? preset.allowedTools,
    disallowedTools: options.disallowedTools ?? preset.disallowedTools,
  };
}
