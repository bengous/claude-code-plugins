import { describe, expect, test } from "bun:test";

import { invocations, isLocal, restoreCommand, shellQuote } from "./shell.ts";

const TAG = "[secret-pane:PAT:0a1b2c3d]";

const PAT = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

/** A value the shell would read: a space, a substitution, a quote. */
const SHELLY = "pa ss$(id)'x-long";

type ValueOf = (tag: string) => string | undefined;

const valueOf: ValueOf = (tag) => (tag === TAG ? PAT : undefined);

const shellyOf: ValueOf = (tag) => (tag === TAG ? SHELLY : undefined);

function restoredOf(command: string, of: ValueOf = valueOf): string {
  const restored = restoreCommand(command, of);

  return restored.kind === "restored" ? restored.command : `not restored: ${restored.kind}`;
}

function refused(command: string, of: ValueOf = valueOf): string {
  const restored = restoreCommand(command, of);

  return restored.kind === "refused" ? restored.why : `not refused: ${restored.kind}`;
}

describe("an inert value goes in as it is, wherever the placeholder stands", () => {
  test("a whole single-quoted placeholder piped into gh secret set", () => {
    expect(restoreCommand(`printf '%s' '${TAG}' | gh secret set PAT --repo o/r`, valueOf)).toEqual({
      kind: "restored",
      command: `printf '%s' '${PAT}' | gh secret set PAT --repo o/r`,
      handed: [PAT],
    });
    expect(restoredOf(`printf '%s' '${TAG}' | gh -R o/r secret set PAT`)).toBe(
      `printf '%s' '${PAT}' | gh -R o/r secret set PAT`,
    );
  });

  test("inside double quotes, inside a header, unquoted, after =", () => {
    expect(restoredOf(`echo "token=${TAG}"`)).toBe(`echo "token=${PAT}"`);
    expect(restoredOf(`curl -H 'Authorization: Bearer ${TAG}' https://a/b`)).toBe(
      `curl -H 'Authorization: Bearer ${PAT}' https://a/b`,
    );
    expect(restoredOf(`echo ${TAG}`)).toBe(`echo ${PAT}`);
    expect(restoredOf(`API_KEY=${TAG} npm run x`)).toBe(`API_KEY=${PAT} npm run x`);
  });

  test("in a heredoc, a list and a redirection", () => {
    expect(restoredOf(`cat > .env <<EOF\nPAT=${TAG}\nEOF`)).toBe(
      `cat > .env <<EOF\nPAT=${PAT}\nEOF`,
    );
    expect(
      restoredOf(
        `curl -sS -o /dev/null -w '%{http_code}' --oauth2-bearer ${TAG} https://api.github.com/user 2>&1 && echo ok; echo done`,
      ),
    ).toBe(
      `curl -sS -o /dev/null -w '%{http_code}' --oauth2-bearer ${PAT} https://api.github.com/user 2>&1 && echo ok; echo done`,
    );
  });

  test("a clone over HTTPS, a token handed to git's credential helper", () => {
    expect(restoredOf(`git clone https://x:${TAG}@github.com/o/r.git`)).toBe(
      `git clone https://x:${PAT}@github.com/o/r.git`,
    );
    expect(restoredOf(`printf 'password=%s\\n' ${TAG} | git credential approve`)).toBe(
      `printf 'password=%s\\n' ${PAT} | git credential approve`,
    );
  });

  test("the value comes out of bash as it went in, wherever the placeholder stands", () => {
    const value = "github_pat_11A:b/c+d=e@f,g.h-i_9";
    const of: ValueOf = (tag) => (tag === TAG ? value : undefined);

    for (const command of [
      `printf '%s\\n' ${TAG}`,
      `printf '%s\\n' '${TAG}'`,
      `printf '%s\\n' "${TAG}"`,
      `printf '%s\\n' $'${TAG}'`,
      `cat <<EOF\n${TAG}\nEOF`,
      `cat <<'EOF'\n${TAG}\nEOF`,
      `sh -c "printf '%s\\n' ${TAG}"`,
      `X=${TAG} sh -c 'printf "%s\\n" "$X"'`,
      `printf '%s\\n' "$(printf '%s' ${TAG})"`,
    ]) {
      expect(Bun.spawnSync(["bash", "-c", restoredOf(command, of)]).stdout.toString()).toBe(
        `${value}\n`,
      );
    }
  });

  test("a command naming no placeholder is untouched", () => {
    expect(restoreCommand("git commit -m 'x' && gh pr create", valueOf)).toEqual({
      kind: "untouched",
    });
  });
});

