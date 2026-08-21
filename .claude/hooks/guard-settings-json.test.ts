import { describe, expect, test } from "bun:test";
import {
	blockMessage,
	checkCommand,
	isGuardedFile,
	parseHookInput,
	projectDir,
} from "./guard-settings-json.ts";

const ROOT = "/repo";

// -- parseHookInput ----------------------------------------------------------

describe("parseHookInput", () => {
	test("parses tool payloads", () => {
		const raw = JSON.stringify({
			tool_name: "Edit",
			tool_input: { file_path: "/repo/.claude/settings.json" },
		});
		expect(parseHookInput(raw)?.tool_input?.file_path).toBe(
			"/repo/.claude/settings.json",
		);
	});

	test("returns null for invalid JSON", () => {
		expect(parseHookInput("not json")).toBeNull();
	});
});

// -- projectDir --------------------------------------------------------------

describe("projectDir", () => {
	test("uses CLAUDE_PROJECT_DIR when absolute", () => {
		expect(projectDir({ CLAUDE_PROJECT_DIR: "/repo" })).toBe("/repo");
	});

	test("falls back to cwd when unset", () => {
		expect(projectDir({})).toBe(process.cwd());
	});

	test("falls back to cwd when relative", () => {
		expect(projectDir({ CLAUDE_PROJECT_DIR: "sub/dir" })).toBe(process.cwd());
	});
});

// -- isGuardedFile -----------------------------------------------------------

describe("isGuardedFile", () => {
	test("matches the absolute generated file", () => {
		expect(isGuardedFile("/repo/.claude/settings.json", ROOT)).toBe(true);
	});

	test("matches a project-relative path", () => {
		expect(isGuardedFile(".claude/settings.json", ROOT)).toBe(true);
	});

	test("matches a path with redundant segments", () => {
		expect(isGuardedFile("/repo/.claude/../.claude/settings.json", ROOT)).toBe(
			true,
		);
	});

	test("leaves the JSONC source editable", () => {
		expect(isGuardedFile("/repo/.claude/__settings.jsonc", ROOT)).toBe(false);
	});

	test("leaves settings.local.json editable", () => {
		expect(isGuardedFile("/repo/.claude/settings.local.json", ROOT)).toBe(
			false,
		);
	});

	test("leaves another repo's settings.json alone", () => {
		expect(isGuardedFile("/other/.claude/settings.json", ROOT)).toBe(false);
	});
});

// -- checkCommand ------------------------------------------------------------

describe("checkCommand blocks writes", () => {
	const blocked = [
		'echo "{}" > .claude/settings.json',
		"echo '{}' >> .claude/settings.json",
		"jq '.model = \"opus\"' in.json > ./.claude/settings.json",
		"sed -i 's/opus/sonnet/' .claude/settings.json",
		"cat in.json | tee .claude/settings.json",
		"mv .claude/settings.json.tmp .claude/settings.json",
		"cp backup.json .claude/settings.json",
		"truncate -s 0 .claude/settings.json",
	];

	for (const cmd of blocked) {
		test(cmd, () => {
			expect(checkCommand(cmd)).not.toBeNull();
		});
	}
});

describe("checkCommand allows non-writes", () => {
	const allowed = [
		"cat .claude/settings.json",
		"grep model .claude/settings.json",
		"git diff .claude/settings.json",
		"cp .claude/settings.json /tmp/backup.json",
		"node -e '...' > .claude/settings.json.tmp",
		"./.claude/scripts/settings-sync.sh",
		'echo "{}" > .claude/__settings.jsonc',
		'echo "{}" > .claude/settings.local.json',
		"ls .claude",
	];

	for (const cmd of allowed) {
		test(cmd, () => {
			expect(checkCommand(cmd)).toBeNull();
		});
	}
});

// -- blockMessage ------------------------------------------------------------

describe("blockMessage", () => {
	test("points at the JSONC source and names how it was caught", () => {
		const msg = blockMessage("sed -i");
		expect(msg).toContain(".claude/__settings.jsonc");
		expect(msg).toContain("sed -i");
	});

	// hook-patterns.md: a PreToolUse hook writes to stderr, which Claude reads.
	// Naming the escape hatch there teaches the model to reach for it.
	test("keeps the escape hatch out of what the model reads", () => {
		expect(blockMessage("sed -i")).not.toContain("SETTINGS_BYPASS");
	});
});
