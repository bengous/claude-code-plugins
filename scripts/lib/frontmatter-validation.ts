/**
 * Pure validation functions for YAML frontmatter validation.
 * No side effects - all functions return FrontmatterResult objects.
 */

import { parse, YAMLParseError } from "yaml";

export interface FrontmatterResult {
  valid: boolean;
  filePath: string;
  error?: {
    message: string;
    line?: number;
    col?: number;
    code?: string;
  };
  frontmatter?: Record<string, unknown>;
}

/**
 * Extract YAML frontmatter from markdown content.
 * Returns null if no frontmatter is present.
 */
export function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/**
 * Validate YAML frontmatter in a file's content.
 * Returns validation result with parsed frontmatter or error details.
 */
export function validateFrontmatter(
  filePath: string,
  content: string
): FrontmatterResult {
  const yaml = extractFrontmatter(content);

  if (!yaml) {
    return { valid: true, filePath }; // No frontmatter = skip
  }

  try {
    const frontmatter = parse(yaml, { strict: true });
    return { valid: true, filePath, frontmatter };
  } catch (e) {
    if (e instanceof YAMLParseError) {
      return {
        valid: false,
        filePath,
        error: {
          message: e.message,
          line: e.linePos?.[0]?.line,
          col: e.linePos?.[0]?.col,
          code: e.code,
        },
      };
    }
    return {
      valid: false,
      filePath,
      error: { message: String(e) },
    };
  }
}
