import { describe, expect, test } from "bun:test";

import { globMatch, literalPrefix } from "./glob.ts";

describe("globMatch", () => {
  test("a star stays inside one segment", () => {
    expect(globMatch("src/*.py", "src/a.py")).toBe(true);
    expect(globMatch("src/*.py", "src/sub/a.py")).toBe(false);
  });

  test("a double star crosses segments, and with a slash also matches none", () => {
    expect(globMatch("src/**", "src/a/b/c.ts")).toBe(true);
    expect(globMatch("**/__init__.py", "__init__.py")).toBe(true);
    expect(globMatch("**/__init__.py", "a/b/__init__.py")).toBe(true);
  });

  test("braces offer alternatives, each a glob of its own", () => {
    expect(globMatch("core/{app,admin}.py", "core/admin.py")).toBe(true);
    expect(globMatch("core/{app,admin}.py", "core/db.py")).toBe(false);
    expect(globMatch("{a,b/**}/x.ts", "b/c/d/x.ts")).toBe(true);
  });

  test("the pattern matches the whole path, and dots are literal", () => {
    expect(globMatch("a.py", "xa.py")).toBe(false);
    expect(globMatch("a.py", "a_py")).toBe(false);
    expect(globMatch("?.py", "a.py")).toBe(true);
  });
});

describe("literalPrefix", () => {
  test("is the folder part before the first wildcard", () => {
    expect(literalPrefix("src/core/**")).toBe("src/core/");
    expect(literalPrefix("system/{web,admin}.py")).toBe("system/");
    expect(literalPrefix("system/llm/*")).toBe("system/llm/");
    expect(literalPrefix("*.py")).toBe("");
    expect(literalPrefix("a/b.py")).toBe("a/");
  });
});
