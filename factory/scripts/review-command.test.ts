import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TEMPLATES_DIR } from "./templates.ts";

const COMMAND = readFileSync(
  join(TEMPLATES_DIR, "repo", ".claude", "commands", "pr-review.md"),
  "utf8",
);

/** The `Bash(...)` rules of the command's `allowed-tools`, each as the commands it lets run. */
function bashRules(text: string): RegExp[] {
  const line = /^allowed-tools:(.*)$/mu.exec(text)?.[1] ?? "";

  return [...line.matchAll(/Bash\(([^)]+)\)/gu)].map(([, rule = ""]) => {
    // `prefix:*` is the older spelling of `prefix*`: anything after the prefix.
    const glob = rule.endsWith(":*") ? `${rule.slice(0, -2)}*` : rule;

    const pattern = glob
      .split("*")
      .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*");

    return new RegExp(`^${pattern}$`, "u");
  });
}

/** Every `gh` command the text names in backticks, each `<placeholder>` written as a value. */
function namedCommands(text: string): string[] {
  return [...text.matchAll(/`(gh [^`]+)`/gu)].map(([, command = ""]) =>
    command.replaceAll(/<[^>]+>/gu, "x"),
  );
}

describe("the review command", () => {
  test("its allowed-tools let every gh command its text names run", () => {
    const rules = bashRules(COMMAND);

    const denied = namedCommands(COMMAND).filter(
      (command) => !rules.some((rule) => rule.test(command)),
    );

    expect(rules.length).toBeGreaterThan(0);
    expect(denied).toEqual([]);
  });

  test("reads the artifacts of the issue it judges against", () => {
    expect(namedCommands(COMMAND)).toContain("gh api repos/x/x/issues/x/artifacts --paginate");
  });

  test("a gh command outside allowed-tools is caught", () => {
    const rules = bashRules("allowed-tools: Bash(gh api repos/*/issues/*/comments:*)\n");

    expect(rules.some((rule) => rule.test("gh api repos/x/x/issues/x/comments --paginate"))).toBe(
      true,
    );
    expect(rules.some((rule) => rule.test("gh api repos/x/x/issues/x/artifacts --paginate"))).toBe(
      false,
    );
  });
});
