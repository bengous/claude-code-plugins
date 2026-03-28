import { describe, expect, test } from "bun:test";

import {
	extractCodeBlocks,
	findBoxes,
	validateVerticalRuns,
	type CodeBlock,
} from "./validate-ascii-diagrams.ts";

// ── Helper: run vertical validation on raw diagram lines ─────
function verticalIssues(diagram: string): string[] {
	const lines = diagram.split("\n");
	const block: CodeBlock = { startLine: 1, lines };
	return validateVerticalRuns(block, "test.md").map((i) => i.message);
}

// Column helper: pad string to place char at exact column
function atCol(col: number, ch: string): string {
	return " ".repeat(col) + ch;
}

// ── Orphaned ┐ (nothing below at same column) ───────────────

describe("orphaned ┐", () => {
	test("detects ┐ with no vertical below (off by one)", () => {
		// ┐ at col 10, │ below at col 11
		const diagram = [
			atCol(10, "┐"),
			atCol(11, "│"),
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues.some((m) => m.includes("┐"))).toBe(true);
	});

	test("passes when ┐ has │ directly below at same column", () => {
		const diagram = [
			atCol(10, "┐"),
			atCol(10, "│"),
		].join("\n");
		const issues = verticalIssues(diagram);
		const cornerIssues = issues.filter((m) => m.includes("┐"));
		expect(cornerIssues).toEqual([]);
	});

	test("passes when ┐ has ┘ directly below", () => {
		const diagram = [
			atCol(10, "┐"),
			atCol(10, "┘"),
		].join("\n");
		const issues = verticalIssues(diagram);
		const cornerIssues = issues.filter((m) => m.includes("┐"));
		expect(cornerIssues).toEqual([]);
	});

	test("detects ┐ at end of block (no line below)", () => {
		const diagram = atCol(10, "┐");
		const issues = verticalIssues(diagram);
		expect(issues.some((m) => m.includes("┐"))).toBe(true);
	});

	test("detects ┐ when line below is too short", () => {
		const diagram = [
			atCol(20, "┐"),
			"short",
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues.some((m) => m.includes("┐"))).toBe(true);
	});
});

// ── Orphaned ┘ (nothing above at same column) ───────────────

describe("orphaned ┘", () => {
	test("detects ┘ with no vertical above (off by one)", () => {
		// │ at col 16, ┘ at col 15
		const diagram = [
			atCol(16, "│"),
			atCol(15, "┘"),
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues.some((m) => m.includes("┘"))).toBe(true);
	});

	test("passes when ┘ has │ directly above at same column", () => {
		const diagram = [
			atCol(10, "│"),
			atCol(10, "┘"),
		].join("\n");
		const issues = verticalIssues(diagram);
		const cornerIssues = issues.filter((m) => m.includes("┘"));
		expect(cornerIssues).toEqual([]);
	});

	test("detects ┘ at start of block (no line above)", () => {
		const diagram = atCol(10, "┘");
		const issues = verticalIssues(diagram);
		expect(issues.some((m) => m.includes("┘"))).toBe(true);
	});
});

// ── Vertical run gap detection ───────────────────────────────

