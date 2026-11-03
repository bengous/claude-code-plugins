import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parse } from "yaml";

import type { GitResult } from "../../tools/platform/git.ts";
import {
  admit,
  APP_LOGIN,
  decide,
  type Gh,
  type Git,
  markerOf,
  place,
  type Placed,
  type PullRequest,
  report,
  type Run,
  tierOf,
} from "./red-dev-land.ts";

const REPO = "o/r";

const SHA = "b4c89e32c29adb12598a20b4ec66e65bfa007eeb";

const DEV = "1111111111111111111111111111111111111111";

const RUN: Run = {
  event: "pull_request",
  conclusion: "success",
  headBranch: "fix/red-dev-489",
  headSha: SHA,
  headRepository: REPO,
};

const PR: PullRequest = {
  number: 490,
  headSha: SHA,
  base: "dev",
  crossRepository: false,
  draft: false,
  comments: [],
};

const answer = (sha: string, login = APP_LOGIN) => ({ login, body: `done\n\n${markerOf(sha)}` });

describe("admit", () => {
  test("a green pull request run of an open fix/red-dev-<issue> to dev, at its head, is judged", () => {
    expect(admit(REPO, RUN, [PR])).toEqual({ kind: "judge", pr: 490, sha: SHA });
  });

  test("a run of another event, branch, repository or conclusion is left alone, and says why", () => {
    const cases: [Partial<Run>, string][] = [
      [{ event: "push" }, "the run's event is push, not pull_request"],
      [{ headBranch: "fix/red-dev-x" }, "the run's branch fix/red-dev-x is no fix/red-dev-<issue>"],
      [{ headBranch: "feature/red-dev-489" }, "is no fix/red-dev-<issue>"],
      [{ headBranch: "fix/red-dev-489/more" }, "is no fix/red-dev-<issue>"],
      [{ headRepository: "fork/r" }, "the run's head is in fork/r, not in o/r"],
      [{ conclusion: "failure" }, "ended failure, not success"],
      [{ conclusion: "cancelled" }, "ended cancelled, not success"],
    ];

    for (const [fields, reason] of cases) {
      const admission = admit(REPO, { ...RUN, ...fields }, [PR]);

      expect(admission.kind).toBe("none");
      expect(admission.kind === "none" && admission.reason).toContain(reason);
    }
  });

  test("a pull request missing, from a fork, moved on, to another base, a draft, or answered is left alone", () => {
    const cases: [readonly PullRequest[], string][] = [
      [[], "no open pull request comes from fix/red-dev-489 in o/r"],
      [[{ ...PR, crossRepository: true }], "no open pull request comes from"],
      [[{ ...PR, headSha: "ccc" }], `#490's head is ccc, no longer the run's ${SHA}`],
      [[{ ...PR, base: "main" }], "#490 targets main, not dev"],
      [[{ ...PR, draft: true }], "#490 is a draft"],
      [[{ ...PR, comments: [answer(SHA)] }], `#490 is answered already at ${SHA}`],
    ];

    for (const [prs, reason] of cases) {
      const admission = admit(REPO, RUN, prs);

      expect(admission.kind).toBe("none");
      expect(admission.kind === "none" && admission.reason).toContain(reason);
    }
  });

  test("a fork's pull request of the same branch name gives way to this repository's", () => {
    expect(admit(REPO, RUN, [{ ...PR, number: 7, crossRepository: true }, PR])).toEqual({
      kind: "judge",
      pr: 490,
      sha: SHA,
    });
  });

  test("an answer to an earlier head does not hold back the new one", () => {
    expect(admit(REPO, RUN, [{ ...PR, comments: [answer("aaa")] }]).kind).toBe("judge");
  });

  test("a marker in a comment by anyone but the App counts for nothing", () => {
    for (const login of ["bengous", "bengous-agents", "github-actions[bot]"]) {
      expect(admit(REPO, RUN, [{ ...PR, comments: [answer(SHA, login)] }]).kind).toBe("judge");
    }
  });
});

