import { describe, expect, test } from "bun:test";

import { githubSlugOf, slugOfPullRequest, slugOfRepoOption } from "./github.ts";
import type { Check, PullRequestFacts, PushTarget, RepoFacts } from "./landing.ts";
import {
  CURRENT_BRANCH,
  EVERY_BRANCH,
  PUSH_DESTINATION,
  ghCommandOf,
  gitCommandOf,
  isPrMerge,
  isReleaseCreate,
  latestChecks,
  packageScriptOf,
  profiledMergeRefusal,
  profiledPushRefusal,
  publicMergeRefusal,
  publicPushRefusal,
  pushOf,
  releaseScriptOf,
  resolveTargets,
} from "./landing.ts";
import { commandsOf, parseLine, unwrap } from "./shell.ts";

const LANDING = { trunk: "dev", release: "main" } as const;

const PUBLIC: RepoFacts = { visibility: "PUBLIC", defaultBranch: "main" };

/** The argv of each simple command of a line, once its wrappers are peeled. */
function argvsOf(command: string): string[][] {
  return commandsOf(parseLine(command)).map((parsed) =>
    unwrap(parsed.words, "/repo").argv.map((word) => word.text),
  );
}

/** The push targets of a command line: every `git push` it runs, `HEAD` left unresolved. */
function targetsOf(command: string): PushTarget[] {
  return argvsOf(command).flatMap((argv) => {
    const git = gitCommandOf(argv);
    const push = git?.subcommand === "push" ? pushOf(git.args) : null;

    return push === null ? [] : push.targets;
  });
}

function isPush(command: string): boolean {
  return argvsOf(command).some((argv) => gitCommandOf(argv)?.subcommand === "push");
}

function pushVerdict(command: string, currentBranch: string | null = null): string | null {
  return profiledPushRefusal(
    resolveTargets(targetsOf(command), { current: currentBranch, push: null }),
    LANDING,
    true,
  );
}

function check(name: string, state: string, startedAt: string): Check {
  return { name, state, startedAt, workflow: "CI", event: "pull_request" };
}

function plain(ref: string): PushTarget {
  return { ref, forced: false, deleted: false };
}

function pr(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    number: 7,
    url: "https://github.com/o/n/pull/7",
    baseRefName: "dev",
    mergeable: "MERGEABLE",
    checks: [check("validate", "SUCCESS", "2026-01-01T00:00:00Z")],
    ...overrides,
  };
}

describe("gitCommandOf", () => {
  test("a git invocation without options locates nothing", () => {
    expect(gitCommandOf(["git", "commit", "-m", "x"])).toEqual({
      location: [],
      inlineAliases: [],
      subcommand: "commit",
      index: 1,
      args: ["-m", "x"],
    });
  });

  test("keeps every -C in order, for git to chain", () => {
    expect(gitCommandOf(["git", "-C", "/tmp/foo", "-C", "sub", "push"])?.location).toEqual([
      "-C",
      "/tmp/foo",
      "-C",
      "sub",
    ]);
  });

  test("skips the global options that do not locate the repository", () => {
    expect(
      gitCommandOf(["git", "-c", "user.name=x", "--no-pager", "-C", "/tmp/foo", "-p", "push"]),
    ).toEqual({
      location: ["-C", "/tmp/foo"],
      inlineAliases: [],
      subcommand: "push",
      index: 7,
      args: [],
    });
  });

  test("reads the aliases a -c option defines", () => {
    expect(gitCommandOf(["git", "-c", "alias.p=push", "p", "origin"])?.inlineAliases).toEqual([
      "p",
    ]);
  });

  test("keeps --git-dir and --work-tree in both spellings", () => {
    expect(
      gitCommandOf(["git", "--git-dir=/tmp/g", "--work-tree", "/tmp/w", "push"])?.location,
    ).toEqual(["--git-dir", "/tmp/g", "--work-tree", "/tmp/w"]);
  });

  test("an option value that names a subcommand is no subcommand", () => {
    expect(gitCommandOf(["git", "-c", "push.default=current", "status"])?.subcommand).toBe(
      "status",
    );
  });

  test("a program path ending in git is git", () => {
    expect(gitCommandOf(["/usr/bin/git", "push"])?.subcommand).toBe("push");
  });

  test("another program is none", () => {
    expect(gitCommandOf(["gitk", "push"])).toBeNull();
    expect(gitCommandOf(["git"])).toBeNull();
  });
});

