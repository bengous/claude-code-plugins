import { describe, expect, test } from "bun:test";

import { promptFor } from "./headless-run.ts";

describe("promptFor", () => {
  test("fills each placeholder", () => {
    expect(promptFor("{{from}} → {{to}}", { from: "2.1.292", to: "2.1.294" })).toBe(
      "2.1.292 → 2.1.294",
    );
  });

  test("refuses a placeholder without a value, naming its source", () => {
    expect(() => promptFor("{{from}} {{form}}", { from: "2.1.292" }, "p.md")).toThrow(
      "p.md: no value for {{form}}",
    );
  });
});
