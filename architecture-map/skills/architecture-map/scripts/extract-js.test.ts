import { describe, expect, test } from "bun:test";

import { blankComments, jsLinks, specifiersOf, tsconfigAliases } from "./extract-js.ts";

describe("specifiersOf", () => {
  test("reads imports, type imports, side-effect imports, re-exports, require and dynamic import", () => {
    const source = [
      'import x from "./a"',
      'import type { T } from "@/b"',
      'import "./c.css"',
      'export * from "./d"',
      'export { e } from "./e"',
      'const f = require("../f")',
      'const g = () => import("./g")',
      'import fs from "node:fs"',
    ].join("\n");

    expect(specifiersOf(source)).toEqual([
      "./a",
      "@/b",
      "./c.css",
      "./d",
      "./e",
      "../f",
      "./g",
      "node:fs",
    ]);
  });
});

describe("tsconfigAliases", () => {
  test("reads simple prefix entries through comments and trailing commas", () => {
    const text =
      '{\n  // comment\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "#x": ["y"], } }\n}';

    expect(tsconfigAliases(text)).toEqual([["@/", "src/"]]);
  });

  test("an unreadable tsconfig gives null, so the caller can say so", () => {
    expect(tsconfigAliases("{ not json")).toBeNull();
  });
});

describe("jsLinks", () => {
  const files = new Map([
    ["src/domain/index.ts", 'export * from "./order"\n'],
    ["src/domain/order.ts", "export const x = 1\n"],
    ["src/infra/db.ts", 'import { x } from "@/domain"\nimport fs from "node:fs"\n'],
    ["src/ui/App.tsx", 'import { db } from "../infra/db.js"\nimport "./missing"\n'],
  ]);

  test("resolves relative paths, .js to .ts, index files and aliases, and counts relative misses", () => {
    expect(jsLinks(files, [["@/", "src/"]])).toEqual({
      missed: 1,
      links: [
        ["src/domain/index.ts", "src/domain/order.ts"],
        ["src/infra/db.ts", "src/domain/index.ts"],
        ["src/ui/App.tsx", "src/infra/db.ts"],
      ],
    });
  });

  test("an alias to the root is written './' or '.'", () => {
    const flat = new Map([
      ["a.ts", 'import "~/b"\n'],
      ["b.ts", ""],
    ]);

    expect(jsLinks(flat, [["~/", "./"]]).links).toEqual([["a.ts", "b.ts"]]);
  });
});

describe("comments and strings", () => {
  test("a comment marker inside a string is text, not a comment", () => {
    const text = [
      "{",
      '  "$schema": "https://json.schemastore.org/tsconfig",',
      '  "compilerOptions": { "paths": { "@/*": ["./src/*"] } },',
      '  "include": ["src/**/*.ts"]',
      "}",
    ].join("\n");

    expect(tsconfigAliases(text)).toEqual([["@/", "src/"]]);
  });

  test("commented-out imports and imports written in a template literal are not links", () => {
    const source = [
      '// import x from "./ghost"',
      '/* import y from "../lib/util" */',
      'const doc = `import z from "./x"`',
      'import real from "./real"',
    ].join("\n");

    expect(specifiersOf(source)).toEqual(["./real"]);
    expect(blankComments(source, true)).toHaveLength(source.length);
  });

  test("an aliased import that finds no file counts as missed", () => {
    const files = new Map([["src/a.ts", 'import "@/nowhere"\n']]);

    expect(jsLinks(files, [["@/", "src/"]]).missed).toBe(1);
  });
});