describe("pushOf ignores commands that push nothing", () => {
  const notPush = [
    "git status",
    "git fetch origin",
    "git pull --rebase",
    "bun test",
    'echo "git push origin dev:main"',
    "git commit -m 'git push origin main'",
    'git commit -m "fix: git push guard"',
    "git -c push.default=current status",
  ];

  for (const command of notPush) {
    test(`not a push: ${command}`, () => {
      expect(isPush(command)).toBe(false);
    });
  }

  test("a dry run pushes nothing", () => {
    expect(pushOf(["--dry-run", "origin", "main"])).toBeNull();
    expect(pushOf(["-nf", "origin", "main"])).toBeNull();
  });
});

describe("pushOf reads the destinations", () => {
  test("a bare branch", () => {
    expect(targetsOf("git push origin dev")).toEqual([plain("dev")]);
  });

  test("a refspec destination", () => {
    expect(targetsOf("git push origin feature/x:dev")).toEqual([plain("dev")]);
  });

  test("a sha refspec destination", () => {
    expect(targetsOf("git push origin 2f46dd6:main")).toEqual([plain("main")]);
  });

  test("a fully qualified destination", () => {
    expect(targetsOf("git push origin HEAD:refs/heads/main")).toEqual([plain("main")]);
  });

  test("several refspecs", () => {
    expect(targetsOf("git push origin dev feature/x")).toEqual([plain("dev"), plain("feature/x")]);
  });

  test("a remote alone or no argument pushes the current branch", () => {
    expect(targetsOf("git push origin")).toEqual([plain(PUSH_DESTINATION)]);
    expect(targetsOf("git push")).toEqual([plain(PUSH_DESTINATION)]);
  });

  test("HEAD and @ alone name the current branch", () => {
    expect(targetsOf("git push origin HEAD")).toEqual([plain(CURRENT_BRANCH)]);
    expect(targetsOf("git push origin @")).toEqual([plain(CURRENT_BRANCH)]);
  });

  test("options are read as neither the remote nor a refspec", () => {
    expect(targetsOf("git push -u origin feature/x")).toEqual([plain("feature/x")]);
  });

  test("an option value does not shift the positionals", () => {
    expect(targetsOf("git push --push-option ci.skip origin dev")).toEqual([plain("dev")]);
    expect(targetsOf("git push -o ci.skip origin dev")).toEqual([plain("dev")]);
  });

  test("the remote is the first positional", () => {
    expect(pushOf(["upstream", "main"])?.remote).toBe("upstream");
    expect(pushOf(["--repo", "fork"])?.remote).toBe("fork");
    expect(pushOf([])?.remote).toBeNull();
  });

  test("collects the targets of several pushes", () => {
    expect(targetsOf("git push origin dev; git push origin feature/x")).toEqual([
      plain("dev"),
      plain("feature/x"),
    ]);
  });

  test("a push behind global options", () => {
    expect(targetsOf("git -C /tmp/x -c k=v --no-pager push origin main")).toEqual([plain("main")]);
  });

  test("a tag is no branch", () => {
    expect(targetsOf("git push origin refs/tags/v1:refs/tags/v1")).toEqual([]);
    expect(targetsOf("git push origin tag v1")).toEqual([]);
    expect(targetsOf("git push origin --tags")).toEqual([]);
  });

  test("--all, --branches and a pattern reach every branch", () => {
    expect(targetsOf("git push --all origin")).toEqual([plain(EVERY_BRANCH)]);
    expect(targetsOf("git push --branches origin")).toEqual([plain(EVERY_BRANCH)]);
    expect(targetsOf("git push origin 'refs/heads/*:refs/heads/*'")).toEqual([plain(EVERY_BRANCH)]);
  });

  test("--mirror forces and deletes every branch", () => {
    expect(targetsOf("git push --mirror origin")).toEqual([
      { ref: EVERY_BRANCH, forced: true, deleted: true },
    ]);
  });
});

