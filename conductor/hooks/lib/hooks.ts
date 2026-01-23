/**
 * Minimal Hook Utilities
 *
 * Lightweight helpers for Claude Code hook scripts.
 * Self-contained within conductor for marketplace portability.
 */

import { readFileSync } from "fs";
import type { HookInput } from "./types";

/**
 * Read hook input from stdin.
 * Returns null if stdin is empty or invalid JSON.
 */
export function readHookInput(): HookInput | null {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
}

/**
 * Allow the operation (exit 0).
 * Use when the hook should not block.
 */
export function allow(): never {
  process.exit(0);
}

/**
 * Block the operation (exit 2).
 * Reason is printed to stderr and shown to user.
 */
export function block(reason: string): never {
  console.error(reason);
  process.exit(2);
}
