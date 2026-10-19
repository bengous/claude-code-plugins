import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";
import { parse } from "yaml";

import {
  bunRefusal,
  decide,
  type Exec,
  type Finished,
  type Gh,
  junitCases,
  kitRun,
  markerOf,
  parseArgs,
  playwrightFlakes,
  recordOf,
  type Report,
  report,
  retryBun,
  retryKit,
} from "./flaky-report.ts";

const ROOT = join(import.meta.dir, "..");

/** Bun's junit report of a first run, as the spike measured it: a flaky test and a timeout fail. */
const FIRST_RUN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="3" failures="2" skipped="0" time="0.066191169">
  <testsuite name="sub/flaky.test.ts" file="sub/flaky.test.ts" tests="2" assertions="2" failures="1" skipped="0" time="0.004517884" hostname="ci">
    <testsuite name="group" file="sub/flaky.test.ts" line="6" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="ci">
      <testcase name="flaky passes on retry" classname="group" time="0.000305" file="sub/flaky.test.ts" line="7" assertions="1">
        <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;&#10;      at sub/flaky.test.ts:10:17&#10;</failure>
      </testcase>
    </testsuite>
    <testcase name="stable" classname="" time="0.000019" file="sub/flaky.test.ts" line="16" assertions="1" />
  </testsuite>
  <testsuite name="sub/other.test.ts" file="sub/other.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.000443257" hostname="ci">
    <testcase name="other stable" classname="" time="0.00001" file="sub/other.test.ts" line="2" assertions="1" />
  </testsuite>
  <testsuite name="sub/timeout.test.ts" file="sub/timeout.test.ts" tests="1" assertions="0" failures="1" skipped="0" time="0.050601212" hostname="ci">
    <testcase name="too slow" classname="" time="0.050072" file="sub/timeout.test.ts" line="2" assertions="0">
      <failure type="TimeoutError" message="test timed out" />
    </testcase>
  </testsuite>
</testsuites>
`;

/** The rerun of the two failed files: the flaky test passes, the timeout fails again. */
const SECOND_RUN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="2" failures="1" skipped="0" time="0.0644293">
  <testsuite name="sub/flaky.test.ts" file="sub/flaky.test.ts" tests="2" assertions="2" failures="0" skipped="0" time="0.002803306" hostname="ci">
    <testsuite name="group" file="sub/flaky.test.ts" line="6" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="ci">
      <testcase name="flaky passes on retry" classname="group" time="0.000048" file="sub/flaky.test.ts" line="7" assertions="1" />
    </testsuite>
    <testcase name="stable" classname="" time="0.00001" file="sub/flaky.test.ts" line="16" assertions="1" />
  </testsuite>
  <testsuite name="sub/timeout.test.ts" file="sub/timeout.test.ts" tests="1" assertions="0" failures="1" skipped="0" time="0.050566361" hostname="ci">
    <testcase name="too slow" classname="" time="0.050071" file="sub/timeout.test.ts" line="2" assertions="0">
      <failure type="TimeoutError" message="test timed out" />
    </testcase>
  </testsuite>
</testsuites>
`;

const SUMMARY_TWO_FAILED =
  "\n 2 pass\n 2 fail\n 3 expect() calls\nRan 4 tests across 3 files. [65.00ms]\n";

describe("junitCases", () => {
  test("reads each test case, the failure's text when it has one, else its type and message", () => {
    expect(junitCases(FIRST_RUN)).toEqual([
      {
        id: "sub/flaky.test.ts > group > flaky passes on retry",
        file: "sub/flaky.test.ts",
        failure:
          "AssertionError: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1\n\n      at sub/flaky.test.ts:10:17",
      },
      { id: "sub/flaky.test.ts > stable", file: "sub/flaky.test.ts", failure: null },
      { id: "sub/other.test.ts > other stable", file: "sub/other.test.ts", failure: null },
      {
        id: "sub/timeout.test.ts > too slow",
        file: "sub/timeout.test.ts",
        failure: "TimeoutError: test timed out",
      },
    ]);
  });

  test("an afterAll that throws is the case bun names (unnamed)", () => {
    const xml = `<testsuite name="cleanup" file="hooks.test.ts">
      <testcase name="body ok" classname="cleanup" file="hooks.test.ts" line="4" assertions="1" />
      <testcase name="(unnamed)" classname="cleanup" time="0.000134" file="hooks.test.ts" assertions="0">
        <failure type="Error" message="EBUSY afterAll">Error: EBUSY afterAll&#10;      at hooks.test.ts:3:52&#10;</failure>
      </testcase>
    </testsuite>`;

    expect(junitCases(xml).map(({ id, failure }) => [id, failure !== null])).toEqual([
      ["hooks.test.ts > cleanup > body ok", false],
      ["hooks.test.ts > cleanup > (unnamed)", true],
    ]);
  });

  test("decodes bun's entities and turns a Windows path's separators forward", () => {
    const xml = `<testcase name="a &gt; b &amp; &quot;c&quot; &lt;d&gt;" classname="d &apos;q&apos;" file="vellum\\src\\a.spec.ts" />`;

    expect(junitCases(xml)).toEqual([
      {
        id: `vellum/src/a.spec.ts > d 'q' > a > b & "c" <d>`,
        file: "vellum/src/a.spec.ts",
        failure: null,
      },
    ]);
  });
});