describe("pushOf reads force and deletion", () => {
  const forced = [
    "git push --force origin dev",
    "git push -f origin dev",
    "git push origin dev --force",
    "git push origin dev -f",
    "git push -uf origin dev",
    "git push --force-with-lease origin dev",
    "git push --force-with-lease=dev origin dev",
    "git push --force-with-lease=dev:abc123 origin dev",
    "git push --force-if-includes --force-with-lease origin dev",
  ];

  for (const command of forced) {
    test(`forced: ${command}`, () => {
      expect(targetsOf(command)).toEqual([{ ref: "dev", forced: true, deleted: false }]);
    });
  }

  test("a plus refspec forces its own target only", () => {
    expect(targetsOf("git push origin +feature/x dev")).toEqual([
      { ref: "feature/x", forced: true, deleted: false },
      { ref: "dev", forced: false, deleted: false },
    ]);
  });

  test("force in one push does not taint another", () => {
    expect(targetsOf("git push -f origin feature/x; git push origin dev")).toEqual([
      { ref: "feature/x", forced: true, deleted: false },
      { ref: "dev", forced: false, deleted: false },
    ]);
  });

  test("options other than force are not force", () => {
    expect(targetsOf("git push -u --no-force-with-lease origin dev")).toEqual([
      { ref: "dev", forced: false, deleted: false },
    ]);
  });

  test("a delete refspec and --delete delete their target", () => {
    expect(targetsOf("git push origin :dev")).toEqual([
      { ref: "dev", forced: false, deleted: true },
    ]);
    expect(targetsOf("git push origin --delete dev")).toEqual([
      { ref: "dev", forced: false, deleted: true },
    ]);
    expect(targetsOf("git push -d origin dev")).toEqual([
      { ref: "dev", forced: false, deleted: true },
    ]);
  });
});

describe("profiledPushRefusal refuses a push to the release", () => {
  const denied = [
    "git push origin dev:main",
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/main",
    "git push --force origin main",
    "git push origin :main",
    "git push --all origin",
    "git push --mirror origin",
    "git -C /tmp/x push origin main",
  ];

  for (const command of denied) {
    test(`refuses: ${command}`, () => {
      expect(pushVerdict(command)).toContain("the release is the human's");
    });
  }
});

describe("profiledPushRefusal refuses a force push or a deletion of the trunk", () => {
  const denied = [
    "git push --force origin dev",
    "git push origin dev --force",
    "git push --force-with-lease origin dev",
    "git push origin +dev",
    "git push -f origin HEAD:dev",
    "git push origin :dev",
    "git push origin --delete dev",
  ];

  for (const command of denied) {
    test(`refuses: ${command}`, () => {
      expect(pushVerdict(command)).toContain("never targets 'dev'");
    });
  }
});

describe("profiledPushRefusal allows the sanctioned pushes", () => {
  const allowed = [
    "git push origin dev",
    "git push origin feature/x:dev",
    "git push -u origin feature/new-hook",
    "git push --force-with-lease origin feature/x",
    "git push --force-with-lease origin fix/typo",
    "git push origin HEAD:feature/x",
    "git push origin --delete feature/x",
    "git push origin --tags",
    "git push --dry-run origin main",
  ];

  for (const command of allowed) {
    test(`allows: ${command}`, () => {
      expect(pushVerdict(command)).toBeNull();
    });
  }
});

