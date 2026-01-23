/**
 * Hook Installation Utilities
 *
 * Pure functions extracted from setup-hooks.ts for testability.
 * These functions handle hook merging and plugin identification.
 */

/** Plugin hook marker (used to identify and remove plugin hooks) */
export const PLUGIN_MARKER = "(from conductor plugin)";

/** Hook configuration as stored in Claude Code settings */
export interface HookConfig {
  type: "command";
  command: string;
  timeout: number;
  description: string;
}

/** Matcher configuration with associated hooks */
export interface MatcherConfig {
  matcher: string;
  hooks: HookConfig[];
}

/** Full hooks configuration by event type */
export type HooksConfig = Record<string, MatcherConfig[]>;

/**
 * Check if a hook was installed by this plugin.
 */
export function isPluginHook(hook: HookConfig): boolean {
  return hook.description?.includes(PLUGIN_MARKER) ?? false;
}

/**
 * Remove all plugin-installed hooks from a matcher array.
 * Returns new array without mutating input.
 */
export function removePluginHooks(matchers: MatcherConfig[]): MatcherConfig[] {
  if (!Array.isArray(matchers)) return matchers;

  return matchers
    .map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks.filter((h) => !isPluginHook(h)),
    }))
    .filter((matcher) => matcher.hooks.length > 0);
}

/**
 * Merge plugin hooks into existing hooks configuration.
 * Removes any existing plugin hooks first to allow clean reinstall.
 */
export function mergeHooks(
  existing: MatcherConfig[] | undefined,
  plugin: MatcherConfig[]
): MatcherConfig[] {
  if (!Array.isArray(existing)) {
    return plugin;
  }

  // Remove any existing plugin hooks first
  const cleaned = removePluginHooks(existing);
  const result = [...cleaned];

  for (const pluginMatcher of plugin) {
    const existingMatcher = result.find((m) => m.matcher === pluginMatcher.matcher);

    if (existingMatcher) {
      // Merge hooks for this matcher
      existingMatcher.hooks = [...existingMatcher.hooks, ...pluginMatcher.hooks];
    } else {
      // Add new matcher
      result.push(pluginMatcher);
    }
  }

  return result;
}

/**
 * Count how many plugin hooks are installed in a hooks configuration.
 */
export function countPluginHooks(matchers: MatcherConfig[] | undefined): number {
  if (!Array.isArray(matchers)) return 0;

  return matchers.reduce((count, matcher) => {
    return count + matcher.hooks.filter(isPluginHook).length;
  }, 0);
}
