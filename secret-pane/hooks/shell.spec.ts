import { describe, expect, test } from "bun:test";

import { restoreCommand, shellQuote } from "./shell.ts";

const TAG = "[secret-pane:PAT:0a1b2c3d]";

const PAT = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

const valueOf = (tag: string) => (tag === TAG ? PAT : undefined);

function refused(command: string): string {
  const restored = restoreCommand(command, valueOf);

  return restored.kind === "refused" ? restored.why : `not refused: ${restored.kind}`;
}

describe("restored", () => {
  test("a whole single-quoted placeholder piped into gh secret set", () => {
    expect(restoreCommand(`printf '%s' '${TAG}' | gh secret set PAT --repo o/r`, valueOf)).toEqual({
      kind: "restored",
      command: `printf '%s' '${PAT}' | gh secret set PAT --repo o/r`,
      handed: [PAT],
    });
  });

  test("a header of curl, the redirection a word", () => {
    expect(
      restoreCommand(
        `curl -fsS -H 'Authorization: Bearer x' -o /dev/null 'https://a/b' > out`,
        valueOf,
      ),
    ).toEqual({ kind: "untouched" });
    expect(restoreCommand(`curl -fsS -u '${TAG}' https://a/b`, valueOf).kind).toBe("restored");
  });

  test("the skill's own check, curl with the token as a bearer", () => {
    expect(
      restoreCommand(
        `curl -fsS -o /dev/null -w '%{http_code}\\n' --oauth2-bearer '${TAG}' https://api.github.com/repos/o/r`,
        valueOf,
      ),
    ).toEqual({
      kind: "restored",
      command: `curl -fsS -o /dev/null -w '%{http_code}\\n' --oauth2-bearer '${PAT}' https://api.github.com/repos/o/r`,
      handed: [PAT],
    });
  });

  test("gh secret set behind a global option", () => {
    expect(restoreCommand(`printf '%s' '${TAG}' | gh -R o/r secret set PAT`, valueOf).kind).toBe(
      "restored",
    );
  });

  test("a value with shell characters goes in quoted", () => {
    const value = `pa ss$(id)'x`;

    expect(restoreCommand(`printf '%s' '${TAG}'`, () => value)).toEqual({
      kind: "restored",
      command: `printf '%s' ${shellQuote(value)}`,
      handed: [value],
    });
    expect(shellQuote(value)).toBe(`'pa ss$(id)'\\''x'`);
  });

  test("a token handed to git's credential helper", () => {
    expect(restoreCommand(`printf '%s' '${TAG}' | git credential approve`, valueOf)).toEqual({
      kind: "restored",
      command: `printf '%s' '${PAT}' | git credential approve`,
      handed: [PAT],
    });
  });

  test("a command naming no placeholder is untouched", () => {
    expect(restoreCommand("git commit -m 'x' && gh pr create", valueOf)).toEqual({
      kind: "untouched",
    });
  });
});

describe("refused", () => {
  test("a placeholder the session never minted", () => {
    expect(refused(`printf '%s' '[secret-pane:PAT:ffffffff]' | gh secret set PAT`)).toContain(
      "no placeholder of this session",
    );
  });

  test("a placeholder that is not a whole single-quoted word", () => {
    expect(refused(`curl -H 'Authorization: Bearer ${TAG}' https://a/b`)).toContain(
      "whole single-quoted word",
    );
    expect(refused(`echo ${TAG}`)).toContain("whole single-quoted word");
    expect(refused(`echo "${TAG}"`)).toContain("whole single-quoted word");
  });

  test("lists, background, subshells and substitutions", () => {
    expect(refused(`printf '%s' '${TAG}' | gh secret set X && gh api r`)).toContain("&");
    expect(refused(`printf '%s' '${TAG}' | gh secret set X & gh issue create`)).toContain("&");
    expect(refused(`printf '%s' '${TAG}'; git commit -m x`)).toContain(";");
    expect(refused(`(git commit -m '${TAG}')`)).toContain("(");
    expect(refused(`echo $(gh issue create --body '${TAG}')`)).toContain("$");
    expect(refused(`printf '%s' '${TAG}' | tee a | gh secret set X`)).toContain(
      "more than one pipe",
    );
    expect(refused(`printf '%s' '${TAG}'\ngit commit -m x`)).toContain("new line");
  });

  test("a wrapper that runs its arguments as a command", () => {
    expect(refused(`sh -c '${TAG}'`)).toContain("`sh`");
    expect(refused(`printf '%s' '${TAG}' | xargs gh issue create --body`)).toContain("`xargs`");
    expect(refused(`env X=1 printf '%s' '${TAG}'`)).toContain("`env`");
  });

  test("every git subcommand outside the local ones, whatever the options before it", () => {
    expect(refused(`git commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`git --work-tree /x commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`/usr/bin/git -C /r tag -m '${TAG}' v1`)).toContain("`git tag`");
    expect(refused(`git commit-tree HEAD^{tree} -m '${TAG}'`)).toContain("{");
    expect(refused(`printf '%s' '${TAG}' | git commit -F -`)).toContain("`git commit`");
    expect(refused(`git submodule add '${TAG}'`)).toContain("`git submodule`");
    expect(refused(`git.exe commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`Git.EXE commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`'C:\\Git\\bin\\git.exe' commit -m '${TAG}'`)).toContain("`git commit`");
    expect(refused(`printf '%s' '${TAG}' | Bash.exe -c x`)).toContain("`bash`");
  });

  test("a git alias, which may stand for any subcommand", () => {
    expect(refused(`git ci -m '${TAG}'`)).toContain("`git ci`");
    expect(refused(`git -c alias.x=commit x -m '${TAG}'`)).toContain("`git x`");
  });

  test("git push, with the way to hand git the token instead", () => {
    expect(refused(`git push '${TAG}' main`)).toContain("git credential approve");
  });

  test("every gh command but secret", () => {
    expect(refused(`gh api -H '${TAG}' repos/o/r`)).toContain("gh command");
    expect(refused(`printf '%s' '${TAG}' | gh variable set X`)).toContain("gh command");
    expect(refused(`printf '%s' '${TAG}' | gh issue create --body-file -`)).toContain("gh command");
  });

  test("an assignment in front of the command", () => {
    expect(refused(`GH_TOKEN='${TAG}' gh api r`)).toContain("whole single-quoted word");
    expect(refused(`X=1 printf '%s' '${TAG}'`)).toContain("assignment");
  });
});