describe("profiledPushRefusal resolves a push without refspec against the current branch", () => {
  test("a bare force push on the trunk is refused", () => {
    expect(pushVerdict("git push --force-with-lease", "dev")).toContain("never targets 'dev'");
  });

  test("a bare push on the release is refused", () => {
    expect(pushVerdict("git push", "main")).toContain("the release is the human's");
  });

  test("HEAD on the release is refused", () => {
    expect(pushVerdict("git push origin HEAD", "main")).toContain("the release is the human's");
  });

  test("a bare force push on a feature branch is allowed", () => {
    expect(pushVerdict("git push --force-with-lease", "feature/x")).toBeNull();
  });

  test("a bare push with no branch checked out is allowed", () => {
    expect(pushVerdict("git push", null)).toBeNull();
  });
});

describe("resolveTargets", () => {
  const branches = { current: "x", push: "main" };

  test("a push without refspec goes where @{push} names", () => {
    expect(resolveTargets([plain(PUSH_DESTINATION)], branches)).toEqual([plain("main")]);
  });

  test("without @{push}, a push without refspec reads as the current branch", () => {
    expect(resolveTargets([plain(PUSH_DESTINATION)], { current: "x", push: null })).toEqual([
      plain("x"),
    ]);
  });

  test("HEAD reaches the current branch and @{push}", () => {
    expect(resolveTargets([plain(CURRENT_BRANCH)], branches)).toEqual([plain("x"), plain("main")]);
    expect(resolveTargets([plain(CURRENT_BRANCH)], { current: "x", push: "x" })).toEqual([
      plain("x"),
    ]);
  });

  test("no branch checked out leaves no target", () => {
    expect(resolveTargets([plain(CURRENT_BRANCH)], { current: null, push: null })).toEqual([]);
  });
});

describe("profiledPushRefusal names the way to land", () => {
  test("with scripts/land.ts", () => {
    expect(
      profiledPushRefusal([{ ref: "main", forced: false, deleted: false }], LANDING, true),
    ).toContain("bun ./scripts/land.ts <branch>");
  });

  test("without it", () => {
    const reason = profiledPushRefusal(
      [{ ref: "dev", forced: true, deleted: false }],
      LANDING,
      false,
    );

    expect(reason).toContain("open a pull request");
    expect(reason).not.toContain("land.ts");
  });
});

describe("publicPushRefusal", () => {
  const main = [{ ref: "main", forced: false, deleted: false }];

  test("refuses the default branch of a public repository", () => {
    expect(publicPushRefusal(main, PUBLIC, "github.com/o/n")).toContain(
      "'main' is the default branch of the public repository github.com/o/n",
    );
  });

  test("allows the default branch of a private repository", () => {
    expect(
      publicPushRefusal(main, { visibility: "PRIVATE", defaultBranch: "main" }, "s"),
    ).toBeNull();
  });

  test("reads the default branch from the repository, master included", () => {
    const master = { visibility: "PUBLIC", defaultBranch: "master" };

    expect(publicPushRefusal(main, master, "s")).toBeNull();
    expect(
      publicPushRefusal([{ ref: "master", forced: false, deleted: false }], master, "s"),
    ).not.toBeNull();
  });

  test("allows a feature branch, refuses every branch", () => {
    expect(
      publicPushRefusal([{ ref: "feature/x", forced: true, deleted: false }], PUBLIC, "s"),
    ).toBeNull();
    expect(
      publicPushRefusal([{ ref: EVERY_BRANCH, forced: false, deleted: false }], PUBLIC, "s"),
    ).not.toBeNull();
  });
});

/** What the guard reads of a gh invocation: its subcommand, its positionals, its repository, the doors it opens. */
type GhReading = {
  readonly group: string | null;
  readonly action: string | null;
  readonly positionals: readonly string[];
  readonly repo: string | null;
  readonly merge: boolean;
  readonly release: boolean;
};

