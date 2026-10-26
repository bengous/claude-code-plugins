import { describe, expect, test } from "bun:test";

import type { Assessment, Vocabulary } from "./mentions.ts";
import { assess, commitsOf, findMentions } from "./mentions.ts";

const CWD = "/work/repo";

const PLAIN: Vocabulary = {
  gitAliases: new Set(),
  doorScriptNames: new Set(),
  doorScriptsAt: () => new Set(),
  profiledAt: () => true,
  approvals: false,
};

const UNPROFILED: Vocabulary = { ...PLAIN, profiledAt: () => false };

/** Every directory exists: these cases read the line, not the disk. */
function read(command: string, vocabulary: Vocabulary = PLAIN): Assessment {
  return assess(command, CWD, vocabulary, { exists: () => true });
}

function whys(command: string, vocabulary: Vocabulary = PLAIN): string[] {
  return read(command, vocabulary).unresolved.map((entry) => entry.why);
}

function doorKinds(command: string, vocabulary: Vocabulary = PLAIN): string[] {
  return read(command, vocabulary).doors.map((door) => door.kind);
}

function kinds(command: string): string[] {
  return findMentions(command, PLAIN).map((mention) => mention.kind);
}

describe("findMentions", () => {
  test("finds push after git, merge and release after gh, and the release script by path", () => {
    expect(kinds("git push origin main")).toEqual(["push"]);
    expect(kinds("gh pr merge 7")).toEqual(["merge"]);
    expect(kinds("gh api -X PUT repos/o/n/pulls/7/merge")).toEqual(["merge"]);
    expect(kinds("gh release create v1")).toEqual(["release"]);
    expect(kinds("bun ./scripts/release")).toEqual(["release"]);
  });

  test("a word that only contains a keyword is no mention", () => {
    for (const command of [
      "git log --merges",
      "git pushd",
      "gh pr view 7 --json mergeable,mergeStateStatus",
      "git push-hook",
      "echo push",
      "bun test scripts/release.test.ts",
      "git log | grep push",
    ]) {
      expect(findMentions(command, PLAIN)).toEqual([]);
    }
  });

  test("a git alias that pushes and a package script that opens a door are mentions", () => {
    const vocabulary = {
      ...PLAIN,
      gitAliases: new Set(["p"]),
      doorScriptNames: new Set(["ship"]),
    };

    expect(findMentions("git p origin main", vocabulary).map((mention) => mention.kind)).toEqual([
      "push",
    ]);
    expect(findMentions("bun run ship", vocabulary).map((mention) => mention.kind)).toEqual([
      "script",
    ]);
  });

  test("gh release and the release path are mentions in any repository", () => {
    expect(findMentions("gh release create v1", UNPROFILED)).toHaveLength(1);
    expect(findMentions("bun scripts/release.ts", UNPROFILED)).toHaveLength(1);
  });
});

