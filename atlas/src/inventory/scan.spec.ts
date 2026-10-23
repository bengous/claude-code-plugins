import { describe, expect, test } from "bun:test";

import { FILE_BYTES } from "./inventory.ts";
import { stated } from "./manifests.ts";
import { dirsOf, envOf, importsOf } from "./scan.ts";

// Every pattern the inventory runs on a file's text, on texts of the largest size it reads, built
// to make a backtracking pattern retry from each position. A linear pattern reads each in a few
// milliseconds; the bound is loose, for a slow machine, and a quadratic one misses it by far.
const BOUND_MS = 1500;

const sized = (unit: string): string => unit.repeat(Math.floor(FILE_BYTES / unit.length));

const files = new Set(["a.ts", "b/c.py", "b/__init__.py"]);

const TREE = { files, dirs: dirsOf(files), packages: new Map(), modules: new Map() };

const elapsed = (run: () => void): number => {
  const start = performance.now();
  run();

  return performance.now() - start;
};

describe("the patterns stay linear on a crafted file of FILE_BYTES", () => {
  test.each([
    ["TS import without a quote", "a.ts", sized("import x ")],
    ["TS export without a quote", "a.ts", sized("export { a, b }\n")],
    ["TS dynamic import without a quote", "a.ts", sized("import(")],
    ["Python from with dots", "b/c.py", `from ${sized(".")}`],
    ["Python from with a long name", "b/c.py", `from ${sized("a.")}`],
    ["Python import list", "b/c.py", `import ${sized("a, ")}`],
    ["environment reads", "a.ts", sized("process.env[")],
  ])("%s", (_, path, text) => {
    expect(elapsed(() => [importsOf(TREE, path, text), envOf(path, text)])).toBeLessThan(BOUND_MS);
  });

  const repo = { files, goMains: new Set<string>() };

  test.each([
    ["go.mod with unclosed require blocks", "go.mod", "go.mod", sized("require (\n")],
    ["a Nix module head without its brace", "nix", "m.nix", `{ config ${sized("x ")}`],
    [
      "Nix imports without their bracket",
      "nix",
      "m.nix",
      `{ config, ... }: ${sized("imports = [ ")}`,
    ],
    ["a flake without an equals sign", "flake.nix", "flake.nix", sized("nixosConfigurations.a ")],
    ["a Dockerfile of one long line", "Dockerfile", "Dockerfile", `ENV ${sized("A=1 ")}`],
    ["requirements of one long name", "requirements", "requirements.txt", sized("a")],
  ] as const)("%s", (_, kind, path, text) => {
    expect(elapsed(() => stated(kind, path, text, repo))).toBeLessThan(BOUND_MS);
  });
});
