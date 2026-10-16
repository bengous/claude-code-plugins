import { describe, expect, test } from "bun:test";
import path from "node:path";

import { invocationsOf, unwrap } from "./shell.ts";

const CWD = "/work/repo";

function argvs(script: string): string[][] {
  return invocationsOf(script, CWD).map((invocation) => [...invocation.argv]);
}

function cwds(script: string): string[] {
  return invocationsOf(script, CWD).map((invocation) => invocation.cwd);
}

describe("invocationsOf splits a line into simple commands", () => {
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

  test("a push inside a compound command", () => {
    expect(
      argvs("git fetch origin && git rebase origin/dev && git push origin feature/x:dev"),
    ).toEqual([
      ["git", "fetch", "origin"],
      ["git", "rebase", "origin/dev"],
      ["git", "push", "origin", "feature/x:dev"],
    ]);
  });

  test("keeps a quoted word whole and unquoted", () => {
    expect(argvs(`git commit -m "fix: git push origin main" -m 'x; y'`)).toEqual([
      ["git", "commit", "-m", "fix: git push origin main", "-m", "x; y"],
    ]);
  });

  test("an echo of a push runs no push", () => {
    expect(argvs('echo "git push origin dev:main"')).toEqual([
      ["echo", "git push origin dev:main"],
    ]);
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

  test("drops a comment", () => {
    expect(argvs("git status # git push origin main\ngit log")).toEqual([
      ["git", "status"],
      ["git", "log"],
    ]);
  });

  test("keeps a # inside a word", () => {
    expect(argvs("echo a#b")).toEqual([["echo", "a#b"]]);
  });

  test("skips a heredoc body", () => {
    const script = "git commit -F - <<'EOF'\ngit push origin main\nEOF\ngit log";

    expect(argvs(script)).toEqual([
      ["git", "commit", "-F", "-"],
      ["git", "log"],
    ]);
  });

  test("skips a <<- heredoc body whose delimiter is indented with tabs", () => {
    expect(argvs("cat <<-EOF\n\tgit push origin main\n\tEOF\nnext")).toEqual([["cat"], ["next"]]);
  });

  test("drops redirections and the words they name", () => {
    expect(argvs("git push origin main 2>&1 > out.log < in.txt &> all.log")).toEqual([
      ["git", "push", "origin", "main"],
    ]);
  });

  test("drops a here-string", () => {
    expect(argvs("cat <<< 'git push origin main'")).toEqual([["cat"]]);
  });

  test("reads an unquoted command substitution as a command, run before its own", () => {
    expect(argvs("echo $(git push origin main)")).toEqual([
      ["git", "push", "origin", "main"],
      ["echo", "$(git push origin main)"],
    ]);
  });

  test("reads backticks as a command", () => {
    expect(argvs("echo `git push origin main` done")).toEqual([
      ["git", "push", "origin", "main"],
      ["echo", "`git push origin main`", "done"],
    ]);
  });

  test("reads a process substitution as a command", () => {
    expect(argvs("diff <(git show a) b")).toEqual([
      ["git", "show", "a"],
      ["diff", "<(git show a)", "b"],
    ]);
  });

  test("reads the script of bash -c, sh -c and bash -lc", () => {
    expect(argvs(`bash -c "git push origin main"`)).toEqual([["git", "push", "origin", "main"]]);
    expect(argvs(`sh -c 'cd /x && git push'`)).toEqual([["git", "push"]]);
    expect(argvs(`bash -lc "git push origin dev"`)).toEqual([["git", "push", "origin", "dev"]]);
  });

  test("keeps a shell that runs a script file", () => {
    expect(argvs("bash scripts/release.sh")).toEqual([["bash", "scripts/release.sh"]]);
  });

  test("reads the words of eval", () => {
    expect(argvs(`eval "git push origin main"`)).toEqual([["git", "push", "origin", "main"]]);
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
      ["git", "push", "--force", "origin", "dev"],
    ]);
  });

  test("reads backticks inside double quotes", () => {
    expect(argvs('echo "a `git push origin main` b"')).toEqual([
      ["git", "push", "origin", "main"],
      ["echo", "a `git push origin main` b"],
    ]);
  });

  test("reads nested substitutions", () => {
    expect(argvs('echo "$(echo "$(git push origin main)")"')).toEqual([
      ["git", "push", "origin", "main"],
      ["echo", "$(git push origin main)"],
      ["echo", '$(echo "$(git push origin main)")'],
    ]);
  });

  test("an escaped $( inside double quotes is text", () => {
    expect(argvs(String.raw`echo "\$(git push origin main)"`)).toEqual([
      ["echo", "$(git push origin main)"],
    ]);
  });

  test("an empty line runs nothing", () => {
    expect(argvs("  \n ; ")).toEqual([]);
  });
});