describe("bunRefusal", () => {
  test("a first run whose every failure junit names is retried", () => {
    expect(bunRefusal(2, SUMMARY_TWO_FAILED)).toBeNull();
  });

  test("a file that threw while loading, counted by bun and missing from junit, is not", () => {
    const output = "\n 2 pass\n 3 fail\n 1 error\n 3 expect() calls\nRan 5 tests across 4 files.\n";

    expect(bunRefusal(2, output)).toBe(
      "bun counts 1 error(s) outside any test, which junit does not name",
    );
  });

  test("a count of failed tests junit does not match is not, nor a run junit names no failure of", () => {
    expect(bunRefusal(1, SUMMARY_TWO_FAILED)).toContain("bun counts 2 failed test(s)");
    expect(bunRefusal(0, SUMMARY_TWO_FAILED)).toBe("bun's junit report names no failed test");
    expect(bunRefusal(2, "Segmentation fault")).toBe("bun printed no count of failed tests");
  });
});

/** A fake `bun test` that writes, at the junit path it is given, the next report in line. */
function fakeBun(runs: readonly { code: number; junit: string | null; output: string }[]) {
  const calls: (readonly string[])[] = [];

  const exec: Exec = async (argv) => {
    const next = runs[calls.length];
    calls.push(argv);

    if (next === undefined) throw new Error(`unexpected run ${argv.join(" ")}`);

    const outfile = argv.find((arg) => arg.startsWith("--reporter-outfile="));

    if (next.junit !== null && outfile !== undefined) {
      await Bun.write(outfile.slice("--reporter-outfile=".length), next.junit);
    }

    return { code: next.code, output: next.output };
  };

  return { exec, calls };
}

describe("retryBun", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flaky-report-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reruns the failed files alone; a test that passes there is a flake, the exit is the rerun's", async () => {
    const { exec, calls } = fakeBun([
      { code: 1, junit: FIRST_RUN, output: SUMMARY_TWO_FAILED },
      { code: 1, junit: SECOND_RUN, output: "" },
    ]);

    const retried = await retryBun(["bun", "test", "--parallel", "vellum"], exec, dir);

    expect(calls[1]).toEqual([
      "bun",
      "test",
      "--parallel",
      "./sub/flaky.test.ts",
      "./sub/timeout.test.ts",
      "--reporter=junit",
      `--reporter-outfile=${join(dir, "bun-2.xml")}`,
    ]);
    expect(retried.code).toBe(1);
    expect(retried.flakes.map(({ id, runner }) => [id, runner])).toEqual([
      ["sub/flaky.test.ts > group > flaky passes on retry", "bun"],
    ]);
  });

  test("a green first run, or one whose failures junit misses, runs once", async () => {
    const green = fakeBun([{ code: 0, junit: SECOND_RUN, output: "" }]);

    expect(await retryBun(["bun", "test", "vellum"], green.exec, dir)).toEqual({
      code: 0,
      flakes: [],
    });

    const unnamed = fakeBun([{ code: 1, junit: FIRST_RUN, output: " 3 fail\n 1 error\n" }]);

    expect(await retryBun(["bun", "test", "vellum"], unnamed.exec, dir)).toEqual({
      code: 1,
      flakes: [],
    });
    expect([green.calls.length, unnamed.calls.length]).toEqual([1, 1]);
  });

  test("refuses a command that is not bun test", async () => {
    const { exec } = fakeBun([]);

    await expect(retryBun(["bun", "run", "e2e"], exec, dir)).rejects.toThrow(
      "retry bun runs bun test",
    );
  });
});

