import { describe, expect, test } from "bun:test";
import { isLintable, parseFilePath } from "./format-and-lint.ts";

// -- parseFilePath -----------------------------------------------------------

describe("parseFilePath", () => {
	test("extracts file_path from valid JSON", () => {
		const input = JSON.stringify({ tool_input: { file_path: "src/foo.ts" } });
		expect(parseFilePath(input)).toBe("src/foo.ts");
	});

	test("returns null for missing file_path", () => {
		expect(parseFilePath(JSON.stringify({ tool_input: {} }))).toBeNull();
	});

	test("returns null for invalid JSON", () => {
		expect(parseFilePath("not json")).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(parseFilePath("")).toBeNull();
	});
});

// -- isLintable --------------------------------------------------------------

describe("isLintable", () => {
	test.each([
		["src/foo.ts", true],
		["src/bar.js", true],
		["src/baz.mjs", true],
		["./src/foo.ts", true],
		["src/style.css", false],
		["README.md", false],
		["package.json", false],
		["src/data.json", false],
		[".env", false],
		[".claude/hooks/guard-destructive.ts", false],
		["scripts/build.ts", false],
	])("%s → %s", (file, expected) => {
		expect(isLintable(file)).toBe(expected);
	});

	test("supports custom scope", () => {
		expect(isLintable("lib/foo.ts", new Set([".ts"]), "lib/")).toBe(true);
		expect(isLintable("src/foo.ts", new Set([".ts"]), "lib/")).toBe(false);
	});

	test("supports custom extensions", () => {
		expect(isLintable("src/foo.tsx", new Set([".tsx"]), "src/")).toBe(true);
		expect(isLintable("src/foo.ts", new Set([".tsx"]), "src/")).toBe(false);
	});
});
