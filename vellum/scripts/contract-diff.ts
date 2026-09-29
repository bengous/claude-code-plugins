#!/usr/bin/env bun
/**
 * What a reviewer reads of a range before its code, as Markdown for a PR: the contracts' diffs
 * (one whose comments only moved is named, not diffed), the table's rules that changed, the test
 * titles added, reworded, moved and removed, the functions whose body changed outside the
 * contracts, those moved named once, and the boundary and walk suites' status at the range's
 * head: the plugin's tree at that commit, extracted under the temp directory with its locked
 * dependencies and removed after, so the checkout is never read nor touched.
 *
 *   bun run --cwd vellum contract-diff <base>..<head>   (<base> alone reads up to HEAD)
 *
 * Its readings are textual, and say so: a title is a string literal passed, in the code and never
 * inside a string or a comment, to `test`, `describe`, or a keyed table's `["title", () => …]` in a
 * file that hands its titles to `test` by name; a function is a named declaration or a `const` bound
 * to a function, read off Bun's transpiler output, so types, comments and layout never count as a
 * change. What changed outside every function of a file (a table of rows, an object of routes) is
 * said of the file, unnamed.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

type FileChange = {
  readonly status: "A" | "D" | "M" | "R";
  readonly from: string;
  readonly to: string;
};

type Paired = { readonly from: Titled; readonly to: Titled };

export type TitleChanges = {
  readonly added: readonly Titled[];
  readonly changed: readonly Paired[];
  readonly moved: readonly Paired[];
  readonly removed: readonly Titled[];
};

type Titled = { readonly file: string; readonly title: string };

type FunctionChanges = {
  readonly byFile: readonly {
    readonly file: string;
    readonly changed: readonly string[];
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly outside: boolean;
  }[];
  readonly moved: readonly Move[];
  readonly movedChanged: readonly Move[];
};

type Move = { readonly name: string; readonly from: string; readonly to: string };

/** A module's named functions, each its parameters and body as written, and what is left around them. */
export type Functions = { readonly functions: Map<string, string>; readonly outside: string };

/** Two titles this close in words are one test reworded. */
const REWORDED = 0.5;

const TEST_FILE = /\.(?:spec|test|e2e)\.tsx?$/u;

const SOURCE_FILE = /\.tsx?$/u;

/** The suites whose status closes the report, relative to the plugin's root. */
const SUITES = [
  { name: "boundaries", path: "src/boundaries.spec.ts" },
  { name: "walk", path: "src/workflow.spec.ts" },
];

function git(cwd: string, args: readonly string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString().trim()}`);
  }

  return run.stdout.toString();
}

/** A file's text at a revision; `""` when the revision holds none. */
function show(cwd: string, revision: string, path: string): string {
  const run = Bun.spawnSync(["git", "show", `${revision}:${path}`], { cwd, stdout: "pipe" });

  return run.exitCode === 0 ? run.stdout.toString() : "";
}

function changesIn(cwd: string, base: string, head: string, plugin: string): FileChange[] {
  return git(cwd, ["diff", "--name-status", "-M", base, head, "--", plugin])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [code = "", from = "", to = from] = line.split("\t");
      const status = code.slice(0, 1);

      if (status !== "A" && status !== "D" && status !== "M" && status !== "R") {
        throw new Error(`a change git names ${code} is not read here: ${line}`);
      }

      return { status, from, to };
    });
}

/** A source's code, each string or template literal in it as `"#<n>"` and each comment as a space. */
type Scanned = {
  readonly code: string;
  readonly literals: readonly string[];
  readonly comments: readonly string[];
};

/** Whether a `/` at this point of the code opens a regular expression rather than a division. */
function opensRegex(code: string): boolean {
  const before = code.trimEnd();

  return before === "" || /[(,=:[!&|?{};]$|\breturn$|\btypeof$/u.test(before);
}

/** The index past a regular expression's closing `/` and its flags. */
function pastRegex(text: string, open: number): number {
  let inClass = false;

  for (let at = open + 1; at < text.length; at += 1) {
    const char = text.charAt(at);

    if (char === "\\") at += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass)
      return at + 1 + (/^\w*/u.exec(text.slice(at + 1))?.[0].length ?? 0);
  }

  return text.length;
}

/** Splits a source into its code and its literals, comments dropped, so a string never reads as code. */
export function scan(source: string): Scanned {
  const literals: string[] = [];
  const comments: string[] = [];
  let code = "";

  for (let at = 0; at < source.length; at += 1) {
    const char = source.charAt(at);
    const next = source.charAt(at + 1);

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      comments.push(source.slice(at, end === -1 ? source.length : end));
      at = (end === -1 ? source.length : end) - 1;
      code += " ";
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2);
      comments.push(source.slice(at, end === -1 ? source.length : end + 2));
      at = end === -1 ? source.length : end + 1;
      code += " ";
    } else if (char === '"' || char === "'" || char === "`") {
      const end = pastString(source, at);
      code += `"#${literals.length}"`;
      literals.push(source.slice(at, end + 1));
      at = end;
    } else if (char === "/" && opensRegex(code)) {
      const end = pastRegex(source, at);
      code += "/r/";
      at = end - 1;
    } else code += char;
  }

  return { code, literals, comments };
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((text, at) => text === b[at]);
}

