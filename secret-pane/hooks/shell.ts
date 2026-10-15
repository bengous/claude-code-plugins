/**
 * The one shape of Bash command a placeholder may be restored in, and the
 * command with each placeholder replaced by its value, shell-quoted. Anything
 * the lexer below does not read as plain words joined by at most one pipe is
 * refused: an allow-list, since no list of what to refuse covers a shell.
 */

const TAG_WORD = /^'(\[secret-pane:[A-Za-z_][A-Za-z0-9_]*:[0-9a-f]{8}\])'$/u;

const TAG_ANYWHERE = /\[secret-pane:[A-Za-z_][A-Za-z0-9_]*:[0-9a-f]{8}\]/u;

/** Outside quotes, any of these makes the command something other than words and one pipe. */
const OPERATORS_REFUSED = new Set([";", "&", "(", ")", "<", "`", "$", "\n", "\\", "{", "}"]);

/** Programs that run their arguments as another command: a placeholder handed to one is code. */
const WRAPPERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "env",
  "xargs",
  "eval",
  "exec",
  "sudo",
  "doas",
  "nohup",
  "time",
  "timeout",
  "nice",
  "watch",
  "command",
  "builtin",
  "ssh",
  "parallel",
  "find",
]);

/**
 * The git subcommands that can neither write a message into history nor send text out. Any other,
 * an alias included, may put a value where it cannot be taken back.
 */
const GIT_LOCAL = new Set([
  "status",
  "diff",
  "log",
  "show",
  "fetch",
  "pull",
  "clone",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "blame",
  "grep",
  "describe",
  "shortlog",
  "reflog",
  "cat-file",
  "show-ref",
  "for-each-ref",
  "branch",
  "checkout",
  "switch",
  "restore",
  "reset",
  "add",
  "rm",
  "mv",
  "clean",
  "init",
  "remote",
  "config",
  "worktree",
  "credential",
  "bisect",
  "help",
  "version",
]);

const GIT_PUSH_REFUSED = [
  "`git push` sends commits out, so a command naming a placeholder may not run it:",
  "hand the token to a credential helper that stores it, with printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n' '<placeholder>' | git credential approve",
  "(gh's own helper keeps nothing and pushes with gh's login: gh auth status), then push in a command that names no placeholder",
].join(" ");

/** git's global options that take the next word as their value. */
const GIT_VALUED_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

/** gh's global options that take the next word as their value. */
const GH_VALUED_OPTIONS = new Set(["-R", "--repo"]);

/** The one gh subcommand that takes a value in order to keep it secret. */
const GH_SINK = "secret";

type Word = { readonly raw: string; readonly text: string };

type Lexed =
  | { readonly kind: "words"; readonly commands: readonly (readonly Word[])[] }
  | { readonly kind: "refused"; readonly why: string };

/**
 * Words and pipes, quotes kept in `raw` and removed in `text`. A single-quoted
 * span is literal; a double-quoted one may hold neither `$`, a backtick nor a
 * backslash. Redirections `>` and `>>` stay words: they run nothing.
 */
