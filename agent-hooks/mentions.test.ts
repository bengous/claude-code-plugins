import { describe, expect, test } from "bun:test";

import type { Assessment, Vocabulary } from "./mentions.ts";
import { assess, findMentions } from "./mentions.ts";

const CWD = "/work/repo";

const PLAIN: Vocabulary = {
  gitAliases: new Set(),
  doorScripts: new Set(),
  releaseDoors: true,
  releaseScriptAt: () => true,
};

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

describe("findMentions", () => {
  test("finds push after git, merge and release after gh, and the release script by path", () => {
    const kinds = (command: string): string[] =>
      findMentions(command, PLAIN).map((mention) => mention.kind);

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
    const vocabulary = { ...PLAIN, gitAliases: new Set(["p"]), doorScripts: new Set(["ship"]) };

    expect(findMentions("git p origin main", vocabulary).map((mention) => mention.kind)).toEqual([
      "push",
    ]);
    expect(findMentions("bun run ship", vocabulary).map((mention) => mention.kind)).toEqual([
      "script",
    ]);
  });

  test("gh release and its keyword wait for a landing profile; the release path does not", () => {
    const unprofiled = { ...PLAIN, releaseDoors: false };

    expect(findMentions("gh release create v1", unprofiled)).toEqual([]);
    expect(findMentions("bun scripts/release.ts", unprofiled)).toHaveLength(1);
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

  test("a release script mention outside a profiled repository is no door", () => {
    const unprofiled = { ...PLAIN, releaseDoors: false, releaseScriptAt: (): boolean => false };

    expect(read("npx tsx scripts/release.ts", unprofiled)).toEqual({ doors: [], unresolved: [] });
    expect(read("bun ./scripts/release.ts", unprofiled)).toEqual({ doors: [], unresolved: [] });
  });
});