describe("tierOf", () => {
  test("reads tier.ts's line", () => {
    expect(tierOf("low a test fix\n")).toEqual({ tier: "low", reason: "a test fix" });
    expect(tierOf("human touches a risky path\n")).toEqual({
      tier: "human",
      reason: "touches a risky path",
    });
  });

  test("anything else reads human", () => {
    for (const output of ["", "medium why", "low", "LOW fine"]) {
      expect(tierOf(output).tier).toBe("human");
    }
  });
});

describe("place", () => {
  const placed: Placed = {
    pr: 490,
    sha: SHA,
    devSha: DEV,
    devIsAncestor: true,
    paths: ["scripts/x.ts"],
  };

  test("a head dev is an ancestor of, off the e2e paths, goes to the tier", () => {
    expect(place(placed)).toBeNull();
  });

  test("a head on dev already changes nothing, and claims no push", () => {
    expect(place({ ...placed, devSha: SHA, paths: [] })).toEqual({
      kind: "none",
      reason: `${SHA} is on dev already`,
    });
  });

  test("dev moved: a marked comment, nothing pushed", () => {
    const action = place({ ...placed, devIsAncestor: false });

    expect(action?.kind).toBe("comment");
    expect(action?.kind === "comment" && action.body).toContain("`dev` moved");
    expect(action?.kind === "comment" && action.body).toEndWith(markerOf(SHA));
  });

  test("a head that touches the e2e paths is left to a human, the path named", () => {
    const action = place({ ...placed, paths: ["scripts/x.ts", "vellum/src/page/app.tsx"] });

    expect(action?.kind).toBe("comment");
    expect(action?.kind === "comment" && action.body).toContain("`vellum/src/page/app.tsx`");
    expect(action?.kind === "comment" && action.body).toContain("`e2e`");
    expect(action?.kind === "comment" && action.body).toEndWith(markerOf(SHA));
  });

  test("a path check-e2e-green.ts leaves out does not hold the head back", () => {
    expect(
      place({ ...placed, paths: ["vellum/skills/x/SKILL.md", "vellum/a.test.ts"] }),
    ).toBeNull();
  });
});

describe("decide", () => {
  test("low pushes, and says so on the pull request", () => {
    expect(decide(490, SHA, { tier: "low", reason: "a test fix" })).toEqual({
      kind: "push",
      pr: 490,
      sha: SHA,
      comment: `red-dev-land pushed ${SHA} to \`dev\`, a fast-forward: its tier is \`low\`, a test fix\n\n${markerOf(SHA)}`,
    });
  });

  test("human comments with the reason and land.ts", () => {
    expect(decide(490, SHA, { tier: "human", reason: "touches a risky path" })).toEqual({
      kind: "comment",
      pr: 490,
      body: `red-dev-land leaves ${SHA} to a human: its tier is \`human\`, touches a risky path\n\nA human lands it with \`bun ./scripts/land.ts <branch>\`.\n\n${markerOf(SHA)}`,
    });
  });
});

const ENV = {
  GITHUB_REPOSITORY: REPO,
  RUN_EVENT: RUN.event,
  RUN_CONCLUSION: RUN.conclusion,
  RUN_HEAD_BRANCH: RUN.headBranch,
  RUN_HEAD_SHA: RUN.headSha,
  RUN_HEAD_REPOSITORY: RUN.headRepository,
};

const exited = (code: number, stdout = ""): Promise<GitResult> =>
  Promise.resolve({ kind: "exited", code, stdout, stderr: code === 0 ? "" : "boom" });

interface WorldFields {
  prs?: PullRequest[];
  tier?: () => Promise<string>;
  ancestor?: number;
  devSha?: string;
  paths?: string[];
}