/** The kit's output as the spike's module printed it, one test red. A line apiece: the formatter would strip the two spaces of the blank line under the error. */
const KIT_RED = [
  "",
  "hooks/flaky.test.ts:",
  "(fail) group > kit flaky [2.11ms]",
  "  AssertionError: expect(received).toBe()",
  "  ",
  "  Expected: 2",
  "  Received: 1",
  "(pass) kit stable [0.39ms]",
  "",
  "hooks/other.test.ts:",
  "(pass) kit other [1.91ms]",
  "",
  " 2 pass",
  " 1 fail",
  "Ran 3 tests across 2 files. [0.19s]",
  "",
].join("\n");

const KIT_GREEN = `
hooks/flaky.test.ts:
(pass) group > kit flaky [1.79ms]
(pass) kit stable [0.36ms]

hooks/other.test.ts:
(pass) kit other [1.75ms]

 3 pass
 0 fail
Ran 3 tests across 2 files. [0.16s]
`;

function fakeKit(runs: readonly Finished[]) {
  let at = 0;

  const exec: Exec = (argv) => {
    const next = runs[at];
    at += 1;

    return next === undefined
      ? Promise.reject(new Error(`unexpected run ${argv.join(" ")}`))
      : Promise.resolve(next);
  };

  return { exec, runs: () => at };
}

describe("kitRun", () => {
  test("names each file the kit ran and each failed test, with the lines under it", () => {
    const read = kitRun(KIT_RED);

    expect([...read.files]).toEqual(["hooks/flaky.test.ts", "hooks/other.test.ts"]);
    expect(read.failed).toEqual([
      {
        id: "kit:hooks/flaky.test.ts > group > kit flaky",
        file: "hooks/flaky.test.ts",
        failure: "AssertionError: expect(received).toBe()\n\nExpected: 2\nReceived: 1",
      },
    ]);
  });

  test("a file that did not load is a failed test of its own, its Windows path turned forward", () => {
    const read = kitRun(
      '\nhooks\\broken.test.ts:\n(fail) the file did not load\n  hooks/broken.test.ts: cannot import "node:fs" (from hooks/broken.test.ts)\n',
    );

    expect(read.failed).toEqual([
      {
        id: "kit:hooks/broken.test.ts > the file did not load",
        file: "hooks/broken.test.ts",
        failure: 'hooks/broken.test.ts: cannot import "node:fs" (from hooks/broken.test.ts)',
      },
    ]);
  });
});

describe("retryKit", () => {
  const KIT = ["claude", "plugin", "test", "vellum"];

  test("reruns the kit once; a test that failed and then passed is a flake", async () => {
    const { exec, runs } = fakeKit([
      { code: 1, output: KIT_RED },
      { code: 0, output: KIT_GREEN },
    ]);

    expect(await retryKit(KIT, exec)).toEqual({
      code: 0,
      flakes: [
        {
          id: "kit:hooks/flaky.test.ts > group > kit flaky",
          runner: "kit",
          firstFailure: "AssertionError: expect(received).toBe()\n\nExpected: 2\nReceived: 1",
        },
      ],
    });
    expect(runs()).toBe(2);
  });

  test("a test that fails twice is no flake, and the kit exits red", async () => {
    const { exec } = fakeKit([
      { code: 1, output: KIT_RED },
      { code: 1, output: KIT_RED },
    ]);

    expect(await retryKit(KIT, exec)).toEqual({ code: 1, flakes: [] });
  });

  test("a test whose file the second run never reached is no flake", async () => {
    const { exec } = fakeKit([
      { code: 1, output: KIT_RED },
      { code: 1, output: "\nhooks/other.test.ts:\n(pass) kit other [1.75ms]\nerror: crashed\n" },
    ]);

    expect(await retryKit(KIT, exec)).toEqual({ code: 1, flakes: [] });
  });

  test("a red kit that names no failed test runs once", async () => {
    const { exec, runs } = fakeKit([{ code: 1, output: "error: the module did not register\n" }]);

    expect(await retryKit(KIT, exec)).toEqual({ code: 1, flakes: [] });
    expect(runs()).toBe(1);
  });
});

const result = (status: string, message?: string) =>
  message === undefined ? { status } : { status, error: { message } };

