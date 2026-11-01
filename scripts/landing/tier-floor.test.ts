import { describe, expect, test } from "bun:test";

import {
  type Change,
  changesOf,
  type FloorInput,
  floorOf,
  LINE_CAP,
  linesOf,
  riskyPaths,
} from "./tier-floor.ts";

const RISKY = { kind: "read", risky: ["scripts/land.ts", ".github/workflows/**"] } as const;

function input(changes: readonly Change[], fields: Partial<FloorInput> = {}): FloorInput {
  return { changes, subjects: ["docs: a line"], risky: RISKY, lines: 10, ...fields };
}

const modified = (path: string): Change => ({ status: "M", paths: [path] });

describe("floorOf", () => {
  test("leaves a small change off every listed path to the judge", () => {
    expect(floorOf(input([modified("docs/repo-ops/git.md"), modified("scripts/a.ts")]))).toBeNull();
  });

  test("sends a change touching a risky path to the human, naming it", () => {
    expect(floorOf(input([modified("docs/x.md"), modified("scripts/land.ts")]))).toEqual({
      tier: "human",
      reason: "touches a risky path: scripts/land.ts",
    });
  });

  test("counts both sides of a rename against the risky globs", () => {
    const renamed: Change = { status: "R", paths: ["scripts/land.ts", "scripts/landing.ts"] };

    expect(floorOf(input([renamed]))?.reason).toContain("scripts/land.ts");
  });

  test("counts every path as risky while the profile does not read", () => {
    const unreadable = { kind: "unreadable", why: "profile.reveiw: unknown key" } as const;

    expect(floorOf(input([modified("docs/x.md")], { risky: unreadable }))).toEqual({
      tier: "human",
      reason:
        "the review profile does not read, so every path is risky: profile.reveiw: unknown key",
    });
  });

  test("sends a change touching an e2e path to the human", () => {
    expect(floorOf(input([modified("vellum/src/page.ts")]))?.reason).toBe(
      "touches an e2e path: vellum/src/page.ts",
    );
  });

  test("sends a breaking commit to the human, whatever its paths", () => {
    const subjects = ["docs: a line", "feat(github-flow)!: drop the worker agent"];

    expect(floorOf(input([modified("docs/x.md")], { subjects }))?.reason).toBe(
      "a breaking commit: feat(github-flow)!: drop the worker agent",
    );
  });

  test.each([
    ["A", "github-flow/skills/new/SKILL.md"],
    ["D", "github-flow/agents/issue-worker.md"],
    ["R", "github-flow/skills/pr/SKILL.md"],
    ["A", "newplugin/.claude-plugin/plugin.json"],
    ["D", ".claude-plugin/marketplace.json"],
  ])("sends a component file with status %s (%s) to the human", (status, path) => {
    expect(floorOf(input([{ status, paths: [path] }]))?.reason).toBe(
      `adds, removes or renames a plugin component: ${path}`,
    );
  });

  test("leaves a component file only modified to the judge", () => {
    expect(floorOf(input([modified("github-flow/skills/pr/SKILL.md")]))).toBeNull();
  });

  test("sends an added command to the human", () => {
    expect(floorOf(input([{ status: "A", paths: ["git/commands/new.md"] }]))?.tier).toBe("human");
  });

  test.each(["github-flow/hooks/hooks.json", "atlas/.mcp.json", ".mcp.json"])(
    "sends any change to %s, which runs in every session, to the human",
    (path) => {
      expect(floorOf(input([modified(path)]))?.reason).toBe(
        `changes hooks or MCP servers: ${path}`,
      );
    },
  );

  test("sends a change past the line cap to the human, and keeps one at the cap", () => {
    const docs = [modified("docs/x.md")];

    expect(floorOf(input(docs, { lines: LINE_CAP }))).toBeNull();
    expect(floorOf(input(docs, { lines: LINE_CAP + 1 }))?.reason).toBe(
      `${LINE_CAP + 1} lines changed, past the ${LINE_CAP}-line cap`,
    );
  });

  test("sends a change that touches no file to the human", () => {
    expect(floorOf(input([]))?.tier).toBe("human");
  });

  test("names three paths, then counts the rest", () => {
    const many = ["a", "b", "c", "d", "e"].map((name) => modified(`vellum/src/${name}.ts`));

    expect(floorOf(input(many))?.reason).toBe(
      "touches an e2e path: vellum/src/a.ts, vellum/src/b.ts, vellum/src/c.ts and 2 more",
    );
  });
});

describe("changesOf", () => {
  test("reads git diff --name-status -z, a rename with its two paths", () => {
    expect(changesOf("M\0docs/x.md\0R087\0a.ts\0b.ts\0A\0c.ts\0")).toEqual([
      { status: "M", paths: ["docs/x.md"] },
      { status: "R", paths: ["a.ts", "b.ts"] },
      { status: "A", paths: ["c.ts"] },
    ]);
  });

  test("reads no change from an empty diff", () => {
    expect(changesOf("")).toEqual([]);
  });
});

describe("linesOf", () => {
  test("adds the added and removed lines, a binary file counting none", () => {
    expect(
      linesOf("3\t1\tdocs/x.md\u00002\t0\t\u0000old.ts\u0000new.ts\u0000-\t-\timage.png\u0000"),
    ).toBe(6);
  });
});

describe("riskyPaths", () => {
  test("keeps the paths a risky glob matches", () => {
    expect(riskyPaths(["docs/x.md", ".github/workflows/ci.yml"], RISKY)).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });
});
