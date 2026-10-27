import { describe, expect, test } from "bun:test";

import type { Word } from "./shell.ts";
import { commandsOf, parseLine, unwrap } from "./shell.ts";

const CWD = "/work/repo";

function argvs(script: string): string[][] {
  return commandsOf(parseLine(script)).map((command) => command.words.map((word) => word.text));
}

/** The words of the line's own commands, not those of its substitutions. */
function words(script: string): Word[] {
  return commandsOf(parseLine(script))
    .filter((command) => !command.substitution)
    .flatMap((command) => command.words);
}

/** The parts of an unwrapped command these cases read. */
type Peeled = { readonly argv: string[]; readonly cwd: string; readonly opaque: string | null };

function unwrapped(script: string): Peeled {
  const [command] = commandsOf(parseLine(script));
  const result = unwrap(command?.words ?? [], CWD);

  return { argv: result.argv.map((word) => word.text), cwd: result.cwd, opaque: result.opaque };
}

describe("parseLine splits a line into simple commands", () => {
  test("on &&, ||, ;, |, & and newlines", () => {
    expect(argvs("a 1 && b 2 || c; d | e & f\ng")).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c"],
      ["d"],
      ["e"],
      ["f"],
      ["g"],
    ]);
  });

  test("marks a command a pipe feeds", () => {
    expect(commandsOf(parseLine("a | b || c")).map((command) => command.piped)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("keeps a quoted word whole, its quotes removed, its quoted span recorded", () => {
    const script = `git commit -m "fix: git push origin main" -m 'x; y'`;
    const message = words(script)[3];

    expect(argvs(script)).toEqual([
      ["git", "commit", "-m", "fix: git push origin main", "-m", "x; y"],
    ]);
    expect(message?.quoted).toEqual([{ start: 14, end: 41 }]);
    expect(message?.expands).toBe(false);
  });

  test("reads escapes inside double quotes and outside quotes", () => {
    expect(argvs(String.raw`a "say \"hi\" \$HOME" b\ c`)).toEqual([["a", 'say "hi" $HOME', "b c"]]);
  });

  test("reads an ANSI-C quoted word", () => {
    expect(argvs(String.raw`a $'it\'s'`)).toEqual([["a", "it's"]]);
  });

  test("joins a line continuation", () => {
    expect(argvs("git push \\\n  origin main")).toEqual([["git", "push", "origin", "main"]]);
  });

  test("records a comment as inert", () => {
    const line = parseLine("git status # git push origin main\ngit log");

    expect(argvs("git status # git push origin main\ngit log")).toEqual([
      ["git", "status"],
      ["git", "log"],
    ]);
    expect(line.inert).toEqual([{ start: 11, end: 33 }]);
  });

  test("keeps a # inside a word", () => {
    expect(argvs("echo a#b")).toEqual([["echo", "a#b"]]);
  });

  test("records a heredoc body on the command that reads it", () => {
    const script = "git commit -F - <<'EOF'\ngit push origin main\nEOF\ngit log";
    const [commit] = commandsOf(parseLine(script));

    expect(argvs(script)).toEqual([
      ["git", "commit", "-F", "-"],
      ["git", "log"],
    ]);
    expect(commit?.heredocs).toEqual([{ start: 24, end: 45, expands: false }]);
  });

  test("marks the body of a heredoc whose delimiter is not quoted as expanding", () => {
    const [cat] = commandsOf(parseLine("cat <<EOF\n$(date)\nEOF"));

    expect(cat?.heredocs).toEqual([{ start: 10, end: 18, expands: true }]);
  });

  test("records how each command is joined, and the list it belongs to", () => {
    const commands = commandsOf(parseLine("a && b || c | d; e"));

    expect(commands.map((command) => command.join)).toEqual([null, "&&", "||", "|", null]);
    expect(new Set(commands.slice(0, 4).map((command) => command.list)).size).toBe(1);
    expect(commands[4]?.list).not.toBe(commands[0]?.list);
  });

  test("reads a <<- heredoc whose delimiter is indented with tabs", () => {
    expect(argvs("cat <<-EOF\n\tgit push origin main\n\tEOF\nnext")).toEqual([["cat"], ["next"]]);
  });

  test("drops redirections, recording the words they name as inert", () => {
    expect(argvs("git push origin main 2>&1 > out.log < in.txt &> all.log")).toEqual([
      ["git", "push", "origin", "main"],
    ]);
    expect(parseLine("git log > push.log").inert).toEqual([{ start: 10, end: 18 }]);
  });

  test("keeps a here-string as a word of its command", () => {
    expect(argvs("cat <<< 'git push origin main'")).toEqual([["cat", "git push origin main"]]);
  });

  test("marks a word Bash expands", () => {
    expect(words(`a $B "$C" '$D' \\$E x$(f) "$(g)" \`h\``).map((word) => word.expands)).toEqual([
      false,
      true,
      true,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  test("puts the home directory in a leading ~, and leaves ~user to expansion", () => {
    const [home, user] = words("~/x ~other/y");

    expect(home?.text).toBe(`${process.env["HOME"] ?? ""}/x`);
    expect(user?.expands).toBe(true);
  });

  test("reads a substitution as a command run before its own", () => {
    expect(argvs("echo $(git push origin main)")).toEqual([
      ["git", "push", "origin", "main"],
      ["echo", "$(git push origin main)"],
    ]);
  });

  test("reads a substitution inside double quotes, its heredoc holding a quote", () => {
    const script = `git commit -m "$(cat <<'EOF'\nfix the 5" screen\nEOF\n)" && git push --force origin dev`;

    expect(argvs(script)).toEqual([
      ["cat"],
      ["git", "commit", "-m", `$(cat <<'EOF'\nfix the 5" screen\nEOF\n)`],
      ["git", "push", "--force", "origin", "dev"],
    ]);
  });

  test("a quote inside a substitution inside double quotes does not close the word", () => {
    expect(argvs(`x="$(printf '%s"' a)"; git push --force origin dev`)).toEqual([
      ["printf", '%s"', "a"],
      ["x=$(printf '%s\"' a)"],
      ["git", "push", "--force", "origin", "dev"],
    ]);
  });

  test("reads backticks, inside double quotes too", () => {
    expect(argvs('echo "a `git push origin main` b"')).toEqual([
      ["git", "push", "origin", "main"],
      ["echo", "a `git push origin main` b"],
    ]);
  });

  test("reads a process substitution as a command", () => {
    expect(argvs("diff <(git show a) b")).toEqual([
      ["git", "show", "a"],
      ["diff", "<(git show a)", "b"],
    ]);
  });

  test("groups a subshell and a substitution between open and close", () => {
    expect(parseLine("(cd /x) && echo $(y)").items.map((item) => item.kind)).toEqual([
      "open",
      "command",
      "close",
      "open",
      "command",
      "close",
      "command",
    ]);
  });

  test("notices a shell function definition", () => {
    expect(parseLine("f() { git push; }; f").definesFunction).toBe(true);
    expect(parseLine("function f { git push; }").definesFunction).toBe(true);
    expect(parseLine('git commit -m "f() { }"').definesFunction).toBe(false);
  });

  test("an empty line runs nothing", () => {
    expect(argvs("  \n ; ")).toEqual([]);
  });
});

describe("unwrap", () => {
  test("drops assignments before the program, keeping them apart", () => {
    const [command] = commandsOf(parseLine("GIT_DIR=/x A=1 git push"));
    const result = unwrap(command?.words ?? [], CWD);

    expect(result.argv.map((word) => word.text)).toEqual(["git", "push"]);
    expect(result.assignments.map((word) => word.text)).toEqual(["GIT_DIR=/x", "A=1"]);
  });

  test("drops reserved words and wrappers", () => {
    expect(unwrapped("if ! command git push").argv).toEqual(["git", "push"]);
    expect(unwrapped("exec -a name git push").argv).toEqual(["git", "push"]);
    expect(unwrapped("time -p nohup git push").argv).toEqual(["git", "push"]);
    expect(unwrapped("/usr/bin/time -f %e git push").argv).toEqual(["git", "push"]);
  });

  test("drops env with its options; -C and --chdir move the command", () => {
    expect(unwrapped("env -u HOME --unset=PATH -i A=1 git push").argv).toEqual(["git", "push"]);
    expect(unwrapped("env -C /tmp/x git push").cwd).toBe("/tmp/x");
    expect(unwrapped("env --chdir=sub git push").cwd).toBe("/work/repo/sub");
  });

  test("env -S, xargs and flock -c hide the command until it runs", () => {
    expect(unwrapped("env -S 'git push origin main'").opaque).toBe("env -S");
    expect(unwrapped("xargs -n 1 git push origin").opaque).toBe("xargs");
    expect(unwrapped("flock /tmp/l -c 'git push'").opaque).toBe("flock -c");
  });

  test("drops nice, timeout, sudo, flock and their operands", () => {
    expect(unwrapped("nice -n 10 git push").argv).toEqual(["git", "push"]);
    expect(unwrapped("timeout -k 5 10 git push").argv).toEqual(["git", "push"]);
    expect(unwrapped("sudo -u root -E -- git push").argv).toEqual(["git", "push"]);
    expect(unwrapped("sudo -D /tmp/x git push").cwd).toBe("/tmp/x");
    expect(unwrapped("flock -w 60 /tmp/lock git push").argv).toEqual(["git", "push"]);
  });

  test("reads systemd-run only when its command stays here", () => {
    expect(unwrapped("systemd-run --user --scope -q -p MemoryMax=8G -- git push").argv).toEqual([
      "git",
      "push",
    ]);
    expect(unwrapped("systemd-run --user git push").opaque).toStartWith("systemd-run without");
  });

  test("reads mise exec up to its --", () => {
    expect(unwrapped("mise exec node@24 -- git push").argv).toEqual(["git", "push"]);
    expect(unwrapped("mise run release").argv).toEqual(["mise", "run", "release"]);
  });

  test("command -v runs nothing", () => {
    const [command] = commandsOf(parseLine("command -v git"));

    expect(unwrap(command?.words ?? [], CWD).runsNothing).toBe(true);
  });
});
