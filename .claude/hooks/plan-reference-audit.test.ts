import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hookPath = join(import.meta.dir, "plan-reference-audit.ts");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

/**
 * Writes an executable stub that stands in for the `claude` reviewer binary.
 * It ignores its args/stdin and emits `output` on stdout, then exits `exitCode`.
 * The reviewer is invoked with `--output-format json`, so `output` is the
 * top-level wrapper `{"result":"<agent text>"}`.
 */
async function makeStub(opts: {
	output?: string;
	exitCode?: number;
}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "plan-audit-hook-"));
	tempDirs.push(dir);
	const bin = join(dir, "claude-stub.sh");
	const exitCode = opts.exitCode ?? 0;
	const emit =
		opts.output !== undefined ? `cat <<'STUB_EOF'\n${opts.output}\nSTUB_EOF` : "";
	await writeFile(bin, `#!/usr/bin/env bash\n${emit}\nexit ${exitCode}\n`);
	await chmod(bin, 0o755);
	return bin;
}

/**
 * Wraps a reviewer verdict the way `claude -p --output-format json` actually
 * does in this environment: a top-level ARRAY of stream events whose trailing
 * `{type:"result", result}` element carries the agent's final text. The agent
 * tends to wrap its JSON in prose + a ```json fence, so model that too.
 */
function reviewerOutput(
	verdict: { blocking: string[]; advisory: string[] },
	opts: { fenced?: boolean } = {},
) {
	const json = JSON.stringify(verdict);
	const text = opts.fenced
		? `Here is what I found in the codebase.\n\n\`\`\`json\n${json}\n\`\`\``
		: json;
	return JSON.stringify([
		{ type: "system", subtype: "init" },
		{ type: "assistant" },
		{ type: "user" },
		{ type: "result", subtype: "success", is_error: false, result: text },
	]);
}

/** The legacy/documented single-object shape: `{ ..., result: "<text>" }`. */
function reviewerObjectOutput(verdict: {
	blocking: string[];
	advisory: string[];
}) {
	return JSON.stringify({ type: "result", result: JSON.stringify(verdict) });
}

async function runHook(opts: {
	plan: string | null;
	bin?: string;
	env?: Record<string, string>;
}) {
	const payload: { tool_input: { plan?: string }; cwd: string } = {
		tool_input: {},
		cwd: process.cwd(),
	};
	if (opts.plan !== null) payload.tool_input.plan = opts.plan;

	const proc = Bun.spawn(["bun", hookPath], {
		cwd: process.cwd(),
		env: {
			...process.env,
			...(opts.bin ? { PLAN_AUDIT_CLAUDE_BIN: opts.bin } : {}),
			...(opts.env ?? {}),
		},
		stdin: new Blob([JSON.stringify(payload)]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function parseDecision(stdout: string): {
	permissionDecision?: string;
	permissionDecisionReason?: string;
	additionalContext?: string;
} | null {
	if (stdout.trim() === "") return null;
	return JSON.parse(stdout).hookSpecificOutput;
}

describe("plan-reference-audit PreToolUse gate", () => {
	test("blocks the exit when the reviewer reports a provably-absent reference", async () => {
		const bin = await makeStub({
			output: reviewerOutput(
				{
					blocking: ["app/.env.example — Glob found no match"],
					advisory: [],
				},
				{ fenced: true },
			),
		});

		const result = await runHook({ plan: "Read app/.env.example then …", bin });

		expect(result.exitCode).toBe(0);
		const decision = parseDecision(result.stdout);
		expect(decision?.permissionDecision).toBe("deny");
		expect(decision?.permissionDecisionReason).toContain("app/.env.example");
	});

	test("parses the documented single result-object output shape too", async () => {
		const bin = await makeStub({
			output: reviewerObjectOutput({
				blocking: ["lib/missing.ts — Grep found no definition"],
				advisory: [],
			}),
		});

		const result = await runHook({ plan: "Edit lib/missing.ts …", bin });

		expect(result.exitCode).toBe(0);
		const decision = parseDecision(result.stdout);
		expect(decision?.permissionDecision).toBe("deny");
		expect(decision?.permissionDecisionReason).toContain("lib/missing.ts");
	});

	test("allows normal flow when the reviewer finds nothing", async () => {
		const bin = await makeStub({
			output: reviewerOutput({ blocking: [], advisory: [] }),
		});

		const result = await runHook({ plan: "A clean, well-grounded plan.", bin });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});

	test("surfaces advisory notes without blocking when there are no blocking refs", async () => {
		const bin = await makeStub({
			output: reviewerOutput({
				blocking: [],
				advisory: ["getToken vs getSession — API claim unverified"],
			}),
		});

		const result = await runHook({ plan: "Call getToken() to …", bin });

		expect(result.exitCode).toBe(0);
		const decision = parseDecision(result.stdout);
		expect(decision?.permissionDecision).toBeUndefined();
		expect(decision?.additionalContext).toContain("getToken");
	});

	test("fails open (no deny) when the reviewer exits non-zero", async () => {
		const bin = await makeStub({ exitCode: 1 });

		const result = await runHook({ plan: "Some plan.", bin });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});

	test("fails open (no deny) when the reviewer emits unparseable output", async () => {
		const bin = await makeStub({ output: "not json at all" });

		const result = await runHook({ plan: "Some plan.", bin });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});

	test("no-ops immediately under the recursion guard, never invoking the reviewer", async () => {
		// Stub would emit a blocking verdict; the guard must short-circuit first.
		const bin = await makeStub({
			output: reviewerOutput({
				blocking: ["should-never-be-read — guard active"],
				advisory: [],
			}),
		});

		const result = await runHook({
			plan: "Read app/.env.example then …",
			bin,
			env: { CLAUDE_PLAN_AUDIT: "1" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});

	test("allows normal flow when there is no plan text to audit", async () => {
		const bin = await makeStub({
			output: reviewerOutput({
				blocking: ["should-never-be-read — no plan"],
				advisory: [],
			}),
		});

		const result = await runHook({ plan: null, bin });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});
});
