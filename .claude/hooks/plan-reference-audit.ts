#!/usr/bin/env bun

/**
 * PreToolUse hook for ExitPlanMode — audits a plan's concrete references
 * (file paths, symbols) against the real codebase BEFORE implementation.
 *
 * Spawns the `plan-reference-auditor` agent headlessly (`claude -p`). When the
 * reviewer reports a reference that provably does not exist, the exit is BLOCKED
 * via a PreToolUse `deny` decision (the reason is fed back to the agent so it can
 * revise the plan and resubmit). Everything uncertain stays advisory and rides
 * through as non-blocking context.
 *
 * Fail-open by construction: any spawn failure, non-zero exit, or unparseable
 * output exits 0 (allow) — a broken or slow reviewer must never trap the user
 * in plan mode.
 */

import { HOOK_EXIT } from "./guard-destructive.ts";

export interface Review {
	blocking: string[];
	advisory: string[];
}

export interface DenyResponse {
	hookSpecificOutput: {
		hookEventName: "PreToolUse";
		permissionDecision: "deny";
		permissionDecisionReason: string;
	};
}

export interface AdvisoryResponse {
	hookSpecificOutput: {
		hookEventName: "PreToolUse";
		additionalContext: string;
	};
}

export function parseHookInput(raw: string): { plan: string | null; cwd: string } {
	try {
		const parsed = JSON.parse(raw) as {
			tool_input?: { plan?: unknown };
			cwd?: unknown;
		};
		const plan = parsed.tool_input?.plan;
		const cwd = parsed.cwd;
		return {
			plan: typeof plan === "string" ? plan : null,
			cwd: typeof cwd === "string" ? cwd : process.cwd(),
		};
	} catch {
		return { plan: null, cwd: process.cwd() };
	}
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function tryParse(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch {
		return null;
	}
}

/**
 * Parse the reviewer's final text into a Review. The agent is asked for bare
 * JSON but in practice often wraps it in prose and/or a ```json fence, so try
 * (in order): the whole text, any fenced block, then the first `{`…last `}`.
 */
export function parseReview(text: string): Review | null {
	const trimmed = text.trim();
	const candidates: string[] = [trimmed];

	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) candidates.push(fence[1].trim());

	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

	for (const candidate of candidates) {
		const parsed = tryParse(candidate);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const obj = parsed as { blocking?: unknown; advisory?: unknown };
			return {
				blocking: asStringArray(obj.blocking),
				advisory: asStringArray(obj.advisory),
			};
		}
	}
	return null;
}

/**
 * Pull the agent's final text out of `claude -p --output-format json` stdout.
 * The CLI emits either a single `{type:"result", result}` object or a top-level
 * ARRAY of stream events whose trailing `result` event carries it; handle both.
 */
export function extractResultText(outer: unknown): string | null {
	const resultOf = (event: unknown): string | null => {
		const value = (event as { result?: unknown })?.result;
		return typeof value === "string" ? value : null;
	};

	if (Array.isArray(outer)) {
		for (let i = outer.length - 1; i >= 0; i--) {
			const event = outer[i];
			if (
				event !== null &&
				typeof event === "object" &&
				(event as { type?: unknown }).type === "result"
			) {
				return resultOf(event);
			}
		}
		return null;
	}
	if (outer !== null && typeof outer === "object") {
		return resultOf(outer);
	}
	return null;
}

/** Unwrap `claude -p --output-format json` stdout, then parse the verdict. */
export function extractReview(rawStdout: string): Review | null {
	const outer = tryParse(rawStdout);
	if (outer === null) return null;
	const result = extractResultText(outer);
	if (result === null) return null;
	return parseReview(result);
}

export function buildDenyResponse(review: Review): DenyResponse {
	const blocking = review.blocking.map((ref) => `- ${ref}`).join("\n");
	let reason =
		"This plan references files or symbols the plan-reference-auditor could not find in the codebase:\n\n" +
		`${blocking}\n\n` +
		"Correct or remove these references (or, if the plan creates them, say so explicitly), then resubmit the plan.";
	if (review.advisory.length > 0) {
		const advisory = review.advisory.map((note) => `- ${note}`).join("\n");
		reason += `\n\nAdvisory (non-blocking) notes to double-check:\n${advisory}`;
	}
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		},
	};
}

export function buildAdvisoryResponse(advisory: string[]): AdvisoryResponse {
	const notes = advisory.map((note) => `- ${note}`).join("\n");
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			additionalContext:
				"plan-reference-auditor advisory notes (non-blocking) — verify before relying on these references:\n" +
				notes,
		},
	};
}

/** Spawn the reviewer agent; returns its verdict, or null on any failure. */
function runReviewer(plan: string, cwd: string): Review | null {
	const bin = process.env.PLAN_AUDIT_CLAUDE_BIN || "claude";
	const prompt = `Audit this plan for reference accuracy:\n\n${plan}`;
	let proc: ReturnType<typeof Bun.spawnSync>;
	try {
		proc = Bun.spawnSync(
			[
				bin,
				"-p",
				"--agent",
				"plan-reference-auditor",
				"--allowedTools",
				"Read",
				"Grep",
				"Glob",
				"--output-format",
				"json",
			],
			{
				cwd,
				env: { ...process.env, CLAUDE_PLAN_AUDIT: "1" },
				stdin: new TextEncoder().encode(prompt),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	} catch {
		return null;
	}
	if (!proc.success) return null;
	return extractReview(proc.stdout.toString());
}

if (import.meta.main) {
	// Recursion guard: the reviewer child runs with this set; never re-audit.
	if (process.env.CLAUDE_PLAN_AUDIT === "1") {
		process.exit(HOOK_EXIT.ALLOW);
	}

	const { plan, cwd } = parseHookInput(await Bun.stdin.text());
	if (!plan || plan.trim() === "") {
		process.exit(HOOK_EXIT.ALLOW);
	}

	const review = runReviewer(plan, cwd);
	if (review === null) {
		// Fail-open: a broken/slow reviewer must not trap the user in plan mode.
		process.exit(HOOK_EXIT.ALLOW);
	}

	if (review.blocking.length > 0) {
		console.log(JSON.stringify(buildDenyResponse(review)));
		process.exit(HOOK_EXIT.ALLOW);
	}

	if (review.advisory.length > 0) {
		console.log(JSON.stringify(buildAdvisoryResponse(review.advisory)));
	}
	process.exit(HOOK_EXIT.ALLOW);
}