function lex(command: string): Lexed {
  const commands: Word[][] = [[]];
  let raw = "";
  let text = "";
  let at = 0;

  const flush = () => {
    if (raw !== "") commands.at(-1)?.push({ raw, text });
    raw = "";
    text = "";
  };

  while (at < command.length) {
    const char = command[at] ?? "";

    if (char === "'") {
      const close = command.indexOf("'", at + 1);

      if (close < 0) return { kind: "refused", why: "an unclosed single quote" };
      raw += command.slice(at, close + 1);
      text += command.slice(at + 1, close);
      at = close + 1;
      continue;
    }

    if (char === '"') {
      const close = command.indexOf('"', at + 1);

      if (close < 0) return { kind: "refused", why: "an unclosed double quote" };
      const inner = command.slice(at + 1, close);

      if (/[$`\\]/u.test(inner))
        return { kind: "refused", why: "a double-quoted span the shell expands" };
      raw += command.slice(at, close + 1);
      text += inner;
      at = close + 1;
      continue;
    }

    if (char === " " || char === "\t") {
      flush();
      at += 1;
      continue;
    }

    if (char === "|") {
      if (command[at + 1] === "|") return { kind: "refused", why: "a list (`||`)" };
      flush();

      if (commands.length >= 2) return { kind: "refused", why: "more than one pipe" };
      commands.push([]);
      at += 1;
      continue;
    }

    if (OPERATORS_REFUSED.has(char))
      return { kind: "refused", why: `\`${char === "\n" ? "a new line" : char}\` outside quotes` };
    raw += char;
    text += char;
    at += 1;
  }

  flush();

  if (commands.some((words) => words.length === 0))
    return { kind: "refused", why: "an empty command around a pipe" };

  return { kind: "words", commands };
}

/**
 * The program a word names, as Windows and macOS find it: its directory, by
 * either slash, and a `.exe` dropped, the case folded (`Git.EXE` runs git).
 */
function basename(word: string): string {
  const name = word
    .slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1)
    .toLowerCase();

  return name.endsWith(".exe") ? name.slice(0, -".exe".length) : name;
}

export type Program = "git" | "gh";

export type GlobalOption = { readonly name: string; readonly value: string | undefined };

export type Parsed = {
  readonly options: readonly GlobalOption[];
  readonly subcommand: string | undefined;
  /** The words after the subcommand. */
  readonly rest: readonly string[];
};

/** A git or gh invocation's global options, each value the next word or after `=`, then the first word that is none. */
export function parseInvocation(program: Program, args: readonly string[]): Parsed {
  const valued = program === "git" ? GIT_VALUED_OPTIONS : GH_VALUED_OPTIONS;
  const options: GlobalOption[] = [];

  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? "";
    const equals = word.indexOf("=");

    if (!word.startsWith("-")) return { options, subcommand: word, rest: args.slice(at + 1) };

    if (word.startsWith("--") && equals > 0) {
      options.push({ name: word.slice(0, equals), value: word.slice(equals + 1) });
    } else if (valued.has(word)) {
      options.push({ name: word, value: args[at + 1] });
      at += 1;
    } else {
      options.push({ name: word, value: undefined });
    }
  }

  return { options, subcommand: undefined, rest: [] };
}

/** Whether an invocation can neither write a message into history nor send text out: a local git subcommand, gh secret, or none. */
export function isLocal(program: Program, args: readonly string[]): boolean {
  const { subcommand } = parseInvocation(program, args);

  if (program === "gh") return subcommand === undefined || subcommand === GH_SINK;

  return subcommand === undefined || GIT_LOCAL.has(subcommand);
}

/** Why one simple command may not carry a value, or nothing. */
function programRefusal(words: readonly Word[]): string | undefined {
  const [program, ...rest] = words.map((word) => word.text);
  const name = basename(program ?? "");

  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(program ?? ""))
    return "a variable assignment in front of the command";

  if (WRAPPERS.has(name)) return `\`${name}\`, which runs its arguments as another command`;

  if (name === "git" && !isLocal("git", rest)) {
    const { subcommand } = parseInvocation("git", rest);

    return subcommand === "push"
      ? GIT_PUSH_REFUSED
      : `\`git ${subcommand}\` may write the value into history or send it out, where it cannot be taken back (an alias counts as unknown): to mention the secret, write its name`;
  }

  if (name === "gh" && !isLocal("gh", rest))
    return "a gh command that sends text to GitHub (gh secret alone takes the value)";

  return undefined;
}

/** Outside quotes, each of these ends a simple command. */
const COMMAND_ENDS = new Set([";", "&", "|", "(", ")", "`", "\n"]);

const REDIRECTION = /^(?:<<<|<<-?|<>|<&|>>|>\||>&|<|>)/u;

/**
 * Where a redirection starting at `at` ends, and whether a target word
 * follows it: none after a here-string, whose word a command reads, nor
 * after a duplicated descriptor (`2>&1`, `>&-`).
 */
type Redirection = { readonly end: number; readonly hasTarget: boolean };

function redirection(command: string, at: number): Redirection {
  const operator = REDIRECTION.exec(command.slice(at))?.[0] ?? ">";
  const end = at + operator.length;

  const descriptor = operator.endsWith("&")
    ? (/^[0-9]*-?/u.exec(command.slice(end))?.[0] ?? "")
    : "";

  if (operator === "<<<" || descriptor !== "")
    return { end: end + descriptor.length, hasTarget: false };

  return { end, hasTarget: command[end] !== "(" };
}

/** Inside double quotes, the characters a backslash escapes. */
const DOUBLE_QUOTED_ESCAPES = new Set(['"', "\\", "$", "`", "\n"]);

type Part =
  | { readonly kind: "word"; readonly text: string; readonly isQuoted: boolean }
  | { readonly kind: "end"; readonly char: string };

/**
 * The command cut into words and the operators that end a simple command, as
 * the shell would cut it before any expansion: quotes and escapes removed, a
 * comment and a redirection's target dropped. An unclosed quote runs to the end.
 */
