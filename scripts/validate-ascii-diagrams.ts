#!/usr/bin/env bun
/**
 * Validate ASCII box-drawing alignment in Markdown code blocks.
 *
 * Finds boxes (┌─┐ ... └─┘) and checks:
 * 1. Top/bottom width match
 * 2. Left/right │ present on every interior line
 * 3. Lines not exceeding 78 chars
 *
 * Usage: bun scripts/quality/validate-ascii-diagrams.ts [file...]
 *   If no files, validates docs/architecture/*.md
 */

// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone script, not Effect
import { readFileSync, readdirSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone script, not Effect
import { basename, resolve } from "node:path";

export type Issue = {
  file: string;
  blockLine: number; // line in the md file (1-based)
  localLine: number; // line within code block (1-based)
  col: number;
  message: string;
};

export type CodeBlock = { startLine: number; lines: string[] };

type Box = {
  topRow: number;
  bottomRow: number;
  left: number;
  topRight: number;
  bottomRight: number;
};

// ── Extract fenced code blocks ─────────────────────────────

export function extractCodeBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = content.split("\n");
  let inBlock = false;
  let current: CodeBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      if (inBlock && current !== null) {
        blocks.push(current);
        current = null;
        inBlock = false;
      } else {
        inBlock = true;
        current = { startLine: i + 2, lines: [] }; // +2: 1-based, skip ``` line
      }
    } else if (inBlock && current !== null) {
      current.lines.push(line);
    }
  }
  return blocks;
}

// ── Find boxes by scanning for ┌ and matching └ ───────────

export function findBoxes(lines: string[]): Box[] {
  const boxes: Box[] = [];

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    let col = 0;
    while (col < line.length) {
      if (line[col] !== "┌") { col++; continue; }

      // Find matching ┐ on same line (nearest)
      const rightIdx = line.indexOf("┐", col + 1);
      if (rightIdx === -1) { col++; continue; }

      // Verify horizontal line between them
      let validTop = true;
      for (let c = col + 1; c < rightIdx; c++) {
        const ch = line[c]!;
        if (ch !== "─" && ch !== "┬" && ch !== "┴" && ch !== "┼") {
          validTop = false;
          break;
        }
      }
      if (!validTop) { col++; continue; }

      // Find matching └ below at same left column
      for (let brow = row + 1; brow < lines.length; brow++) {
        const bline = lines[brow]!;
        if (col >= bline.length) continue;
        if (bline[col] === "│" || bline[col] === "├") continue;
        if (bline[col] === "└") {
          const brightIdx = bline.indexOf("┘", col + 1);
          boxes.push({
            topRow: row,
            bottomRow: brow,
            left: col,
            topRight: rightIdx,
            bottomRight: brightIdx === -1 ? -1 : brightIdx,
          });
          break;
        }
        break; // Something else at this column — not a box continuation
      }
      col = rightIdx + 1;
    }
  }
  return boxes;
}

// ── Validate ───────────────────────────────────────────────

function validateBlock(
  block: CodeBlock,
  file: string,
): Issue[] {
  const issues: Issue[] = [];
  const { lines, startLine } = block;

  const emit = (local: number, col: number, msg: string) =>
    issues.push({
      file,
      blockLine: startLine + local - 1,
      localLine: local,
      col,
      message: msg,
    });

  // Line width
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > 78) {
      emit(i + 1, lines[i]!.length, `line is ${lines[i]!.length} chars (max 78)`);
    }
  }

  const boxes = findBoxes(lines);

  for (const box of boxes) {
    const { topRow, bottomRow, left, topRight, bottomRight } = box;
    const width = topRight - left;

    // Bottom must have ┘
    if (bottomRight === -1) {
      emit(bottomRow + 1, left, `└ at col ${left} has no matching ┘`);
      continue;
    }

    // Width consistency
    const bwidth = bottomRight - left;
    if (bwidth !== width) {
      emit(
        bottomRow + 1,
        bottomRight,
        `box bottom is ${bwidth} wide but top is ${width} wide (top line ${topRow + 1})`,
      );
    }

    const right = topRight; // use top right as reference

    // Interior lines: check │ at left and right columns
    for (let row = topRow + 1; row < bottomRow; row++) {
      const line = lines[row]!;

      // Left edge
      if (left < line.length) {
        const lch = line[left];
        if (lch !== "│" && lch !== "├") {
          emit(
            row + 1,
            left,
            `expected │ at col ${left} (left edge), got '${lch}'`,
          );
        }
      } else {
        emit(row + 1, left, `line too short for left edge │ at col ${left}`);
      }

      // Right edge
      if (right < line.length) {
        const rch = line[right];
        if (rch !== "│" && rch !== "┤") {
          emit(
            row + 1,
            right,
            `expected │ at col ${right} (right edge), got '${rch}'`,
          );
        }
      } else {
        emit(row + 1, right, `line too short for right edge │ at col ${right} (is ${line.length} chars)`);
      }
    }
  }

  return issues;
}

// ── Vertical connector validation ─────────────────────────