describe("assess accounts for each mention", () => {
  test("no mention: nothing to read", () => {
    expect(read("bun test && git status")).toEqual({ doors: [], unresolved: [] });
  });

  test("a quoted argument or a heredoc body of a command that does not run it is inert", () => {
    for (const command of [
      'git commit -m "git push origin main"',
      "git commit -F - <<'EOF'\ngit push origin main\nEOF",
      'echo "then git push"',
      'gh pr create --title "gh pr merge after review" --body x',
      'rg -n "git push" agent-hooks',
      "git log --grep=push --oneline",
      "git stash push -m wip",
      "cat scripts/release.ts && bun x oxlint scripts/release.ts",
      "python3 - <<'EOF'\ns = open('x').read().replace('git push', 'git push -u')\nEOF",
      "node -e \"console.log('git push')\"",
      "git log > push.log",
      "git status # git push origin main",
    ]) {
      expect(read(command)).toEqual({ doors: [], unresolved: [] });
    }
  });

  test("a gh api call that merges or moves a branch ref is a door; a read is not", () => {
    expect(doorKinds("gh api -X PUT repos/o/n/pulls/7/merge")).toEqual(["merge"]);
    expect(doorKinds("gh api -X DELETE repos/o/n/git/refs/heads/dev")).toEqual(["api-ref"]);
    expect(doorKinds("gh api repos/o/n/merges -f base=main -f head=dev")).toEqual(["api-ref"]);
    expect(read("gh api repos/o/n/pulls/7/merge")).toEqual({ doors: [], unresolved: [] });
  });

  test("a door invocation with literal words is a door", () => {
    expect(doorKinds("git push origin feature/x")).toEqual(["push"]);
    expect(doorKinds("git add -A && git commit -m 'x' && git push -u origin HEAD")).toEqual([
      "push",
    ]);
    expect(doorKinds("gh pr merge 7 --squash --body \"$(cat <<'EOF'\nnotes\nEOF\n)\"")).toEqual([
      "merge",
    ]);
    expect(doorKinds("bun ./scripts/release.ts")).toEqual(["release-script"]);
    expect(doorKinds("systemd-run --user --scope -q -- git push origin feature/x")).toEqual([
      "push",
    ]);
  });

  test("a variable the line assigns a literal is read, a loop variable is not", () => {
    expect(doorKinds('wt=/tmp/wt && git -C "$wt" push origin feature/x')).toEqual(["push"]);
    expect(doorKinds("S=/tmp/x; cd $S; git push origin feature/x")).toEqual(["push"]);
    expect(whys("for b in a c; do git push origin $b; done")).toEqual([
      "$b is known only at run time",
    ]);
    expect(whys("R=x git push origin $R")).toEqual(["$R is known only at run time"]);
  });

  test("a literal bash -c script is read as a line of its own", () => {
    expect(doorKinds("flock /tmp/lock sh -c 'cd /tmp/x && git push origin feature/x'")).toEqual([
      "push",
    ]);
    expect(whys("bash -c 'git checkout main && git push'")).toEqual([
      "an earlier git checkout changes the branch it reads",
    ]);
  });

  test("a state change before a door that reads it leaves the door unresolved", () => {
    expect(whys("git checkout -q main && git push")).toEqual([
      "an earlier git checkout changes the branch it reads",
    ]);
    expect(doorKinds("git checkout -b feature/x && git push -u origin feature/x")).toEqual([
      "push",
    ]);
    expect(whys("git remote add origin git@github.com:o/n.git && git push -u origin main")).toEqual(
      ["an earlier git remote add changes what it reads"],
    );
    expect(doorKinds("git worktree remove ../wt && git push origin feature/x")).toEqual(["push"]);
    expect(doorKinds("git config push.default && git push origin feature/x")).toEqual(["push"]);
    expect(assess("cd /nonexistent-dir-xyz; git push origin main", CWD, PLAIN).unresolved).toEqual([
      { kind: "push", why: "an earlier cd /nonexistent-dir-xyz leaves its directory unknown" },
    ]);
  });

  test("GIT_DIR on the push blocks it, GIT_SSH_COMMAND does not", () => {
    expect(whys("GIT_DIR=/x/.git git push origin main")).toEqual(["GIT_DIR is set for it"]);
    expect(doorKinds('GIT_SSH_COMMAND="ssh -v" git push origin feature/x')).toEqual(["push"]);
  });

  test("a mention run through what the guard does not read is unresolved", () => {
    expect(whys("stdbuf -oL git push origin main")).toEqual(["it runs through stdbuf"]);
    expect(whys("bash <<'X'\ngit push origin main\nX")).toEqual(["its heredoc feeds bash"]);
    expect(whys("echo 'git push origin main' | sh")).toEqual(["it is piped into sh"]);
    expect(whys("echo main | xargs git push origin")).toEqual([
      "xargs hides its words until it runs",
    ]);
    expect(whys("eval 'git push origin main'")).toEqual(["it runs through eval"]);
    expect(whys("npx tsx scripts/release.ts")).toEqual(["it runs through npx tsx"]);
    expect(whys("git -c alias.p=push p origin main")).toEqual(["it runs through the git alias p"]);
    expect(whys("git -c alias.p=push status")).toEqual([
      "it stands in a git -c option, which can define an alias",
    ]);
    expect(whys("git p origin main", { ...PLAIN, gitAliases: new Set(["p"]) })).toEqual([
      "it runs through the git alias p",
    ]);
    expect(
      whys("gh api graphql -f query='mutation { mergePullRequest(input: {}) { x } }'"),
    ).toEqual(["a GraphQL mutation names its target by node id"]);
    expect(
      whys("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git', 'push'])\nEOF"),
    ).toEqual(["its heredoc feeds python3"]);
  });

  test("a line that defines a shell function leaves every mention unresolved", () => {
    expect(whys("f() { git push origin main; }; f")).toEqual([
      "the line defines a shell function, which runs what the guard cannot follow",
    ]);
  });

  test("a release command outside a profiled repository is no door", () => {
    for (const command of [
      "npx tsx scripts/release.ts",
      "bun ./scripts/release.ts",
      "gh release create v1",
    ]) {
      expect(read(command, UNPROFILED)).toEqual({ doors: [], unresolved: [] });
    }
  });

  test("a package script is a door where its manifest says so, and unresolved where the guard is lost", () => {
    const vocabulary: Vocabulary = {
      ...PLAIN,
      doorScriptNames: new Set(["release"]),
      doorScriptsAt: (dir) => new Set(dir === CWD ? ["release"] : []),
    };

    expect(doorKinds("bun run release", vocabulary)).toEqual(["script"]);
    expect(read("cd /elsewhere && bun run release", vocabulary)).toEqual({
      doors: [],
      unresolved: [],
    });
    expect(whys('cd "$X" && bun run release', vocabulary)).toEqual([
      "an earlier cd $X leaves its directory unknown",
    ]);
  });
});

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