describe("playwrightFlakes", () => {
  test("a test Playwright marks flaky is one, named by its file, describes and title", () => {
    const flakes = playwrightFlakes({
      suites: [
        {
          title: "grill.e2e.ts",
          specs: [
            {
              title: "stable",
              file: "grill.e2e.ts",
              tests: [{ status: "expected", results: [result("passed")] }],
            },
          ],
          suites: [
            {
              title: "group",
              specs: [
                {
                  title: "flaky passes on retry",
                  file: "grill.e2e.ts",
                  tests: [
                    {
                      status: "flaky",
                      results: [
                        result("failed", "Error: \u001B[2mexpect(\u001B[22mreceived).toBe(2)"),
                        result("passed"),
                      ],
                    },
                  ],
                },
                {
                  title: "always fails",
                  file: "grill.e2e.ts",
                  tests: [{ status: "unexpected", results: [result("failed"), result("failed")] }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(flakes).toEqual([
      {
        id: "e2e:grill.e2e.ts > group > flaky passes on retry",
        runner: "e2e",
        firstFailure: "Error: expect(received).toBe(2)",
      },
    ]);
  });
});

const RUN_1 = "https://github.com/o/r/actions/runs/1/attempts/1";

const RUN_1_AGAIN = "https://github.com/o/r/actions/runs/1/attempts/2";

const RUN_2 = "https://github.com/o/r/actions/runs/2/attempts/1";

const FLAKE = {
  id: "e2e:grill.e2e.ts > group > flaky passes on retry",
  runner: "e2e" as const,
  firstFailure: "Error: timed out",
};

const reportOf = (job: string, runUrl: string, flakes = [FLAKE]): Report => ({
  job,
  runUrl,
  flakes,
});

describe("decide", () => {
  test("no flake records nothing", () => {
    expect(decide([reportOf("win32", RUN_1, [])], [])).toEqual([]);
  });

  test("a new flake opens an issue that holds its marker and the run it was seen in", () => {
    const [action] = decide([reportOf("e2e (light-1440)", RUN_1)], []);

    expect(action).toMatchObject({
      kind: "open",
      title: `Flaky: ${FLAKE.id}`,
      comments: [],
    });
    expect(action?.kind === "open" && action.body).toContain(markerOf(FLAKE.id));
    expect(action?.kind === "open" && action.body).toContain(
      recordOf({ job: "e2e (light-1440)", runUrl: RUN_1 }),
    );
  });

  test("a known flake gets a comment on its issue, naming the new run", () => {
    const issues = [
      { number: 9, texts: ["unrelated"] },
      { number: 7, texts: [`body ${markerOf(FLAKE.id)}`] },
    ];

    expect(decide([reportOf("e2e (light-1440)", RUN_2)], issues)).toEqual([
      {
        kind: "comment",
        issue: 7,
        body: expect.stringContaining(recordOf({ job: "e2e (light-1440)", runUrl: RUN_2 })),
      },
    ]);
  });

  test("the same test from two windows opens one issue and comments once for the second", () => {
    const actions = decide(
      [reportOf("e2e (light-1440)", RUN_1), reportOf("e2e (dark-1440)", RUN_1)],
      [],
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind === "open" && actions[0].comments).toEqual([
      expect.stringContaining(recordOf({ job: "e2e (dark-1440)", runUrl: RUN_1 })),
    ]);
  });

  test("the same test from two jobs on a known issue comments once per job", () => {
    const issues = [{ number: 7, texts: [markerOf(FLAKE.id)] }];

    const actions = decide(
      [reportOf("win32", RUN_2), reportOf("e2e (win32, light-1440)", RUN_2)],
      issues,
    );

    expect(actions.map((action) => action.kind === "comment" && action.issue)).toEqual([7, 7]);
  });

  test("a run already recorded, or reported twice, is recorded once", () => {
    const recorded = [
      { number: 7, texts: [markerOf(FLAKE.id), recordOf({ job: "win32", runUrl: RUN_1 })] },
    ];

    expect(decide([reportOf("win32", RUN_1)], recorded)).toEqual([]);
    expect(decide([reportOf("win32", RUN_1), reportOf("win32", RUN_1)], [])).toHaveLength(1);
  });

  test("a marker never closes its HTML comment early", () => {
    expect(markerOf("a --> b")).toBe("<!-- flaky:a --&gt; b -->");
  });
});

interface Issue {
  number: number;
  body: string;
  labels: string[];
  comments: string[];
}

/** GitHub as the flaky job sees it: its open issues, and the label. */
function world() {
  const issues: Issue[] = [];
  const labels: string[] = [];

  const gh: Gh = (args) => {
    const [command, sub] = args;
    const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";

    if (command === "issue" && sub === "list") {
      return Promise.resolve(
        JSON.stringify(
          issues.flatMap(({ number, body, labels: on, comments }) =>
            on.includes(flag("--label"))
              ? [{ number, body, comments: comments.map((text) => ({ body: text })) }]
              : [],
          ),
        ),
      );
    }

    if (command === "label" && sub === "create") {
      labels.push(args[2] ?? "");

      return Promise.resolve("");
    }

    if (command === "issue" && sub === "create") {
      const number = issues.length + 1;
      issues.push({ number, body: flag("--body"), labels: [flag("--label")], comments: [] });

      return Promise.resolve(`https://github.com/o/r/issues/${number}\n`);
    }

    if (command === "issue" && sub === "comment") {
      const target = (args[2] ?? "").split("/").at(-1);
      issues.find((issue) => issue.number === Number(target))?.comments.push(flag("--body"));

      return Promise.resolve("");
    }

    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };

  return { issues, labels, gh };
}

const NO_GH: Gh = (args) => Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));

describe("report, from the reports the jobs uploaded", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "flaky-reports-"));
  });

  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  const upload = (artifact: string, name: string, contents: Report): void => {
    mkdirSync(join(folder, artifact), { recursive: true });
    writeFileSync(join(folder, artifact, `${name}.json`), JSON.stringify(contents));
  };

  test("two runs of one flaky test: one issue, labelled, then a comment", async () => {
    const { issues, labels, gh } = world();
    upload("flaky-e2e-light-1440-1", "e2e", reportOf("e2e (light-1440)", RUN_1));
    upload("flaky-win32-1", "bun", reportOf("win32", RUN_1, []));

    expect(await report({ GITHUB_REPOSITORY: "o/r" }, gh, folder)).toEqual([
      "opened https://github.com/o/r/issues/1",
    ]);

    rmSync(folder, { recursive: true });
    upload("flaky-e2e-dark-1440-1", "e2e", reportOf("e2e (dark-1440)", RUN_2));

    expect(await report({ GITHUB_REPOSITORY: "o/r" }, gh, folder)).toEqual(["commented on #1"]);
    expect(labels).toEqual(["flaky"]);
    expect(issues.map(({ labels: on, comments }) => [on, comments.length])).toEqual([
      [["flaky"], 1],
    ]);
  });

  test("a re-run that downloads the first attempt's report again records nothing new", async () => {
    const { issues, gh } = world();
    upload("flaky-win32-1", "kit", reportOf("win32", RUN_1));
    await report({ GITHUB_REPOSITORY: "o/r" }, gh, folder);

    upload("flaky-e2e-light-1440-2", "e2e", reportOf("e2e (light-1440)", RUN_1_AGAIN, []));

    expect(await report({ GITHUB_REPOSITORY: "o/r" }, gh, folder)).toEqual([
      "every flaky test of this run is recorded already",
    ]);
    expect(issues[0]?.comments).toEqual([]);
  });

  test("no report folder, as when no job uploaded one, is no flake and calls no gh", async () => {
    expect(await report({ GITHUB_REPOSITORY: "o/r" }, NO_GH, join(folder, "absent"))).toEqual([
      "no flaky test in this run",
    ]);
  });

  test("refuses a run whose environment lacks the repository", async () => {
    await expect(report({}, NO_GH, folder)).rejects.toThrow("GITHUB_REPOSITORY is unset");
  });
});

describe("parseArgs", () => {
  test("reads the three commands", () => {
    expect(parseArgs(["retry", "bun", "--job", "win32", "--", "bun", "test", "vellum"])).toEqual({
      kind: "retry",
      runner: "bun",
      job: "win32",
      argv: ["bun", "test", "vellum"],
    });
    expect(parseArgs(["playwright", "--job", "e2e (light-1440)", "r.json"])).toEqual({
      kind: "playwright",
      job: "e2e (light-1440)",
      path: "r.json",
    });
    expect(parseArgs(["report", "flaky-reports"])).toEqual({
      kind: "report",
      folder: "flaky-reports",
    });
  });

  test("refuses a retry with no command or no job, and an unknown runner", () => {
    expect(parseArgs(["retry", "bun", "--job", "win32"])).toBeNull();
    expect(parseArgs(["retry", "bun", "--", "bun", "test"])).toBeNull();
    expect(parseArgs(["retry", "jest", "--job", "x", "--", "jest"])).toBeNull();
  });
});

describe("the CLI on a real bun test", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flaky-cli-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a test that fails once goes green on the retry and is written to the report", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(
      join(dir, "sub", "flaky.test.ts"),
      `import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
const marker = \`\${import.meta.dir}/.marker\`;
test("fails once", () => {
  const first = !existsSync(marker);
  writeFileSync(marker, "1");
  expect(first).toBe(false);
});
test("stable", () => expect(1).toBe(1));
`,
    );

    const env = {
      ...process.env,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
    };

    const script = join(ROOT, "scripts", "flaky-report.ts");
    const bun = process.execPath;

    const ran = await $`${bun} ${script} retry bun --job win32 -- ${bun} test ./sub`
      .cwd(dir)
      .env(env)
      .quiet()
      .nothrow();

    expect(ran.exitCode).toBe(0);
    expect(await Bun.file(join(dir, "flaky-reports", "bun.json")).json()).toEqual({
      job: "win32",
      runUrl: RUN_1,
      flakes: [
        { id: "sub/flaky.test.ts > fails once", runner: "bun", firstFailure: expect.any(String) },
      ],
    });
  });
});

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
}