/** Whether two texts of a file differ by where their comments sit alone: the same code, the same comments. */
export function onlyCommentsMoved(before: string, after: string): boolean {
  const one = scan(before);
  const other = scan(after);

  return (
    normalized(one.code) === normalized(other.code) &&
    same(one.literals, other.literals) &&
    same(one.comments.toSorted(), other.comments.toSorted())
  );
}

/** A literal's text, `null` for a template that interpolates. */
function literalText(literal: string): string | null {
  const quote = literal.charAt(0);
  const inner = literal.slice(1, -1);

  if (quote === "`") return inner.includes("${") ? null : inner;

  return quote === '"' ? String(JSON.parse(literal)) : inner.replaceAll("\\'", "'");
}

/** Every title a suite gives its tests and groups, in the order written, read off its code alone. */
export function titlesOf(source: string): string[] {
  const { code, literals } = scan(source);
  const called = /\b(?:test|it|describe)(?:\.\w+)*(?:\([^()]*\))?\(\s*"#(\d+)"/gu;
  const keyed = /\[\s*"#(\d+)",\s*(?:async\s*)?\(/gu;
  const byName = /\btest(?:\.\w+)*\(\s*[A-Za-z_$]/u.test(code);

  return [...code.matchAll(called), ...(byName ? code.matchAll(keyed) : [])]
    .toSorted((a, b) => a.index - b.index)
    .flatMap(([, n = ""]) => {
      const text = literalText(literals[Number.parseInt(n, 10)] ?? "");

      return text === null ? [] : [text];
    });
}

function wordsOf(title: string): Set<string> {
  return new Set(title.toLowerCase().match(/[a-z0-9']+/gu) ?? []);
}

function likeness(a: string, b: string): number {
  const one = wordsOf(a);
  const other = wordsOf(b);
  const shared = [...one].filter((word) => other.has(word)).length;

  return shared / new Set([...one, ...other]).size;
}

/** What is left of `from` once each title of `taken` is taken out once. */
function without(from: readonly string[], taken: readonly string[]): string[] {
  const left = [...from];

  for (const title of taken) {
    const at = left.indexOf(title);

    if (at !== -1) left.splice(at, 1);
  }

  return left;
}

/**
 * The titles each file lost and gained; a lost title and a gained one close in words are one test
 * reworded, or moved when the words are the same, paired greedily, the closest first, across files.
 */
export function titleChanges(
  files: readonly { readonly file: string; readonly before: string[]; readonly after: string[] }[],
): TitleChanges {
  const lost = files.flatMap(({ file, before, after }) =>
    without(before, after).map((title) => ({ file, title })),
  );

  const gained = files.flatMap(({ file, before, after }) =>
    without(after, before).map((title) => ({ file, title })),
  );

  const pairs = lost
    .flatMap((from) => gained.map((to) => ({ from, to, like: likeness(from.title, to.title) })))
    .filter(({ like }) => like >= REWORDED)
    .toSorted((a, b) => b.like - a.like);

  const paired: Paired[] = [];

  for (const { from, to } of pairs) {
    if (!paired.some((pair) => pair.from === from || pair.to === to)) paired.push({ from, to });
  }

  return {
    added: gained.filter((to) => !paired.some((pair) => pair.to === to)),
    changed: paired.filter(({ from, to }) => from.title !== to.title),
    moved: paired.filter(({ from, to }) => from.title === to.title),
    removed: lost.filter((from) => !paired.some((pair) => pair.from === from)),
  };
}

/** Each opening bracket and the one that closes it. */
const CLOSERS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

/** The index past the bracket that closes the one at `open`, strings and templates skipped. */
function closing(text: string, open: number): number {
  const stack: string[] = [];

  for (let at = open; at < text.length; at += 1) {
    const char = text.charAt(at);

    if (char === '"' || char === "'" || char === "`") {
      at = pastString(text, at);
      continue;
    }

    const closer = CLOSERS.get(char);

    if (closer !== undefined) stack.push(closer);
    else if (char === stack.at(-1)) {
      stack.pop();

      if (stack.length === 0) return at + 1;
    }
  }

  return text.length;
}

/** The index of a string's closing quote; a template's `${…}` is skipped whole. */
function pastString(text: string, open: number): number {
  const quote = text.charAt(open);

  for (let at = open + 1; at < text.length; at += 1) {
    const char = text.charAt(at);

    if (char === "\\") at += 1;
    else if (quote === "`" && char === "$" && text.charAt(at + 1) === "{") {
      at = closing(text, at + 1) - 1;
    } else if (char === quote) return at;
  }

  return text.length;
}

/** Where an arrow's expression body ends: the first `;`, `,` or closing bracket at its own depth. */
function expressionEnd(text: string, from: number): number {
  for (let at = from; at < text.length; at += 1) {
    const char = text.charAt(at);

    if (char === "(" || char === "[" || char === "{") at = closing(text, at) - 1;
    else if (char === '"' || char === "'" || char === "`") at = pastString(text, at);
    else if (";,)]}\n".includes(char)) return at;
  }

  return text.length;
}

/** How a function is written: `function name(`, `const name = (…) =>`, or a class's `name(…) {`. */
type Written = "declared" | "arrow" | "method";

/** Words a method's pattern also matches at a line's start, which open no function. */
const NOT_METHODS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "super",
]);

/** A function's parameters and body from the `(` of its parameters: `null` for no function there. */
function functionAt(text: string, open: number, written: Written): string | null {
  const params = closing(text, open);
  const rest = text.slice(params).match(/^\s*(=>)?\s*/u);
  const start = params + (rest?.[0].length ?? 0);

  if (written === "arrow" && rest?.[1] === undefined) return null;

  if (written === "method" && (rest?.[1] !== undefined || text.charAt(start) !== "{")) return null;
  const end = text.charAt(start) === "{" ? closing(text, start) : expressionEnd(text, start);

  return text.slice(open, end);
}

function normalized(code: string): string {
  return code
    .replaceAll(/jsxDEV_\w+/gu, "jsxDEV")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/** Each named function of a module's JavaScript, by name, and the code outside the outermost ones. */
export function functionsOf(javascript: string): Functions {
  const declarations: readonly { readonly pattern: RegExp; readonly written: Written }[] = [
    { pattern: /\bfunction(?:\s*\*\s*|\s+)([A-Za-z_$][\w$]*)\s*\(/gu, written: "declared" },
    {
      pattern:
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*)?\(/gu,
      written: "arrow",
    },
    {
      pattern: /^[ \t]*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?([A-Za-z_$][\w$]*)\s*\(/gmu,
      written: "method",
    },
  ];

  const functions = new Map<string, string>();
  const spans: { readonly start: number; readonly end: number }[] = [];

  for (const { pattern, written } of declarations) {
    for (const match of javascript.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const [, name = ""] = match;

      if (written === "method" && NOT_METHODS.has(name)) continue;
      const declared = written === "arrow" && match[0].includes("function") ? "declared" : written;
      const body = functionAt(javascript, open, declared);

      if (body === null) continue;
      let key = name;

      for (let n = 2; functions.has(key); n += 1) key = `${name}#${n}`;
      functions.set(key, normalized(body));

      // The whole declaration leaves the code outside: its `export` and `async`, and its `;`.
      const lead = /(?:export\s+(?:default\s+)?)?(?:async\s+)?$/u.exec(
        javascript.slice(0, match.index),
      );

      const end = open + body.length;

      spans.push({
        start: match.index - (lead?.[0].length ?? 0),
        end: javascript.charAt(end) === ";" ? end + 1 : end,
      });
    }
  }

  let outside = "";
  let at = 0;

  for (const { start, end } of spans.toSorted((a, b) => a.start - b.start)) {
    if (start < at) continue;
    outside += javascript.slice(at, start);
    at = end;
  }

  // An import names where code comes from, not what it does: a moved file changes it alone.
  const wiring = /(?:^|\n)\s*(?:import|export)\b[^;]*?(?:\bfrom\s*)?"[^"]*";/gu;

  return {
    functions,
    outside: normalized((outside + javascript.slice(at)).replaceAll(wiring, "")),
  };
}

function javascriptOf(path: string, source: string): string {
  if (source === "") return "";

  return new Bun.Transpiler({ loader: path.endsWith(".tsx") ? "tsx" : "ts" }).transformSync(source);
}

type Named = { readonly file: string; readonly name: string; readonly body: string };

/** The names of `list` in `file`, but those `moves` took. */
function namesIn(list: readonly Named[], file: string, moves: Set<string>): string[] {
  return list.flatMap((one) =>
    one.file === file && !moves.has(`${file}\0${one.name}`) ? [one.name] : [],
  );
}

/**
 * Changed, new and gone names per file. A name gone from one file and new in another moved: with
 * the same body when one there has it, else changed on the way when one there has its name.
 */
export function functionChanges(
  files: readonly {
    readonly file: string;
    readonly before: Functions;
    readonly after: Functions;
  }[],
): FunctionChanges {
  const gone = files.flatMap(({ file, before, after }) =>
    [...before.functions].flatMap(([name, body]) =>
      after.functions.has(name) ? [] : [{ file, name, body }],
    ),
  );

  const added = files.flatMap(({ file, before, after }) =>
    [...after.functions].flatMap(([name, body]) =>
      before.functions.has(name) ? [] : [{ file, name, body }],
    ),
  );

  const moved = gone.flatMap((from) => {
    const to = added.find((one) => one.body === from.body && one.file !== from.file);

    return to === undefined ? [] : [{ name: from.name, from: from.file, to: to.file, pair: to }];
  });

  const movedChanged = gone.flatMap((from) => {
    const to = added.find(
      (one) =>
        one.name === from.name &&
        one.file !== from.file &&
        !moved.some(({ pair }) => pair === one) &&
        !moved.some((move) => move.from === from.file && move.name === from.name),
    );

    return to === undefined ? [] : [{ name: from.name, from: from.file, to: to.file, pair: to }];
  });

  const movedFrom = new Set(
    [...moved, ...movedChanged].map(({ name, from }) => `${from}\0${name}`),
  );

  const movedTo = new Set(
    [...moved, ...movedChanged].map(({ pair }) => `${pair.file}\0${pair.name}`),
  );

  const byFile = files.flatMap(({ file, before, after }) => {
    const changed = [...after.functions].flatMap(([name, body]) => {
      const was = before.functions.get(name);

      return was !== undefined && was !== body ? [name] : [];
    });

    const entry = {
      file,
      changed,
      added: namesIn(added, file, movedTo),
      removed: namesIn(gone, file, movedFrom),
      outside: before.outside !== "" && after.outside !== "" && before.outside !== after.outside,
    };

    return entry.outside || [entry.changed, entry.added, entry.removed].some((l) => l.length > 0)
      ? [entry]
      : [];
  });

  return {
    byFile,
    moved: moved.map(({ name, from, to }) => ({ name, from, to })),
    movedChanged: movedChanged.map(({ name, from, to }) => ({ name, from, to })),
  };
}

function codeList(list: readonly string[]): string {
  return list.map((name) => `\`${name}\``).join(", ");
}

function titledLine({ file, title }: Titled): string {
  return `- ${title} (\`${file}\`)`;
}

function renderTitles({ added, changed, moved, removed }: TitleChanges): string[] {
  return [
    ...(added.length > 0
      ? [`Added (${added.length}):`, ...added.map((one) => titledLine(one)), ""]
      : []),
    ...(changed.length > 0
      ? [
          `Reworded (${changed.length}):`,
          ...changed.map(({ from, to }) => `- ${from.title}\n  → ${to.title} (\`${to.file}\`)`),
          "",
        ]
      : []),
    ...(moved.length > 0
      ? [
          `Moved to another file (${moved.length}):`,
          ...moved.map(({ from, to }) => `- ${to.title}: \`${from.file}\` → \`${to.file}\``),
          "",
        ]
      : []),
    ...(removed.length > 0
      ? [`Removed (${removed.length}):`, ...removed.map((one) => titledLine(one)), ""]
      : []),
  ];
}

function renderFunctions({ byFile, moved, movedChanged }: FunctionChanges): string[] {
  const lines = byFile.map(({ file, changed, added, removed, outside }) => {
    const parts = [
      changed.length > 0 ? `changed ${codeList(changed)}` : "",
      added.length > 0 ? `new ${codeList(added)}` : "",
      removed.length > 0 ? `gone ${codeList(removed)}` : "",
      outside ? "and code outside its functions" : "",
    ].filter((part) => part !== "");

    return `- \`${file}\`: ${parts.join("; ")}`;
  });

  return [
    ...lines,
    ...(moved.length > 0
      ? [
          "",
          "Moved with the same body:",
          ...moved.map(({ name, from, to }) => `- \`${name}\`: \`${from}\` → \`${to}\``),
        ]
      : []),
    ...(movedChanged.length > 0
      ? [
          "",
          "Moved and changed on the way:",
          ...movedChanged.map(({ name, from, to }) => `- \`${name}\`: \`${from}\` → \`${to}\``),
        ]
      : []),
  ];
}

function suiteStatus(root: string, sha: string): string[] {
  return SUITES.map(({ name, path }) => {
    if (!existsSync(join(root, path))) return `- ${name}: no \`${path}\` at \`${sha}\``;

    const run = Bun.spawnSync(["bun", "test", `./${path}`], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    const pass = /(\d+) pass/u.exec(output)?.[1] ?? "?";
    const fail = /(\d+) fail/u.exec(output)?.[1] ?? "?";
    const verdict = run.exitCode === 0 ? "green" : "red";

    return `- ${name} (\`${path}\`) at \`${sha}\`: ${verdict}, ${pass} pass, ${fail} fail`;
  });
}

/** The suites at `head`: the plugin's tree at that commit, with its locked dependencies, in a directory removed after. */
function suitesAt(top: string, head: string, plugin: string): string[] {
  const sha = git(top, ["rev-parse", "--short", head]).trim();
  const dir = mkdtempSync(join(tmpdir(), "contract-diff-"));

  try {
    const tar = join(dir, "head.tar");
    git(top, ["archive", "--output", tar, head, "--", plugin]);
    const untar = Bun.spawnSync(["tar", "-xf", tar, "-C", dir], { stderr: "pipe" });

    if (untar.exitCode !== 0) throw new Error(`tar -xf failed: ${untar.stderr.toString().trim()}`);
    const root = join(dir, plugin);

    if (existsSync(join(root, "bun.lock"))) {
      const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });

      if (install.exitCode !== 0) {
        return [`Not run at \`${sha}\`: \`bun install --frozen-lockfile\` failed there.`];
      }
    }

    return suiteStatus(root, sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function section(title: string, body: readonly string[], none: string): string[] {
  return [`## ${title}`, "", ...(body.length > 0 ? body : [none]), ""];
}

/** The report for `range` on the plugin at `pluginRoot`; the suites run at the range's head unless `suites` is false. */
export function contractDiff(range: string, pluginRoot: string, suites = true): string {
  const [base = "", head = "HEAD"] = range.includes("..") ? range.split("..") : [range];
  const top = git(pluginRoot, ["rev-parse", "--show-toplevel"]).trim();
  const plugin = relative(top, pluginRoot).replaceAll("\\", "/") || ".";
  const changes = changesIn(top, base, head, plugin);
  const inPlugin = (path: string): string => relative(plugin, path).replaceAll("\\", "/");

  const moveOnly = ({ status, from, to }: FileChange): boolean =>
    status !== "A" &&
    status !== "D" &&
    onlyCommentsMoved(show(top, base, from), show(top, head, to));

  const contractChanges = changes.filter(({ to }) => to.endsWith("/contract.ts"));
  const commentsMoved = contractChanges.filter((change) => moveOnly(change));
  const contracts = contractChanges.filter((change) => !commentsMoved.includes(change));

  const contractDiffText =
    contracts.length === 0
      ? ""
      : git(top, [
          "diff",
          "-M",
          base,
          head,
          "--",
          ...contracts.flatMap(({ from, to }) => [from, to]),
        ]);

  const snapshot = git(top, [
    "diff",
    base,
    head,
    "--",
    `${plugin}/src/__snapshots__/table.spec.ts.snap`,
  ])
    .split("\n")
    .filter((line) => /^[-+]/u.test(line) && !/^(?:---|\+\+\+)/u.test(line))
    .filter((line) => line.slice(1).trim() !== "");

  const titles = titleChanges(
    changes
      .filter(({ to }) => TEST_FILE.test(to))
      .map(({ status, from, to }) => ({
        file: inPlugin(to),
        before: status === "A" ? [] : titlesOf(show(top, base, from)),
        after: status === "D" ? [] : titlesOf(show(top, head, to)),
      })),
  );

  const functions = functionChanges(
    changes
      .filter(({ to }) => SOURCE_FILE.test(to) && !TEST_FILE.test(to) && !to.endsWith(".d.ts"))
      .filter(({ to }) => !to.endsWith("/contract.ts"))
      .map(({ status, from, to }) => ({
        file: inPlugin(to),
        before: functionsOf(status === "A" ? "" : javascriptOf(from, show(top, base, from))),
        after: functionsOf(status === "D" ? "" : javascriptOf(to, show(top, head, to))),
      })),
  );

  const titleLines = renderTitles(titles);

  return [
    `# ${range}`,
    "",
    ...section(
      "Contracts",
      [
        ...commentsMoved.map(({ to }) => `Only comments moved in \`${inPlugin(to)}\`.`),
        ...(contractDiffText === "" ? [] : ["```diff", contractDiffText.trimEnd(), "```"]),
      ],
      "No contract changed.",
    ),
    ...section(
      "Rules (`table.spec.ts.snap`)",
      snapshot.length === 0 ? [] : ["```diff", ...snapshot, "```"],
      "No rule changed.",
    ),
    ...section(
      "Test titles",
      titleLines.at(-1) === "" ? titleLines.slice(0, -1) : titleLines,
      "No title changed.",
    ),
    ...section(
      "Function bodies changed outside the contracts",
      renderFunctions(functions),
      "None.",
    ),
    ...section(
      "Boundary and walk suites, at the range's head",
      suites ? suitesAt(top, head, plugin) : [],
      "Not run.",
    ),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

if (import.meta.main) {
  const [range] = Bun.argv.slice(2);

  if (range === undefined) {
    console.error("usage: bun run --cwd vellum contract-diff <base>..<head>");
    process.exit(2);
  }

  process.stdout.write(contractDiff(range, dirname(import.meta.dir)));
}
