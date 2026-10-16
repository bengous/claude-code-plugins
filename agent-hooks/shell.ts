import { homedir } from "node:os";
import path from "node:path";

/** One simple command of a Bash tool call: its words, quotes removed, and the directory it runs in. */
export type Invocation = { readonly cwd: string; readonly argv: readonly string[] };

type Token =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "separator" }
  | { readonly kind: "open" }
  | { readonly kind: "close" };

const SEPARATOR: Token = { kind: "separator" };

const OPEN: Token = { kind: "open" };

const CLOSE: Token = { kind: "close" };

const ASSIGNMENT = /^[A-Za-z_]\w*=/u;

const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** A program that runs the command after its own options: what those options take, and which ones move or replace it. */
type Wrapper = {
  /** Options that take a value, as the next word or attached (`-uNAME`, `--unset=NAME`). */
  readonly values?: ReadonlySet<string>;
  readonly chdir?: ReadonlySet<string>;
  /** Options whose value is the command line itself, split on whitespace (`env -S`). */
  readonly split?: ReadonlySet<string>;
  /** Options with which the wrapper runs nothing (`command -v`). */
  readonly runsNothing?: ReadonlySet<string>;
  /** Words after the options before the command (`timeout`'s duration). */
  readonly operands?: number;
};

const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
  ["command", { runsNothing: new Set(["-v", "-V"]) }],
  ["exec", { values: new Set(["-a"]) }],
  ["nohup", {}],
  ["builtin", {}],
  ["time", {}],
  [
    "env",
    {
      values: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
      chdir: new Set(["-C", "--chdir"]),
      split: new Set(["-S", "--split-string"]),
    },
  ],
  ["nice", { values: new Set(["-n", "--adjustment"]) }],
  ["timeout", { values: new Set(["-s", "--signal", "-k", "--kill-after"]), operands: 1 }],
  [
    "xargs",
    {
      values: new Set([
        "-I",
        "-L",
        "-n",
        "-P",
        "-s",
        "-E",
        "-d",
        "-a",
        "--max-lines",
        "--max-args",
        "--max-procs",
        "--max-chars",
        "--eof",
        "--delimiter",
        "--arg-file",
      ]),
    },
  ],
  [
    "sudo",
    {
      values: new Set([
        "-u",
        "-g",
        "-C",
        "-D",
        "-h",
        "-p",
        "-r",
        "-t",
        "-T",
        "-U",
        "--user",
        "--group",
        "--close-from",
        "--chdir",
        "--host",
        "--prompt",
        "--role",
        "--type",
        "--command-timeout",
        "--other-user",
      ]),
      chdir: new Set(["-D", "--chdir"]),
    },
  ],
]);

type Heredoc = { readonly delimiter: string; readonly stripTabs: boolean };

type Redirection = { readonly end: number; readonly dropsWord: boolean };

type Scan = { readonly tokens: Token[]; readonly end: number };

/** The command a simple command runs and the directory it runs in. */
type Unwrapped = { readonly argv: string[]; readonly cwd: string };

type OptionRead = {
  readonly name: string;
  readonly value: string | undefined;
  readonly width: number;
};

/**
 * Reads a shell line as Bash splits it into simple commands, from `start`: quotes, escapes, line continuations,
 * comments, heredoc bodies and redirections are consumed, `&&`, `||`, `;`, `|`, `&` and newlines separate commands,
 * and a subshell opens a group. A command substitution, `$(…)`, backticks or `<(…)`, quoted or not, is read as a
 * group placed before the command it belongs to, which Bash runs first; the word keeps its source text. With
 * `closer`, the scan ends at the parenthesis that closes the substitution it reads. No expansion runs: `$VAR` and
 * `~user` stay text.
 */