describe("an inert value, refused", () => {
  test("a placeholder the session never minted", () => {
    expect(refused(`printf '%s' '[secret-pane:PAT:ffffffff]' | gh secret set PAT`)).toContain(
      "no placeholder of this session",
    );
  });

  test("beside a git or gh word that writes history or sends it out, anywhere in the command", () => {
    expect(refused(`echo ${TAG} > .env && git commit -am x`)).toContain("`git commit`");
    expect(refused(`sh -c "git commit -m ${TAG}"`)).toContain("`git commit`");
    expect(refused(`gh pr create --body "${TAG}"`)).toContain("gh command other than gh secret");
    expect(refused(`curl -fsS --oauth2-bearer ${TAG} https://a && gh api user`)).toContain(
      "curl --oauth2-bearer",
    );
  });

  test("every git subcommand outside the local ones, an alias and push", () => {
    expect(refused(`git --work-tree /x commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`/usr/bin/git -C /r tag -m '${TAG}' v1`)).toContain("`git tag`");
    expect(refused(`git submodule add https://x:${TAG}@github.com/o/r`)).toContain(
      "`git submodule`",
    );
    expect(refused(`git.exe commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`Git.EXE commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`'C:\\Git\\bin\\git.exe' commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`git ci -m '${TAG}'`)).toContain("`git ci`");
    expect(refused(`git -c alias.x=commit x -m '${TAG}'`)).toContain("`git x`");
    expect(refused(`git push https://x:${TAG}@github.com/o/r main`)).toContain(
      "git credential approve",
    );
  });

  test("right after $, where the value would name a variable", () => {
    expect(refused(`echo $${TAG}`)).toContain("variable's name");
    expect(refused(`echo "\${${TAG}}"`)).toContain("variable's name");
    expect(refused(`echo $HOME:${TAG}`)).toContain("variable's name");
    expect(restoredOf(`echo "$HOME" ${TAG}`)).toBe(`echo "$HOME" ${PAT}`);
  });
});

test("every fix a refusal names runs, whatever the value holds", () => {
  for (const of of [valueOf, shellyOf]) {
    for (const fix of [
      `printf 'Authorization: Bearer %s' '${TAG}' | curl -H @- https://api.github.com/user`,
      `printf '%s' '${TAG}' | gh secret set NAME --repo org/repo`,
      `curl --oauth2-bearer '${TAG}' https://api.github.com/user`,
      `printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n' '${TAG}' | git credential approve`,
      `printf 'PAT=%s\\n' '${TAG}' >> .env`,
    ]) {
      expect(restoreCommand(fix, of).kind).toBe("restored");
    }
  }
});

describe("a value with shell characters takes the strict shape", () => {
  test("a whole single-quoted placeholder goes in shell-quoted, a redirection to stdout beside it", () => {
    expect(restoreCommand(`printf '%s' '${TAG}' | gh secret set X 2>&1`, shellyOf)).toEqual({
      kind: "restored",
      command: `printf '%s' ${shellQuote(SHELLY)} | gh secret set X 2>&1`,
      handed: [SHELLY],
    });
    expect(shellQuote(SHELLY)).toBe(`'pa ss$(id)'\\''x-long'`);
  });

  test("a placeholder that is not a whole single-quoted word, with the pipe that builds one", () => {
    expect(refused(`curl -H "Authorization: Bearer ${TAG}" https://a/b`, shellyOf)).toContain(
      "| curl -H @-",
    );
    expect(refused(`curl -H 'Authorization: Bearer ${TAG}' https://a/b`, shellyOf)).toContain(
      "whole single-quoted word",
    );
    expect(refused(`echo ${TAG}`, shellyOf)).toContain("whole single-quoted word");
  });

  test("lists, background, subshells and substitutions", () => {
    expect(refused(`printf '%s' '${TAG}' | gh secret set X && gh api r`, shellyOf)).toContain(
      "`&`",
    );
    expect(refused(`printf '%s' '${TAG}' | gh secret set X & gh issue create`, shellyOf)).toContain(
      "`&`",
    );
    expect(refused(`printf '%s' '${TAG}'; git commit -m x`, shellyOf)).toContain("`;`");
    expect(refused(`(git commit -m '${TAG}')`, shellyOf)).toContain("`(`");
    expect(refused(`echo $(gh issue create --body '${TAG}')`, shellyOf)).toContain("`$`");
    expect(refused(`printf '%s' '${TAG}' | tee a | gh secret set X`, shellyOf)).toContain(
      "more than one pipe",
    );
    expect(refused(`printf '%s' '${TAG}'\ngit commit -m x`, shellyOf)).toContain("new line");
    expect(refused(`git commit-tree HEAD^{tree} -m '${TAG}'`, shellyOf)).toContain("`{`");
  });

  test("a wrapper, an assignment, git and gh", () => {
    expect(refused(`sh -c '${TAG}'`, shellyOf)).toContain("`sh`");
    expect(refused(`printf '%s' '${TAG}' | Bash.exe -c x`, shellyOf)).toContain("`bash`");
    expect(refused(`printf '%s' '${TAG}' | xargs gh issue create --body`, shellyOf)).toContain(
      "`xargs`",
    );
    expect(refused(`env X=1 printf '%s' '${TAG}'`, shellyOf)).toContain("`env`");
    expect(refused(`X=1 printf '%s' '${TAG}'`, shellyOf)).toContain("assignment");
    expect(refused(`printf '%s' '${TAG}' | git commit -F -`, shellyOf)).toContain("`git commit`");
    expect(refused(`printf '%s' '${TAG}' | gh variable set X`, shellyOf)).toContain(
      "gh command other than gh secret",
    );
  });
});

function argsOf(command: string, program: "git" | "gh" = "git") {
  return invocations(command, program).map((call) => call.args);
}

describe("invocations", () => {
  test("each git word with the words after it, quotes and escapes removed", () => {
    expect(argsOf(`git commit -m "fix: the thing" && git -C "my dir" status`)).toEqual([
      ["commit", "-m", "fix: the thing"],
      ["-C", "my dir", "status"],
    ]);
    expect(argsOf(`git commit -m "say \\"hi\\"" | cat`)).toEqual([["commit", "-m", `say "hi"`]]);
    expect(argsOf("/usr/bin/git log; gh pr list", "gh")).toEqual([["pr", "list"]]);
  });

  test("inside a quoted command, a substitution or a subshell too", () => {
    expect(argsOf(`sh -c "git commit -m x"`)).toEqual([["commit", "-m", "x"]]);
    expect(argsOf("echo `git rev-parse HEAD` $(git log -1)")).toEqual([
      ["rev-parse", "HEAD"],
      ["log", "-1"],
    ]);
    expect(argsOf("(git commit)")).toEqual([["commit"]]);
  });

  test("a literal heredoc's body names nothing, unless a shell on its line runs it", () => {
    expect(
      argsOf(
        `git add -A && git commit -m "$(cat <<'EOF'\nfix: run \`cd ~/p && git push\` then "hi\nEOF\n)"`,
      ),
    ).toEqual([
      ["add", "-A"],
      ["commit", "-m", "$(cat <<'EOF'\n)"],
    ]);
    expect(argsOf("git commit -F- <<'EOF'\nmsg git push\nEOF\ngit status")).toEqual([
      ["commit", "-F-"],
      ["status"],
    ]);
    expect(argsOf("cat <<-'END'\n\tgit push\n\tEND\ngit log")).toEqual([["log"]]);
    expect(argsOf("bash <<'EOF'\ngit commit -am x\nEOF")).toEqual([["commit", "-am", "x"]]);
    expect(argsOf("cat <<'EOF' | sh\ngit commit -am x\nEOF")).toEqual([["commit", "-am", "x"]]);
    expect(argsOf("cat <<EOF\n$(git commit -am x)\nEOF")).toEqual([["commit", "-am", "x"]]);
  });

  test("a comment names nothing", () => {
    expect(argsOf("echo hi # git push")).toEqual([]);
    expect(argsOf("echo a#b git")).toEqual([[]]);
  });

  test("the cd targets standing before each, a subshell's kept in it", () => {
    expect(invocations("cd /a && cd b; GIT_DIR=/g git status", "git")).toEqual([
      { isRemote: false, before: ["GIT_DIR=/g"], args: ["status"], inputs: [], cds: ["/a", "b"] },
    ]);
    expect(invocations("(cd /a && git status) && git log", "git").map((call) => call.cds)).toEqual([
      ["/a"],
      [],
    ]);
    expect(invocations("cd -P /x && cd && git log", "git")[0]?.cds).toEqual(["/x", "~"]);
  });
});

describe("isLocal", () => {
  test("a local git subcommand or none, and gh secret alone", () => {
    expect(isLocal("git", ["-C", "/r", "status"])).toBe(true);
    expect(isLocal("git", ["--version"])).toBe(true);
    expect(isLocal("git", ["--git-dir=/g", "commit"])).toBe(false);
    expect(isLocal("git", ["ci"])).toBe(false);
    expect(isLocal("gh", ["-R", "o/r", "secret", "set", "X"])).toBe(true);
    expect(isLocal("gh", ["api", "user"])).toBe(false);
    expect(isLocal("gh", ["--version"])).toBe(true);
  });
});
