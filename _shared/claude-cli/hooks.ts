/**
 * Hook factory utilities for common hook patterns.
 *
 * @remarks
 * **SECURITY NOTE: Fail-Open Behavior**
 *
 * All hook factories use fail-open semantics: if the validation logic throws
 * an exception, the operation is ALLOWED to proceed. This design prioritizes
 * availability over safety - a buggy hook won't block legitimate operations.
 *
 * If you need fail-closed behavior (block on error), catch exceptions in your
 * validation function and return `{ block: true, reason: "..." }`.
 *
 * @example
 * ```typescript
 * #!/usr/bin/env bun
 * import { createPreToolUseHook } from "./_shared/claude-cli/hooks";
 *
 * createPreToolUseHook({
 *   matcher: "Bash",
 *   validate: (input) => {
 *     if (input.tool_input?.command?.includes("rm -rf")) {
 *       return { block: true, reason: "Dangerous command blocked" };
 *     }
 *     return { block: false };
 *   },
 * }).run();
 * ```
 */

import type { HookInput } from "./types";
import { readHookInput } from "./index";

/**
 * Validation result from a hook validator.
 */
export interface ValidationResult {
  /** Whether to block the operation */
  block: boolean;
  /** Reason shown to user when blocking */
  reason?: string;
}

/**
 * Configuration for PreToolUse hooks.
 */
export interface PreToolUseHookConfig {
  /** Tool name to match (e.g., "Bash", "Edit"). Omit to match all tools. */
  matcher?: string;
  /** Validation function. Return { block: true } to prevent the tool from running. */
  validate: (input: HookInput) => ValidationResult | Promise<ValidationResult>;
}

/**
 * Configuration for PostToolUse hooks.
 */
export interface PostToolUseHookConfig {
  /** Tool name to match. Omit to match all tools. */
  matcher?: string;
  /** Handler called after tool execution. */
  handler: (input: HookInput) => void | Promise<void>;
}

/**
 * Configuration for SubagentStop hooks.
 */
export interface SubagentStopHookConfig {
  /** Contract verification function. Return false to block session end. */
  checkContract: (input: HookInput) => boolean | Promise<boolean>;
  /** Message shown when contract is not fulfilled. */
  failureMessage: string;
}

/**
 * Create a PreToolUse hook for validating tool calls.
 *
 * Exit codes:
 * - 0: Allow the operation
 * - 2: Block the operation (reason shown to user via stderr)
 *
 * @example
 * ```typescript
 * #!/usr/bin/env bun
 * import { createPreToolUseHook, spawn, VALIDATE_PRESET, withPreset } from "./_shared/claude-cli";
 *
 * createPreToolUseHook({
 *   matcher: "Bash",
 *   validate: (input) => {
 *     const cmd = input.tool_input?.command as string;
 *     if (!cmd) return { block: false };
 *
 *     // Use agent to analyze command
 *     const result = spawn(withPreset(VALIDATE_PRESET, {
 *       prompt: `Is this command safe? Answer SAFE or UNSAFE: ${cmd}`,
 *       maxTurns: 1,
 *     }));
 *
 *     if (!result.ok || result.result.includes("UNSAFE")) {
 *       return { block: true, reason: result.ok ? result.result : result.error };
 *     }
 *     return { block: false };
 *   },
 * }).run();
 * ```
 */
export function createPreToolUseHook(config: PreToolUseHookConfig) {
  return {
    async run() {
      const input = readHookInput();
      if (!input) {
        process.exit(0);
      }

      // Check matcher
      if (config.matcher && input.tool_name !== config.matcher) {
        process.exit(0);
      }

      try {
        const result = await config.validate(input);

        if (result.block) {
          if (result.reason) {
            console.error(result.reason);
          }
          process.exit(2); // Block
        }

        process.exit(0); // Allow
      } catch (err) {
        console.error(`HOOK ERROR: ${err}`);
        process.exit(0); // Allow on error (fail-open)
      }
    },
  };
}

/**
 * Create a PostToolUse hook for reacting to tool execution.
 *
 * PostToolUse hooks run after a tool completes. They cannot block
 * the operation but can provide additional context or trigger side effects.
 *
 * @example
 * ```typescript
 * #!/usr/bin/env bun
 * import { createPostToolUseHook } from "./_shared/claude-cli/hooks";
 *
 * createPostToolUseHook({
 *   matcher: "Edit",
 *   handler: (input) => {
 *     console.log(`File edited: ${input.tool_input?.file_path}`);
 *   },
 * }).run();
 * ```
 */
export function createPostToolUseHook(config: PostToolUseHookConfig) {
  return {
    async run() {
      const input = readHookInput();
      if (!input) {
        process.exit(0);
      }

      // Check matcher
      if (config.matcher && input.tool_name !== config.matcher) {
        process.exit(0);
      }

      try {
        await config.handler(input);
        process.exit(0);
      } catch (err) {
        console.error(`HOOK ERROR: ${err}`);
        process.exit(0);
      }
    },
  };
}

/**
 * Create a SubagentStop hook for enforcing output contracts.
 *
 * SubagentStop hooks verify that a subagent produced expected outputs
 * before allowing the session to end.
 *
 * @example
 * ```typescript
 * #!/usr/bin/env bun
 * import { createSubagentStopHook } from "./_shared/claude-cli/hooks";
 *
 * createSubagentStopHook({
 *   checkContract: (input) => {
 *     const outputFile = `.t-plan/${input.session_id}/explore.md`;
 *     return Bun.file(outputFile).exists();
 *   },
 *   failureMessage: "Subagent must write explore.md before stopping",
 * }).run();
 * ```
 */
export function createSubagentStopHook(config: SubagentStopHookConfig) {
  return {
    async run() {
      const input = readHookInput();
      if (!input?.session_id) {
        process.exit(0);
      }

      try {
        const contractMet = await config.checkContract(input);

        if (!contractMet) {
          console.error(`CONTRACT UNFULFILLED: ${config.failureMessage}`);
          process.exit(2); // Block
        }

        process.exit(0); // Allow
      } catch (err) {
        console.error(`HOOK ERROR: ${err}`);
        process.exit(0); // Allow on error
      }
    },
  };
}

/**
 * Create a UserPromptSubmit hook for intercepting user prompts.
 *
 * @example
 * ```typescript
 * #!/usr/bin/env bun
 * import { createUserPromptSubmitHook } from "./_shared/claude-cli/hooks";
 *
 * createUserPromptSubmitHook({
 *   validate: (input) => {
 *     const prompt = input.user_prompt || "";
 *     if (prompt.toLowerCase().includes("delete everything")) {
 *       return { block: true, reason: "This prompt seems dangerous" };
 *     }
 *     return { block: false };
 *   },
 * }).run();
 * ```
 */
export function createUserPromptSubmitHook(config: {
  validate: (input: HookInput) => ValidationResult | Promise<ValidationResult>;
}) {
  return {
    async run() {
      const input = readHookInput();
      if (!input) {
        process.exit(0);
      }

      try {
        const result = await config.validate(input);

        if (result.block) {
          if (result.reason) {
            console.error(result.reason);
          }
          process.exit(2);
        }

        process.exit(0);
      } catch (err) {
        console.error(`HOOK ERROR: ${err}`);
        process.exit(0);
      }
    },
  };
}