describe("vertical run gaps", () => {
	test("detects space gap in vertical │ run", () => {
		//          col 50
		// line 0:   │
		// line 1:   │
		// line 2:   (space)  ← gap
		// line 3:   │
		// line 4:   │
		const diagram = [
			atCol(50, "│"),
			atCol(50, "│"),
			atCol(50, " "),  // space at col 50
			atCol(50, "│"),
			atCol(50, "│"),
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues.some((m) => m.includes("gap"))).toBe(true);
	});

	test("does not flag text between vertical segments", () => {
		// Text labels like "allowed" crossing the vertical column are intentional
		//          col 16
		// line 0:   │
		// line 1:   ▼
		// line 2:   o  ← text char (e.g. from "PreToolUse"), not a gap
		// line 3:   │
		// line 4:   e  ← text char (e.g. from "allowed"), not a gap
		// line 5:   │
		const diagram = [
			atCol(16, "│"),
			atCol(16, "▼"),
			" ".repeat(10) + "PreToolUse",  // col 16 = 'o' (text)
			atCol(16, "│"),
			" ".repeat(13) + "allowed",      // col 16 = 'o' (text)
			atCol(16, "│"),
		].join("\n");
		const issues = verticalIssues(diagram);
		const gapIssues = issues.filter((m) => m.includes("gap"));
		expect(gapIssues).toEqual([]);
	});

	test("passes when vertical run is continuous", () => {
		const diagram = [
			atCol(50, "│"),
			atCol(50, "│"),
			atCol(50, "│"),
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues).toEqual([]);
	});

	test("does not flag short vertical (2 lines) as having a gap", () => {
		const diagram = [
			atCol(5, "│"),
			atCol(5, "▼"),
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues).toEqual([]);
	});

	test("does not flag gap between stacked boxes (└ → blank → ┌)", () => {
		const diagram = [
			"│ └──────────────────┘ │",  // └ at col 2, ┘ at col 21
			"│                      │",  // space gap — but box transition
			"│ ┌──────────────────┐ │",  // ┌ at col 2, ┐ at col 21
			"│ │ content          │ │",
			"│ └──────────────────┘ │",
		].join("\n");
		const issues = verticalIssues(diagram);
		const gapIssues = issues.filter((m) => m.includes("gap"));
		expect(gapIssues).toEqual([]);
	});

	test("detects gap when line is too short for the column", () => {
		const diagram = [
			atCol(50, "│"),
			atCol(50, "│"),
			"short",          // col 50 doesn't exist → gap
			atCol(50, "│"),
			atCol(50, "│"),
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues.some((m) => m.includes("gap"))).toBe(true);
	});
});

// ── Skips box interiors (already validated by findBoxes) ─────

describe("box corners are not orphaned", () => {
	test("┐ in a box is not flagged as orphaned", () => {
		const diagram = [
			"┌────┐",
			"│ hi │",
			"└────┘",
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues).toEqual([]);
	});

	test("┐ outside a box IS flagged", () => {
		const diagram = [
			"┌────┐" + " ".repeat(14) + "┐",
			"│ hi │" + " ".repeat(14) + " ",  // no │ at col 20
			"└────┘",
		].join("\n");
		const issues = verticalIssues(diagram);
		expect(issues.some((m) => m.includes("┐") && m.includes("col 20"))).toBe(true);
	});
});

// ── Real-world regression: the user's broken diagram ─────────
// These use the EXACT content from the git diff

describe("real-world: agentic-loop diagram", () => {
	test("detects misalignment in broken version", () => {
		// The broken version has ┐ at col 55, but │ below at col 56
		const broken = [
			"         │ Claude turns │◄────────────────────────────┐",       // ┐ at col 55
			"         └──────┬───────┘                               │",    // │ at col 56
			"                │                                       │",    // │ at col 56
			"                ▼                                       │",
			"          PreToolUse ──deny──► (Claude adjusts)         │",
			"                │                                       │",
			"             allowed                                    │",
			"                │                                       │",
			"                ▼                                       │",
			"        PermissionRequest ──auto-deny──► (Claude adjusts)",    // missing │
			"                │                                       │",
		].join("\n");
		const issues = verticalIssues(broken);
		// Should detect: ┐ at col 55 has no vertical below (│ is at 56)
		expect(issues.length).toBeGreaterThan(0);
		expect(issues.some((m) => m.includes("┐"))).toBe(true);
	});

	test("passes on fixed version", () => {
		const fixed = [
			"         │ Claude turns │◄────────────────────────────────┐",  // ┐ at col 58
			"         └──────┬───────┘                                 │",  // │ at col 58
			"                │                                         │",
			"                ▼                                         │",
			"          PreToolUse ──deny──► (Claude adjusts)           │",
			"                │                                         │",
			"             allowed                                      │",
			"                │                                         │",
			"                ▼                                         │",
			"        PermissionRequest ──auto-deny──► (Claude adjusts) │",  // │ at col 58
			"                │                                         │",
			"          approved/auto                                   │",
			"                │                                         │",
			"                ├──success──► PostToolUse ──────────────►─┘",  // ┘ at col 58
			"                │                    │                    │",
			"                └──failure──► PostToolUseFailure ───────►─┘",
		].join("\n");
		const issues = verticalIssues(fixed);
		expect(issues).toEqual([]);
	});
});
