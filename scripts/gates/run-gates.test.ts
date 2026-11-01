import { describe, expect, test } from "bun:test";

import { failureReport } from "./run-gates.ts";

describe("failureReport", () => {
  test("opens with the red gate names, then each failing gate with its output, in table order", () => {
    const report = failureReport([
      { gate: "typecheck", command: "bun x tsgo --noEmit", exitCode: 0, output: "" },
      { gate: "lint-ts", command: "bun x oxlint", exitCode: 1, output: "x no-unused-vars" },
      { gate: "fmt", command: "bun x oxfmt --check", exitCode: 2, output: "scripts/a.ts" },
    ]);

    expect(report).toBe(
      "Red gates: lint-ts, fmt\n\n" +
        "lint-ts: bun x oxlint\nx no-unused-vars\n\n" +
        "fmt: bun x oxfmt --check\nscripts/a.ts",
    );
  });

  test("is empty when every gate passes", () => {
    const report = failureReport([
      { gate: "typecheck", command: "bun x tsgo --noEmit", exitCode: 0, output: "" },
    ]);

    expect(report).toBe("");
  });
});