/** GitHub and git as red-dev-land sees them: the open pull requests, dev, the pushes. */
function world(fields: WorldFields) {
  const calls: string[] = [];
  const comments: string[] = [];
  const pushes: string[] = [];
  const prs = fields.prs ?? [PR];

  const gh: Gh = (args) => {
    calls.push(`gh ${args.join(" ")}`);
    const [command, sub] = args;

    if (command === "pr" && sub === "list") {
      return Promise.resolve(
        JSON.stringify(
          prs.map((pr) => ({
            number: pr.number,
            headRefOid: pr.headSha,
            baseRefName: pr.base,
            isCrossRepository: pr.crossRepository,
            isDraft: pr.draft,
          })),
        ),
      );
    }

    const listed = /^repos\/o\/r\/issues\/(\d+)\/comments\?per_page=100$/u.exec(args[2] ?? "");

    if (command === "api" && sub === "--paginate" && listed !== null) {
      const pr = prs.find((found) => found.number === Number(listed[1]));

      return Promise.resolve(
        (pr?.comments ?? []).map((comment) => `${JSON.stringify(comment)}\n`).join(""),
      );
    }

    if (command === "pr" && sub === "comment") {
      comments.push(args[args.indexOf("--body") + 1] ?? "");

      return Promise.resolve("");
    }

    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };

  const git: Git = (args) => {
    calls.push(`git ${args.join(" ")}`);
    const [command] = args;

    if (command === "fetch") return exited(0);

    if (command === "rev-parse") return exited(0, `${fields.devSha ?? DEV}\n`);

    if (command === "merge-base") return exited(fields.ancestor ?? 0);

    if (command === "diff") return exited(0, (fields.paths ?? ["scripts/x.ts"]).join("\0"));

    if (command === "push") {
      pushes.push(args.at(-1) ?? "");

      return exited(0);
    }

    return Promise.reject(new Error(`unexpected git ${args.join(" ")}`));
  };

  const tier = (pr: number, sha: string): Promise<string> => {
    calls.push(`tier ${pr} ${sha}`);

    return fields.tier === undefined ? Promise.resolve("low a test fix\n") : fields.tier();
  };

  return { calls, comments, pushes, gh, git, tier };
}

describe("report", () => {
  test("a low head with dev its ancestor is pushed to dev, then the pull request says so", async () => {
    const { calls, comments, pushes, gh, git, tier } = world({});

    expect(await report(ENV, gh, git, tier)).toBe(`pushed ${SHA} to dev for #490`);
    expect(pushes).toEqual([`${SHA}:refs/heads/dev`]);
    expect(comments).toHaveLength(1);
    expect(calls).toContain(
      `git fetch --no-tags origin +refs/heads/dev:refs/remotes/origin/dev ${SHA}`,
    );
    expect(calls).toContain(`git merge-base --is-ancestor refs/remotes/origin/dev ${SHA}`);
    expect(calls).toContain(`git diff --name-only -z refs/remotes/origin/dev...${SHA}`);
    expect(calls.findIndex((call) => call.startsWith("git push"))).toBeLessThan(
      calls.findIndex((call) => call.startsWith("gh pr comment")),
    );
  });

  test("a human head, dev moved, or an e2e path comments and pushes nothing", async () => {
    const cases: WorldFields[] = [
      { tier: () => Promise.resolve("human risky\n") },
      { ancestor: 1 },
      { paths: ["mise.toml"] },
    ];

    for (const fields of cases) {
      const { comments, pushes, gh, git, tier } = world(fields);

      expect(await report(ENV, gh, git, tier)).toBe("commented on #490");
      expect(pushes).toEqual([]);
      expect(comments).toHaveLength(1);
    }
  });

  test("dev moved, an e2e path or a head on dev asks no tier", async () => {
    for (const fields of [{ ancestor: 1 }, { paths: ["mise.toml"] }, { devSha: SHA }]) {
      const { calls, gh, git, tier } = world(fields);
      await report(ENV, gh, git, tier);

      expect(calls.some((call) => call.startsWith("tier "))).toBe(false);
    }
  });

  test("a head on dev already: no push, no comment", async () => {
    const { comments, pushes, gh, git, tier } = world({ devSha: SHA, paths: [] });

    expect(await report(ENV, gh, git, tier)).toBe(`${SHA} is on dev already`);
    expect(pushes).toEqual([]);
    expect(comments).toEqual([]);
  });

  test("a head the App answered is left alone; anyone else's marker is not", async () => {
    const answered = world({ prs: [{ ...PR, comments: [answer(SHA)] }] });

    expect(await report(ENV, answered.gh, answered.git, answered.tier)).toBe(
      `#490 is answered already at ${SHA}`,
    );

    const typed = world({ prs: [{ ...PR, comments: [answer(SHA, "someone")] }] });

    expect(await report(ENV, typed.gh, typed.git, typed.tier)).toBe(
      `pushed ${SHA} to dev for #490`,
    );
  });

  test("a crash of tier.ts fails the run with no comment, so no marker is left", async () => {
    const { comments, pushes, gh, git, tier } = world({
      tier: () => Promise.reject(new Error("bun ./scripts/landing/tier.ts exited 1: boom")),
    });

    await expect(report(ENV, gh, git, tier)).rejects.toThrow("tier.ts exited 1");
    expect(pushes).toEqual([]);
    expect(comments).toEqual([]);
  });

  test("a run it does not admit reads no pull request, runs no tier and touches no git", async () => {
    const { calls, gh, git, tier } = world({});

    expect(await report({ ...ENV, RUN_EVENT: "push" }, gh, git, tier)).toBe(
      "the run's event is push, not pull_request",
    );
    expect(calls).toEqual([]);

    expect(await report({ ...ENV, RUN_CONCLUSION: "failure" }, gh, git, tier)).toContain(
      "not success",
    );
    expect(calls.every((call) => call.startsWith("gh "))).toBe(true);
  });

  test("a merge-base that fails stops the run, nothing pushed", async () => {
    const { pushes, comments, gh, git, tier } = world({ ancestor: 128 });

    await expect(report(ENV, gh, git, tier)).rejects.toThrow("git merge-base");
    expect(pushes).toEqual([]);
    expect(comments).toEqual([]);
  });

  test("refuses a run whose environment lacks a variable", async () => {
    const { gh, git, tier } = world({});

    await expect(report({ GITHUB_REPOSITORY: REPO }, gh, git, tier)).rejects.toThrow(
      "RUN_EVENT is unset",
    );
  });
});

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number>;
  env?: Record<string, string>;
}