function parts(command: string): readonly Part[] {
  const out: Part[] = [];
  let text = "";
  let isWord = false;
  let isQuoted = false;
  let isTargetNext = false;
  let at = 0;

  const flush = () => {
    if (isWord && isTargetNext) isTargetNext = false;
    else if (isWord) out.push({ kind: "word", text, isQuoted });
    text = "";
    isWord = false;
    isQuoted = false;
  };

  while (at < command.length) {
    const char = command[at] ?? "";

    if (char === "\\") {
      const next = command[at + 1] ?? "";

      // A backslash before a new line joins the two lines.
      if (next !== "\n") {
        text += next;
        isWord = true;
      }

      at += 2;
    } else if (char === "'") {
      const close = command.indexOf("'", at + 1);
      const end = close < 0 ? command.length : close;

      text += command.slice(at + 1, end);
      isWord = true;
      isQuoted = true;
      at = end + 1;
    } else if (char === '"') {
      at += 1;

      while (at < command.length && command[at] !== '"') {
        const inner = command[at] ?? "";
        const next = command[at + 1] ?? "";

        if (inner === "\\" && DOUBLE_QUOTED_ESCAPES.has(next)) {
          text += next === "\n" ? "" : next;
          at += 2;
        } else {
          text += inner;
          at += 1;
        }
      }

      isWord = true;
      isQuoted = true;
      at += 1;
    } else if (char === "#" && !isWord) {
      const newline = command.indexOf("\n", at);

      at = newline < 0 ? command.length : newline;
    } else if (char === " " || char === "\t" || char === "\r") {
      flush();
      at += 1;
    } else if (char === "<" || char === ">") {
      // A redirection stays in its command, wherever it stands (`git >/dev/null commit`): the number before it and its target are no words of it.
      if (isWord && !isQuoted && /^\d+$/u.test(text)) {
        text = "";
        isWord = false;
      } else {
        flush();
      }

      const { end, hasTarget } = redirection(command, at);

      isTargetNext = hasTarget;
      at = end;
    } else if (COMMAND_ENDS.has(char)) {
      flush();
      isTargetNext = false;
      out.push({ kind: "end", char });
      at += 1;
    } else {
      text += char;
      isWord = true;
      at += 1;
    }
  }

  flush();

  return out;
}

export type Invocation = {
  /** Found in the command an `ssh` hands its host: it runs on another machine. */
  readonly isRemote: boolean;
  /** The words before the program's in its simple command: assignments such as `GIT_DIR=...`, a wrapper. */
  readonly before: readonly string[];
  /** The words after the program's, to the end of its simple command. */
  readonly args: readonly string[];
  /** The targets of the `cd` commands before it that still decide where it runs, in order; none, the session's directory. */
  readonly cds: readonly string[];
};

/** The words that may open a simple command and leave the rest of it the command it is. */
const LEADING = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"]);

/**
 * Where a `cd` or `pushd` goes, as written: `~` with no argument, `-` for the
 * directory before, which `popd` goes back to too; nothing for any other command.
 */
function placeChange(texts: readonly string[]): string | undefined {
  const start = texts.findIndex((text) => !LEADING.has(text));
  const [program = "", ...rest] = start < 0 ? [] : texts.slice(start);

  if (program === "popd") return "-";

  if (program !== "cd" && program !== "pushd") return undefined;

  return rest.find((word) => word === "-" || !word.startsWith("-")) ?? "~";
}

