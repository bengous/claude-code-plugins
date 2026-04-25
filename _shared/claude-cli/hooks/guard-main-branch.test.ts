import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HOOK_EXIT } from "../hooks.ts";
import {
	extractCdTarget,
	isBranchMutatingCommand,
	isProtectedBranch,
} from "./guard-main-branch.ts";

// -- isProtectedBranch -------------------------------------------------------

describe("isProtectedBranch", () => {
	test("returns true for main", () => {
		expect(isProtectedBranch("main")).toBe(true);
	});

	test("returns true for master", () => {
		expect(isProtectedBranch("master")).toBe(true);
	});

	test("returns false for dev", () => {
		expect(isProtectedBranch("dev")).toBe(false);
	});

	test("returns false for feature branches", () => {
		expect(isProtectedBranch("feature/new-hook")).toBe(false);
	});

	test("returns false for fix branches", () => {
		expect(isProtectedBranch("fix/typo")).toBe(false);
	});
});

// -- extractCdTarget ---------------------------------------------------------

describe("extractCdTarget", () => {
	test("extracts unquoted path before &&", () => {
		expect(extractCdTarget("cd /tmp/foo && git commit")).toBe("/tmp/foo");
	});

	test("extracts double-quoted path", () => {
		expect(extractCdTarget('cd "/tmp/my dir" && git push')).toBe("/tmp/my dir");
	});

	test("extracts single-quoted path", () => {
		expect(extractCdTarget("cd '/tmp/foo' && git commit")).toBe("/tmp/foo");
	});

	test("extracts path before ;", () => {
		expect(extractCdTarget("cd /tmp/foo; git commit")).toBe("/tmp/foo");
	});

	test("returns null when no leading cd", () => {
		expect(extractCdTarget("git commit -m 'test'")).toBeNull();
	});

	test("returns null when cd is mid-command", () => {
		expect(extractCdTarget("git commit && cd /tmp")).toBeNull();
	});

	test("ignores leading whitespace", () => {
		expect(extractCdTarget("  cd /tmp && git commit")).toBe("/tmp");
	});
});

// -- isBranchMutatingCommand: blocked ----------------------------------------

describe("isBranchMutatingCommand blocks mutations", () => {
	const blocked = [
		"git commit -m 'test'",
		"git commit --amend",
		"git push origin main",
		"git push",
		"git merge dev",
		"git rebase dev",
		"git  commit -m 'test'",
	];

	for (const cmd of blocked) {
		test(`blocks: ${cmd}`, () => {
			expect(isBranchMutatingCommand(cmd)).toBe(true);
		});
	}
});

// -- isBranchMutatingCommand: allowed ----------------------------------------

describe("isBranchMutatingCommand allows non-mutations", () => {
	const allowed = [
		"git status",
		"git log --oneline",
		"git diff",
		"git checkout dev",
		"git branch -a",
		"git fetch origin",
		"git stash",
		"git show HEAD",
		"git remote -v",
		"ls -la",
		"bun test",
	];

	for (const cmd of allowed) {
		test(`allows: ${cmd}`, () => {
			expect(isBranchMutatingCommand(cmd)).toBe(false);
		});
	}
});

// -- isBranchMutatingCommand: string literal bypass --------------------------

describe("isBranchMutatingCommand ignores mutations inside string literals", () => {
	const fullyQuoted = [
		'echo "git commit -m test"',
		"echo 'git push origin main'",
	];

	for (const cmd of fullyQuoted) {
		test(`allows fully-quoted: ${cmd}`, () => {
			expect(isBranchMutatingCommand(cmd)).toBe(false);
		});
	}

	// These commands ARE mutations (git commit), but the inner quoted text
	// (git push, git rebase) should not independently trigger a match.
	const outerMutationWithQuotedInner = [
		'git commit -m "fix: git push guard"',
		"git commit -m 'blocks git rebase'",
	];

	for (const cmd of outerMutationWithQuotedInner) {
		test(`detects outer mutation despite quoted inner: ${cmd}`, () => {
			expect(isBranchMutatingCommand(cmd)).toBe(true);
		});
	}
});

// -- integration: subprocess -------------------------------------------------

