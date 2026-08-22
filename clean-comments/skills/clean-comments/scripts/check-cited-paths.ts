#!/usr/bin/env bun
// Checks file paths cited INSIDE comments: a pointer to a module that moved or
// vanished is a comment that lies, and it is the only truth test that mechanizes
// completely.
//
// Why a script and not an agent's judgment: whether a file exists is a fact, not an
// appraisal. Having an LLM rule on it costs tokens and invents false positives. The
// agent gets the list of broken pointers and spends its context on what only it can do.
//
// Always exits 0, writes nothing: this is an audit probe, not a gate step. A stale
// pointer gets fixed by hand, with the comment in view.
//
// Blind spots, by design: a bare filename with no directory, a path inside a hidden
// directory, and a path relative to a project area this script did not derive (pass
// --root for that one).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const DEFAULT_EXT =
  "ts,tsx,js,jsx,mjs,cjs,astro,vue,svelte,py,go,rs,java,rb,php,c,h,cpp,cs,swift,kt";
const DEFAULT_CITED_EXT = `${DEFAULT_EXT},md,mdx,json,jsonc,css,scss,sql,yml,yaml,toml,sh,liquid`;
const DEFAULT_EXCLUDE = "node_modules,dist,build,out,target,vendor,.git,.claude,.astro,.next,.venv";

const HELP = `check-cited-paths — list file paths cited in comments whose target does not exist

Usage: check-cited-paths.ts [repo-root] [options]

Options:
  --ext <list>         comma-separated extensions of files to scan
                       (default: ${DEFAULT_EXT})
  --cited-ext <list>   extensions accepted inside a citation
                       (default: scanned extensions plus md, json, css, sql, yml...)
  --exclude <dir>      directory name to skip, repeatable
                       (default: ${DEFAULT_EXCLUDE})
  --root <path>        extra resolution root, repeatable. Use it when the repo cites
                       modules relative to a directory this script does not derive.
  --external <regex>   citation to ignore, repeatable. Use it for paths that live
                       outside the repo by design (a ported theme, vendored sources).
  --count              output comment-line counts per file instead of checking
                       citations: the hunters' denominator and the guard's estimate
  -h, --help           this text

Resolution: a citation is innocent as soon as it resolves against the repo root, any
ancestor directory of the citing file, any top-level directory, any top-level "src"
directory, or any --root you passed.

Exits 0 whatever it finds.`;

function parseArgs(argv: string[]) {
  let repoRoot = ".";
  let ext = DEFAULT_EXT;
  let citedExt: string | undefined;
  const exclude = DEFAULT_EXCLUDE.split(",");
  const roots: string[] = [];
  const external: RegExp[] = [];
  let count = false;
  let seenPositional = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`Error: ${arg} needs a value`);
        process.exit(2);
      }
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      case "--ext":
        ext = next();
        break;
      case "--cited-ext":
        citedExt = next();
        break;
      case "--exclude":
        exclude.push(next());
        break;
      case "--root":
        roots.push(next());
        break;
      case "--external":
        external.push(new RegExp(next()));
        break;
      case "--count":
        count = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Error: unknown option ${arg}\n`);
          console.error(HELP);
          process.exit(2);
        }
        if (!seenPositional) {
          repoRoot = arg;
          seenPositional = true;
        }
    }
  }

  return {
    repoRoot: resolve(repoRoot),
    ext: ext.split(",").map((e) => `.${e.replace(/^\./, "")}`),
    citedExt: (citedExt ?? `${ext},${DEFAULT_CITED_EXT}`)
      .split(",")
      .map((e) => e.replace(/^\./, "")),
    exclude: new Set(exclude),
    roots,
    external,
    count,
  };
}

const opts = parseArgs(process.argv.slice(2));

if (!existsSync(opts.repoRoot)) {
  console.error(`Error: ${opts.repoRoot} does not exist`);
  process.exit(2);
}

// A cited path: at least one directory, a name, an extension the repo knows. Extensions
// are restricted so the pattern does not catch domain names (example.com) or versions
// (1.2.3). Longest extension first, and nothing word-like after it: regex alternation
// is ordered, so an unsorted list truncates ".json" to ".js" and ".css" to ".c".
const citedPathPattern = new RegExp(
  String.raw`(?:^|[\s\`'"(<\[])((?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.-]+\.(?:${[...opts.citedExt]
    .sort((a, b) => b.length - a.length)
    .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")}))(?![\w-])`,
  "g",
);

function collect(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // broken symlink
    }
    if (st.isDirectory()) {
      if (!opts.exclude.has(entry)) collect(full, out);
    } else if (opts.ext.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

// Which markers open a comment depends on the language: "#" is a comment in Python and
// shell, but a private field or a URL fragment in TypeScript, and treating it as one
// there invents citations out of ordinary code.
const HASH_LANGS = new Set([
  ".py",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".yml",
  ".yaml",
  ".toml",
  ".pl",
  ".r",
  ".ex",
]);
const HTML_LANGS = new Set([".astro", ".vue", ".svelte", ".html", ".md", ".mdx", ".xml"]);

// Masks string-literal content with spaces, length-preserving, so a comment marker
// inside a string never opens a segment. Without this, an unterminated /* inside a
// glob string turned every remaining line of the file into "comments" and inflated
// the --count denominators. Per-line only: a template literal spanning lines is not
// tracked, and an apostrophe in code prose can mask the rest of its own line — either
// way the damage is one line, never the file.
function maskStrings(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") {
        out += "  ";
        i++;
      } else if (ch === quote) {
        quote = null;
        out += ch;
      } else {
        out += " ";
      }
    } else {
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      out += ch;
    }
  }
  return out;
}