function readGh(argv: readonly string[]): GhReading | null {
  const gh = ghCommandOf(argv);

  return gh === null
    ? null
    : {
        group: gh.group,
        action: gh.action,
        positionals: gh.positionals,
        repo: gh.repo,
        merge: isPrMerge(gh),
        release: isReleaseCreate(gh),
      };
}

describe("ghCommandOf", () => {
  test("gh pr merge with a selector and options", () => {
    expect(readGh(["gh", "pr", "merge", "12", "--squash", "-b", "body text"])).toEqual({
      group: "pr",
      action: "merge",
      positionals: ["12"],
      repo: null,
      merge: true,
      release: false,
    });
  });

  test("gh pr merge with a value option before the selector", () => {
    expect(readGh(["gh", "pr", "merge", "--subject", "s", "feature/x"])).toMatchObject({
      positionals: ["feature/x"],
      merge: true,
    });
  });

  test("reads --repo wherever it stands, in every spelling", () => {
    expect(readGh(["gh", "pr", "merge", "-R", "o/n"])).toMatchObject({ repo: "o/n", merge: true });
    expect(readGh(["gh", "pr", "merge", "--repo=o/n", "3"])).toMatchObject({
      repo: "o/n",
      positionals: ["3"],
    });
    expect(readGh(["gh", "-R", "o/n", "pr", "merge", "7"])).toMatchObject({
      repo: "o/n",
      merge: true,
    });
    expect(readGh(["gh", "pr", "-R", "o/n", "merge", "7"])).toMatchObject({
      repo: "o/n",
      merge: true,
    });
  });

  test("reads --auto, and --disable-auto merges nothing", () => {
    expect(ghCommandOf(["gh", "pr", "merge", "12", "--auto"])?.flags.has("--auto")).toBe(true);
    expect(readGh(["gh", "pr", "merge", "12", "--disable-auto"])).toMatchObject({ merge: false });
  });

  test("gh release create", () => {
    expect(readGh(["gh", "release", "create", "v1", "--notes", "x"])).toMatchObject({
      release: true,
      merge: false,
    });
  });

  test("other gh commands open no door, and other programs are none", () => {
    expect(readGh(["gh", "pr", "view", "12"])).toMatchObject({ merge: false, release: false });
    expect(readGh(["gh", "release", "view", "v1"])).toMatchObject({ release: false });
    expect(readGh(["git", "pr", "merge"])).toBeNull();
  });
});

describe("releaseScriptOf", () => {
  test("through a runtime or directly", () => {
    expect(releaseScriptOf(["bun", "./scripts/release.ts"], "/r")).toEqual({
      script: "./scripts/release.ts",
      path: "/r/scripts/release.ts",
      dryRun: false,
    });
    expect(releaseScriptOf(["bun", "run", "scripts/release.ts", "abc123"], "/r")).toEqual({
      script: "scripts/release.ts",
      path: "/r/scripts/release.ts",
      dryRun: false,
    });
    expect(releaseScriptOf(["./scripts/release.ts"], "/r")?.script).toBe("./scripts/release.ts");
    expect(releaseScriptOf(["bash", "/r/scripts/release.sh"], "/x")?.script).toBe(
      "/r/scripts/release.sh",
    );
  });

  test("resolves the script against the directory it runs in", () => {
    expect(releaseScriptOf(["bun", "release.ts"], "/r/scripts")?.script).toBe("release.ts");
    expect(releaseScriptOf(["bun", "release.ts"], "/r")).toBeNull();
  });

  test("reads --dry-run", () => {
    expect(releaseScriptOf(["bun", "./scripts/release.ts", "--dry-run"], "/r")?.dryRun).toBe(true);
  });

  test("skips a runner option and its value, and follows --cwd", () => {
    expect(releaseScriptOf(["bun", "--cwd", "sub", "scripts/release.ts"], "/r")?.path).toBe(
      "/r/sub/scripts/release.ts",
    );
    expect(releaseScriptOf(["node", "-r", "./setup.js", "scripts/release.ts"], "/r")?.path).toBe(
      "/r/scripts/release.ts",
    );
    expect(
      releaseScriptOf(["bun", "--env-file=.env", "run", "scripts/release.ts"], "/r"),
    ).not.toBeNull();
  });

  test("a use that runs nothing is none", () => {
    expect(releaseScriptOf(["node", "--check", "scripts/release.ts"], "/r")).toBeNull();
    expect(releaseScriptOf(["bun", "build", "scripts/release.ts"], "/r")).toBeNull();
    expect(releaseScriptOf(["bash", "-n", "scripts/release.sh"], "/r")).toBeNull();
    expect(releaseScriptOf(["deno", "check", "scripts/release.ts"], "/r")).toBeNull();
  });

  test("another script is none", () => {
    expect(releaseScriptOf(["bun", "./scripts/land.ts", "feature/x"], "/r")).toBeNull();
    expect(releaseScriptOf(["bun", "test", "scripts/release.test.ts"], "/r")).toBeNull();
    expect(releaseScriptOf(["cat", "scripts/release.ts"], "/r")).toBeNull();
  });
});