interface Job {
  readonly needs?: readonly string[];
  readonly if?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": boolean };
  readonly steps: readonly Step[];
}

const ci = async (): Promise<Readonly<Record<string, Job>>> =>
  parse(await Bun.file(join(ROOT, ".github/workflows/ci.yml")).text()).jobs;

describe("ci.yml", () => {
  test("win32 runs both of its suites through the retry", async () => {
    const runs = (await ci()).win32?.steps.map((step) => step.run);

    expect(runs).toContain(
      "bun ./scripts/flaky-report.ts retry bun --job win32 -- bun test --parallel vellum",
    );
    expect(runs).toContain(
      "bun ./scripts/flaky-report.ts retry kit --job win32 -- claude plugin test vellum",
    );
  });

  test("each reporting job uploads its report even when red, under a name of its own per attempt", async () => {
    const jobs = await ci();

    const names = ["win32", "e2e-window", "e2e-win32"].map((name) => {
      const upload = jobs[name]?.steps.find((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      );

      expect(upload?.if).toBe("${{ !cancelled() }}");
      expect(upload?.with?.path).toBe("flaky-reports/*.json");

      return upload?.with?.name;
    });

    expect(names).toEqual([
      "flaky-win32-${{ github.run_attempt }}",
      "flaky-e2e-${{ matrix.window }}-${{ github.run_attempt }}",
      "flaky-e2e-win32-${{ github.run_attempt }}",
    ]);
  });

  test("the flaky job alone writes issues, one run at a time, from every report of the run", async () => {
    const flaky = (await ci()).flaky;

    expect(flaky?.needs).toEqual(["win32", "e2e-window", "e2e-win32"]);
    expect(flaky?.permissions).toEqual({ contents: "read", issues: "write" });
    expect(flaky?.concurrency).toEqual({ group: "flaky", "cancel-in-progress": false });
    expect(flaky?.if).toContain("always()");
    expect(flaky?.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(
      flaky?.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))?.with,
    ).toEqual({ pattern: "flaky-*", path: "flaky-reports" });
    expect(flaky?.steps.map((step) => step.run)).toContain(
      "bun ./scripts/flaky-report.ts report flaky-reports",
    );
  });

  test("the e2e jobs read the report the Playwright config writes under CI", async () => {
    const config = `const { default: config } = await import("./e2e/playwright.config.ts");
console.log(JSON.stringify({ retries: config.retries, reporter: config.reporter }));`;

    const loaded: { retries: number; reporter: [string, { outputFile?: string }?][] } =
      await $`${process.execPath} -e ${config}`
        .cwd(join(ROOT, "vellum"))
        .env({ ...process.env, CI: "true" })
        .json();

    const json = loaded.reporter.find(([name]) => name === "json")?.[1]?.outputFile;
    const jobs = await ci();

    expect(loaded.retries).toBe(1);
    expect(json).toBe(join(ROOT, "vellum", "test-results", "playwright.json"));

    for (const name of ["e2e-window", "e2e-win32"]) {
      const record = jobs[name]?.steps.find((step) =>
        step.run?.includes("flaky-report.ts playwright"),
      );

      expect(record?.run).toEndWith(" vellum/test-results/playwright.json");
      expect(record?.if).toBe("${{ !cancelled() && steps.suite.outcome != 'skipped' }}");
    }
  });
});
