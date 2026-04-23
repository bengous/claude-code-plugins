#!/usr/bin/env bun
/**
 * null-as-error scanner
 *
 * Detects silent error swallowing in Effect codebases:
 *   catchAll(() => Effect.succeed(null | [] | false))
 *   catchAll(() => Effect.void)
 *   Effect.ignore
 *
 * Phase 1: ripgrep for candidate lines (fast, broad)
 * Phase 2: Bun enrichment per hit (context, function name, export status)
 * Output: structured JSON to stdout
 */

import { $ } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PatternId =
  | "catchAll-succeed-null"
  | "catchAll-succeed-empty-array"
  | "catchAll-succeed-false"
  | "catchAll-void"
  | "catchAll-effect-void"
  | "effect-ignore";

type Sentinel = "null" | "empty-array" | "false" | "void" | "custom";

type Hit = {
  readonly file: string;
  readonly line: number;
  readonly pattern: PatternId;
  readonly sentinel: Sentinel;
  readonly function: string | null;
  readonly exported: boolean;
  readonly suppressed: boolean;
  readonly suppressionMarker: string | null;
  readonly snippet: string;
  readonly context: string;
};

type ScanResult = {
  readonly hits: readonly Hit[];
  readonly meta: {
    readonly filesScanned: number;
    readonly hitsFound: number;
    readonly suppressed: number;
    readonly scope: string;
  };
};

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

type DetectionPattern = {
  readonly id: PatternId;
  readonly rgPattern: string;
  readonly sentinel: Sentinel;
};

const PATTERNS: readonly DetectionPattern[] = [
  {
    id: "catchAll-succeed-null",
    rgPattern: String.raw`catchAll\(\s*\(?[^)]*\)?\s*=>\s*Effect\.succeed\(\s*null`,
    sentinel: "null",
  },
  {
    id: "catchAll-succeed-empty-array",
    rgPattern: String.raw`catchAll\(\s*\(?[^)]*\)?\s*=>\s*Effect\.succeed\(\s*\[`,
    sentinel: "empty-array",
  },
  {
    id: "catchAll-succeed-false",
    rgPattern: String.raw`catchAll\(\s*\(?[^)]*\)?\s*=>\s*Effect\.succeed\(\s*false`,
    sentinel: "false",
  },
  {
    id: "catchAll-void",
    rgPattern: String.raw`catchAll\(\s*\(\)\s*=>\s*Effect\.void\b`,
    sentinel: "void",
  },
  {
    id: "catchAll-effect-void",
    rgPattern: String.raw`catchAll\(\s*\(\)\s*=>\s*Effect\.succeed\(\s*undefined`,
    sentinel: "void",
  },
  {
    id: "effect-ignore",
    rgPattern: String.raw`Effect\.ignore\b`,
    sentinel: "void",
  },
];

// ---------------------------------------------------------------------------
// Suppression marker
// ---------------------------------------------------------------------------

const SUPPRESSION_RE = /etch-best-effort:\s*(.+)/;
const DEFAULT_SUPPRESSION_MARKERS = ["etch-best-effort:"];

