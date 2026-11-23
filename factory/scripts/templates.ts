import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import type { TemplateFile } from "./render.ts";

export const TEMPLATES_DIR = join(import.meta.dir, "..", "templates");

/** Templates under `repo/` land in the target repository at the rest of their path. */
export const REPO_PREFIX = "repo/";

export const ROUTINE_PROMPT = "routine/prompt.md";

export const CLAUDE_MD_SECTIONS = "claude-md-sections.md";

/** The hook entries the install merges into the target repository's `.claude/settings.json`. */
export const SETTINGS_HOOKS = "settings-hooks.json";

/** Every file under `root`, dot directories included, its path relative to `root` with `/`. */
export function readTemplates(root: string = TEMPLATES_DIR): TemplateFile[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);

      const path = full
        .slice(root.length + 1)
        .split(sep)
        .join("/");

      return { path, content: readFileSync(full, "utf8") };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}
