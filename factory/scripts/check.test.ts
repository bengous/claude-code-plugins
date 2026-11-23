import { describe, expect, test } from "bun:test";

import {
  type Ci,
  ciNameOf,
  evaluate,
  type Facts,
  format,
  isTierValidated,
  LABELS,
  parseRepositoryLines,
  parseRuleLines,
  parseWorkflow,
  repoArgument,
  requiredFiles,
} from "./check.ts";

const CI_WORKFLOW = `name: CI
on:
  pull_request:
  merge_group:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
`;

const CI: Ci = {
  kind: "read",
  name: "CI",
  workflow: parseWorkflow(CI_WORKFLOW) ?? {
    events: new Set(),
    pushBranches: null,
    jobs: new Set(),
  },
};

const COMPLETE: Facts = {
  repo: "o/r",
  defaultBranch: "main",
  isPrivate: false,
  allowAutoMerge: true,
  labels: new Set([...LABELS.map(({ name }) => name), "bug"]),
  files: new Set(requiredFiles()),
  hooksInstalled: true,
  ci: CI,
  tierValidated: true,
  workflowToken: "read",
  rules: parseRuleLines(
    [
      "ruleset 7",
      "threads",
      "ruleset 7",
      "check test",
      "check review",
      "check owner-gate",
      "ruleset 7",
      "queue",
      "ruleset 7",
    ].join("\n"),
  ),
  secrets: { kind: "listed", names: new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ROUTINE_FIRE_TOKEN"]) },
};

const NO_RULES = parseRuleLines("");

const missing = (facts: Facts): string[] =>
  evaluate(facts)
    .filter((item) => !item.ok)
    .map(({ name }) => name);

describe("evaluate", () => {
  test("a repository set up like the trial is all ok", () => {
    expect(missing(COMPLETE)).toEqual([]);
  });

  test("every label of the factory's states is asked for", () => {
    expect(missing({ ...COMPLETE, labels: new Set() })).toEqual([
      "label ready",
      "label in-progress",
      "label blocked",
      "label needs-human",
      "label trunk-red",
      "label tier:low",
      "label tier:human",
      "label human-approved",
    ]);
    expect(format(evaluate({ ...COMPLETE, labels: new Set() }))).toContain(
      "missing  label human-approved: gh label create human-approved --repo o/r --description 'The owner approves this pull request'\\''s head commit'",
    );
  });

  test("names each file the default branch lacks, the tier script and the verify skill included", () => {
    const files = new Set(
      requiredFiles().filter(
        (path) => !path.includes("tier") && !path.includes("verify") && path !== "CLAUDE.md",
      ),
    );

    expect(missing({ ...COMPLETE, files })).toEqual([
      ".claude/hooks/require-verify.sh on main",
      ".github/factory/tier-cases.json on main",
      ".github/factory/tier-prompt.md on main",
      ".github/factory/tier.json on main",
      ".github/factory/tier.ts on main",
      ".claude/skills/verify/SKILL.md on main",
      "CLAUDE.md on main",
    ]);
    expect(format(evaluate({ ...COMPLETE, files }))).toContain(
      "missing  .claude/skills/verify/SKILL.md on main: record the verify recipe, step 4 of /factory:install, then land it on main",
    );
  });

  test("requires the two new workflows and the settings file among the files", () => {
    expect(requiredFiles()).toEqual(
      expect.arrayContaining([
        ".github/workflows/conflict.yml",
        ".github/workflows/trunk-red.yml",
        ".github/workflows/owner-gate.yml",
        ".claude/settings.json",
      ]),
    );
  });

  test("a settings file without the verify hooks is missing them", () => {
    expect(missing({ ...COMPLETE, hooksInstalled: false })).toEqual([
      ".claude/settings.json runs the two verify hooks",
    ]);
  });

  test("a repository without a merge queue is all ok, and its line says what stands in for it", () => {
    const rules = parseRuleLines(
      "ruleset 7\nthreads\ncheck test\ncheck review\ncheck owner-gate\n",
    );

    const items = evaluate({ ...COMPLETE, rules });

    expect(items.filter((item) => !item.ok)).toEqual([]);
    expect(format(items)).toContain(
      "ok       main has no merge queue: a pull request merges once its checks pass; conflict.yml marks one that conflicts, and trunk-red.yml has a red main repaired",
    );
    expect(format(evaluate(COMPLETE))).toContain("ok       main has a merge queue\n");
  });

  test("a bare ruleset, no auto-merge and no secret are each missing with their fix", () => {
    const bare: Facts = {
      ...COMPLETE,
      allowAutoMerge: false,
      rules: NO_RULES,
      secrets: { kind: "listed", names: new Set() },
    };

    const text = format(evaluate(bare));

    for (const line of [
      "missing  main requires the check test: gh api -X POST repos/o/r/rulesets --input ruleset.json",
      "missing  main requires the check review: gh api -X POST repos/o/r/rulesets --input ruleset.json",
      "missing  main requires the check owner-gate: gh api -X POST repos/o/r/rulesets --input ruleset.json",
      "missing  main requires resolved review threads: gh api -X POST repos/o/r/rulesets --input ruleset.json",
      "missing  auto-merge allowed: gh repo edit o/r --enable-auto-merge",
      "missing  secret CLAUDE_CODE_OAUTH_TOKEN: gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo o/r",
      "missing  secret ROUTINE_FIRE_TOKEN: gh secret set ROUTINE_FIRE_TOKEN --repo o/r",
    ]) {
      expect(text).toContain(line);
    }
  });

  test("an existing repository ruleset is updated in place", () => {
    const items = evaluate({ ...COMPLETE, rules: parseRuleLines("ruleset 9\n") }).filter(
      (item) => !item.ok,
    );

    expect(items.map(({ name }) => name)).toEqual([
      "main requires the check test",
      "main requires the check review",
      "main requires the check owner-gate",
      "main requires resolved review threads",
    ]);
    expect(new Set(items.map(({ fix }) => fix))).toEqual(
      new Set(["gh api -X PUT repos/o/r/rulesets/9 --input ruleset.json"]),
    );
  });

  test("an auto-merge setting the token cannot see is missing and says so", () => {
    expect(missing({ ...COMPLETE, allowAutoMerge: null })).toEqual([
      "auto-merge allowed (not visible to this token)",
    ]);
  });

  test("a private repository is told what its workflows' token may do by default", () => {
    const text = format(evaluate({ ...COMPLETE, isPrivate: true }));

    expect(text).toContain(
      "ok       private repository: a workflow's token defaults to read. The factory's workflows declare what they need; a job of your own that reads more than the code, pull requests included, declares its permissions too",
    );
    expect(format(evaluate(COMPLETE))).not.toContain("private repository");
    expect(format(evaluate({ ...COMPLETE, isPrivate: true, workflowToken: null }))).toContain(
      "defaults to a level this token cannot see",
    );
  });

  test("says whether the classifier is trusted, and never counts it missing", () => {
    expect(format(evaluate(COMPLETE))).toContain(
      "ok       tier cases validated: the classifier judges what passes the floor",
    );
    expect(format(evaluate({ ...COMPLETE, tierValidated: false }))).toContain(
      "ok       tier cases not validated: the floor runs alone, and every change waits for the owner",
    );
  });
});

function withWorkflow(text: string): Facts {
  const workflow = parseWorkflow(text);

  if (workflow === null) throw new Error("not a workflow");

  return { ...COMPLETE, ci: { kind: "read", name: "CI", workflow } };
}

describe("the CI workflow", () => {
  test("a workflow without a test job, off pull requests or off the trunk is reported", () => {
    expect(
      missing(withWorkflow("on:\n  push:\n    branches: [release]\njobs:\n  build: {}\n")),
    ).toEqual([
      'the CI workflow "CI" has a job named test',
      'the CI workflow "CI" runs on pull_request',
      'the CI workflow "CI" runs on push to main',
      'the CI workflow "CI" runs on merge_group',
    ]);
  });

  test("a job named test by its name, and a push with no branch filter, count", () => {
    expect(
      missing(
        withWorkflow("on: [push, pull_request, merge_group]\njobs:\n  unit:\n    name: test\n"),
      ),
    ).toEqual([]);
  });

  test("merge_group is asked for only where the default branch has a merge queue", () => {
    const facts = withWorkflow("on: [push, pull_request]\njobs:\n  test: {}\n");

    expect(missing(facts)).toEqual(['the CI workflow "CI" runs on merge_group']);
    expect(
      missing({
        ...facts,
        rules: parseRuleLines("threads\ncheck test\ncheck review\ncheck owner-gate\n"),
      }),
    ).toEqual([]);
  });

  test("a trunk-red.yml that names no workflow, or one that does not exist, is reported", () => {
    expect(missing({ ...COMPLETE, ci: { kind: "unnamed" } })).toEqual([
      "trunk-red.yml names the CI workflow",
    ]);
    expect(missing({ ...COMPLETE, ci: { kind: "absent", name: "Build" } })).toEqual([
      'the CI workflow "Build", which trunk-red.yml listens to, exists',
    ]);
  });

  test("ciNameOf reads the name the install wrote", () => {
    expect(ciNameOf('on:\n  workflow_run:\n    workflows: ["Build & test"]\n')).toBe(
      "Build & test",
    );
    expect(ciNameOf("on:\n  workflow_run:\n    workflows: [CI]\n")).toBeNull();
  });

  test("parseWorkflow refuses what is not a workflow", () => {
    expect(parseWorkflow("just: text")).toBeNull();
    expect(parseWorkflow(": : :")).toBeNull();
  });
});

describe("isTierValidated", () => {
  test.each([
    ['{"model": "claude-haiku-5-5", "prompt": "3d3b36cfa7c1", "cases": []}', true],
    ['{"model": null, "prompt": null, "cases": []}', false],
    ["not json", false],
    [null, false],
  ])("%p", (cases, validated) => {
    expect(isTierValidated(cases)).toBe(validated);
  });
});

describe("parseRuleLines", () => {
  test("keeps the first repository ruleset and every check", () => {
    expect(parseRuleLines("ruleset 3\ncheck a b\nruleset 4\nqueue\n")).toEqual({
      checks: new Set(["a b"]),
      threadsResolved: false,
      mergeQueue: true,
      rulesetId: "3",
    });
  });

  test("refuses a line it does not know", () => {
    expect(() => parseRuleLines("deletion\n")).toThrow("a line it should not: deletion");
  });
});

describe("parseRepositoryLines", () => {
  test.each([
    ["main\ntrue\nfalse\n", true, false],
    ["main\nfalse\ntrue\n", false, true],
    ["main\nunknown\nfalse\n", null, false],
    ["main\nnull\ntrue\n", null, true],
  ])("%p", (text, allowAutoMerge, isPrivate) => {
    expect(parseRepositoryLines(text)).toEqual({
      defaultBranch: "main",
      allowAutoMerge,
      isPrivate,
    });
  });

  test("refuses an answer missing a line", () => {
    expect(() => parseRepositoryLines("main\ntrue\n")).toThrow("the repository query printed");
  });
});

describe("secrets the token cannot list", () => {
  test("each is reported not visible, with the reason, and missing", () => {
    expect(
      missing({
        ...COMPLETE,
        secrets: { kind: "hidden", reason: "HTTP 403: Resource not accessible" },
      }),
    ).toEqual([
      "secret CLAUDE_CODE_OAUTH_TOKEN (not visible: HTTP 403: Resource not accessible)",
      "secret ROUTINE_FIRE_TOKEN (not visible: HTTP 403: Resource not accessible)",
    ]);
  });
});

describe("repoArgument", () => {
  test.each([[["--repo", "o/r"]], [["--repo=o/r"]]])("%p", (argv) => {
    expect(repoArgument(argv)).toEqual({ repo: "o/r" });
  });

  test("help", () => {
    expect(repoArgument(["-h"])).toBeNull();
  });

  test.each([
    [[], "--repo is missing"],
    [["--repo=o"], '--repo is not owner/name: "o"'],
    [["--repo", "o/r", "extra"], "Unexpected argument 'extra'"],
    [["--rep", "o/r"], "Unknown option '--rep'"],
  ])("refuses %p with a reason", (argv, reason) => {
    const parsed = repoArgument(argv);

    expect(parsed !== null && "error" in parsed && parsed.error).toContain(reason);
  });
});
