import { describe, expect, test } from "bun:test";

import { commitsOf } from "./commits.ts";

const CWD = "/work/repo";

/** Each commit as the line from its start, its arguments, and the directory it runs in. */
function found(command: string): [string, readonly string[], string | null][] {
  return commitsOf(command, CWD, { exists: () => true }).map((commit) => [
    command.slice(commit.start),
    commit.git.args,
    commit.cwd,
  ]);
}

describe("commitsOf", () => {
  test("finds a git commit as written, its wrappers, assignments and location peeled", () => {
    expect(found("git commit -m x")).toEqual([["git commit -m x", ["-m", "x"], CWD]]);
    expect(found("FOO=1 timeout 60 git -C sub commit -qm x 2>&1")).toEqual([
      ["FOO=1 timeout 60 git -C sub commit -qm x 2>&1", ["-qm", "x"], CWD],
    ]);
    expect(found(`git "commit" -m x`)).toEqual([[`git "commit" -m x`, ["-m", "x"], CWD]]);
  });

  test("follows a cd, in a subshell too, and finds each commit of the line", () => {
    expect(found("cd sub && git commit -m a; git commit -m b")).toEqual([
      ["git commit -m a; git commit -m b", ["-m", "a"], `${CWD}/sub`],
      ["git commit -m b", ["-m", "b"], `${CWD}/sub`],
    ]);
    expect(found("(cd sub && git commit -m a) && git commit -m b")).toEqual([
      ["git commit -m a) && git commit -m b", ["-m", "a"], `${CWD}/sub`],
      ["git commit -m b", ["-m", "b"], CWD],
    ]);
    expect(found('cd "$DIR" && git commit -m a')).toEqual([["git commit -m a", ["-m", "a"], null]]);
  });

  test("a message written by a substitution or a heredoc is still the commit's, the heredoc handed over", () => {
    expect(found("git commit -m \"$(cat <<'EOF'\nfix: a\nEOF\n)\"")).toHaveLength(1);
    expect(found("git commit -F - <<'EOF'\nfix: a\nEOF")).toEqual([
      ["git commit -F - <<'EOF'\nfix: a\nEOF", ["-F", "-"], CWD],
    ]);
    expect(
      commitsOf("git commit -F - <<'EOF'\nfix: a\nEOF", CWD, { exists: () => true })[0]?.heredoc,
    ).toBe("fix: a\n");
  });

  test("a commit inside a substitution, a nested script, behind xargs, or another subcommand is none", () => {
    expect(found('echo "$(git commit -m a)"')).toEqual([]);
    expect(found("bash -c 'git commit -m a'")).toEqual([]);
    expect(found("echo -m a | xargs git commit")).toEqual([]);
    expect(found("git merge --no-ff x && git cherry-pick y && git revert z")).toEqual([]);
    expect(found("git log --grep commit")).toEqual([]);
    expect(found("f() { git commit -m a; }; f")).toEqual([]);
  });
});