function collect(
  command: string,
  program: Program,
  base: readonly string[],
  isRemote: boolean,
  found: Invocation[],
): void {
  const saved: string[][] = [];
  let cds = [...base];
  let words: Extract<Part, { kind: "word" }>[] = [];
  let isInBackticks = false;

  const end = () => {
    const texts = words.map((word) => word.text);
    const target = placeChange(texts);
    const runsElsewhere = basename(texts.find((text) => !LEADING.has(text)) ?? "") === "ssh";

    if (target !== undefined) cds.push(target);

    for (const [at, word] of words.entries()) {
      if (basename(word.text) === program) {
        found.push({
          isRemote,
          before: texts.slice(0, at),
          args: texts.slice(at + 1),
          cds: [...cds],
        });
      }

      if (word.isQuoted && /[\s;&|()<>`]/u.test(word.text))
        collect(word.text, program, cds, isRemote || runsElsewhere, found);
    }

    words = [];
  };

  for (const part of parts(command)) {
    if (part.kind === "word") {
      words.push(part);
      continue;
    }

    end();
    const opens = part.char === "(" || (part.char === "`" && !isInBackticks);
    const closes = part.char === ")" || (part.char === "`" && isInBackticks);

    if (part.char === "`") isInBackticks = !isInBackticks;

    if (opens) {
      saved.push(cds);
      cds = [...cds];
    }

    if (closes) cds = saved.pop() ?? cds;
  }

  end();
}

/** A heredoc whose delimiter is quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`): its body is text no shell expands. */
const LITERAL_HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\([^\s;&|<>()]+))[^\n]*\n/gu;

/** The programs that run the text they are handed as commands: a heredoc on their line is a script. */
const RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ssh", "eval", "source", "."]);

/**
 * The command with the body of each literal heredoc taken out, the commit
 * message of `git commit -m "$(cat <<'EOF' ... EOF)"` first among them: text
 * that never runs, which would read as commands. A body handed to a shell on
 * the heredoc's own line (`bash <<'EOF'`, `cat <<'EOF' | sh`) runs, and stays.
 */
function withoutLiteralBodies(command: string): string {
  let out = "";
  let at = 0;

  for (const match of command.matchAll(LITERAL_HEREDOC)) {
    const start = match.index;

    if (start < at) continue;
    const lineStart = command.lastIndexOf("\n", start) + 1;
    const lineEnd = start + match[0].length;
    const line = command.slice(lineStart, lineEnd);
    const isRun = line.split(/[\s;&|()`"']+/u).some((word) => RUNNERS.has(basename(word)));

    if (isRun) continue;
    const delimiter = match[2] ?? match[3] ?? match[4] ?? "";
    const stripsTabs = match[1] === "-";
    let close = lineEnd;
    let isClosed = false;

    while (close < command.length) {
      const next = command.indexOf("\n", close);
      const end = next < 0 ? command.length : next;
      const body = command.slice(close, end);

      close = next < 0 ? command.length : next + 1;

      if ((stripsTabs ? body.replace(/^\t+/u, "") : body) === delimiter) {
        isClosed = true;
        break;
      }
    }

    out += command.slice(at, lineEnd);
    at = isClosed ? close : command.length;
  }

  return out + command.slice(at);
}

/**
 * Each word of the command that names `program`, with the words after it to
 * the end of its simple command and the `cd` targets standing before it. A
 * coarse cut on blanks, quotes and operators, no expansion; a quoted span that
 * holds blanks or operators is read again as a command run from where it
 * stands, so `sh -c "git commit"` names git too, and a literal heredoc's body
 * is no command. A `cd` or `pushd` counts after a keyword or a brace too; a
 * subshell's or a substitution's stays in it.
 */
export function invocations(command: string, program: Program): readonly Invocation[] {
  const found: Invocation[] = [];

  collect(withoutLiteralBodies(command), program, [], false, found);

  return found;
}

/** A value as one single-quoted shell word, whatever it holds. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type Restoration =
  | { readonly kind: "untouched" }
  | { readonly kind: "restored"; readonly command: string; readonly handed: readonly string[] }
  | { readonly kind: "refused"; readonly why: string };

/**
 * The command with each placeholder put back, or why it may not be. A command
 * that names no placeholder is untouched. `valueOf` answers a kept value, or
 * nothing for a placeholder this session never minted.
 */
export function restoreCommand(
  command: string,
  valueOf: (tag: string) => string | undefined,
): Restoration {
  if (!TAG_ANYWHERE.test(command)) return { kind: "untouched" };
  const lexed = lex(command);

  if (lexed.kind === "refused") return { kind: "refused", why: lexed.why };
  const handed = new Set<string>();
  const out: string[] = [];

  for (const words of lexed.commands) {
    const restored: string[] = [];

    for (const word of words) {
      const tag = TAG_WORD.exec(word.raw)?.[1];

      if (tag === undefined) {
        if (TAG_ANYWHERE.test(word.raw))
          return { kind: "refused", why: "a placeholder that is not a whole single-quoted word" };
        restored.push(word.raw);
        continue;
      }

      const value = valueOf(tag);

      if (value === undefined)
        return { kind: "refused", why: `${tag} is no placeholder of this session` };
      handed.add(value);
      restored.push(shellQuote(value));
    }

    out.push(restored.join(" "));
  }

  // A value piped into a command reaches it too: every command of the pipe is held to the same rule.
  for (const words of lexed.commands) {
    const why = programRefusal(words);

    if (why !== undefined) return { kind: "refused", why };
  }

  return { kind: "restored", command: out.join(" | "), handed: [...handed] };
}