describe("assess where profile.approvals may gate a dispatch or a label", () => {
  const GATED: Vocabulary = { ...PLAIN, approvals: true };

  test("without it, a dispatch or a label is no mention", () => {
    for (const command of [
      "gh workflow run release.yml",
      "gh pr edit 12 --add-label ok-humain",
      "gh api -X POST repos/o/n/actions/workflows/release.yml/dispatches -f ref=dev",
      "gh api repos/o/n/issues/12/labels -f 'labels[]=ok-humain'",
      'echo x | bash -c "gh workflow run release.yml"',
    ]) {
      expect(findMentions(command, PLAIN).filter((m) => m.kind !== "release")).toEqual([]);
      expect(read(command).unresolved).toEqual([]);
    }
  });

  test("reads gh workflow run, its options around the workflow", () => {
    expect(read("gh workflow run release.yml --ref dev -f version=1.2", GATED).doors).toEqual([
      { kind: "dispatch", workflow: "release.yml", repo: null, cwd: CWD },
    ]);
    expect(read("gh workflow run -r dev -f a=b release -R o/n", GATED).doors).toEqual([
      { kind: "dispatch", workflow: "release", repo: "o/n", cwd: CWD },
    ]);
    expect(read("gh workflow list && gh workflow view release.yml", GATED).doors).toEqual([]);
  });

  test("reads the labels gh pr edit, gh issue edit and gh pr create add, and the number they name", () => {
    expect(read("gh pr edit 12 --add-label ok-humain", GATED).doors).toEqual([
      { kind: "label", prs: [12], labels: ["ok-humain"], repo: null, cwd: CWD },
    ]);
    expect(
      read("gh issue edit https://github.com/o/n/pull/12 --add-label 'bug, ok-humain'", GATED)
        .doors,
    ).toEqual([{ kind: "label", prs: [12], labels: ["bug", "ok-humain"], repo: null, cwd: CWD }]);
    expect(read("gh pr edit --add-label=ok-humain", GATED).doors).toEqual([
      { kind: "label", prs: null, labels: ["ok-humain"], repo: null, cwd: CWD },
    ]);
    expect(read("gh pr create --base dev -t x -b y -l ok-humain", GATED).doors).toEqual([
      { kind: "label", prs: null, labels: ["ok-humain"], repo: null, cwd: CWD },
    ]);
    expect(read("gh pr edit 12 --remove-label ok-humain --title x", GATED).doors).toEqual([]);
  });

  test("reads the REST forms: a dispatch, labels added to an issue or a pull request", () => {
    expect(
      read("gh api -X POST repos/o/n/actions/workflows/release.yml/dispatches -f ref=dev", GATED)
        .doors,
    ).toEqual([{ kind: "dispatch", workflow: "release.yml", repo: "o/n", cwd: CWD }]);
    expect(
      read(
        "gh api repos/{owner}/{repo}/issues/12/labels -f 'labels[]=bug' -f 'labels[]=ok-humain'",
        GATED,
      ).doors,
    ).toEqual([{ kind: "label", prs: [12], labels: ["bug", "ok-humain"], repo: null, cwd: CWD }]);
    expect(
      read("gh api -X PATCH repos/o/n/issues/12 -f 'labels[]=ok-humain'", GATED).doors,
    ).toEqual([{ kind: "label", prs: [12], labels: ["ok-humain"], repo: "o/n", cwd: CWD }]);
    expect(read("gh api repos/o/n/issues/12/labels", GATED).doors).toEqual([]);
  });

  test("a gated door it cannot read whole is unresolved", () => {
    expect(read('gh workflow run "$WF"', GATED).unresolved.map((entry) => entry.kind)).toEqual([
      "dispatch",
    ]);
    expect(read('gh pr edit "$N" --add-label ok-humain', GATED).unresolved[0]?.kind).toBe("label");
    expect(
      read("gh api repos/o/n/issues/12/labels --input body.json", GATED).unresolved[0]?.why,
    ).toBe("its body comes from a file");
    expect(
      read(
        "gh api graphql -f query='mutation { addLabelsToLabelable(input: {}) { clientMutationId } }'",
        GATED,
      ).unresolved[0]?.kind,
    ).toBe("label");
    expect(read("bash -c 'gh workflow run release.yml'", GATED).doors).toEqual([
      { kind: "dispatch", workflow: "release.yml", repo: null, cwd: CWD },
    ]);
    expect(
      read("echo gh workflow run release.yml | sh", GATED).unresolved.map((entry) => entry.kind),
    ).toContain("dispatch");
  });
});
