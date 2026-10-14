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

/** The program a word names, its directory and a Windows `.exe` dropped. */
function basename(word: string): string {
  const name = word.slice(word.lastIndexOf("/") + 1);

  return name.toLowerCase().endsWith(".exe") ? name.slice(0, -".exe".length) : name;
}

/** The first word after the program that is no option, the valued options' values skipped. */
function subcommand(args: readonly string[], valued: ReadonlySet<string>): string | undefined {
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at] ?? "";

    if (!word.startsWith("-")) return word;

    if (valued.has(word)) at += 1;
  }

  return undefined;
}

/** Why one simple command may not carry a value, or nothing. */
function programRefusal(words: readonly Word[]): string | undefined {
  const [program, ...rest] = words.map((word) => word.text);
  const name = basename(program ?? "");

  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(program ?? ""))
    return "a variable assignment in front of the command";

  if (WRAPPERS.has(name)) return `\`${name}\`, which runs its arguments as another command`;

  const gitSubcommand = name === "git" ? subcommand(rest, GIT_VALUED_OPTIONS) : undefined;

  if (gitSubcommand === "push") return GIT_PUSH_REFUSED;

  if (gitSubcommand !== undefined && !GIT_LOCAL.has(gitSubcommand))
    return `\`git ${gitSubcommand}\` may write the value into history or send it out, where it cannot be taken back (an alias counts as unknown): to mention the secret, write its name`;

  if (name === "gh" && subcommand(rest, GH_VALUED_OPTIONS) !== GH_SINK)
    return "a gh command that sends text to GitHub (gh secret alone takes the value)";

  return undefined;
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
