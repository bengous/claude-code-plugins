/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import { parseFinalDir, parseProjectPath, parseVersion, parseWipDir } from "./paths.ts";

describe("parseWipDir", () => {
  test("accepts plans/<date>/wip-<sid8>/ only", () => {
    expect(parseWipDir("plans/2026-09-15/wip-4c2a9d93/").ok).toBe(true);
    expect(parseWipDir("plans/2026-09-15/wip-4c2a9d93").ok).toBe(false);
    expect(parseWipDir("plans/2026-09-15/notification/").ok).toBe(false);
    expect(parseWipDir("other/2026-09-15/wip-4c2a9d93/").ok).toBe(false);
  });
});

describe("parseFinalDir", () => {
  test("refuses a wip- slug", () => {
    expect(parseFinalDir("plans/2026-09-15/notification-settings/").ok).toBe(true);
    expect(parseFinalDir("plans/2026-09-15/wip-4c2a9d93/").ok).toBe(false);
  });
});

describe("parseVersion", () => {
  test("integers from 1", () => {
    expect(parseVersion(1).ok).toBe(true);
    expect(parseVersion(0).ok).toBe(false);
    expect(parseVersion(1.5).ok).toBe(false);
  });
});

describe("parseProjectPath", () => {
  test("keeps a relative path, normalized", () => {
    const parsed = parseProjectPath("./plans//x/./a.md");
    expect(parsed).toEqual({ ok: true, value: "plans/x/a.md" as never });
  });

  test("refuses absolute paths and parent segments", () => {
    expect(parseProjectPath("/etc/passwd").ok).toBe(false);
    expect(parseProjectPath("plans/../../etc/passwd").ok).toBe(false);
    expect(parseProjectPath("").ok).toBe(false);
  });
});
