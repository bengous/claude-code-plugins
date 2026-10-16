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

const WRAPPERS = new Set(["command", "exec", "nohup", "builtin", "time"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

const TIMEOUT_VALUE_FLAGS = new Set(["-s", "-k", "--signal", "--kill-after"]);

type Heredoc = { readonly delimiter: string; readonly stripTabs: boolean };

type Redirection = { readonly end: number; readonly dropsWord: boolean };

/**
 * Reads a shell line as Bash would split it into simple commands: quotes, escapes, line continuations, comments,
 * heredoc bodies and redirections are consumed, `&&`, `||`, `;`, `|`, `&` and newlines separate commands, and a
 * subshell or an unquoted `$(…)` opens a group. No expansion runs: `$VAR`, `~user` and `$(…)` inside quotes stay text.
 */
function tokenize(script: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: Heredoc[] = [];
  let word: string | null = null;
  let dropNextWord = false;
  let inBackticks = false;
  let index = 0;

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

  while (index < script.length) {
    const char = script[index] ?? "";
    const next = script[index + 1] ?? "";

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
      const [text, end] = doubleQuoted(script, index + 1);
      word = (word ?? "") + text;
      index = end + 1;
    } else if (char === "#" && word === null) {
      index = lineEnd(script, index);
    } else if (char === "\n") {
      endWord();
      tokens.push(SEPARATOR);
      index = skipHeredocs(script, index + 1, heredocs.splice(0));
    } else if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
    } else if ((char === "<" || char === ">") && next === "(") {
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
    } else if (char === "`") {
      endWord();
      tokens.push(inBackticks ? CLOSE : OPEN);
      inBackticks = !inBackticks;
      index += 1;
    } else if (char === "(" || char === ")") {
      endWord();
      tokens.push(char === "(" ? OPEN : CLOSE);
      index += 1;
    } else if (char === ";" || char === "|" || char === "&") {
      endWord();
      tokens.push(SEPARATOR);
      index += 1;
    } else {
      word = (word ?? "") + char;
      index += 1;
    }
  }

  endWord();

  return tokens;
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

function doubleQuoted(script: string, start: number): [string, number] {
  let text = "";
  let index = start;

  while (index < script.length && script[index] !== '"') {
    const char = script[index] ?? "";
    const next = script[index + 1] ?? "";

    if (char === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
      text += next;
      index += 2;
    } else if (char === "\\" && next === "\n") {
      index += 2;
    } else {
      text += char;
      index += 1;
    }
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

/** The words of a simple command once its assignments, reserved words and wrappers such as `env` are dropped. */
export function commandWords(words: readonly string[]): string[] {
  let index = 0;

  for (;;) {
    const word = words[index];

    if (word === undefined) {
      return [];
    }

    if (ASSIGNMENT.test(word) || KEYWORDS.has(word) || WRAPPERS.has(word)) {
      index += 1;
    } else if (word === "env") {
      index += 1;

      while (words[index]?.startsWith("-") === true || ASSIGNMENT.test(words[index] ?? "")) {
        index += words[index] === "-u" ? 2 : 1;
      }
    } else if (word === "timeout") {
      index += 1;

      while (words[index]?.startsWith("-") === true) {
        index += TIMEOUT_VALUE_FLAGS.has(words[index] ?? "") ? 2 : 1;
      }

      index += 1;
    } else {
      return words.slice(index);
    }
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
    const argv = commandWords(words);
    words = [];
    const [program, ...args] = argv;

    if (program === undefined) {
      return;
    }

    const name = path.basename(program);
    const inner = SHELLS.has(name) ? shellScript(args) : null;

    if (name === "cd" || name === "pushd") {
      dir = changeDir(dir, args);
    } else if (inner !== null) {
      invocations.push(...invocationsOf(inner, dir));
    } else if (name === "eval") {
      invocations.push(...invocationsOf(args.join(" "), dir));
    } else {
      invocations.push({ cwd: dir, argv });
    }
  };

  for (const token of tokenize(script)) {
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