// Characters that form vertical connections in diagrams
const VERTICAL_CHARS = new Set("│┐┘├┤┬┴┼");
// Characters that connect downward (expect something below at same column)
const CONNECTS_DOWN = new Set("│┐┌┬├┤┼");
// Characters that connect upward (expect something above at same column)
const CONNECTS_UP = new Set("│┘└┴├┤┼");
// Characters that are valid as vertical neighbors (including arrowheads)
const VERTICAL_NEIGHBOR = new Set("│┐┘├┤┬┴┼┌└▼▲");

export function validateVerticalRuns(
	block: CodeBlock,
	file: string,
): Issue[] {
	const issues: Issue[] = [];
	const { lines, startLine } = block;

	// Collect columns of box corners so we can skip them
	const boxes = findBoxes(lines);
	const boxCorners = new Set<string>();
	for (const box of boxes) {
		boxCorners.add(`${box.topRow},${box.left}`);       // ┌
		boxCorners.add(`${box.topRow},${box.topRight}`);   // ┐
		boxCorners.add(`${box.bottomRow},${box.left}`);    // └
		if (box.bottomRight !== -1) {
			boxCorners.add(`${box.bottomRow},${box.bottomRight}`); // ┘
		}
	}

	const emit = (local: number, col: number, msg: string) =>
		issues.push({
			file,
			blockLine: startLine + local - 1,
			localLine: local,
			col,
			message: msg,
		});

	// Check 1: Orphaned ┐ — must have vertical neighbor below
	// Check 2: Orphaned ┘ — must have vertical neighbor above
	for (let row = 0; row < lines.length; row++) {
		const line = lines[row]!;
		for (let col = 0; col < line.length; col++) {
			const ch = line[col]!;

			if (ch === "┐" && !boxCorners.has(`${row},${col}`)) {
				const below = row + 1 < lines.length ? lines[row + 1]![col] : undefined;
				if (!below || !VERTICAL_NEIGHBOR.has(below)) {
					emit(row + 1, col, `┐ at col ${col} has no vertical connector below`);
				}
			}

			if (ch === "┘" && !boxCorners.has(`${row},${col}`)) {
				const above = row > 0 ? lines[row - 1]![col] : undefined;
				if (!above || !VERTICAL_NEIGHBOR.has(above)) {
					emit(row + 1, col, `┘ at col ${col} has no vertical connector above`);
				}
			}
		}
	}

	// Check 3: Vertical run gap detection
	// For each column, find runs of vertical chars. If a column has vertical
	// chars on lines above and below a gap, the gap line is missing a connector.
	const maxCol = Math.max(...lines.map((l) => l.length), 0);
	for (let col = 0; col < maxCol; col++) {
		// Collect all rows that have a vertical character at this column
		const rows: number[] = [];
		for (let row = 0; row < lines.length; row++) {
			const ch = lines[row]![col];
			if (ch !== undefined && VERTICAL_NEIGHBOR.has(ch)) {
				rows.push(row);
			}
		}
		if (rows.length < 3) continue;

		// Find consecutive pairs with a gap of exactly 1 line between them
		for (let i = 0; i < rows.length - 1; i++) {
			const above = rows[i]!;
			const below = rows[i + 1]!;
			if (below - above === 2) {
				// Skip gaps between box closing (└/┘) and box opening (┌/┐).
				// A blank line between vertically stacked boxes is normal layout.
				const aboveCh = lines[above]![col]!;
				const belowCh = lines[below]![col]!;
				const isBoxTransition =
					(aboveCh === "└" || aboveCh === "┘") &&
					(belowCh === "┌" || belowCh === "┐");
				if (isBoxTransition) continue;

				// Only flag when the gap char is a space or missing (line too short).
				// Non-space text chars (labels like "allowed") crossing a vertical
				// column are intentional — not misalignment.
				const gapRow = above + 1;
				const gapCh = lines[gapRow]![col];
				if (gapCh === undefined || gapCh === " ") {
					emit(
						gapRow + 1,
						col,
						`gap in vertical run at col ${col} (lines ${above + 1} and ${below + 1} have │ but line ${gapRow + 1} does not)`,
					);
				}
			}
		}
	}

	return issues;
}

// ── Main ───────────────────────────────────────────────────

function hasBoxDrawing(lines: string[]): boolean {
  return lines.some((l) => l.includes("┌") || l.includes("└"));
}

if (import.meta.main) {
  let files = process.argv.slice(2);
  if (files.length === 0) {
    const dir = resolve(import.meta.dir, "../docs/architecture");
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => resolve(dir, f));
  }

  let total = 0;

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const blocks = extractCodeBlocks(content);
    const fileIssues: Issue[] = [];

    for (const block of blocks) {
      if (hasBoxDrawing(block.lines)) {
        fileIssues.push(...validateBlock(block, file));
        fileIssues.push(...validateVerticalRuns(block, file));
      }
    }

    if (fileIssues.length > 0) {
      console.log(`\n${basename(file)}:`);
      for (const iss of fileIssues) {
        console.log(`  L${iss.blockLine} (block line ${iss.localLine}), col ${iss.col}: ${iss.message}`);
      }
      total += fileIssues.length;
    }
  }

  if (total === 0) {
    console.log("All diagrams pass validation.");
  } else {
    console.log(`\n${total} issue(s) found.`);
    process.exit(1);
  }
}