describe("packageScriptOf", () => {
  test("a run of a package.json script, its arguments and its directory", () => {
    expect(packageScriptOf(["bun", "run", "release", "x"], "/r")).toEqual({
      name: "release",
      cwd: "/r",
      args: ["x"],
    });
    expect(packageScriptOf(["npm", "run", "release", "--", "--dry-run"], "/r")?.args).toEqual([
      "--dry-run",
    ]);
    expect(packageScriptOf(["pnpm", "-C", "sub", "release"], "/r")?.cwd).toBe("/r/sub");
    expect(packageScriptOf(["yarn", "release"], "/r")?.name).toBe("release");
  });

  test("a file is no package script", () => {
    expect(packageScriptOf(["bun", "run", "scripts/release.ts"], "/r")).toBeNull();
    expect(packageScriptOf(["node", "release"], "/r")).toBeNull();
  });
});

describe("profiledMergeRefusal", () => {
  test("allows a green, mergeable pull request into the trunk", () => {
    expect(profiledMergeRefusal(pr(), LANDING, true)).toBeNull();
  });

  test("refuses a merge into the release", () => {
    expect(profiledMergeRefusal(pr({ baseRefName: "main" }), LANDING, true)).toContain(
      "gh pr edit 7 --base dev",
    );
  });

  test("refuses red and running checks, naming each", () => {
    const checks = [
      check("validate", "FAILURE", "1"),
      check("e2e", "IN_PROGRESS", "1"),
      check("scope", "SKIPPED", "1"),
    ];

    expect(profiledMergeRefusal(pr({ checks }), LANDING, true)).toBe(
      "agent-hooks: checks not green on #7: validate failure, e2e in_progress. Wait for the running ones (gh pr checks 7 --watch) and fix the red ones before merging.",
    );
  });

  test("reads the newest run of each check", () => {
    const checks = [
      check("validate", "FAILURE", "2026-01-01T00:00:00Z"),
      check("validate", "SUCCESS", "2026-01-02T00:00:00Z"),
    ];

    expect(latestChecks(checks)).toEqual(checks.slice(1));
    expect(profiledMergeRefusal(pr({ checks }), LANDING, true)).toBeNull();
  });

  test("keeps a run of each workflow and event, as gh pr checks does", () => {
    const failedPullRequest = check("e2e", "FAILURE", "2026-01-01T00:00:00Z");
    const skippedPush = { ...check("e2e", "SKIPPED", "2026-01-02T00:00:00Z"), event: "push" };

    const otherWorkflow = {
      ...check("e2e", "SUCCESS", "2026-01-03T00:00:00Z"),
      workflow: "Nightly",
    };

    const checks = [failedPullRequest, skippedPush, otherWorkflow];

    expect(latestChecks(checks)).toEqual(checks);
    expect(profiledMergeRefusal(pr({ checks }), LANDING, true)).toContain(
      "checks not green on #7: e2e failure",
    );
  });

  test("refuses a head with no check yet", () => {
    expect(profiledMergeRefusal(pr({ checks: [] }), LANDING, true)).toContain(
      "no check reported on #7's head yet",
    );
  });

  test("with --auto, lets running checks and no check yet wait for green", () => {
    const running = [check("validate", "IN_PROGRESS", "1")];

    expect(profiledMergeRefusal(pr({ checks: running }), LANDING, true, true)).toBeNull();
    expect(profiledMergeRefusal(pr({ checks: [] }), LANDING, true, true)).toBeNull();
    expect(
      profiledMergeRefusal(
        pr({ checks: [check("validate", "FAILURE", "1")] }),
        LANDING,
        true,
        true,
      ),
    ).toContain("checks not green on #7: validate failure");
    expect(profiledMergeRefusal(pr({ baseRefName: "main" }), LANDING, true, true)).toContain(
      "#7 merges into 'main', the release",
    );
  });

  test("refuses a pull request that is not mergeable", () => {
    expect(profiledMergeRefusal(pr({ mergeable: "CONFLICTING" }), LANDING, true)).toContain(
      "#7 is not mergeable (conflicting)",
    );
    expect(profiledMergeRefusal(pr({ mergeable: "UNKNOWN" }), LANDING, true)).toContain(
      "not mergeable (unknown)",
    );
  });
});

