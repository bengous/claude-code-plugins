import { describe, expect, test } from "bun:test";

import { findOffences, isCandidate } from "./check-lint-disables.ts";

// Split so this file never carries a literal directive its own gate would flag.
const OX = "ox";
const ES = "es";
const BARE = `// ${OX}lint-disable-next-line no-console`;
const JUSTIFIED = `${BARE} -- the reason`;
const BARE_ESLINT = `// ${ES}lint-disable no-console`;

describe("isCandidate", () => {
  test("accepts every linted extension", () => {
    expect(isCandidate("scripts/a.ts")).toBe(true);
    expect(isCandidate("scripts/a.js")).toBe(true);
    expect(isCandidate("scripts/a.mjs")).toBe(true);
    expect(isCandidate("scripts/a.cjs")).toBe(true);
  });

  test("rejects other extensions", () => {
    expect(isCandidate("scripts/a.md")).toBe(false);
    expect(isCandidate("scripts/a.sh")).toBe(false);
    expect(isCandidate("scripts/a")).toBe(false);
  });

  test("rejects excluded prefixes whatever the extension", () => {
    expect(isCandidate("archive/a.mjs")).toBe(false);
    expect(isCandidate("_docs/a.cjs")).toBe(false);
    expect(isCandidate("node_modules/a.js")).toBe(false);
    expect(isCandidate("tools/oxlint/anti-slop/index.ts")).toBe(false);
  });
});

describe("findOffences", () => {
  test("reports a directive with no reason", () => {
    const offences = findOffences("a.mjs", `const x = 1;\n${BARE}\n`);
    expect(offences).toEqual([{ path: "a.mjs", line: 2, text: BARE }]);
  });

  test("accepts a directive that says why", () => {
    expect(findOffences("a.cjs", JUSTIFIED)).toEqual([]);
  });

  test("reports the eslint spelling too", () => {
    expect(findOffences("a.js", BARE_ESLINT)).toHaveLength(1);
  });

  test("ignores lines with no directive", () => {
    expect(findOffences("a.ts", "const x = 1;\n// a plain comment\n")).toEqual([]);
  });
});