interface Workflow {
  on?: unknown;
  concurrency?: unknown;
  permissions?: unknown;
  jobs: Record<string, { permissions?: unknown; steps: Step[] }>;
}

const workflowAt = async (path: string): Promise<Workflow> =>
  parse(await Bun.file(join(import.meta.dir, "..", "..", path)).text());

const pinOf = async (path: string, job: string): Promise<string | undefined> =>
  (await workflowAt(path)).jobs[job]?.steps.find((step) => step.name?.startsWith("Pin Claude Code"))
    ?.run;

describe("red-dev-land.yml", () => {
  test("wakes on each CI run completed on a fix/red-dev branch, one run per branch at a time", async () => {
    const workflow = await workflowAt(".github/workflows/red-dev-land.yml");

    expect(workflow.on).toEqual({
      workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["fix/red-dev-*"] },
    });
    expect(workflow.concurrency).toEqual({
      group: "red-dev-land-${{ github.event.workflow_run.head_branch }}",
      "cancel-in-progress": false,
    });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs["red-dev-land"]?.permissions).toBeUndefined();
  });

  test("runs the default branch's code, with the App's token, and never the pull request's", async () => {
    const steps = (await workflowAt(".github/workflows/red-dev-land.yml")).jobs["red-dev-land"]
      ?.steps;

    const checkout = steps?.find((step) => step.uses?.startsWith("actions/checkout@"));

    expect(checkout?.with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      "fetch-depth": 0,
      token: "${{ steps.app.outputs.token }}",
    });

    const land = steps?.find((step) => step.run === "bun ./scripts/ci/red-dev-land.ts");

    expect(land?.env?.["GH_TOKEN"]).toBe("${{ steps.app.outputs.token }}");
    expect(land?.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
  });

  test("pins Claude Code as ci.yml's validate does", async () => {
    const pin = await pinOf(".github/workflows/red-dev-land.yml", "red-dev-land");

    expect(pin).toBeString();
    expect(pin).toBe(await pinOf(".github/workflows/ci.yml", "validate"));
  });
});
