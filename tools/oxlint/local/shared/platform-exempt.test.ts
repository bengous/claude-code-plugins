import { describe, expect, test } from "bun:test";

import { isPlatformExempt } from "./platform-exempt.ts";

const exempt = (path: string): boolean => isPlatformExempt("/repo", `/repo/${path}`);

describe("isPlatformExempt", () => {
  test("exempts the source and every copy directory", () => {
    expect(exempt("tools/platform/git.ts")).toBe(true);
    expect(exempt("todos/lib/platform/pure.ts")).toBe(true);
    expect(exempt("vellum/src/platform/fs.ts")).toBe(true);
  });

  test("keeps a platform directory deeper than a copy lives", () => {
    expect(exempt("vellum/src/runtime/lib/platform/x.ts")).toBe(false);
    expect(exempt("lib/platform/x.ts")).toBe(false);
  });

  test("exempts the tests and what only they load", () => {
    for (const path of [
      "scripts/a.test.ts",
      "vellum/src/a.spec.ts",
      "scripts/land.fixture.ts",
      "atlas/fixtures/sample/map.ts",
      "fixtures/x.ts",
      "vellum/src/runtime/hooks/fixtures.ts",
      "agent-hooks/test-support.ts",
      "vellum/e2e/harness.ts",
    ]) {
      expect({ path, exempt: exempt(path) }).toEqual({ path, exempt: true });
    }
  });

  test("keeps product code, whatever its name holds", () => {
    expect(exempt("scripts/gates/affected.ts")).toBe(false);
    expect(exempt("scripts/attest.ts")).toBe(false);
    expect(exempt("vellum/src/e2e-paths.ts")).toBe(false);
  });

  test("reads a Windows path and a cwd with a trailing separator", () => {
    expect(isPlatformExempt("C:\\repo\\", "C:\\repo\\todos\\lib\\platform\\pure.ts")).toBe(true);
    expect(isPlatformExempt("C:\\repo", "C:\\repo\\scripts\\affected.ts")).toBe(false);
  });
});