describe("publicMergeRefusal", () => {
  test("refuses a merge into the default branch of a public repository", () => {
    expect(publicMergeRefusal(pr({ baseRefName: "main" }), PUBLIC, "github.com/o/n")).toContain(
      "#7 merges into 'main', the default branch of the public repository github.com/o/n",
    );
  });

  test("allows another base, or a private repository", () => {
    expect(publicMergeRefusal(pr(), PUBLIC, "s")).toBeNull();
    expect(
      publicMergeRefusal(
        pr({ baseRefName: "main" }),
        { visibility: "PRIVATE", defaultBranch: "main" },
        "s",
      ),
    ).toBeNull();
  });
});

describe("githubSlugOf", () => {
  const cases = [
    ["git@github.com:bengous/claude-code-plugins.git", "github.com/bengous/claude-code-plugins"],
    ["https://github.com/bengous/dotfiles", "github.com/bengous/dotfiles"],
    ["https://token@github.com/o/n.git/", "github.com/o/n"],
    ["ssh://git@github.com:22/o/n.git", "github.com/o/n"],
    ["git://example.com/o/n", "example.com/o/n"],
  ] as const;

  for (const [url, slug] of cases) {
    test(`${url} is ${slug}`, () => {
      expect(githubSlugOf(url)).toBe(slug);
    });
  }

  test("a local path or a bare name is none", () => {
    expect(githubSlugOf("/srv/git/repo.git")).toBeNull();
    expect(githubSlugOf("../other")).toBeNull();
    expect(githubSlugOf("file:///srv/repo")).toBeNull();
  });

  test("a --repo value gives its repository", () => {
    expect(slugOfRepoOption("o/n")).toBe("github.com/o/n");
    expect(slugOfRepoOption("ghe.example.com/o/n")).toBe("ghe.example.com/o/n");
    expect(slugOfRepoOption("https://github.com/o/n.git")).toBe("github.com/o/n");
    expect(slugOfRepoOption("n")).toBeNull();
  });

  test("a pull request URL gives its repository", () => {
    expect(slugOfPullRequest("https://github.com/o/n/pull/12")).toBe("github.com/o/n");
    expect(slugOfPullRequest("not a url")).toBeNull();
  });
});
