import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  answerOf,
  type Ask,
  type Calibration,
  type Case,
  claudeArgs,
  type Config,
  decide,
  type Decision,
  digestOf,
  externalIdOf,
  type FileChange,
  filesOf,
  floorOf,
  type GitHub,
  parseCalibration,
  parseConfig,
  parseOwners,
  promptOf,
  type Read,
  readRules,
  type Recorded,
  recordsOf,
  replayCases,
  reportOf,
  type Rules,
  staleness,
  summaryOf,
} from "../templates/repo/.github/factory/tier.ts";
import { TEMPLATES_DIR } from "./templates.ts";

const SYSTEM = "the prompt";

const PROMPT = digestOf(SYSTEM);

const MODEL = "claude-haiku-5-5";

const HEAD = "1111111111111111111111111111111111111111";

const CHANGE = "diff --git a/src/cli.ts b/src/cli.ts";

const DIFF = digestOf(CHANGE);

const verdict = (
  tier: Recorded["tier"],
  reason: string,
  overrides: Partial<Recorded> = {},
): Recorded => ({ tier, reason, prompt: PROMPT, model: MODEL, diff: DIFF, ...overrides });

const read = <T>(value: T): Read<T> => ({ kind: "read", value });

const whyOf = (result: Read<unknown>): string => (result.kind === "unreadable" ? result.why : "");

const OWNERS = read<readonly string[]>(["/.github/", "/.claude/", "/CLAUDE.md"]);

const CONFIG = read<Config>({ lineCap: 400, humanPaths: ["migrations/**"] });

const file = (path: string, lines = 10, previous: string | null = null): FileChange => ({
  path,
  previous,
  lines,
});

const calibration = (cases: readonly Case[] = []): Calibration => ({
  model: MODEL,
  prompt: PROMPT,
  cases,
});

const RULES: Rules = {
  owners: OWNERS,
  config: CONFIG,
  system: SYSTEM,
  calibration: read(calibration()),
};

const claudeOutput = (tier: string, reason = "a test covers it", model = MODEL): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: { tier, reason },
    modelUsage: { [model]: {} },
  });

interface Fake extends GitHub {
  readonly stored: Recorded[];
  readonly asked: string[];
  readonly ask: Ask;
}

