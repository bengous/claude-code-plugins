import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The dependency direction of `.claude/rules/architecture.md`, held by a test: the domain
 * does no IO, the hooks module imports nothing of ours, the page never sees the server.
 */

const ROOT = join(import.meta.dir, "..");

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.name.includes(".test."),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

function imports(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1] ?? "");
}

function offending(dir: string, forbidden: RegExp): string[] {
  return sources(dir).flatMap((file) =>
    imports(file)
      .filter((specifier) => forbidden.test(specifier))
      .map((specifier) => `${file.slice(ROOT.length + 1)} imports ${specifier}`),
  );
}

describe("dependency direction", () => {
  test("src/domain imports no runtime, no adapter, no application, no page", () => {
    expect(
      offending("src/domain", /^(node:|bun|\.\.\/(adapters|app|protocol)|\.\.\/\.\.\/ui)/u),
    ).toEqual([]);
  });

  test("hooks/register.ts imports types from claude-code and nothing else", () => {
    expect(imports(join(ROOT, "hooks/register.ts"))).toEqual(["claude-code"]);
  });

  test("the page and its renderers never import the server side", () => {
    const forbidden = /^(node:|bun$|.*\/src\/(app|adapters)\/)/u;
    expect(offending("ui", forbidden)).toEqual([]);
    expect(offending("plugins", /^(.*\/src\/(app|adapters)\/)/u)).toEqual([]);
  });

  test("the server never imports the page", () => {
    expect(offending("src", /\/ui\/(?!index\.html)/u)).toEqual([]);
  });
});