function findSuppression(
  lines: readonly string[],
  hitLineIdx: number,
): string | null {
  // Check the hit line and the line before it
  for (const offset of [0, -1]) {
    const idx = hitLineIdx + offset;
    if (idx < 0 || idx >= lines.length) continue;
    const match = SUPPRESSION_RE.exec(lines[idx]!);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context enrichment
// ---------------------------------------------------------------------------

const FUNCTION_RE =
  /(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*[:=]|(\w+)\s*\()/;

function findEnclosingFunction(
  lines: readonly string[],
  hitLineIdx: number,
): { name: string | null; exported: boolean } {
  // Scan backwards from the hit line to find the enclosing function/const
  for (let i = hitLineIdx; i >= Math.max(0, hitLineIdx - 30); i--) {
    const line = lines[i]!;
    const match = FUNCTION_RE.exec(line);
    if (match !== null) {
      const name = match[1] ?? match[2] ?? match[3] ?? null;
      const exported = line.trimStart().startsWith("export");
      return { name, exported };
    }
  }
  return { name: null, exported: false };
}

function extractContext(
  lines: readonly string[],
  hitLineIdx: number,
  radius: number = 3,
): string {
  const start = Math.max(0, hitLineIdx - radius);
  const end = Math.min(lines.length, hitLineIdx + radius + 1);
  return lines
    .slice(start, end)
    .map((l, i) => {
      const lineNum = start + i + 1;
      const marker = start + i === hitLineIdx ? ">" : " ";
      return `${marker} ${String(lineNum).padStart(4)}| ${l}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Ripgrep execution
// ---------------------------------------------------------------------------

type RgMatch = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

async function ripgrep(
  pattern: string,
  scope: string,
): Promise<readonly RgMatch[]> {
  try {
    const result =
      await $`rg --type ts --no-messages --json -e ${pattern} ${scope}`.quiet();
    const stdout = result.stdout.toString("utf-8");
    const matches: RgMatch[] = [];

    for (const line of stdout.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (
          parsed.type === "match" &&
          parsed.data?.path?.text !== undefined &&
          parsed.data.line_number !== undefined &&
          parsed.data.lines?.text !== undefined
        ) {
          matches.push({
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            text: parsed.data.lines.text.trimEnd(),
          });
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
    return matches;
  } catch {
    // rg exits non-zero when no matches found
    return [];
  }
}

// ---------------------------------------------------------------------------
// File cache
// ---------------------------------------------------------------------------

const fileCache = new Map<string, readonly string[]>();

async function readFileLines(path: string): Promise<readonly string[]> {
  const cached = fileCache.get(path);
  if (cached !== undefined) return cached;
  const content = await Bun.file(path).text();
  const lines = content.split("\n");
  fileCache.set(path, lines);
  return lines;
}

// ---------------------------------------------------------------------------
// Test file detection
// ---------------------------------------------------------------------------

function isTestFile(path: string): boolean {
  return (
    path.includes(".test.") ||
    path.includes(".spec.") ||
    path.includes("/testing/") ||
    path.includes("/__tests__/")
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scan(scope: string): Promise<ScanResult> {
  const allHits: Hit[] = [];
  const seenFiles = new Set<string>();

  for (const pattern of PATTERNS) {
    const matches = await ripgrep(pattern.rgPattern, scope);

    for (const match of matches) {
      seenFiles.add(match.file);

      // Skip test files from results (auditor can still review if needed)
      if (isTestFile(match.file)) continue;

      const lines = await readFileLines(match.file);
      const hitLineIdx = match.line - 1; // 0-indexed

      const suppression = findSuppression(lines, hitLineIdx);
      const { name, exported } = findEnclosingFunction(lines, hitLineIdx);
      const context = extractContext(lines, hitLineIdx);

      allHits.push({
        file: match.file,
        line: match.line,
        pattern: pattern.id,
        sentinel: pattern.sentinel,
        function: name,
        exported,
        suppressed: suppression !== null,
        suppressionMarker: suppression,
        snippet: match.text.trim(),
        context,
      });
    }
  }

  // Deduplicate (same file+line can match multiple patterns)
  const deduped = new Map<string, Hit>();
  for (const hit of allHits) {
    const key = `${hit.file}:${hit.line}`;
    if (!deduped.has(key)) {
      deduped.set(key, hit);
    }
  }

  const hits = [...deduped.values()].toSorted((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    return fileCmp !== 0 ? fileCmp : a.line - b.line;
  });

  return {
    hits,
    meta: {
      filesScanned: seenFiles.size,
      hitsFound: hits.length,
      suppressed: hits.filter((h) => h.suppressed).length,
      scope,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const scope = args.find((a) => !a.startsWith("-")) ?? "src/";
const jsonFlag = args.includes("--json");

const result = await scan(scope);

if (jsonFlag) {
  console.log(JSON.stringify(result, null, 2));
} else {
  // Human-readable output
  const { hits, meta } = result;
  console.error(
    `Scanned ${meta.filesScanned} files in ${meta.scope} -- ${meta.hitsFound} hits (${meta.suppressed} suppressed)\n`,
  );

  for (const hit of hits) {
    const status = hit.suppressed ? "[SUPPRESSED]" : hit.exported ? "[ERROR]" : "[WARNING]";
    const fn = hit.function !== null ? ` in ${hit.function}` : "";
    console.log(`${status} ${hit.file}:${hit.line}${fn}`);
    console.log(`  pattern: ${hit.pattern} (sentinel: ${hit.sentinel})`);
    if (hit.suppressed && hit.suppressionMarker !== null) {
      console.log(`  marker: ${hit.suppressionMarker}`);
    }
    console.log(`  ${hit.snippet}`);
    console.log();
  }
}