// Extracts the comment segments of a line. Markers are searched on the string-masked
// line (skipped for HTML/Markdown, where quotes are prose, not syntax); the segment
// text is sliced from the original, indices align because masking preserves length.
function commentSegments(source: string, file: string): { line: number; text: string }[] {
  const ext = file.slice(file.lastIndexOf("."));
  const hash = HASH_LANGS.has(ext);
  const html = HTML_LANGS.has(ext);
  const out: { line: number; text: string }[] = [];
  let inBlock = false;
  let number = 0;
  for (const line of source.split("\n")) {
    number++;
    if (inBlock) {
      const end = line.indexOf("*/");
      out.push({ line: number, text: end === -1 ? line : line.slice(0, end) });
      if (end !== -1) inBlock = false;
      continue;
    }
    const masked = html ? line : maskStrings(line);
    const blockStart = masked.indexOf("/*");
    const starts = [
      hash ? -1 : masked.indexOf("//"),
      hash ? -1 : blockStart,
      html ? masked.indexOf("<!--") : -1,
      hash ? masked.indexOf("#") : -1,
    ].filter((i) => i !== -1);
    if (starts.length === 0) continue;
    const start = Math.min(...starts);
    if (start === blockStart && line.indexOf("*/", start) === -1) inBlock = true;
    out.push({ line: number, text: line.slice(start) });
  }
  return out;
}

// Repos routinely cite their modules by partial path: <area>/auth.ts from one zone,
// <zone>/src/data/faq.ts from another, <siblings>/Card.astro from next door. Every
// directory down to this depth is a resolution root, and one valid resolution clears a
// citation. Clearing too eagerly only costs a missed break — which the reading agent
// still catches — while a false "not found" wastes its context on a fiction.
// (The examples above wear angle brackets on purpose: a real-looking path in a comment
// is exactly what this script reports, and it should not flag its own prose.)
const ROOT_DEPTH = 3;

function resolutionRoots(): string[] {
  const derived = [""];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > ROOT_DEPTH) return;
    for (const entry of readdirSync(dir)) {
      if (opts.exclude.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      const next = rel ? join(rel, entry) : entry;
      derived.push(next);
      walk(full, next, depth + 1);
    }
  };
  walk(opts.repoRoot, "", 1);
  return [...derived, ...opts.roots];
}

const ROOTS = resolutionRoots();

// Beyond the shared roots, a citation also resolves against any ANCESTOR directory of
// the citing file: <siblings>/Carousel.astro written inside components/sections means
// the area next door, and no repo-wide root list can guess every such pair.
function ancestors(file: string): string[] {
  const out: string[] = [];
  let dir = resolve(join(file, ".."));
  while (dir.startsWith(opts.repoRoot) && dir !== opts.repoRoot) {
    out.push(dir);
    dir = resolve(join(dir, ".."));
  }
  return out;
}

function exists(cited: string, file: string): boolean {
  const cleaned = cited.replace(/^\.\//, "");
  if (existsSync(resolve(join(file, ".."), cited))) return true;
  if (ROOTS.some((r) => existsSync(join(opts.repoRoot, r, cleaned)))) return true;
  return ancestors(file).some((a) => existsSync(join(a, cleaned)));
}

function isExternal(cited: string): boolean {
  const cleaned = cited.replace(/^\.\//, "");
  return opts.external.some((re) => re.test(cleaned));
}

if (opts.count) {
  let total = 0;
  for (const file of collect(opts.repoRoot, [])) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = commentSegments(source, file).length;
    if (lines > 0) console.log(`${relative(opts.repoRoot, file)}\t${lines}`);
    total += lines;
  }
  console.log(`\n${total} comment lines total.`);
  process.exit(0);
}

const broken: { file: string; line: number; cited: string }[] = [];
let citations = 0;

for (const file of collect(opts.repoRoot, [])) {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { line, text } of commentSegments(source, file)) {
    for (const match of text.matchAll(citedPathPattern)) {
      const cited = match[1];
      if (!cited || isExternal(cited)) continue;
      citations++;
      if (!exists(cited, file)) {
        broken.push({ file: relative(opts.repoRoot, file), line, cited });
      }
    }
  }
}

console.log(`${citations} paths cited in comments, ${broken.length} not found.\n`);
for (const b of broken) {
  console.log(`${b.file}:${b.line} — cites "${b.cited}" — not found`);
}
