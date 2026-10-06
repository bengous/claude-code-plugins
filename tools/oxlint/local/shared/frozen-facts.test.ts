import { describe, expect, test } from "bun:test";

import { frozenFactsIn } from "./frozen-facts.ts";

function facts(text: string): string[] {
  return frozenFactsIn(text).map((fact) => fact.text);
}

describe("Claude Code versions", () => {
  test("with the index each one starts at", () => {
    expect(frozenFactsIn("Measured on Claude Code 2.1.287.")).toEqual([
      { index: 24, text: "2.1.287" },
    ]);
  });

  test("every one of a list", () => {
    expect(facts("in the kit on 2.1.282, 2.1.283 and 2.1.284")).toEqual([
      "2.1.282",
      "2.1.283",
      "2.1.284",
    ]);
  });

  test("with a leading v, reported without it", () => {
    expect(facts("verified against CLI v2.1.232")).toEqual(["2.1.232"]);
  });

  test("named, whatever its patch", () => {
    expect(facts("since Claude Code 2.2.0, and claude-code@3.0.12")).toEqual(["2.2.0", "3.0.12"]);
  });

  test("named and shaped at once is one fact", () => {
    expect(facts("Written by Claude Code 2.1.291.")).toEqual(["2.1.291"]);
  });

  test("not another tool's or a plugin's version", () => {
    const text = [
      "lefthook 2.1.12 skips a pre-push run job",
      "gh 2.99.0 or later, native zstd in 1.2.14",
      "| [claude-orchestration](orchestration/) | 2.8.2 | Parallel |",
      "Chrome 120.0.6099.109",
    ].join("\n");

    expect(facts(text)).toEqual([]);
  });

  test("not a date", () => {
    expect(facts("## 0.17.1 - 2026-10-06")).toEqual([]);
  });
});

describe("GitHub Actions run ids", () => {
  test("after run or runs, every one of a list", () => {
    expect(facts("run 37004299897, and (runs 35859775898, 35860625035)")).toEqual([
      "37004299897",
      "35859775898",
      "35860625035",
    ]);
  });

  test("with no context word", () => {
    expect(facts("947e49c ran in 35834032446 (`dev`)")).toEqual(["35834032446"]);
  });

  test("in a run's URL", () => {
    expect(facts("https://github.com/o/r/actions/runs/35858620580/job/1")).toEqual(["35858620580"]);
  });

  test("not a Unix time, a 32-bit bound, a byte count or an ISBN", () => {
    const text = [
      "at 1758821481 seconds, 1758400000000 ms",
      "z-index 2147483647, 1073741824 bytes",
      "https://www.amazon.com/dp/0134494164 and 9781491971437",
      "a float 7.000000000000001",
    ].join("\n");

    expect(facts(text)).toEqual([]);
  });
});
