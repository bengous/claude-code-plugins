import { homedir } from "node:os";
import path from "node:path";

/** A stretch of the line, from `start` included to `end` excluded. */
export type Span = { readonly start: number; readonly end: number };

/** A word of a command: its text with the quotes removed, where it stands in the line, and what Bash does to it. */
export type Word = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** The quoted parts of its source, single, double or ANSI-C: text Bash hands over as data. */
  readonly quoted: readonly Span[];
  /** Bash expands part of it when the command runs: `$NAME`, `${…}`, `$(…)`, backticks. */
  readonly expands: boolean;
};

/** A heredoc body; with an unquoted delimiter, Bash expands `$…`, `$(…)` and backticks in it. */
export type Heredoc = Span & { readonly expands: boolean };

/** How a command is joined to the one before it in its list: `&&`, `||`, a pipe, or nothing (the list starts). */
export type Join = "&&" | "||" | "|" | null;

/** A simple command as written: its words, the heredoc bodies it reads, how it is wired. */
export type Command = {
  readonly words: readonly Word[];
  readonly heredocs: readonly Heredoc[];
  /** Joined to the command before it by a pipe: it reads that command's output. */
  readonly piped: boolean;
  readonly join: Join;
  /** The list it belongs to: commands up to a `;`, a newline, a `&` or a parenthesis share one. */
  readonly list: number;
  /** Inside `$(…)`, backticks or `<(…)`. */
  readonly substitution: boolean;
};

export type Item =
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "open" }
  | { readonly kind: "close" };

/**
 * A Bash line, read without running it: its simple commands in the order Bash runs them, a substitution before the
 * command it belongs to, and each subshell or substitution between an `open` and a `close`.
 */
export type Line = {
  readonly items: readonly Item[];
  /** Comments and redirection targets: text Bash never runs. */
  readonly inert: readonly Span[];
  readonly definesFunction: boolean;
};

/** The command a simple command runs once its assignments, reserved words and known wrappers are peeled. */
export type Unwrapped = {
  readonly argv: readonly Word[];
  readonly assignments: readonly Word[];
  readonly wrappers: readonly string[];
  readonly cwd: string;
  /** A wrapper that hides the command's words until it runs: `xargs` appends its input, `env -S` splits a string. */
  readonly opaque: string | null;
  readonly runsNothing: boolean;
};

const ASSIGNMENT = /^[A-Za-z_]\w*=/u;

const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);

