import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CLAUDE_MD_SECTIONS, ROUTINE_PROMPT, TEMPLATES_DIR } from "./templates.ts";

/** The lines of a template that speak of a pull request's body without sending to the `pr` skill. */
function bodyRules(path: string): string[] {
  return readFileSync(join(TEMPLATES_DIR, path), "utf8")
    .split("\n")
    .filter(
      (line) =>
        /\b(?:pull request|PR)\b[^.]*\bbody\b|\*\*Checks\*\*/iu.test(line) &&
        !line.includes("`pr` skill"),
    );
}

test("the CLAUDE.md sections leave how to write a pull request body to the pr skill", () => {
  expect(bodyRules(CLAUDE_MD_SECTIONS)).toEqual([]);
});

test("the routine's prompt leaves how to write a pull request body to the pr skill", () => {
  expect(bodyRules(ROUTINE_PROMPT)).toEqual([]);
});
