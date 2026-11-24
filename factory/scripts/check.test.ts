import { describe, expect, test } from "bun:test";

import { digestOf } from "../templates/repo/.github/factory/tier.ts";
import {
  actionsOf,
  bypassOf,
  type Ci,
  ciNameOf,
  evaluate,
  type Facts,
  format,
  LABELS,
  parseRepositoryLines,
  parseRuleLines,
  parseWorkflow,
  repoArgument,
  requiredFiles,
  tierStalenessOf,
  VERIFY_SKILL,
} from "./check.ts";
import { CLAUDE_MD_SECTIONS, readTemplates, REPO_PREFIX } from "./templates.ts";

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
    checks: new Set(),
    pathFiltered: [],
  },
};

const TEMPLATES = new Map(readTemplates().map(({ path, content }) => [path, content]));

const textOf = (path: string): string => {
  if (path === VERIFY_SKILL) return "---\nname: verify\ndescription: Verify a change.\n---\n";

  if (path === "CLAUDE.md") return TEMPLATES.get(CLAUDE_MD_SECTIONS) ?? "";

  return TEMPLATES.get(`${REPO_PREFIX}${path}`) ?? "{}";
};

const FILES = new Map(requiredFiles().map((path) => [path, textOf(path)]));

const COMPLETE: Facts = {
  repo: "o/r",
  defaultBranch: "main",
  isPrivate: false,
  allowAutoMerge: true,
  allowSquashMerge: true,
  labels: new Set([...LABELS.map(({ name }) => name), "bug"]),
  files: FILES,
  hooksInstalled: true,
  ci: CI,
  tierStale: null,
  workflowToken: "read",
  rules: parseRuleLines(
    [
      "ruleset 7",
      "applies 7",
      "threads",
      "ruleset 7",
      "applies 7",
      "check test",
      "check review",
      "check owner-gate",
      "ruleset 7",
      "applies 7",
      "queue",
      "ruleset 7",
      "applies 7",
    ].join("\n"),
  ),
  bypass: { kind: "read", rulesets: [] },
  actions: { kind: "read", enabled: true, allowed: "all" },
  secrets: { kind: "listed", names: new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ROUTINE_FIRE_TOKEN"]) },
};

const withFile = (path: string, text: string): Facts => ({
  ...COMPLETE,
  files: new Map([...FILES, [path, text]]),
});

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
    const files = new Map(
      [...FILES].filter(
        ([path]) => !path.includes("tier") && !path.includes("verify") && path !== "CLAUDE.md",
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

  test("requires the factory's workflows and the settings file among the files", () => {
    expect(requiredFiles()).toEqual(
      expect.arrayContaining([
        ".github/workflows/conflict.yml",
        ".github/workflows/trunk-red.yml",
        ".github/workflows/unclaim.yml",
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
    expect(
      format(evaluate({ ...COMPLETE, tierStale: "the floor runs alone: tier-prompt.md is a" })),
    ).toContain(
      "ok       tier cases not validated, every change waits for the owner: the floor runs alone: tier-prompt.md is a",
    );
  });
});

describe("what the required files say", () => {
  test("an older gate, review, CODEOWNERS, verify skill or CLAUDE.md is each missing with its fix", () => {
    const older: Facts = {
      ...COMPLETE,
      files: new Map([
        ...FILES,
        [".github/workflows/owner-gate.yml", "jobs:\n  gate:\n    run: echo approved\n"],
        [".github/workflows/review.yml", "jobs:\n  review: {}\n"],
        [".github/CODEOWNERS", "/.github/workflows/ @o\n/.claude/ @o\n# /CLAUDE.md @o\n"],
        [VERIFY_SKILL, "---\nname: verify\ndisable-model-invocation: true\n---\n"],
        ["CLAUDE.md", "# Rules\n\nStop on needs-human.\n"],
      ]),
    };

    expect(missing(older)).toEqual([
      ".github/workflows/owner-gate.yml runs .github/factory/tier.ts and reads the label human-approved",
      ".github/workflows/review.yml names the label needs-human",
      ".github/workflows/owner-gate.yml judges a pull request against the default branch only",
      ".github/workflows/review.yml judges a pull request against the default branch only",
      ".github/CODEOWNERS lists /.github/, /.claude/, /CLAUDE.md, and path prefixes from the root alone",
      ".claude/skills/verify/SKILL.md carries no disable-model-invocation: true",
      "CLAUDE.md names the labels needs-human and human-approved",
    ]);

    const text = format(evaluate(older));

    for (const line of [
      "missing  .github/workflows/owner-gate.yml runs .github/factory/tier.ts and reads the label human-approved: run install.ts repo with --force, which writes the template over it, then land it on main",
      "missing  .github/CODEOWNERS lists /.github/, /.claude/, /CLAUDE.md, and path prefixes from the root alone: add a line for each, owned by the owner, and remove every glob line and every path not written from the root: the owner gate reads path prefixes from the root alone, and holds every change for the owner when it meets another line, then land it on main",
      "missing  CLAUDE.md names the labels needs-human and human-approved: merge the factory's sections into CLAUDE.md, then land it on main",
    ]) {
      expect(text).toContain(line);
    }
  });

  test("the templates and the CLAUDE.md sections pass, each with its own ok line", () => {
    const text = format(evaluate(COMPLETE));

    expect(text).toContain(
      "ok       .github/workflows/owner-gate.yml runs .github/factory/tier.ts and reads the label human-approved\n",
    );
    expect(text).toContain(
      "ok       .github/CODEOWNERS lists /.github/, /.claude/, /CLAUDE.md, and path prefixes from the root alone\n",
    );
    expect(text).toContain(
      "ok       .claude/skills/verify/SKILL.md carries no disable-model-invocation: true\n",
    );
  });

  test("a CODEOWNERS with the three lines and a glob line is missing: the owner gate does not read it", () => {
    expect(
      missing(
        withFile(".github/CODEOWNERS", "/.github/ @o\n/.claude/ @o\n/CLAUDE.md @o\n*.js @o\n"),
      ),
    ).toEqual([
      ".github/CODEOWNERS lists /.github/, /.claude/, /CLAUDE.md, and path prefixes from the root alone",
    ]);
  });

  test("a verify skill with disable-model-invocation: false passes", () => {
    expect(
      missing(withFile(VERIFY_SKILL, "---\nname: verify\ndisable-model-invocation: false\n---\n")),
    ).toEqual([]);
  });
});

describe("the repository's settings", () => {
  test("squash merge disallowed, or not visible, is missing", () => {
    expect(format(evaluate({ ...COMPLETE, allowSquashMerge: false }))).toContain(
      "missing  squash merge allowed: gh repo edit o/r --enable-squash-merge",
    );
    expect(missing({ ...COMPLETE, allowSquashMerge: null })).toEqual([
      "squash merge allowed (not visible to this token)",
    ]);
  });

  test("a ruleset with a bypass actor is missing, and names each ruleset to update", () => {
    expect(
      format(evaluate({ ...COMPLETE, bypass: { kind: "read", rulesets: ["7", "9"] } })),
    ).toContain(
      'missing  main\'s rulesets have no bypass actor: write "bypass_actors": [] in ruleset.json, then gh api -X PUT repos/o/r/rulesets/7 --input ruleset.json and gh api -X PUT repos/o/r/rulesets/9 --input ruleset.json',
    );
  });

  test("bypass actors the token cannot read are not visible, and missing", () => {
    expect(
      missing({
        ...COMPLETE,
        bypass: { kind: "hidden", reason: "HTTP 403: Must have admin rights" },
      }),
    ).toEqual([
      "main's rulesets have no bypass actor (not visible: HTTP 403: Must have admin rights)",
    ]);
  });

  test.each([
    [{ kind: "read", enabled: true, allowed: "all" }, "ok       GitHub Actions runs every action"],
    [
      { kind: "read", enabled: true, allowed: "selected" },
      "ok       GitHub Actions runs selected actions only: the owner checks that it allows actions/checkout, oven-sh/setup-bun and anthropics/claude-code-action",
    ],
    [
      { kind: "read", enabled: true, allowed: "local_only" },
      "missing  GitHub Actions runs actions/checkout, oven-sh/setup-bun and anthropics/claude-code-action: gh api -X PUT repos/o/r/actions/permissions -F enabled=true -f allowed_actions=all, or allow actions/checkout, oven-sh/setup-bun and anthropics/claude-code-action",
    ],
    [
      { kind: "read", enabled: false, allowed: "none" },
      "missing  GitHub Actions enabled: gh api -X PUT repos/o/r/actions/permissions",
    ],
    [
      { kind: "hidden", reason: "HTTP 403: Resource not accessible" },
      "missing  GitHub Actions runs the workflows' actions (not visible: HTTP 403: Resource not accessible)",
    ],
  ] as const)("actions %p", (actions, line) => {
    expect(format(evaluate({ ...COMPLETE, actions }))).toContain(line);
  });
});

describe("bypassOf", () => {
  test("names the rulesets that have a bypass actor", () => {
    expect(
      bypassOf([
        { id: "7", answer: { kind: "ok", stdout: "0\n" } },
        { id: "9", answer: { kind: "ok", stdout: "2\n" } },
      ]),
    ).toEqual({ kind: "read", rulesets: ["9"] });
    expect(bypassOf([])).toEqual({ kind: "read", rulesets: [] });
  });

  test("a ruleset the token cannot read, or whose actors it may not see, hides them", () => {
    expect(
      bypassOf([{ id: "7", answer: { kind: "failed", reason: "HTTP 404: Not Found" } }]),
    ).toEqual({
      kind: "hidden",
      reason: "HTTP 404: Not Found",
    });
    expect(bypassOf([{ id: "7", answer: { kind: "ok", stdout: "unknown\n" } }])).toEqual({
      kind: "hidden",
      reason: "this token may not read the bypass actors of ruleset 7",
    });
  });

  test("refuses an answer that is not a count", () => {
    expect(() => bypassOf([{ id: "7", answer: { kind: "ok", stdout: "[]\n" } }])).toThrow(
      "the ruleset 7 query printed",
    );
  });
});

describe("actionsOf", () => {
  test.each([
    ["true all\n", { kind: "read", enabled: true, allowed: "all" }],
    ["false none\n", { kind: "read", enabled: false, allowed: "none" }],
  ] as const)("%p", (stdout, actions) => {
    expect(actionsOf({ kind: "ok", stdout })).toEqual(actions);
  });

  test("a failed read hides the setting; an unknown answer is refused", () => {
    expect(actionsOf({ kind: "failed", reason: "HTTP 403" })).toEqual({
      kind: "hidden",
      reason: "HTTP 403",
    });
    expect(() => actionsOf({ kind: "ok", stdout: "yes\n" })).toThrow(
      "the actions permissions query printed",
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
      'the CI workflow "CI" has a job that reports the check test',
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

  test.each([
    ["a job test whose name reports another check", "  test:\n    name: Unit tests\n"],
    ["a matrix job test", "  test:\n    strategy:\n      matrix:\n        node: [20, 22]\n"],
    [
      "a matrix job named test",
      "  unit:\n    name: test\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n",
    ],
  ])("%s does not report the check test", (_, jobs) => {
    expect(missing(withWorkflow(`on: [push, pull_request, merge_group]\njobs:\n${jobs}`))).toEqual([
      'the CI workflow "CI" has a job that reports the check test',
    ]);
  });

  test("a paths filter on pull_request or push is missing: the required check never reports for a filtered change", () => {
    const facts = withWorkflow(
      "on:\n  pull_request:\n    paths: [src/**]\n  push:\n    paths-ignore: [docs/**]\n  merge_group:\n    paths: [src/**]\njobs:\n  test: {}\n",
    );

    expect(format(evaluate(facts))).toContain(
      'missing  the CI workflow "CI" has no paths filter on pull_request or push: remove paths and paths-ignore from on.pull_request and on.push: the required check test never reports on a change they filter out',
    );
    expect(
      missing(
        withWorkflow(
          "on:\n  pull_request:\n    branches: [main]\n  push:\n  merge_group:\njobs:\n  test: {}\n",
        ),
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

describe("tierStalenessOf", () => {
  const PROMPT = "the prompt";
  const validated = `{"model": "claude-haiku-5-5", "prompt": "${digestOf(PROMPT)}", "cases": []}`;

  test("answers null for cases validated with this prompt", () => {
    expect(tierStalenessOf(validated, PROMPT)).toBeNull();
  });

  test.each([
    [validated, "an edited prompt", "tier-prompt.md is "],
    ['{"model": null, "prompt": null, "cases": []}', PROMPT, "names no model and prompt"],
    ["not json", PROMPT, "tier-cases.json is not JSON"],
    [null, PROMPT, ".github/factory/tier-cases.json is not on the default branch"],
    [validated, null, ".github/factory/tier-prompt.md is not on the default branch"],
  ])("names why the floor runs alone: %p, %p", (cases, prompt, why) => {
    expect(tierStalenessOf(cases, prompt)).toContain(why);
  });
});

describe("parseRuleLines", () => {
  test("keeps the first repository ruleset and every check", () => {
    expect(
      parseRuleLines("ruleset 3\napplies 3\ncheck a b\napplies 3\nruleset 4\nqueue\napplies 5\n"),
    ).toEqual({
      checks: new Set(["a b"]),
      threadsResolved: false,
      mergeQueue: true,
      rulesetId: "3",
      rulesetIds: new Set(["3", "5"]),
    });
  });

  test("refuses a line it does not know", () => {
    expect(() => parseRuleLines("deletion\n")).toThrow("a line it should not: deletion");
  });
});

describe("parseRepositoryLines", () => {
  test.each([
    ["main\ntrue\nfalse\ntrue\n", true, false, true],
    ["main\nfalse\ntrue\nfalse\n", false, true, false],
    ["main\nunknown\nfalse\nunknown\n", null, false, null],
    ["main\nnull\ntrue\nnull\n", null, true, null],
  ])("%p", (text, allowAutoMerge, isPrivate, allowSquashMerge) => {
    expect(parseRepositoryLines(text)).toEqual({
      defaultBranch: "main",
      allowAutoMerge,
      isPrivate,
      allowSquashMerge,
    });
  });

  test("refuses an answer missing a line", () => {
    expect(() => parseRepositoryLines("main\ntrue\nfalse\n")).toThrow(
      "the repository query printed",
    );
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