describe("subprocess integration", () => {
	const hookPath = import.meta.dir + "/guard-main-branch.ts";

	async function runHook(
		command: string,
		env?: Record<string, string>,
	) {
		const input = JSON.stringify({ tool_input: { command } });
		const proc = Bun.spawn(["bun", hookPath], {
			stdin: new Blob([input]),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});

		const [stderr, exitCode] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { exitCode, stderr };
	}

	// Shared temp repo with multiple branches — created once, torn down once
	const tmpDir = `${import.meta.dir}/.tmp-test-repo`;

	beforeAll(() => {
		const init = Bun.spawnSync(["bash", "-c", [
			`rm -rf "${tmpDir}"`,
			`mkdir -p "${tmpDir}"`,
			`cd "${tmpDir}"`,
			"git init -q",
			"git commit --allow-empty -m init -q",
			"git checkout -b main -q 2>/dev/null || true",
			"git branch master 2>/dev/null || true",
			"git branch feature/new-thing 2>/dev/null || true",
		].join(" && ")], { stdout: "pipe", stderr: "pipe" });
		if (init.exitCode !== 0) {
			throw new Error(`Failed to create test repo: ${init.stderr.toString()}`);
		}
	});

	afterAll(() => {
		Bun.spawnSync(["rm", "-rf", tmpDir]);
	});

	async function runHookOnBranch(
		command: string,
		branch: string,
		env?: Record<string, string>,
	) {
		// Point HEAD at the desired branch without checkout (instant)
		Bun.spawnSync(
			["git", "--git-dir", `${tmpDir}/.git`, "symbolic-ref", "HEAD", `refs/heads/${branch}`],
			{ stdout: "pipe", stderr: "pipe" },
		);

		const input = JSON.stringify({ tool_input: { command } });
		const proc = Bun.spawn(["bun", hookPath], {
			stdin: new Blob([input]),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_DIR: `${tmpDir}/.git`, ...env },
		});

		const [stderr, exitCode] = await Promise.all([
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		return { exitCode, stderr };
	}

	test("allows git diff on any branch", async () => {
		const { exitCode } = await runHook("git diff HEAD~1");
		expect(exitCode).toBe(HOOK_EXIT.ALLOW);
	});

	test("allows git commit on non-protected branch (dev)", async () => {
		// We're on dev branch right now, so this should be allowed
		const { exitCode } = await runHook("git commit -m 'test'");
		expect(exitCode).toBe(HOOK_EXIT.ALLOW);
	});

	test("allows with MAIN_BYPASS=1", async () => {
		const { exitCode } = await runHook("git commit -m 'test'", {
			MAIN_BYPASS: "1",
		});
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

	// -- protected branch tests (using temp git repos) -----------------------

	test("blocks git commit on main", async () => {
		const { exitCode, stderr } = await runHookOnBranch(
			"git commit -m 'test'",
			"main",
		);
		expect(exitCode).toBe(HOOK_EXIT.BLOCK);
		expect(stderr).toContain("BLOCKED");
		expect(stderr).toContain("main");
	});

	test("blocks git push on main", async () => {
		const { exitCode, stderr } = await runHookOnBranch(
			"git push origin main",
			"main",
		);
		expect(exitCode).toBe(HOOK_EXIT.BLOCK);
		expect(stderr).toContain("BLOCKED");
	});

	test("blocks git merge on master", async () => {
		const { exitCode, stderr } = await runHookOnBranch(
			"git merge dev",
			"master",
		);
		expect(exitCode).toBe(HOOK_EXIT.BLOCK);
		expect(stderr).toContain("master");
	});

	test("blocks git rebase on main", async () => {
		const { exitCode } = await runHookOnBranch("git rebase dev", "main");
		expect(exitCode).toBe(HOOK_EXIT.BLOCK);
	});

	test("allows git commit on feature branch", async () => {
		const { exitCode } = await runHookOnBranch(
			"git commit -m 'test'",
			"feature/new-thing",
		);
		expect(exitCode).toBe(HOOK_EXIT.ALLOW);
	});

	// Non-mutating commands short-circuit before branch check, so
	// runHook (no temp repo needed) is sufficient and faster.
	test("allows git status regardless of branch", async () => {
		const { exitCode } = await runHook("git status");
		expect(exitCode).toBe(HOOK_EXIT.ALLOW);
	});

	test("allows git log regardless of branch", async () => {
		const { exitCode } = await runHook("git log --oneline");
		expect(exitCode).toBe(HOOK_EXIT.ALLOW);
	});

	test("MAIN_BYPASS=1 allows git commit on main", async () => {
		const { exitCode } = await runHookOnBranch(
			"git commit -m 'emergency'",
			"main",
			{ MAIN_BYPASS: "1" },
		);
		expect(exitCode).toBe(HOOK_EXIT.ALLOW);
	});
});