function scan(script: string, start: number, closer: ")" | null): Scan {
  const tokens: Token[] = [];
  const heredocs: Heredoc[] = [];
  let word: string | null = null;
  let dropNextWord = false;
  let commandStart = 0;
  let depth = 0;
  let index = start;

  const endWord = (): void => {
    if (word !== null) {
      if (dropNextWord) {
        dropNextWord = false;
      } else {
        tokens.push({ kind: "word", text: word });
      }
    }

    word = null;
  };

  const separate = (token: Token): void => {
    endWord();
    tokens.push(token);
    commandStart = tokens.length;
  };

  /** Reads the substitution at `at` into a group before the current command; returns the index after it. */
  const substitution = (at: number): number => {
    let inner: readonly Token[];
    let end: number;

    if (script[at] === "`") {
      end = backtickEnd(script, at + 1);
      inner = scan(script.slice(at + 1, end).replaceAll(/\\([\\`$])/gu, "$1"), 0, null).tokens;
    } else {
      const nested = scan(script, at + 2, ")");
      inner = nested.tokens;
      end = nested.end;
    }

    tokens.splice(commandStart, 0, OPEN, ...inner, CLOSE);
    commandStart += inner.length + 2;
    word = (word ?? "") + script.slice(at, end + 1);

    return end + 1;
  };

  const doubleQuoted = (from: number): number => {
    let at = from;
    word ??= "";

    while (at < script.length && script[at] !== '"') {
      const char = script[at] ?? "";
      const next = script[at + 1] ?? "";

      if (char === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
        word += next;
        at += 2;
      } else if (char === "\\" && next === "\n") {
        at += 2;
      } else if ((char === "$" && next === "(") || char === "`") {
        at = substitution(at);
      } else {
        word += char;
        at += 1;
      }
    }

    return at + 1;
  };

  while (index < script.length) {
    const char = script[index] ?? "";
    const next = script[index + 1] ?? "";

    if (closer !== null && char === closer && depth === 0) {
      endWord();

      return { tokens, end: index };
    }

    if (char === "\\") {
      if (next !== "\n") {
        word = (word ?? "") + next;
      }

      index += 2;
    } else if (char === "'") {
      const end = closing(script, index + 1, "'");
      word = (word ?? "") + script.slice(index + 1, end);
      index = end + 1;
    } else if (char === "$" && next === "'") {
      const [text, end] = ansiQuoted(script, index + 2);
      word = (word ?? "") + text;
      index = end + 1;
    } else if (char === '"') {
      index = doubleQuoted(index + 1);
    } else if (
      char === "`" ||
      (char === "$" && next === "(") ||
      ((char === "<" || char === ">") && next === "(")
    ) {
      index = substitution(index);
    } else if (char === "#" && word === null) {
      index = lineEnd(script, index);
    } else if (char === "\n") {
      separate(SEPARATOR);
      index = skipHeredocs(script, index + 1, heredocs.splice(0));
    } else if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
    } else if (char === "<" || char === ">" || (char === "&" && next === ">")) {
      if (word !== null && /^\d+$/u.test(word)) {
        word = null;
      }

      endWord();
      const operator = redirection(script, index, heredocs);
      index = operator.end;
      dropNextWord = operator.dropsWord;
    } else if (char === "(") {
      separate(OPEN);
      depth += 1;
      index += 1;
    } else if (char === ")") {
      separate(CLOSE);
      depth = Math.max(0, depth - 1);
      index += 1;
    } else if (char === ";" || char === "|" || char === "&") {
      separate(SEPARATOR);
      index += 1;
    } else {
      word = (word ?? "") + char;
      index += 1;
    }
  }

  endWord();

  return { tokens, end: script.length };
}

function backtickEnd(script: string, start: number): number {
  let index = start;

  while (index < script.length && script[index] !== "`") {
    index += script[index] === "\\" ? 2 : 1;
  }

  return Math.min(index, script.length);
}

function closing(script: string, start: number, quote: string): number {
  const end = script.indexOf(quote, start);

  return end === -1 ? script.length : end;
}

function ansiQuoted(script: string, start: number): [string, number] {
  let text = "";
  let index = start;

  while (index < script.length && script[index] !== "'") {
    if (script[index] === "\\") {
      index += 1;
    }

    text += script[index] ?? "";
    index += 1;
  }

  return [text, index];
}

function lineEnd(script: string, start: number): number {
  const end = script.indexOf("\n", start);

  return end === -1 ? script.length : end;
}

/**
 * Consumes one redirection operator from `start`. A heredoc's delimiter is read here and its body skipped at the next
 * newline; every other redirection names a word, which the caller drops.
 */
function redirection(script: string, start: number, heredocs: Heredoc[]): Redirection {
  let index = start;

  if (script.startsWith("<<<", index)) {
    return { end: index + 3, dropsWord: true };
  }

  if (script.startsWith("<<", index)) {
    index += 2;
    const stripTabs = script[index] === "-";
    index += stripTabs ? 1 : 0;

    while (script[index] === " " || script[index] === "\t") {
      index += 1;
    }

    let delimiter = "";

    while (index < script.length && !/[\s;&|<>()]/u.test(script[index] ?? "")) {
      const char = script[index] ?? "";

      if (char !== "'" && char !== '"' && char !== "\\") {
        delimiter += char;
      }

      index += 1;
    }

    heredocs.push({ delimiter, stripTabs });

    return { end: index, dropsWord: false };
  }

  index += 1;

  while (index < script.length && /[<>&|]/u.test(script[index] ?? "")) {
    index += 1;
  }

  return { end: index, dropsWord: true };
}

function skipHeredocs(script: string, start: number, heredocs: readonly Heredoc[]): number {
  let index = start;

  for (const heredoc of heredocs) {
    while (index < script.length) {
      const end = lineEnd(script, index);
      const line = script.slice(index, end);
      index = end + 1;

      if ((heredoc.stripTabs ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter) {
        break;
      }
    }
  }

  return index;
}

function optionOf(
  option: string,
  next: string | undefined,
  values: ReadonlySet<string>,
): OptionRead {
  const equals = option.indexOf("=");

  if (option.startsWith("--") && equals !== -1) {
    return { name: option.slice(0, equals), value: option.slice(equals + 1), width: 1 };
  }

  if (values.has(option)) {
    return { name: option, value: next, width: 2 };
  }

  const short = option.slice(0, 2);

  return !option.startsWith("--") && option.length > 2 && values.has(short)
    ? { name: short, value: option.slice(2), width: 1 }
    : { name: option, value: undefined, width: 1 };
}

/**
 * The command a simple command runs once its assignments, reserved words and wrappers (`env`, `sudo`, `xargs`,
 * `nice`, `timeout`, `time`, …) are dropped, and the directory it runs in: `env -C` and `sudo -D` move it.
 */
export function unwrap(line: readonly string[], cwd: string): Unwrapped {
  let words = [...line];
  let dir = cwd;
  let index = 0;

  for (;;) {
    const word = words[index];
    const wrapper = word === undefined ? undefined : WRAPPERS.get(word);

    if (word === undefined) {
      return { argv: [], cwd: dir };
    }

    if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) {
      index += 1;
      continue;
    }

    if (wrapper === undefined) {
      return { argv: words.slice(index), cwd: dir };
    }

    index += 1;
    let split = false;

    while (!split && words[index]?.startsWith("-") === true && words[index] !== "-") {
      const option = words[index] ?? "";

      if (option === "--") {
        index += 1;
        break;
      }

      if (wrapper.runsNothing?.has(option) === true) {
        return { argv: [], cwd: dir };
      }

      const { name, value, width } = optionOf(
        option,
        words[index + 1],
        wrapper.values ?? new Set(),
      );

      if (value !== undefined && wrapper.chdir?.has(name) === true) {
        dir = path.resolve(dir, value);
      }

      if (value !== undefined && wrapper.split?.has(name) === true) {
        words = [...value.split(/\s+/u).filter(Boolean), ...words.slice(index + width)];
        index = 0;
        split = true;
      } else {
        index += width;
      }
    }

    index += split ? 0 : (wrapper.operands ?? 0);
  }
}

/**
 * Every simple command `script` runs, each with the directory it runs in: a `cd` moves the commands after it, a
 * subshell's `cd` stays inside it, and `bash -c` or `eval` scripts are read in turn. A `cd` to a target this reading
 * cannot resolve (`$VAR`, `~user`, `-`) leaves the directory where it was.
 */
export function invocationsOf(script: string, cwd: string): Invocation[] {
  const invocations: Invocation[] = [];
  const stack: string[] = [];
  let dir = cwd;
  let words: string[] = [];

  const flush = (): void => {
    const { argv, cwd: commandDir } = unwrap(words, dir);
    words = [];
    const [program, ...args] = argv;

    if (program === undefined) {
      return;
    }

    const name = path.basename(program);
    const inner = SHELLS.has(name) ? shellScript(args) : null;

    if (name === "cd" || name === "pushd") {
      dir = changeDir(commandDir, args);
    } else if (inner !== null) {
      invocations.push(...invocationsOf(inner, commandDir));
    } else if (name === "eval") {
      invocations.push(...invocationsOf(args.join(" "), commandDir));
    } else {
      invocations.push({ cwd: commandDir, argv });
    }
  };

  for (const token of scan(script, 0, null).tokens) {
    switch (token.kind) {
      case "word": {
        words.push(token.text);
        break;
      }

      case "separator": {
        flush();
        break;
      }

      case "open": {
        flush();
        stack.push(dir);
        break;
      }

      case "close": {
        flush();
        dir = stack.pop() ?? dir;
        break;
      }

      default: {
        const unreachable: never = token;
        throw new Error(`unhandled token: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  flush();

  return invocations;
}

function changeDir(dir: string, args: readonly string[]): string {
  const target = args.find((arg) => !arg.startsWith("-") || arg === "-");
  const home = process.env["HOME"] ?? homedir();

  if (target === undefined) {
    return home;
  }

  if (target === "-" || /[$`]/u.test(target) || /^~[^/]/u.test(target)) {
    return dir;
  }

  return path.resolve(dir, target.startsWith("~") ? path.join(home, target.slice(1)) : target);
}

function shellScript(args: readonly string[]): string | null {
  const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(arg));

  return flag === -1 ? null : (args[flag + 1] ?? null);
}