describe("unwrap", () => {
  const words = (line: readonly string[]): string[] => unwrap(line, CWD).argv;

  test("drops assignments before the program", () => {
    expect(words(["GIT_DIR=/x", "A=1", "git", "push"])).toEqual(["git", "push"]);
  });

  test("drops reserved words and wrappers", () => {
    expect(words(["if", "!", "command", "git", "push"])).toEqual(["git", "push"]);
    expect(words(["then", "exec", "-a", "name", "git", "push"])).toEqual(["git", "push"]);
    expect(words(["time", "-p", "nohup", "git", "push"])).toEqual(["git", "push"]);
  });

  test("drops env with its options and assignments", () => {
    expect(words(["env", "-u", "HOME", "--unset=PATH", "-uX", "-i", "A=1", "git", "push"])).toEqual(
      ["git", "push"],
    );
  });

  test("env -C and --chdir move the command", () => {
    expect(unwrap(["env", "-C", "/tmp/x", "git", "push"], CWD)).toEqual({
      argv: ["git", "push"],
      cwd: "/tmp/x",
    });
    expect(unwrap(["env", "--chdir=sub", "git", "push"], CWD).cwd).toBe("/work/repo/sub");
    expect(unwrap(["env", "-Csub", "git", "push"], CWD).cwd).toBe("/work/repo/sub");
  });

  test("env -S splits its string into the command", () => {
    expect(words(["env", "-S", "git push origin main"])).toEqual(["git", "push", "origin", "main"]);
    expect(words(["env", "--split-string=git push", "origin"])).toEqual(["git", "push", "origin"]);
  });

  test("drops nice with its adjustment", () => {
    expect(words(["nice", "-n", "10", "git", "push"])).toEqual(["git", "push"]);
    expect(words(["nice", "-10", "git", "push"])).toEqual(["git", "push"]);
    expect(words(["nice", "--adjustment=5", "git", "push"])).toEqual(["git", "push"]);
  });

  test("drops timeout with its options and duration", () => {
    expect(words(["timeout", "-s", "KILL", "10", "git", "push"])).toEqual(["git", "push"]);
  });

  test("drops xargs with its options", () => {
    expect(words(["xargs", "-I", "{}", "-n", "1", "-0", "git", "push", "origin", "{}"])).toEqual([
      "git",
      "push",
      "origin",
      "{}",
    ]);
  });

  test("drops sudo with its options; -D moves the command", () => {
    expect(words(["sudo", "-u", "root", "-E", "--", "git", "push"])).toEqual(["git", "push"]);
    expect(unwrap(["sudo", "-D", "/tmp/x", "git", "push"], CWD).cwd).toBe("/tmp/x");
    expect(words(["sudo", "A=1", "git", "push"])).toEqual(["git", "push"]);
  });

  test("command -v runs nothing", () => {
    expect(words(["command", "-v", "git"])).toEqual([]);
  });

  test("an assignment alone is no command", () => {
    expect(words(["A=1"])).toEqual([]);
  });
});

describe("invocationsOf follows cd", () => {
  test("an absolute cd moves the commands after it", () => {
    expect(cwds("cd /tmp/foo && git push; git log")).toEqual(["/tmp/foo", "/tmp/foo"]);
  });

  test("a relative cd resolves against the directory before it", () => {
    expect(cwds("cd sub && cd ../../other && git push")).toEqual(["/work/other"]);
  });

  test("a quoted cd target", () => {
    expect(cwds('cd "/tmp/my dir" && git push')).toEqual(["/tmp/my dir"]);
    expect(cwds("cd '/tmp/foo' && git commit")).toEqual(["/tmp/foo"]);
  });

  test("a cd before ;", () => {
    expect(cwds("cd /tmp/foo; git commit")).toEqual(["/tmp/foo"]);
  });

  test("leading whitespace", () => {
    expect(cwds("  cd /tmp && git commit")).toEqual(["/tmp"]);
  });

  test("no cd keeps the cwd", () => {
    expect(cwds("git commit -m 'test'")).toEqual([CWD]);
  });

  test("a cd after the command does not move it", () => {
    expect(cwds("git commit && cd /tmp")).toEqual([CWD]);
  });

  test("cd ~ and cd alone go home", () => {
    const home = process.env["HOME"] ?? "";

    expect(cwds("cd ~/x && git push")).toEqual([path.join(home, "x")]);
    expect(cwds("cd && git push")).toEqual([home]);
  });

  test("a target it cannot resolve leaves the directory where it was", () => {
    expect(cwds('cd "$REPO" && git push')).toEqual([CWD]);
    expect(cwds("cd $(git rev-parse --show-toplevel) && git push")).toEqual([CWD, CWD]);
    expect(cwds("cd ~other && git push")).toEqual([CWD]);
    expect(cwds("cd - && git push")).toEqual([CWD]);
  });

  test("a subshell's cd stays inside it", () => {
    expect(cwds("(cd /tmp/a && git push) && git push")).toEqual(["/tmp/a", CWD]);
  });

  test("a substitution runs in the directory before its command's cd", () => {
    expect(cwds('cd /tmp/a && cd "$(git rev-parse --show-toplevel)" && git push')).toEqual([
      "/tmp/a",
      "/tmp/a",
    ]);
  });

  test("env -C moves its command only", () => {
    expect(cwds("env -C /tmp/a git push && git push")).toEqual(["/tmp/a", CWD]);
  });

  test("a bash -c script starts in the directory of the bash", () => {
    expect(cwds(`cd /tmp/a && bash -c "git push"`)).toEqual(["/tmp/a"]);
  });
});
