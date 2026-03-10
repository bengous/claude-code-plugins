import { describe, expect, test } from "bun:test";
import { HOOK_EXIT } from "../hooks.ts";
import { checkCommand, parseHookInput, stripStringLiterals } from "./guard-destructive.ts";

// -- parseHookInput ----------------------------------------------------------

describe("parseHookInput", () => {
	test("extracts command from valid JSON", () => {
		const input = JSON.stringify({ tool_input: { command: "ls -la" } });
		expect(parseHookInput(input)).toBe("ls -la");
	});

	test("returns null for invalid JSON", () => {
		expect(parseHookInput("not json")).toBeNull();
	});

	test("returns null for missing command", () => {
		expect(parseHookInput(JSON.stringify({ tool_input: {} }))).toBeNull();
	});

	test("returns null for missing tool_input", () => {
		expect(parseHookInput(JSON.stringify({}))).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(parseHookInput("")).toBeNull();
	});
});

// -- stripStringLiterals -----------------------------------------------------

describe("stripStringLiterals", () => {
	test("strips double-quoted strings", () => {
		expect(stripStringLiterals('echo "git reset --hard" && ls')).toBe(
			'echo "" && ls',
		);
	});

	test("strips single-quoted strings", () => {
		expect(stripStringLiterals("echo 'git push --force' && ls")).toBe(
			"echo '' && ls",
		);
	});

	test("handles escaped quotes in double-quoted strings", () => {
		expect(
			stripStringLiterals('echo "say \\"git reset --hard\\"" && ls'),
		).toBe('echo "" && ls');
	});

	test("strips heredocs", () => {
		const cmd = `git commit -m "$(cat <<'EOF'
git push --force
git reset --hard
EOF
)"`;
		const result = stripStringLiterals(cmd);
		expect(result).not.toContain("git push --force");
		expect(result).not.toContain("git reset --hard");
	});

	test("leaves unquoted text intact", () => {
		expect(stripStringLiterals("git checkout . && ls")).toBe(
			"git checkout . && ls",
		);
	});

	test("handles mixed quoting styles", () => {
		const cmd = `echo "safe" && echo 'also safe' && git reset --hard`;
		const result = stripStringLiterals(cmd);
		expect(result).toContain("git reset --hard");
		expect(result).not.toContain("safe");
		expect(result).not.toContain("also safe");
	});
});

// -- checkCommand: blocked commands ------------------------------------------

describe("checkCommand blocks destructive commands", () => {
	const blocked: ReadonlyArray<readonly [string, string]> = [
		["rm -rf /tmp/foo", "rm -rf"],
		["rm  -rf /tmp/foo", "rm -rf"],
		["rm -r /", "rm -r /"],
		["rm -r /home", "rm -r /"],
		["git push --force origin main", "git push --force"],
		["git push -f origin main", "git push -f"],
		["git reset --hard HEAD", "git reset --hard"],
		["git reset --hard", "git reset --hard"],
		["git clean -f", "git clean -f"],
		["git clean -fd", "git clean -f"],
		["git checkout .", "git checkout ."],
		["git checkout -- .", "git checkout -- ."],
		["git restore .", "git restore ."],
		["git branch -D feature/foo", "git branch -D"],
	];

	for (const [cmd, expectedLabel] of blocked) {
		test(`blocks: ${cmd}`, () => {
			expect(checkCommand(cmd)).toBe(expectedLabel);
		});
	}
});

// -- checkCommand: allowed commands ------------------------------------------

describe("checkCommand allows safe commands", () => {
	const allowed = [
		"ls -la",
		"bun run validate",
		"git push origin main",
		"git push origin feature/branch",
		"git checkout main",
		"git checkout -b feature/new",
		"git checkout feature/branch",
		"git checkout .gitignore",
		"git restore --staged .",
		"git restore src/file.ts",
		"git branch -d feature/merged",
		"git branch feature/new",
		"git reset --soft HEAD~1",
		"git reset HEAD file.ts",
		"git clean -n",
		"rm src/old-file.ts",
		"rm -f src/old-file.ts",
	];

	for (const cmd of allowed) {
		test(`allows: ${cmd}`, () => {
			expect(checkCommand(cmd)).toBeNull();
		});
	}
});

// -- checkCommand: string literal bypass -------------------------------------

describe("checkCommand ignores destructive text inside string literals", () => {
	const bypassed = [
		'echo "git reset --hard"',
		"echo 'rm -rf /'",
		'git commit -m "fix: git push --force guard"',
		"git commit -m 'blocks git branch -D'",
	];

	for (const cmd of bypassed) {
		test(`allows quoted: ${cmd}`, () => {
			expect(checkCommand(cmd)).toBeNull();
		});
	}
});

// -- integration: subprocess -------------------------------------------------

describe("subprocess integration", () => {
	const hookPath = import.meta.dir + "/guard-destructive.ts";

	async function runHook(command: string) {
		const input = JSON.stringify({ tool_input: { command } });
		const proc = Bun.spawn(["bun", hookPath], {
			stdin: new Blob([input]),
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stderr, exitCode] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { exitCode, stderr };
	}

	test("blocks rm -rf via subprocess", async () => {
		const { exitCode, stderr } = await runHook("rm -rf /tmp/foo");
		expect(exitCode).toBe(HOOK_EXIT.BLOCK);
		expect(stderr).toContain("BLOCKED");
		expect(stderr).toContain("rm -rf");
	});

	test("blocks git checkout . via subprocess", async () => {
		const { exitCode, stderr } = await runHook("git checkout .");
		expect(exitCode).toBe(HOOK_EXIT.BLOCK);
		expect(stderr).toContain("BLOCKED");
		expect(stderr).toContain("git checkout .");
	});

	test("allows safe command via subprocess", async () => {
		const { exitCode } = await runHook("git push origin main");
		expect(exitCode).toBe(HOOK_EXIT.ALLOW);
	});

	test("allows commit message containing destructive text", async () => {
		const cmd = `git commit -m "$(cat <<'EOF'\ngit push --force\ngit reset --hard\nEOF\n)"`;
		const { exitCode } = await runHook(cmd);
		expect(exitCode).toBe(HOOK_EXIT.ALLOW);
	});

	test("exits 0 on invalid JSON input", async () => {
		const proc = Bun.spawn(["bun", hookPath], {
			stdin: new Blob(["not json"]),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(HOOK_EXIT.ALLOW);
	});

	test("exits 0 on empty input", async () => {
		const proc = Bun.spawn(["bun", hookPath], {
			stdin: new Blob([""]),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(HOOK_EXIT.ALLOW);
	});
});