const EXPANSION = /^\$[\w{@*#?$!-]/u;

/** A program that runs the command after its own options: what those options take, and which ones move or hide it. */
type Wrapper = {
  /** Options that take a value, as the next word or attached (`-uNAME`, `--unset=NAME`). */
  readonly values?: ReadonlySet<string>;
  readonly chdir?: ReadonlySet<string>;
  /** Options that hide the command until it runs (`env -S` splits a string into it). */
  readonly hides?: ReadonlySet<string>;
  /** Options with which the wrapper runs nothing (`command -v`). */
  readonly runsNothing?: ReadonlySet<string>;
  /** Words after the options before the command (`timeout`'s duration). */
  readonly operands?: number;
  /** Options that may follow the operands and hide the command (`flock <file> -c '…'`). */
  readonly trailing?: ReadonlySet<string>;
  /** The wrapper appends words it reads at run time (`xargs`). */
  readonly appends?: boolean;
  /** Its options run until a `--`, which starts the command (`mise exec node@24 -- git push`). */
  readonly untilSeparator?: boolean;
  /** Options one of which must be present for the command to run where the line runs (`systemd-run --scope`). */
  readonly staysHere?: ReadonlySet<string>;
};

const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
  ["command", { runsNothing: new Set(["-v", "-V"]) }],
  ["exec", { values: new Set(["-a"]) }],
  ["nohup", {}],
  ["builtin", {}],
  ["time", { values: new Set(["-f", "--format", "-o", "--output"]) }],
  [
    "flock",
    {
      values: new Set(["-w", "--timeout", "-E", "--conflict-exit-code"]),
      hides: new Set(["-c", "--command"]),
      trailing: new Set(["-c", "--command"]),
      operands: 1,
    },
  ],
  [
    "systemd-run",
    {
      values: new Set([
        "-p",
        "--property",
        "-u",
        "--unit",
        "--slice",
        "-E",
        "--setenv",
        "--working-directory",
        "-M",
        "--machine",
        "--description",
        "--uid",
        "--gid",
        "--nice",
      ]),
      chdir: new Set(["--working-directory"]),
      staysHere: new Set(["--scope", "--same-dir", "-d", "--working-directory"]),
    },
  ],
  ["mise", { untilSeparator: true }],
  [
    "env",
    {
      values: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
      chdir: new Set(["-C", "--chdir"]),
      hides: new Set(["-S", "--split-string"]),
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
      appends: true,
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

type Builder = {
  words: Word[];
  heredocs: Heredoc[];
  piped: boolean;
  join: Join;
  list: number;
  substitution: boolean;
};

/** What ends a command: a pipe, `&&`, `||`, or the end of its list. */
type Link = "pipe" | "and" | "or" | "list";

const JOIN_OF: Readonly<Record<Link, Join>> = { pipe: "|", and: "&&", or: "||", list: null };

type Redirection = { readonly end: number; readonly dropsWord: boolean };

type PendingHeredoc = {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  /** A quote or a backslash in the delimiter keeps Bash from expanding the body. */
  readonly quoted: boolean;
  readonly owner: Builder;
};

type WordState = { text: string; start: number; quoted: Span[]; expands: boolean };

type Scan = { readonly items: Item[]; readonly end: number };

type Scanner = {
  readonly script: string;
  readonly inert: Span[];
  definesFunction: boolean;
  lists: number;
};

type OptionRead = {
  readonly name: string;
  readonly value: string | undefined;
  readonly width: number;
};

function builder(substitution: boolean, list: number): Builder {
  return { words: [], heredocs: [], piped: false, join: null, list, substitution };
}

/**
 * Scans from `start`; with `closer`, the scan ends at the character that closes the substitution it reads (the
 * matching `)`, or the next unescaped backtick).
 */
function scan(scanner: Scanner, start: number, closer: ")" | "`" | null): Scan {
  const { script } = scanner;
  const items: Item[] = [];
  const heredocs: PendingHeredoc[] = [];
  scanner.lists += 1;
  let current = builder(closer !== null, scanner.lists);
  let word: WordState | null = null;
  let dropNextWord = false;
  let commandStart = 0;
  let depth = 0;
  let index = start;

  // The closures below assign `word`: read it through this function, where TypeScript does not narrow it.
  const pendingWord = (): WordState | null => word;

  const wordAt = (at: number): WordState => {
    word ??= { text: "", start: at, quoted: [], expands: false };

    return word;
  };

  const endWord = (at: number): void => {
    if (word !== null) {
      if (dropNextWord) {
        scanner.inert.push({ start: word.start, end: at });
        dropNextWord = false;
      } else {
        const text = withHome(script, word);
        current.words.push({ ...word, text, end: at });
      }
    }

    word = null;
  };

  const flush = (at: number, link: Link): void => {
    endWord(at);

    if (current.words.length > 0 || current.heredocs.length > 0) {
      if (current.words[0]?.text === "function") {
        scanner.definesFunction = true;
      }

      items.push({ kind: "command", command: current });
    }

    if (link === "list") {
      scanner.lists += 1;
    }

    const list = link === "list" ? scanner.lists : current.list;
    current = builder(closer !== null, list);
    current.piped = link === "pipe";
    current.join = JOIN_OF[link];
    commandStart = items.length;
  };

  /** Reads the substitution at `at` into a group before the current command; returns the index after it. */
  const substitution = (at: number, opener: number): number => {
    const isBacktick = script[at] === "`";
    const nested = scan(scanner, at + opener, isBacktick ? "`" : ")");
    items.splice(commandStart, 0, { kind: "open" }, ...nested.items, { kind: "close" });
    commandStart += nested.items.length + 2;
    const state = wordAt(at);
    state.text += script.slice(at, nested.end + 1);
    state.expands ||= script[at] !== "<" && script[at] !== ">";

    return nested.end + 1;
  };

  const doubleQuoted = (from: number): number => {
    const state = wordAt(from);
    let at = from + 1;

    while (at < script.length && script[at] !== '"') {
      const char = script[at] ?? "";
      const next = script[at + 1] ?? "";

      if (char === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
        state.text += next;
        at += 2;
      } else if (char === "\\" && next === "\n") {
        at += 2;
      } else if (char === "$" && next === "(") {
        at = substitution(at, 2);
      } else if (char === "`") {
        at = substitution(at, 1);
      } else {
        state.expands ||= EXPANSION.test(script.slice(at, at + 2));
        state.text += char;
        at += 1;
      }
    }

    state.quoted.push({ start: from, end: at + 1 });

    return at + 1;
  };

  while (index < script.length) {
    const char = script[index] ?? "";
    const next = script[index + 1] ?? "";

    if (closer === "`" && char === "`") {
      flush(index, "list");

      return { items, end: index };
    }

    if (closer === ")" && char === ")" && depth === 0) {
      flush(index, "list");

      return { items, end: index };
    }

    if (char === "\\") {
      if (next !== "\n") {
        wordAt(index).text += next;
      }

      index += 2;
    } else if (char === "'") {
      const end = closing(script, index + 1, "'");
      const state = wordAt(index);
      state.text += script.slice(index + 1, end);
      state.quoted.push({ start: index, end: end + 1 });
      index = end + 1;
    } else if (char === "$" && next === "'") {
      const [text, end] = ansiQuoted(script, index + 2);
      const state = wordAt(index);
      state.text += text;
      state.quoted.push({ start: index, end: end + 1 });
      index = end + 1;
    } else if (char === '"') {
      index = doubleQuoted(index);
    } else if (char === "$" && next === "(") {
      index = substitution(index, 2);
    } else if (char === "`") {
      index = substitution(index, 1);
    } else if ((char === "<" || char === ">") && next === "(") {
      index = substitution(index, 2);
    } else if (char === "#" && pendingWord() === null) {
      const end = lineEnd(script, index);
      scanner.inert.push({ start: index, end });
      index = end;
    } else if (char === "\n") {
      flush(index, "list");
      index = skipHeredocs(script, index + 1, heredocs.splice(0));
    } else if (char === " " || char === "\t" || char === "\r") {
      endWord(index);
      index += 1;
    } else if (char === "<" || char === ">" || (char === "&" && next === ">")) {
      const fd = pendingWord();

      if (fd !== null && /^\d+$/u.test(fd.text)) {
        word = null;
      }

      endWord(index);
      const operator = redirection(script, index, heredocs, current);
      index = operator.end;
      dropNextWord = operator.dropsWord;
    } else if (char === "(") {
      const named = current.words.length + (pendingWord() === null ? 0 : 1) === 1;

      if (named && /^\s*\)/u.test(script.slice(index + 1))) {
        scanner.definesFunction = true;
      }

      flush(index, "list");
      items.push({ kind: "open" });
      commandStart = items.length;
      depth += 1;
      index += 1;
    } else if (char === ")") {
      flush(index, "list");
      items.push({ kind: "close" });
      commandStart = items.length;
      depth = Math.max(0, depth - 1);
      index += 1;
    } else if (char === "|" && next !== "|") {
      flush(index, "pipe");
      index += next === "&" ? 2 : 1;
    } else if (char === ";" || char === "|" || char === "&") {
      const doubled = (char === "|" || char === "&") && next === char;
      flush(index, doubled ? (char === "&" ? "and" : "or") : "list");
      index += doubled ? 2 : 1;
    } else {
      const state = wordAt(index);
      state.expands ||= EXPANSION.test(script.slice(index, index + 2));
      state.text += char;
      index += 1;
    }
  }

  flush(script.length, "list");

  return { items, end: script.length };
}

/** An unquoted leading `~` or `~/` is the home directory, as Bash expands it; `~user` is left to `expands`. */
function withHome(script: string, word: WordState): string {
  if (script[word.start] !== "~" || !/^~(?:\/|$)/u.test(word.text)) {
    if (script[word.start] === "~") {
      word.expands = true;
    }

    return word.text;
  }

  return (process.env["HOME"] ?? homedir()) + word.text.slice(1);
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
 * Consumes one redirection operator from `start`. A heredoc's delimiter is read here and its body, skipped at the
 * next newline, is recorded on `owner`; every other redirection names a word, which the caller drops.
 */
function redirection(
  script: string,
  start: number,
  heredocs: PendingHeredoc[],
  owner: Builder,
): Redirection {
  let index = start;

  if (script.startsWith("<<<", index)) {
    return { end: index + 3, dropsWord: false };
  }

  if (script.startsWith("<<", index)) {
    index += 2;
    const stripTabs = script[index] === "-";
    index += stripTabs ? 1 : 0;

    while (script[index] === " " || script[index] === "\t") {
      index += 1;
    }

    let delimiter = "";
    let quoted = false;

    while (index < script.length && !/[\s;&|<>()]/u.test(script[index] ?? "")) {
      const char = script[index] ?? "";

      if (char === "'" || char === '"' || char === "\\") {
        quoted = true;
      } else {
        delimiter += char;
      }

      index += 1;
    }

    heredocs.push({ delimiter, stripTabs, quoted, owner });

    return { end: index, dropsWord: false };
  }

  index += 1;

  while (index < script.length && /[<>&|]/u.test(script[index] ?? "")) {
    index += 1;
  }

  return { end: index, dropsWord: true };
}

function skipHeredocs(script: string, start: number, heredocs: readonly PendingHeredoc[]): number {
  let index = start;

  for (const heredoc of heredocs) {
    const bodyStart = index;
    let bodyEnd = script.length;

    while (index < script.length) {
      const end = lineEnd(script, index);
      const line = script.slice(index, end);

      if ((heredoc.stripTabs ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter) {
        bodyEnd = index;
        index = end + 1;
        break;
      }

      index = end + 1;
    }

    heredoc.owner.heredocs.push({
      start: bodyStart,
      end: Math.min(bodyEnd, script.length),
      expands: !heredoc.quoted,
    });
  }

  return index;
}

/** Reads `script` as Bash splits it, without running anything: no expansion, no file read. */
export function parseLine(script: string): Line {
  const scanner: Scanner = { script, inert: [], definesFunction: false, lists: 0 };
  const { items } = scan(scanner, 0, null);

  return { items, inert: scanner.inert, definesFunction: scanner.definesFunction };
}

/** The commands of a line, in the order Bash runs them. */
export function commandsOf(line: Line): Command[] {
  return line.items.flatMap((item) => (item.kind === "command" ? [item.command] : []));
}

function separatorAfter(words: readonly Word[], from: number): number {
  return words.findIndex((candidate, at) => at >= from && candidate.text === "--");
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
 * The command a simple command runs once its assignments, reserved words and wrappers (`env`, `sudo`, `nice`,
 * `timeout`, `time`, `nohup`, `command`, `exec`, `xargs`) are peeled, and the directory it runs in: `env -C` and
 * `sudo -D` move it.
 */
export function unwrap(words: readonly Word[], cwd: string): Unwrapped {
  const assignments: Word[] = [];
  const wrappers: string[] = [];
  let dir = cwd;
  let opaque: string | null = null;
  let index = 0;

  for (;;) {
    const word = words[index];

    if (word === undefined) {
      return { argv: [], assignments, wrappers, cwd: dir, opaque, runsNothing: false };
    }

    const program = path.basename(word.text);
    const subcommand = words[index + 1]?.text ?? "";

    // mise wraps a command only as `mise exec … --` or `mise x … --`; its other subcommands are its own.
    const wrapper =
      program === "mise" && !["exec", "x"].includes(subcommand) ? undefined : WRAPPERS.get(program);

    if (ASSIGNMENT.test(word.text)) {
      assignments.push(word);
      index += 1;
      continue;
    }

    if (KEYWORDS.has(word.text)) {
      index += 1;
      continue;
    }

    if (wrapper === undefined) {
      return {
        argv: words.slice(index),
        assignments,
        wrappers,
        cwd: dir,
        opaque,
        runsNothing: false,
      };
    }

    wrappers.push(program);
    opaque = wrapper.appends === true ? word.text : opaque;
    index += 1;

    if (wrapper.untilSeparator === true) {
      const separator = separatorAfter(words, index);

      if (separator === -1) {
        return { argv: [], assignments, wrappers, cwd: dir, opaque, runsNothing: true };
      }

      index = separator + 1;
      continue;
    }

    let stays = wrapper.staysHere === undefined;

    while (words[index]?.text.startsWith("-") === true && words[index]?.text !== "-") {
      const option = words[index]?.text ?? "";

      if (option === "--") {
        index += 1;
        break;
      }

      if (wrapper.runsNothing?.has(option) === true) {
        return { argv: [], assignments, wrappers, cwd: dir, opaque, runsNothing: true };
      }

      const { name, value, width } = optionOf(
        option,
        words[index + 1]?.text,
        wrapper.values ?? new Set(),
      );

      if (value !== undefined && wrapper.chdir?.has(name) === true) {
        dir = path.resolve(dir, value);
      }

      if (wrapper.hides?.has(name) === true) {
        opaque = `${word.text} ${name}`;
      }

      stays ||= wrapper.staysHere?.has(name) === true;
      index += width;
    }

    if (!stays) {
      opaque = `${word.text} without ${[...(wrapper.staysHere ?? [])].join(" or ")}`;
    }

    index += wrapper.operands ?? 0;

    if (wrapper.trailing?.has(words[index]?.text ?? "") === true) {
      opaque = `${word.text} ${words[index]?.text ?? ""}`;
    }
  }
}
