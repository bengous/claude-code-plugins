import { describe, expect, test } from "bun:test";

import { EVERY_BRANCH } from "./argv.ts";
import type { Check, PullRequestFacts, RepoFacts } from "./github.ts";
import {
  approvingPhrase,
  dispatchRefusal,
  labelRefusal,
  latestChecks,
  profiledMergeRefusal,
  profiledPushRefusal,
  publicMergeRefusal,
  publicPushRefusal,
} from "./refusals.ts";

const LANDING = { trunk: "dev", release: "main", by: "agent" } as const;

const BY_ACTION = { ...LANDING, by: "action" } as const;

const PUBLIC: RepoFacts = { visibility: "PUBLIC", defaultBranch: "main" };

function check(name: string, state: string, startedAt: string): Check {
  return { name, state, startedAt, workflow: "CI", event: "pull_request" };
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

describe("profiledPushRefusal where the landing action moves the trunk", () => {
  test("refuses every push to the trunk, plain ones included, naming the pull request way", () => {
    for (const target of [
      { ref: "dev", forced: false, deleted: false },
      { ref: "dev", forced: true, deleted: false },
      { ref: "dev", forced: false, deleted: true },
    ]) {
      expect(profiledPushRefusal([target], BY_ACTION, false)).toBe(
        "agent-hooks: 'dev' moves only through the landing action, never by an agent's push. Push your task branch and open a pull request to 'dev': the landing action fast-forwards 'dev' to its head once its run is green.",
      );
    }
  });

  test("refuses a push to the release without telling to push to the trunk", () => {
    const reason = profiledPushRefusal(
      [{ ref: "main", forced: false, deleted: false }],
      BY_ACTION,
      true,
    );

    expect(reason).toContain("the release is the human's. Push your task branch");
    expect(reason).not.toContain("push it there");
    expect(reason).not.toContain("land.ts");
  });

  test("allows a task branch, forced or not", () => {
    expect(
      profiledPushRefusal([{ ref: "fix/x", forced: true, deleted: false }], BY_ACTION, false),
    ).toBeNull();
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

  test("refuses a pull request that is not mergeable", () => {
    expect(profiledMergeRefusal(pr({ mergeable: "CONFLICTING" }), LANDING, true)).toContain(
      "#7 is not mergeable (conflicting)",
    );
    expect(profiledMergeRefusal(pr({ mergeable: "UNKNOWN" }), LANDING, true)).toContain(
      "not mergeable (unknown)",
    );
  });
});

describe("profiledMergeRefusal where the landing action moves the trunk", () => {
  test("refuses a green merge into the trunk, which the action makes", () => {
    expect(profiledMergeRefusal(pr(), BY_ACTION, false)).toBe(
      "agent-hooks: #7 lands on 'dev' through the landing action alone, which fast-forwards 'dev' to its head once its run is green: leave the merge to it.",
    );
  });

  test("refuses a merge into the release, naming the action", () => {
    expect(profiledMergeRefusal(pr({ baseRefName: "main" }), BY_ACTION, true)).toContain(
      "gh pr edit 7 --base dev), then leave it to the landing action",
    );
  });
});

describe("approvingPhrase", () => {
  const release = ["on publie", "publie", "release"];

  test("finds a phrase as words of its own, any case, any whitespace", () => {
    expect(approvingPhrase("Ok, on publie !", release, null, "anywhere")).toBe("on publie");
    expect(approvingPhrase("ON\n  PUBLIE", release, null, "anywhere")).toBe("on publie");
    expect(approvingPhrase("go for the Release", release, null, "anywhere")).toBe("release");
    expect(approvingPhrase("publie la 1.2", release, null, "anywhere")).toBe("publie");
  });

  test("a phrase inside a longer word is none", () => {
    expect(approvingPhrase("on publiera demain", release, null, "anywhere")).toBeNull();
    expect(approvingPhrase("c'est publié", release, null, "anywhere")).toBeNull();
    expect(approvingPhrase("the releases page", release, null, "anywhere")).toBeNull();
    expect(approvingPhrase("prerelease", release, null, "anywhere")).toBeNull();
  });

  test("puts the pull request's number in place of {pr}, which must match whole", () => {
    const ok = ["ok #{pr}", "ok pour la #{pr}"];

    expect(approvingPhrase("ok #12", ok, 12, "anywhere")).toBe("ok #{pr}");
    expect(approvingPhrase("OK pour la #12, merci", ok, 12, "anywhere")).toBe("ok pour la #{pr}");
    expect(approvingPhrase("ok #12", ok, 1, "anywhere")).toBeNull();
    expect(approvingPhrase("ok #123", ok, 12, "anywhere")).toBeNull();
    expect(approvingPhrase("ok #12", ok, 123, "anywhere")).toBeNull();
    expect(approvingPhrase("ok", ok, 12, "anywhere")).toBeNull();
  });

  test("reads a phrase's characters literally", () => {
    expect(approvingPhrase("go (v2)", ["go (v2)"], null, "anywhere")).toBe("go (v2)");
    expect(approvingPhrase("go xv2y", ["go (v2)"], null, "anywhere")).toBeNull();
  });

  test("at line start, takes a phrase that opens the message or one of its lines, and no other", () => {
    const land = ["land #{pr}", "land {pr}"];

    expect(approvingPhrase("land #443", land, 443, "line start")).toBe("land #{pr}");
    expect(approvingPhrase("  Land 442 puis calibre", land, 442, "line start")).toBe("land {pr}");
    expect(approvingPhrase("land #12\nland #13", land, 13, "line start")).toBe("land #{pr}");
    expect(approvingPhrase("don't land 12", land, 12, "line start")).toBeNull();
    expect(approvingPhrase("ne land pas 12, land 13 plutôt", land, 13, "line start")).toBeNull();
    expect(approvingPhrase("ok, land #12", land, 12, "line start")).toBeNull();
  });
});

describe("dispatchRefusal and labelRefusal", () => {
  const release = { name: "release.yml", phrases: ["on publie", "release"] };
  const okHumain = { name: "ok-humain", phrases: ["ok #{pr}", "ok pour la #{pr}"] };

  test("pass on the human's latest message", () => {
    expect(dispatchRefusal(release, { kind: "read", text: "on publie" })).toBeNull();
    expect(labelRefusal(okHumain, [12], { kind: "read", text: "ok pour la #12" })).toBeNull();
  });

  test("refuse a message that does not say so, naming the phrases and the pull request", () => {
    expect(dispatchRefusal(release, { kind: "read", text: "merci" })).toBe(
      `agent-hooks: dispatching release.yml is the human's decision, and the human's latest message does not say so (it would hold one of "on publie", "release"). Ask the human whether to run it, and dispatch it once their own message says so.`,
    );
    expect(labelRefusal(okHumain, [12], { kind: "read", text: "ok #11" })).toBe(
      `agent-hooks: the label ok-humain on #12 is the human's ok on that pull request, and the human's latest message does not say so (it would open a line with one of "ok #12", "ok pour la #12"). Ask the human for their ok on #12, and add the label once their own message gives it.`,
    );
    expect(labelRefusal(okHumain, [12], { kind: "read", text: "pas ok #12" })).not.toBeNull();
  });

  test("refuse a session with no typed message, a transcript that cannot be read, a label with no number", () => {
    expect(dispatchRefusal(release, { kind: "read", text: null })).toContain(
      "the session holds no message the human typed",
    );
    expect(labelRefusal(okHumain, [12], { kind: "unreadable", why: "no transcript" })).toContain(
      "the guard cannot read the human's latest message (no transcript)",
    );
    expect(labelRefusal(okHumain, null, { kind: "read", text: "ok #12" })).toContain(
      "this command does not name each it labels by its number",
    );
    expect(labelRefusal(okHumain, [12, 13], { kind: "read", text: "ok #12" })).toContain(
      "the label ok-humain on #13",
    );
    expect(labelRefusal(okHumain, [12, 13], { kind: "read", text: "ok #12\nok #13" })).toBeNull();
    expect(labelRefusal(okHumain, [12, 13], { kind: "read", text: "ok #12, ok #13" })).toContain(
      "the label ok-humain on #13",
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
