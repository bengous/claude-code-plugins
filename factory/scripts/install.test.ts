import { describe, expect, test } from "bun:test";

import { decide, placements, report } from "./install.ts";

const FILES = [
  { path: "repo/.github/CODEOWNERS", content: "owners" },
  { path: "repo/.github/workflows/review.yml", content: "review" },
  { path: "routine/prompt.md", content: "prompt" },
  { path: "claude-md-sections.md", content: "sections" },
];

const ON_DISK: ReadonlyMap<string, string> = new Map([
  ["/t/.github/CODEOWNERS", "owners"],
  ["/t/.github/workflows/review.yml", "edited"],
]);

const current = (dest: string): string | null => ON_DISK.get(dest) ?? null;

describe("placements", () => {
  test("repo puts the repo/ files under the target, and nothing else", () => {
    expect(placements(FILES, { kind: "repo", target: "/t" })).toEqual([
      { dest: "/t/.github/CODEOWNERS", shown: ".github/CODEOWNERS", content: "owners" },
      {
        dest: "/t/.github/workflows/review.yml",
        shown: ".github/workflows/review.yml",
        content: "review",
      },
    ]);
  });

  test("prompt puts the routine prompt in its directory, and nothing else", () => {
    expect(placements(FILES, { kind: "prompt", dir: "/r" })).toEqual([
      { dest: "/r/prompt.md", shown: "/r/prompt.md", content: "prompt" },
    ]);
  });
});

describe("decide", () => {
  const items = placements(FILES, { kind: "repo", target: "/t" });

  test("never overwrites a differing file without force", () => {
    const decisions = decide(items, current, false);

    expect(decisions.map(({ outcome }) => outcome)).toEqual(["identical", "refused"]);
    expect(report(decisions)).toBe(
      [
        "identical  .github/CODEOWNERS",
        "refused    .github/workflows/review.yml: its content differs; --force overwrites it",
      ].join("\n"),
    );
  });

  test("overwrites a differing file with force and writes a missing one", () => {
    const decisions = decide(
      items,
      (dest) => (dest.endsWith("review.yml") ? "edited" : null),
      true,
    );

    expect(decisions.map(({ outcome }) => outcome)).toEqual(["wrote", "overwrote"]);
  });
});
