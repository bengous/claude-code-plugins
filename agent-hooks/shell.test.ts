import { describe, expect, test } from "bun:test";
import path from "node:path";

import { commandWords, invocationsOf } from "./shell.ts";

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

  test("reads an unquoted command substitution as a command", () => {
    expect(argvs("echo $(git push origin main)")).toEqual([
      ["echo", "$"],
      ["git", "push", "origin", "main"],
    ]);
  });

  test("reads backticks as a command", () => {
    expect(argvs("echo `git push origin main` done")).toEqual([
      ["echo"],
      ["git", "push", "origin", "main"],
      ["done"],
    ]);
  });

  test("reads a process substitution as a command", () => {
    expect(argvs("diff <(git show a) b")).toEqual([["diff"], ["git", "show", "a"], ["b"]]);
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

  test("an empty line runs nothing", () => {
    expect(argvs("  \n ; ")).toEqual([]);
  });
});

describe("commandWords", () => {
  test("drops assignments before the program", () => {
    expect(commandWords(["GIT_DIR=/x", "A=1", "git", "push"])).toEqual(["git", "push"]);
  });

  test("drops reserved words and wrappers", () => {
    expect(commandWords(["if", "!", "command", "git", "push"])).toEqual(["git", "push"]);
    expect(commandWords(["then", "exec", "git", "push"])).toEqual(["git", "push"]);
    expect(commandWords(["time", "nohup", "git", "push"])).toEqual(["git", "push"]);
  });

  test("drops env with its options and assignments", () => {
    expect(commandWords(["env", "-u", "HOME", "-i", "A=1", "git", "push"])).toEqual([
      "git",
      "push",
    ]);
  });

  test("drops timeout with its options and duration", () => {
    expect(commandWords(["timeout", "-s", "KILL", "10", "git", "push"])).toEqual(["git", "push"]);
  });

  test("an assignment alone is no command", () => {
    expect(commandWords(["A=1"])).toEqual([]);
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

  test("a bash -c script starts in the directory of the bash", () => {
    expect(cwds(`cd /tmp/a && bash -c "git push"`)).toEqual(["/tmp/a"]);
  });
});