function fake(options: {
  readonly files?: readonly FileChange[];
  readonly head?: string;
  readonly diff?: string;
  readonly records?: readonly Recorded[];
  readonly answer?: string | Error;
  /** A record another run of the gate writes first, seen once this run has written its own. */
  readonly raced?: Recorded;
}): Fake {
  const stored: Recorded[] = [...(options.records ?? [])];
  const asked: string[] = [];

  return {
    stored,
    asked,
    head: () => Promise.resolve(options.head ?? HEAD),
    files: () => Promise.resolve(options.files ?? [file("src/cli.ts")]),
    diff: () => Promise.resolve(options.diff ?? CHANGE),
    records: () => Promise.resolve(stored),
    record: (_sha, recorded) => {
      if (options.raced !== undefined) stored.push(options.raced);

      stored.push(recorded);

      return Promise.resolve();
    },
    ask: (model, _system, prompt) => {
      asked.push(`${model} ${prompt}`);

      const answer = options.answer ?? claudeOutput("low");

      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

describe("parseOwners", () => {
  test("reads each line's first word as a prefix from the root, comments aside", () => {
    expect(parseOwners("# the judges\n/.github/ @octo\n\n/CLAUDE.md @octo @other\n")).toEqual(
      read(["/.github/", "/CLAUDE.md"]),
    );
  });

  test.each([
    ["*.ts @octo", "CODEOWNERS holds *.ts, which is not a path prefix from the root"],
    ["/src/**/x @octo", "CODEOWNERS holds /src/**/x, which is not a path prefix from the root"],
    ["docs/ @octo", "CODEOWNERS holds docs/, which is not a path prefix from the root"],
    ["# nothing\n", "CODEOWNERS lists no path"],
  ])("does not read %p", (text, why) => {
    expect(parseOwners(text)).toEqual({ kind: "unreadable", why });
  });
});

describe("parseConfig", () => {
  test("reads a cap and a list of globs", () => {
    expect(parseConfig('{"lineCap": 250, "humanPaths": ["db/**"]}')).toEqual(
      read({ lineCap: 250, humanPaths: ["db/**"] }),
    );
  });

  test.each([
    ["{", "tier.json is not JSON"],
    ['{"lineCap": 400, "humanPaths": [], "linecap": 9000}', 'unknown key "linecap"'],
    ['{"lineCap": 0, "humanPaths": []}', "lineCap is a whole number"],
    ['{"lineCap": "400", "humanPaths": []}', "lineCap is a whole number"],
    ['{"lineCap": 400}', "humanPaths is a list of globs"],
    ['{"lineCap": 400, "humanPaths": ["/db/**"]}', '"/db/**" is anchored'],
  ])("does not read %p", (text, why) => {
    expect(whyOf(parseConfig(text))).toContain(why);
  });
});

describe("floorOf", () => {
  test("lets a small change outside every listed path through", () => {
    expect(floorOf([file("src/cli.ts"), file("README.md")], OWNERS, CONFIG)).toBeNull();
  });

  test("holds a sensitive path, the name a rename moved it from included", () => {
    expect(floorOf([file("CLAUDE.md")], OWNERS, CONFIG)?.reason).toBe(
      "touches a sensitive path: CLAUDE.md",
    );
    expect(
      floorOf([file("docs/gate.yml", 0, ".github/workflows/gate.yml")], OWNERS, CONFIG),
    ).toEqual({ tier: "human", reason: "touches a sensitive path: .github/workflows/gate.yml" });
  });

  test("holds a path tier.json lists and a change past the cap, and gives every reason", () => {
    expect(floorOf([file("migrations/001.sql")], OWNERS, CONFIG)?.reason).toBe(
      "touches a path tier.json sends to the owner: migrations/001.sql",
    );
    expect(floorOf([file("src/a.ts", 400), file("src/b.ts", 1)], OWNERS, CONFIG)?.reason).toBe(
      "401 lines changed, past the 400-line cap",
    );
    expect(floorOf([file("src/a.ts", 400)], OWNERS, CONFIG)).toBeNull();
    expect(
      floorOf([file(".github/factory/tier.json", 2), file("src/a.ts", 450)], OWNERS, CONFIG),
    ).toEqual({
      tier: "human",
      reason:
        "touches a sensitive path: .github/factory/tier.json; 452 lines changed, past the 400-line cap",
    });
  });

  test("names three paths and counts the rest", () => {
    const files = ["a", "b", "c", "d", "e"].map((name) => file(`.github/${name}`));

    expect(floorOf(files, OWNERS, CONFIG)?.reason).toBe(
      "touches a sensitive path: .github/a, .github/b, .github/c and 2 more",
    );
  });

  test("holds everything when a rule file does not read, and a change with no file", () => {
    const broken = { kind: "unreadable", why: "why" } as const;

    expect(floorOf([file("src/cli.ts")], broken, CONFIG)?.reason).toBe(
      "every path is sensitive: why",
    );
    expect(floorOf([file("src/cli.ts")], OWNERS, broken)?.reason).toBe(
      "the floor does not read: why",
    );
    expect(floorOf([], OWNERS, CONFIG)?.reason).toBe("the change touches no file");
  });
});

describe("parseCalibration", () => {
  test("reads a pull request case and a diff case, and the model and prompt they were validated with", () => {
    const text = JSON.stringify({
      model: MODEL,
      prompt: PROMPT,
      cases: [
        { name: "a flag", expected: "low", pr: 82 },
        { name: "a migration", expected: "human", diff: "diff --git a/x b/x" },
      ],
    });

    expect(parseCalibration(text)).toEqual(
      read({
        model: MODEL,
        prompt: PROMPT,
        cases: [
          { name: "a flag", expected: "low", pr: 82 },
          { name: "a migration", expected: "human", diff: "diff --git a/x b/x" },
        ],
      }),
    );
  });

  test.each([
    ["{}", "holds no cases array"],
    [
      '{"cases": [{"name": "x", "expected": "maybe", "pr": 1}]}',
      "needs a name and an expected tier",
    ],
    ['{"cases": [{"name": "x", "expected": "low"}]}', "needs a pr number or a diff"],
    ['{"cases": [{"name": "x", "expected": "low", "pr": 1, "diff": "d"}]}', "not both"],
    ['{"cases": [{"name": "x", "expected": "low", "pr": 1.5}]}', "needs a pr number or a diff"],
  ])("does not read %p", (text, why) => {
    expect(whyOf(parseCalibration(text))).toContain(why);
  });
});

describe("staleness", () => {
  test("a classifier answers only with the prompt its cases validated", () => {
    expect(staleness(read(calibration()), SYSTEM)).toBeNull();
    expect(staleness(read({ model: null, prompt: null, cases: [] }), SYSTEM)).toContain(
      "names no model and prompt",
    );
    expect(staleness(read(calibration()), "an edited prompt")).toContain(
      `tier-cases.json was validated with ${PROMPT}`,
    );
    expect(staleness({ kind: "unreadable", why: "broken" }, SYSTEM)).toBe("broken");
  });
});

describe("answerOf", () => {
  test("reads the tier, the reason on one line, and the one model that answered", () => {
    expect(answerOf(claudeOutput("human", "a migration\u0007\nno revert undoes"))).toEqual({
      tier: "human",
      reason: "a migration no revert undoes",
      model: MODEL,
    });
  });

  test("reads the result message of a verbose array", () => {
    const messages = `[{"type":"system"},${claudeOutput("low")}]`;

    expect(answerOf(messages).tier).toBe("low");
  });

  test.each([
    ["not json", "printed no JSON"],
    ['{"type":"assistant"}', "printed no result message"],
    ['{"type":"result","subtype":"error_max_turns","is_error":true}', "ended in error"],
    ['{"type":"result","subtype":"success","is_error":false}', "without structured_output"],
    [claudeOutput("maybe"), "is not low or human"],
    [claudeOutput("low", " "), "gave no reason"],
  ])("refuses %p", (stdout, why) => {
    expect(() => answerOf(stdout)).toThrow(why);
  });
});

describe("claudeArgs", () => {
  test("gives the classifier no tool, hook, MCP server, settings file or saved session", () => {
    const args = claudeArgs(MODEL, SYSTEM);
    const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

    expect(after("--tools")).toBe("");
    expect(after("--setting-sources")).toBe("");
    expect(after("--settings")).toBe('{"disableAllHooks":true}');
    expect(after("--model")).toBe(MODEL);
    expect(after("--system-prompt")).toBe(SYSTEM);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
  });
});

describe("filesOf", () => {
  test("flattens the pages and sums each file's lines", () => {
    const pages = [
      [{ filename: "a.ts", additions: 3, deletions: 2 }],
      [{ filename: "b.ts", previous_filename: "old.ts", additions: 0, deletions: 0 }],
    ];

    expect(filesOf(pages)).toEqual([file("a.ts", 5), file("b.ts", 0, "old.ts")]);
    expect(() => filesOf([[{ filename: "a.ts" }]])).toThrow("no name or no line counts");
  });
});

interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly app: { readonly slug: string };
  readonly external_id: string;
  readonly output: { readonly summary: string };
}

const run = (id: number, overrides: Partial<CheckRun> = {}): CheckRun => ({
  id,
  name: "tier",
  status: "completed",
  app: { slug: "github-actions" },
  external_id: `low ${PROMPT} ${MODEL} ${DIFF}`,
  output: { summary: `reason ${id}` },
  ...overrides,
});

const decided = async (github: Fake, rules: Rules = RULES, asks = true): Promise<Decision> =>
  (await decide(github, rules, asks ? github.ask : null, 7, HEAD)).decision;

const answering =
  (tierOf: (prompt: string) => string): Ask =>
  (_model, _system, prompt) =>
    Promise.resolve(claudeOutput(tierOf(prompt)));

const failing: Ask = () => Promise.reject(new Error("claude -p exited 1"));

describe("recordsOf", () => {
  test("trusts only a completed tier run GitHub Actions created, oldest first", () => {
    const listing = {
      check_runs: [
        run(30),
        run(10, { external_id: `human ${PROMPT} ${MODEL} ${DIFF}` }),
        run(5, { app: { slug: "some-app" } }),
        run(6, { name: "test" }),
        run(7, { status: "in_progress" }),
        run(8, { external_id: `low ${PROMPT} ${MODEL}` }),
        run(9, { external_id: `low ${PROMPT} ${MODEL} ${DIFF} extra` }),
      ],
    };

    expect(recordsOf(listing)).toEqual([
      verdict("human", "reason 10"),
      verdict("low", "reason 30"),
    ]);
  });

  test("writes what it reads back", () => {
    const recorded = verdict("low", "reason 1");

    expect(recordsOf({ check_runs: [run(1, { external_id: externalIdOf(recorded) })] })).toEqual([
      recorded,
    ]);
  });
});

describe("decide", () => {
  test("the floor decides without the classifier or a record", async () => {
    const github = fake({ files: [file(".claude/settings.json")] });

    expect(await decided(github)).toEqual({
      kind: "decided",
      verdict: { tier: "human", reason: "touches a sensitive path: .claude/settings.json" },
      by: "floor",
    });
    expect(github.asked).toEqual([]);
    expect(github.stored).toEqual([]);
  });

  test("a repository without validated cases runs the floor alone", async () => {
    const github = fake({});
    const rules = { ...RULES, calibration: read({ model: null, prompt: null, cases: [] }) };

    expect(await decided(github, rules)).toMatchObject({
      verdict: { tier: "human" },
      by: "calibration",
    });
    expect(github.asked).toEqual([]);
  });

  test("asks the validated model once, with the diff alone, and records its verdict", async () => {
    const github = fake({ diff: "the diff" });

    expect(await decided(github)).toEqual({
      kind: "decided",
      verdict: { tier: "low", reason: "a test covers it" },
      by: "judge",
    });
    expect(github.asked).toEqual([`${MODEL} ${promptOf("the diff")}`]);
    expect(github.stored).toEqual([
      verdict("low", "a test covers it", { diff: digestOf("the diff") }),
    ]);
  });

  test("reuses the verdict recorded on the commit for this diff and does not ask again", async () => {
    const github = fake({
      records: [verdict("low", "judged before")],
      answer: claudeOutput("human"),
    });

    expect(await decided(github)).toEqual({
      kind: "decided",
      verdict: { tier: "low", reason: "judged before" },
      by: "record",
    });
    expect(github.asked).toEqual([]);
  });

  test("a record made with another prompt or model is not reused", async () => {
    const github = fake({
      records: [
        verdict("low", "old prompt", { prompt: "000000000000" }),
        verdict("low", "old model", { model: "claude-haiku-4" }),
      ],
      answer: claudeOutput("human", "no revert undoes it"),
    });

    expect(await decided(github)).toMatchObject({ verdict: { tier: "human" }, by: "judge" });
  });

  test("a record of the same commit judged against another base is not reused", async () => {
    const github = fake({
      records: [verdict("low", "the top commit alone", { diff: digestOf("the top commit") })],
      diff: "the commit under it, which starts gh, and the top commit",
      answer: claudeOutput("human", "starts gh"),
    });

    expect(await decided(github)).toEqual({
      kind: "decided",
      verdict: { tier: "human", reason: "starts gh" },
      by: "judge",
    });
    expect(github.asked).toHaveLength(1);
  });

  test("without leave to ask, a change that needs the classifier answers ask", async () => {
    const github = fake({});

    expect(await decided(github, RULES, false)).toEqual({ kind: "ask" });
    expect(github.asked).toEqual([]);
  });

  test.each([
    [
      new Error("the secret CLAUDE_CODE_OAUTH_TOKEN is not set"),
      "CLAUDE_CODE_OAUTH_TOKEN is not set",
    ],
    [new Error("claude -p gave no answer within 120 s"), "gave no answer"],
    ["garbage", "printed no JSON"],
    [claudeOutput("perhaps"), "is not low or human"],
  ])("a classifier that fails answers human and records nothing: %p", async (answer, why) => {
    const github = fake({ answer });
    const decision = await decided(github);

    expect(decision).toMatchObject({ verdict: { tier: "human" }, by: "failure" });
    expect(JSON.stringify(decision)).toContain(why);
    expect(github.stored).toEqual([]);
  });

  test("an answer from another model than the validated one is human, and not recorded", async () => {
    const github = fake({ answer: claudeOutput("low", "fine", "claude-haiku-6") });

    expect(await decided(github)).toEqual({
      kind: "decided",
      verdict: {
        tier: "human",
        reason: `claude-haiku-6 answered, tier-cases.json was validated with ${MODEL}`,
      },
      by: "calibration",
    });
    expect(github.stored).toEqual([]);
  });

  test("a diff too long for the classifier is human", async () => {
    const github = fake({ diff: "x".repeat(400_001) });

    expect(await decided(github)).toMatchObject({ verdict: { tier: "human" }, by: "failure" });
    expect(github.asked).toEqual([]);
  });

  test("two runs that both asked settle on the oldest record", async () => {
    const github = fake({
      raced: verdict("human", "the other run"),
    });

    expect(await decided(github)).toEqual({
      kind: "decided",
      verdict: { tier: "human", reason: "the other run" },
      by: "judge",
    });
  });

  test("a pull request that moved past the commit is left to that commit's run", async () => {
    const github = fake({ head: "2222222222222222222222222222222222222222" });

    expect(await decided(github)).toEqual({
      kind: "superseded",
      head: "2222222222222222222222222222222222222222",
    });
    expect(github.asked).toEqual([]);
  });
});

describe("summaryOf", () => {
  test("shows the tier, its reason, who decided, and the base branch's cap", () => {
    const summary = summaryOf(
      { tier: "human", reason: "touches a sensitive path: .github/factory/tier.json" },
      "floor",
      HEAD,
      452,
      CONFIG,
    );

    expect(summary).toContain("### Tier: human");
    expect(summary).toContain("touches a sensitive path: .github/factory/tier.json");
    expect(summary).toContain(
      "Decided by the floor. Commit `1111111`, 452 lines changed, the cap is 400. The rules are the base branch's.",
    );
  });
});

describe("replay", () => {
  const CASES: readonly Case[] = [
    { name: "a flag", expected: "low", pr: 82 },
    { name: "a gate edit", expected: "human", pr: 53 },
    { name: "a migration", expected: "human", diff: "migrate the stored file" },
  ];

  const github: GitHub = {
    ...fake({}),
    files: (pr) => Promise.resolve(pr === 53 ? [file(".github/CODEOWNERS")] : [file("src/cli.ts")]),
    diff: () => Promise.resolve("add a flag"),
  };

  test("judges each case three times, the floor's once, and trusts a run with no false low", async () => {
    const results = await replayCases(
      github,
      RULES,
      calibration(CASES),
      answering((prompt) => (prompt.includes("migrate") ? "human" : "low")),
    );

    expect(results.map(({ runs }) => runs.length)).toEqual([3, 1, 3]);

    const { lines, trusted } = reportOf(results, MODEL, PROMPT);

    expect(trusted).toBe(MODEL);
    expect(lines).toContain(
      "agreement 7/7 runs; 6 judged by the classifier, 0 failed, the rest by the floor",
    );
    expect(lines).toContain("false low 0");
    expect(lines).toContain(
      "a gate edit\texpected human\thuman\tfloor\ttouches a sensitive path: .github/CODEOWNERS",
    );
  });

  test("reports every false low and does not trust the run", async () => {
    const results = await replayCases(
      github,
      RULES,
      calibration(CASES),
      answering(() => "low"),
    );

    const { lines, trusted } = reportOf(results, MODEL, PROMPT);

    expect(trusted).toBeNull();
    expect(lines.join("\n")).toContain("false low 3\n  a migration: a test covers it");
  });

  test("does not trust a run with a failure, or one the classifier judged nothing of", async () => {
    const failed = reportOf(
      await replayCases(github, RULES, calibration(CASES), failing),
      MODEL,
      PROMPT,
    );

    expect(failed.trusted).toBeNull();
    expect(failed.lines.join("\n")).toContain("failed 6\n  a flag: claude -p exited 1");

    const floorOnly = await replayCases(
      github,
      RULES,
      calibration([{ name: "a gate edit", expected: "human", pr: 53 }]),
      failing,
    );

    expect(reportOf(floorOnly, MODEL, PROMPT).trusted).toBeNull();
  });

  test("names a low case the classifier read human on every run", async () => {
    const results = await replayCases(
      github,
      RULES,
      calibration(CASES),
      answering(() => "human"),
    );

    const { lines, trusted } = reportOf(results, MODEL, PROMPT);

    expect(trusted).toBe(MODEL);
    expect(lines.join("\n")).toContain("low read human on every run 1\n  a flag");
  });

  test("asks the unvalidated alias until a replay recorded a model", async () => {
    const asked: string[] = [];

    const ask: Ask = (model) => {
      asked.push(model);

      return Promise.resolve(claudeOutput("low"));
    };

    await replayCases(
      github,
      RULES,
      { model: null, prompt: null, cases: [CASES[0] ?? { name: "", expected: "low", pr: 1 }] },
      ask,
    );

    expect(asked).toEqual(["haiku", "haiku", "haiku"]);
  });
});

describe("the files the install writes", () => {
  test("read as rules: a floor, and a classifier no case validated yet", () => {
    const rules = readRules(join(TEMPLATES_DIR, "repo/.github/factory"));

    expect(rules.owners).toEqual(read(["/.github/", "/.claude/", "/CLAUDE.md"]));
    expect(rules.config).toEqual(read({ lineCap: 400, humanPaths: [] }));
    expect(rules.calibration).toEqual(read({ model: null, prompt: null, cases: [] }));
    expect(staleness(rules.calibration, rules.system)).toContain("the floor runs alone");
  });
});
