import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isE2ePath } from "./check-e2e-green.ts";
import type { CiVerdict } from "./ci-wait.ts";
import { write } from "./claude-code-types.fixture.ts";
import { riskyOf } from "./land.ts";
import {
  AGENT_ROUNDS,
  agentModel,
  classify,
  combinedVerdict,
  fixerCommitMessage,
  fixerVerdict,
  fixerVerdictWhy,
  MAJOR_LABEL,
  outcomeLine,
  parsePrList,
  prLogPath,
  type RanFixer,
  recordHandled,
  REFUSALS_BEFORE_HUMAN,
  RENOVATE_EMAIL,
  type RenovatePr,
  reportLines,
  type RiskyPath,
  statePaths,
  versionOf,
} from "./renovate-agent.ts";
import { patchIdOf, short, verdictLine, verdictsOf } from "./review-verdict.ts";

const SCRIPT = join(import.meta.dir, "renovate-agent.ts");

const REPO = join(import.meta.dir, "..");

const SHA = "a".repeat(40);

const NOTHING_RISKY: RiskyPath = () => false;

const isRisky: RiskyPath = (path) => path.startsWith(".github/workflows/");

const pr = (overrides: Partial<RenovatePr> = {}): RenovatePr => ({
  number: 7,
  title: "chore(deps): update dependency x to v1.2.3",
  url: "https://github.com/o/r/pull/7",
  headRefName: "renovate/x-1.x",
  headRefOid: SHA,
  labels: [],
  files: ["package.json", "bun.lock"],
  ...overrides,
});

const run = { id: 1, status: "completed", url: "https://ci/1" } as const;

const GREEN: CiVerdict = { kind: "green", runs: [{ ...run, conclusion: "success" }] };

const RED: CiVerdict = { kind: "red", red: [{ ...run, id: 2, conclusion: "failure" }] };

const RUNNING: CiVerdict = {
  kind: "running",
  running: [{ ...run, id: 3, status: "in_progress", conclusion: null }],
};

describe("classify", () => {
  test("leaves a green non-major update off the e2e and risky paths to Renovate", () => {
    expect(classify(pr(), GREEN, {}, NOTHING_RISKY).owner).toBe("renovate");
  });

  test("owns a red update", () => {
    expect(classify(pr(), RED, {}, NOTHING_RISKY)).toEqual({ owner: "agent", reasons: ["red"] });
  });

  test("owns a major, read from Renovate's label", () => {
    expect(classify(pr({ labels: [MAJOR_LABEL] }), GREEN, {}, NOTHING_RISKY)).toEqual({
      owner: "agent",
      reasons: ["major"],
    });
  });

  test("owns an update whose files touch the e2e paths, with every reason that holds", () => {
    expect(
      classify(
        pr({ files: ["vellum/package.json"], labels: [MAJOR_LABEL] }),
        RED,
        {},
        NOTHING_RISKY,
      ),
    ).toEqual({ owner: "agent", reasons: ["red", "major", "e2e"] });
  });

  test("gives an update touching a risky path to the human, red or green", () => {
    for (const verdict of [GREEN, RED]) {
      expect(classify(pr({ files: [".github/workflows/ci.yml"] }), verdict, {}, isRisky)).toEqual({
        owner: "human",
        why: "touches risky paths (.github/workflows/ci.yml): land.ts lands it only with a human review verdict",
      });
    }
  });

  test("waits while CI runs or has not started, whoever owns the update", () => {
    expect(classify(pr({ labels: [MAJOR_LABEL] }), RUNNING, {}, NOTHING_RISKY).owner).toBe("wait");
    expect(classify(pr(), { kind: "none" }, {}, NOTHING_RISKY).owner).toBe("wait");
  });

  test("leaves a head an earlier run handled, until Renovate pushes another", () => {
    expect(classify(pr(), RED, { "7": [SHA] }, NOTHING_RISKY).owner).toBe("handled");
    expect(classify(pr(), RED, { "7": ["b".repeat(40)] }, NOTHING_RISKY).owner).toBe("agent");
  });
});

describe("combinedVerdict", () => {
  test("is red when a push run is red beside green pull request runs", () => {
    expect(combinedVerdict(GREEN, RED)).toEqual(RED);
  });

  test("is red when a pull request run is red while a push run still runs", () => {
    expect(combinedVerdict(RED, RUNNING)).toEqual(RED);
  });

  test("runs while a push run runs", () => {
    expect(combinedVerdict(GREEN, RUNNING)).toEqual(RUNNING);
  });

  test("is the pull request runs' verdict when the push runs are green or absent", () => {
    expect(combinedVerdict(GREEN, { kind: "none" })).toEqual(GREEN);
    expect(combinedVerdict({ kind: "none" }, GREEN)).toEqual({ kind: "none" });
  });
});

describe("recordHandled", () => {
  test("adds the new heads and forgets the pull requests no longer open", () => {
    expect(
      recordHandled({ "1": ["a"], "2": ["b"] }, [2, 3], { "2": ["c", "b"], "3": ["d"] }),
    ).toEqual({
      "2": ["b", "c"],
      "3": ["d"],
    });
  });
});

describe("parsePrList", () => {
  test("reads gh's listing, labels and files by name", () => {
    const listed = JSON.stringify([
      {
        number: 7,
        title: "t",
        url: "u",
        headRefName: "renovate/x",
        headRefOid: SHA,
        labels: [{ name: "major" }],
        files: [{ path: "package.json" }],
      },
    ]);

    expect(parsePrList(listed)).toEqual([
      {
        number: 7,
        title: "t",
        url: "u",
        headRefName: "renovate/x",
        headRefOid: SHA,
        labels: ["major"],
        files: ["package.json"],
      },
    ]);
  });
});

const FIXERS: readonly RanFixer[] = [
  { name: "oxlint", version: "1.89.0", command: "bun x oxlint --fix" },
  { name: "oxfmt", version: "0.73.0", command: "bun run fmt" },
];

const FIXER_SHA = "f".repeat(40);

const renovateCommit = { sha: SHA, author: RENOVATE_EMAIL };

const scriptsRisky: RiskyPath = (path) => path.startsWith("scripts/");

describe("fixerVerdict", () => {
  const fixed = ["scripts/release-plan.ts", "pinpoint/overlay/main.ts"];

  test("records for a repair touching a risky path on a branch of Renovate's commits and the fixers' alone", () => {
    expect(
      fixerVerdict({
        commits: [
          { sha: FIXER_SHA, author: "t@t" },
          renovateCommit,
          { ...renovateCommit, sha: "b".repeat(40) },
        ],
        fixer: FIXER_SHA,
        fixed,
        isRisky: scriptsRisky,
      }),
    ).toEqual({ kind: "record", risky: ["scripts/release-plan.ts"] });
  });

  test("records nothing for a repair off the risky paths: land.ts needs no verdict", () => {
    expect(
      fixerVerdict({
        commits: [{ sha: FIXER_SHA, author: "t@t" }, renovateCommit],
        fixer: FIXER_SHA,
        fixed,
        isRisky: NOTHING_RISKY,
      }).kind,
    ).toBe("none");
  });

  test("records nothing when the branch holds a commit that is not Renovate's under the fixers'", () => {
    const verdict = fixerVerdict({
      commits: [
        { sha: FIXER_SHA, author: "t@t" },
        { sha: "c".repeat(40), author: "t@t" },
        renovateCommit,
      ],
      fixer: FIXER_SHA,
      fixed,
      isRisky: scriptsRisky,
    });

    expect(verdict).toEqual({
      kind: "none",
      why: `the branch holds cccccccc by t@t besides Renovate's commits and the fixers' ${short(FIXER_SHA)}`,
    });
  });

  test("records nothing when the fixers' commit is not the branch's head, or holds no Renovate commit", () => {
    expect(
      fixerVerdict({
        commits: [
          { sha: "c".repeat(40), author: "t@t" },
          { sha: FIXER_SHA, author: "t@t" },
          renovateCommit,
        ],
        fixer: FIXER_SHA,
        fixed,
        isRisky: scriptsRisky,
      }).kind,
    ).toBe("none");

    expect(
      fixerVerdict({
        commits: [{ sha: FIXER_SHA, author: "t@t" }],
        fixer: FIXER_SHA,
        fixed,
        isRisky: scriptsRisky,
      }).kind,
    ).toBe("none");
  });
});

describe("fixerVerdictWhy", () => {
  test("says no review was made and names the fixers, their versions and Renovate's head", () => {
    const why = fixerVerdictWhy(FIXERS, SHA);

    expect(why).toStartWith("No review:");
    expect(why).toContain("oxlint 1.89.0 (`bun x oxlint --fix`)");
    expect(why).toContain("oxfmt 0.73.0 (`bun run fmt`)");
    expect(why).toContain(`Renovate's head ${SHA}`);
    expect(why).toContain("while its patch against `origin/dev` stays the same");
  });
});

describe("fixerCommitMessage", () => {
  test("names each fixer with its version, its command and the head it ran on", () => {
    const message = fixerCommitMessage(FIXERS, SHA);

    expect(message.split("\n")[0]).toBe(
      "fix(lint): apply the fixes of oxlint 1.89.0 and oxfmt 0.73.0",
    );
    expect(message).toContain("`bun x oxlint --fix`, then `bun run fmt`");
    expect(message).toContain(SHA);
  });
});

describe("versionOf", () => {
  test("reads the version a tool's --version prints", () => {
    expect(versionOf("Version: 1.89.0\n")).toBe("1.89.0");
  });

  test("throws on an output that names no version", () => {
    expect(() => versionOf("error: not found\n")).toThrow("no version in");
  });
});

describe("outcomeLine", () => {
  test("names the log, the kept worktree and the pull request of a failure", () => {
    expect(
      outcomeLine({
        kind: "failed",
        pr: pr(),
        reason: "boom",
        log: "/l",
        worktree: "/w",
        heads: [],
      }),
    ).toBe(
      "Renovate #7 (chore(deps): update dependency x to v1.2.3) needs you: boom (log: /l; its worktree, /w, is kept as it is). https://github.com/o/r/pull/7",
    );
  });
});

interface PackageRule {
  matchFileNames?: string[];
  matchUpdateTypes?: string[];
  automerge?: boolean;
  addLabels?: string[];
}

describe("renovate.json", () => {
  // SAFETY: the repository's own Renovate config; a missing key fails the expectations.
  const config = JSON.parse(readFileSync(join(REPO, "renovate.json"), "utf8")) as {
    automerge: boolean;
    automergeType: string;
    packageRules: PackageRule[];
  };

  test("automerges by branch, the one way that keeps dev's commits signed", () => {
    expect(config.automerge).toBe(true);
    expect(config.automergeType).toBe("branch");
  });

  test("labels majors the way classify reads them, and does not automerge them", () => {
    const majors = config.packageRules.find((rule) => rule.matchUpdateTypes?.includes("major"));

    expect(majors?.automerge).toBe(false);
    expect(majors?.addLabels).toContain(MAJOR_LABEL);
  });

  test("keeps automerge off exactly for the package files on the e2e paths or the risky ones", () => {
    const fileRules = config.packageRules.filter((rule) => rule.matchFileNames !== undefined);

    const globs = fileRules
      .flatMap((rule) => rule.matchFileNames ?? [])
      .map((glob) => new Bun.Glob(glob));

    const profile = riskyOf(REPO, "HEAD");

    if (profile.kind === "unreadable") throw new Error(profile.why);

    const risky = profile.risky.map((glob) => new Bun.Glob(glob));

    const packageFiles = Bun.spawnSync(["git", "ls-files"], { cwd: REPO })
      .stdout.toString()
      .split("\n")
      .filter((path) =>
        /(?:^|\/)(?:package\.json|bun\.lock|mise\.toml)$|^\.github\/workflows\/[^/]+\.ya?ml$/u.test(
          path,
        ),
      );

    expect(fileRules.every((rule) => rule.automerge === false)).toBe(true);
    expect(packageFiles).toContain(".github/workflows/red-dev.yml");

    for (const path of packageFiles) {
      expect({ path, matched: globs.some((glob) => glob.match(path)) }).toEqual({
        path,
        matched: isE2ePath(path) || risky.some((glob) => glob.match(path)),
      });
    }
  });
});

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
echo "$*" >>"$stub/gh-calls"
if [[ "$1 $2" == "pr list" ]]; then cat "$stub/prs.json"; exit 0; fi
if [[ "$1 $2" == "pr comment" ]]; then cat >"$stub/pr-comment"; exit 0; fi
if [[ "$1" == api && "$*" =~ head_sha=([0-9a-f]+)\\&event=([a-z_]+) ]]; then
  runs="$stub/runs-\${BASH_REMATCH[1]}-\${BASH_REMATCH[2]}"
  if [[ -f $runs ]]; then cat "$runs"; fi
  exit 0
fi
`;

// The agent: records its prompt, then makes the move stub/agent-mode names.
const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
printf '%s' "\${!#}" >"$stub/agent-prompt"
echo "$PWD \${CLAUDE_CODE_TYPES_RUN:-unset}" >>"$stub/agent-runs"
case "$(cat "$stub/agent-mode")" in
  commit)
    echo "fix $(wc -l <"$stub/agent-runs")" >>fix.txt
    git add fix.txt
    git commit -qm "fix: adopt the update"
    ;;
  amend) git commit -q --amend -m "chore(deps): rewritten" ;;
  cannot) echo "CANNOT REPAIR: the new version drops an API we need" ;;
  hold) exec sleep 30 ;;
esac
`;

// Stands in for the installs, the fixers and land.ts. oxlint's fixes append a line to each path
// stub/fixer-edits lists. land.ts's verdicts stub/land-exits gives one per call:
// 0 lands, red and review refuse, foreign first pushes a commit of someone else's to the branch,
// hold waits on a child of its own, as land.ts waits on origin/dev's copy.
const BUN_STUB = `#!/usr/bin/env bash
stub="$(dirname "$0")/../stub"
echo "$PWD $*" >>"$stub/bun-calls"
if [[ "$1" == install && -f $stub/install-fails ]]; then exit 1; fi
if [[ "$1 $2 $3" == "x oxlint --version" ]]; then echo "Version: 9.9.1"; exit 0; fi
if [[ "$1 $2 $3" == "x oxfmt --version" ]]; then echo "Version: 9.9.2"; exit 0; fi
if [[ "$1 $2 $3" == "x oxlint --fix" && -f $stub/fixer-edits ]]; then
  while read -r path; do echo fixed >>"$path"; done <"$stub/fixer-edits"
  exit 0
fi
if [[ "$1" == ./scripts/land.ts ]]; then
  exits="$stub/land-exits"
  verdict="$(head -n1 "$exits")"
  sed -i 1d "$exits"
  case "$verdict" in
    0) echo "landed $2 on dev at abc (#7)"; exit 0 ;;
    red) echo "land: CI is red on abc, the head of #7: https://ci/9. Fix it and push" >&2 ;;
    review) echo "land: $2 touches risky paths (.github/workflows/ci.yml); #7 carries no clean review verdict" >&2 ;;
    foreign)
      foreign="$(git commit-tree "HEAD^{tree}" -p HEAD -m "someone else's")"
      git push -qf origin "$foreign:refs/heads/$2"
      echo "land: $2 is at x here and y on #7: push it, then land again" >&2
      ;;
    hold)
      sleep 30 &
      echo $! >"$stub/land-child"
      wait
      ;;
  esac
  exit 1
fi
`;

const NOTIFY_STUB = `#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../stub/notify-calls"
`;

const RISKY_PROFILE = '{ "profile": { "review": { "risky": ["scripts/**"] } } }\n';

let root = "";

let project = "";

let origin = "";

let env: NodeJS.ProcessEnv = {};

const stub = (name: string) => join(root, "stub", name);

const recorded = (name: string) => (existsSync(stub(name)) ? readFileSync(stub(name), "utf8") : "");

const agentRuns = () => recorded("agent-runs").split("\n").filter(Boolean).length;

const state = () => statePaths(join(project, ".git"));

const worktree = () => `${project}.wt/renovate/7`;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
}

const originHead = () => git(origin, "rev-parse", "refs/heads/renovate/x-1.x");

function runScript(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, SCRIPT, "run", ...args], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Lists the branch's pull request as gh does, with the pull request runs' `conclusion` on its head. */
function listPr(conclusion: string, overrides: Partial<RenovatePr> = {}) {
  const head = originHead();

  write(
    stub("prs.json"),
    JSON.stringify([
      {
        number: 7,
        title: "chore(deps): update dependency x to v1.2.3",
        url: "https://github.com/o/r/pull/7",
        headRefName: "renovate/x-1.x",
        headRefOid: head,
        labels: (overrides.labels ?? []).map((name) => ({ name })),
        files: (overrides.files ?? ["package.json"]).map((path) => ({ path })),
      },
    ]),
  );

  write(stub(`runs-${head}-pull_request`), `1\tcompleted\t${conclusion}\thttps://ci/1\n`);

  return head;
}

/** A commit Renovate pushes to the branch after the listing, from a clone of its own. */
function renovatePushes() {
  const clone = join(root, "renovate-clone");
  git(root, "clone", "-q", "-b", "renovate/x-1.x", origin, clone);
  write(join(clone, "package.json"), '{"devDependencies":{"x":"1.2.4"}}\n');
  git(clone, "commit", "-qam", "chore(deps): update dependency x to v1.2.4");
  git(clone, "push", "-q", "origin", "renovate/x-1.x");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

const handled = (): Record<string, string[]> =>
  existsSync(state().handled) ? JSON.parse(readFileSync(state().handled, "utf8")) : {};

const report = (): string[] =>
  existsSync(state().report) ? reportLines(readFileSync(state().report, "utf8")) : [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "renovate-agent-"));
  project = join(root, "project");
  origin = join(root, "origin.git");

  write(
    join(root, "gitconfig"),
    "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = dev\n",
  );

  for (const [name, content] of [
    ["gh", GH_STUB],
    ["claude", CLAUDE_STUB],
    ["bun", BUN_STUB],
    ["notify-send", NOTIFY_STUB],
  ] as const) {
    write(join(root, "bin", name), content);
    chmodSync(join(root, "bin", name), 0o755);
  }

  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("GIT_") && name !== "CLAUDE_CODE_TYPES_RUN",
      ),
    ),
    HOME: root,
    PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };

  mkdirSync(join(root, "stub"));
  write(stub("agent-mode"), "commit");
  write(stub("land-exits"), "0\n");

  git(root, "init", "-q", "--bare", origin);
  mkdirSync(project);
  git(project, "init", "-q", "-b", "dev");
  git(project, "remote", "add", "origin", origin);
  write(join(project, "package.json"), '{"devDependencies":{"x":"1.2.2"}}\n');
  write(join(project, "scripts", "tool.ts"), "export {};\n");
  write(join(project, ".claude", "agent-hooks.jsonc"), RISKY_PROFILE);
  git(project, "add", "-A");
  git(project, "commit", "-qm", "initial commit");
  git(project, "push", "-q", "origin", "dev");
  git(project, "switch", "-qc", "renovate/x-1.x");
  write(join(project, "package.json"), '{"devDependencies":{"x":"1.2.3"}}\n');

  git(
    project,
    "commit",
    "-qam",
    "chore(deps): update dependency x to v1.2.3",
    `--author=renovate[bot] <${RENOVATE_EMAIL}>`,
  );

  git(project, "push", "-q", "origin", "renovate/x-1.x");
  git(project, "switch", "-q", "dev");
  git(project, "branch", "-qD", "renovate/x-1.x");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("agentModel", () => {
  test("gives a major update to Opus, every other to Sonnet", () => {
    expect(agentModel(["red", "major"])).toBe("opus");
    expect(agentModel(["red"])).toBe("sonnet");
    expect(agentModel(["red", "e2e"])).toBe("sonnet");
  });
});

describe("renovate-agent run", () => {
  test("hands a red pull request to the agent, pushes its repair and lands it", () => {
    const head = listPr("failure");

    const result = runScript();

    expect(result.code).toBe(0);
    expect(recorded("agent-prompt")).toContain(`CI is red on ${head}`);
    expect(recorded("agent-prompt")).toContain("Never run `scripts/review-verdict.ts`");
    expect(recorded("agent-runs")).toBe(`${worktree()} 1\n`);

    const repaired = originHead();

    expect(git(origin, "log", "-1", "--format=%s", repaired)).toBe("fix: adopt the update");
    expect(git(origin, "rev-parse", `${repaired}^`)).toBe(head);
    expect(recorded("bun-calls")).toContain(`${worktree()} ./scripts/land.ts renovate/x-1.x`);
    expect(existsSync(worktree())).toBe(false);
    expect(handled()).toEqual({ "7": [head, repaired] });
    expect(report()).toEqual([
      "Renovate #7 (chore(deps): update dependency x to v1.2.3): landed renovate/x-1.x on dev at abc (#7)",
    ]);
    expect(recorded("notify-calls")).toContain("-u normal");
  });

  test("commits the fixers' repair of a red update, records the run's verdict for its risky path, and lands it with no agent", () => {
    const head = listPr("failure");
    write(stub("fixer-edits"), "scripts/tool.ts\npackage.json\n");

    expect(runScript().code).toBe(0);
    expect(agentRuns()).toBe(0);

    const repaired = originHead();

    expect(git(origin, "log", "-1", "--format=%s", repaired)).toBe(
      "fix(lint): apply the fixes of oxlint 9.9.1 and oxfmt 9.9.2",
    );
    expect(git(origin, "rev-parse", `${repaired}^`)).toBe(head);
    expect(git(origin, "show", `${repaired}:scripts/tool.ts`)).toBe("export {};\nfixed");
    expect(recorded("bun-calls")).toContain(`${worktree()} run fmt`);

    const patchId = patchIdOf(project, "origin/dev", repaired);

    if (patchId.kind === "failed") throw new Error(patchId.why);

    const comment = recorded("pr-comment");

    expect(comment.split("\n")[0]).toBe(verdictLine(patchId.id));
    expect(comment).toContain("No review: `scripts/renovate-agent.ts` ran oxlint 9.9.1");
    expect(comment).toContain(`on Renovate's head ${head}`);
    expect(recorded("gh-calls")).toContain("pr comment 7 --body-file -");
    expect(recorded("bun-calls")).toContain(`${worktree()} ./scripts/land.ts renovate/x-1.x`);
    expect(handled()).toEqual({ "7": [head, repaired] });
    expect(report()[0]).toContain("landed renovate/x-1.x");
  });

  test("records no verdict for a fixers' repair off the risky paths", () => {
    listPr("failure");
    write(stub("fixer-edits"), "package.json\n");

    runScript();

    expect(agentRuns()).toBe(0);
    expect(git(origin, "log", "-1", "--format=%s", originHead())).toStartWith("fix(lint):");
    expect(recorded("pr-comment")).toBe("");
    expect(report()[0]).toContain("landed renovate/x-1.x");
  });

  test("records no verdict when the branch holds a commit that is not Renovate's", () => {
    const clone = join(root, "someone-clone");
    git(root, "clone", "-q", "-b", "renovate/x-1.x", origin, clone);
    write(join(clone, "notes.txt"), "a commit of someone's\n");
    git(clone, "add", "notes.txt");
    git(clone, "commit", "-qm", "docs: a note");
    git(clone, "push", "-q", "origin", "renovate/x-1.x");
    listPr("failure");
    write(stub("fixer-edits"), "scripts/tool.ts\n");

    runScript();

    expect(git(origin, "log", "-1", "--format=%s", originHead())).toStartWith("fix(lint):");
    expect(recorded("pr-comment")).toBe("");
    expect(readFileSync(prLogPath(state(), 7), "utf8")).toContain(
      "no verdict recorded: the branch holds",
    );
  });

  test("gives a fixers' repair CI still finds red to the agent, whose commit the run's verdict does not cover", () => {
    const head = listPr("failure");
    write(stub("fixer-edits"), "scripts/tool.ts\n");
    write(stub("land-exits"), "red\n0\n");

    runScript();

    expect(agentRuns()).toBe(1);

    const repaired = originHead();
    const fixer = git(origin, "rev-parse", `${repaired}^`);

    expect(git(origin, "rev-parse", `${fixer}^`)).toBe(head);

    const fixerPatch = patchIdOf(project, "origin/dev", fixer);
    const landingPatch = patchIdOf(project, "origin/dev", repaired);

    if (fixerPatch.kind === "failed") throw new Error(fixerPatch.why);

    if (landingPatch.kind === "failed") throw new Error(landingPatch.why);

    const verdicts = verdictsOf([{ body: recorded("pr-comment"), authorAssociation: "OWNER" }]);

    expect(verdicts).toEqual(new Set([fixerPatch.id]));
    expect(verdicts.has(landingPatch.id)).toBe(false);
    expect(handled()).toEqual({ "7": [head, fixer, repaired] });
  });

  test.each([
    ["pre-commit", "git commit"],
    ["pre-push", "git push"],
  ])(
    "drops a fixers' change its %s hook refuses and hands the branch to the agent",
    (hook, step) => {
      const head = listPr("failure");
      write(stub("fixer-edits"), "scripts/tool.ts\n");
      write(stub("refuse"), "");
      const file = join(project, ".git", "hooks", hook);
      write(file, `#!/usr/bin/env bash\nrm ${stub("refuse")} 2>/dev/null && exit 1\nexit 0\n`);
      chmodSync(file, 0o755);

      runScript();

      expect(agentRuns()).toBe(1);

      const repaired = originHead();

      expect(git(origin, "log", "-1", "--format=%s", repaired)).toBe("fix: adopt the update");
      expect(git(origin, "rev-parse", `${repaired}^`)).toBe(head);
      expect(git(origin, "show", `${repaired}:scripts/tool.ts`)).toBe("export {};");
      expect(recorded("pr-comment")).toBe("");
      expect(readFileSync(prLogPath(state(), 7), "utf8")).toContain(
        `the fixers' change is dropped, ${step} exited 1`,
      );
    },
  );

  test("owns a head red in a push run while its pull request runs are green", () => {
    const head = listPr("success");
    write(stub(`runs-${head}-push`), "4\tcompleted\tfailure\thttps://ci/4\n");

    expect(runScript("--dry-run").stdout).toBe("#7 renovate/x-1.x: agent (red)\n");
  });

  test("lands a green e2e update without the agent", () => {
    listPr("success", { files: ["vellum/package.json"] });

    expect(runScript().code).toBe(0);
    expect(agentRuns()).toBe(0);
    expect(report()[0]).toContain("landed renovate/x-1.x");
  });

  test("gives a landing refused on a red CI to the agent, two agent rounds in all, then to the human", () => {
    listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "red\nred\nred\n");

    expect(runScript().code).toBe(0);
    expect(agentRuns()).toBe(AGENT_ROUNDS);
    expect(recorded("agent-prompt")).toContain("refused it: land: CI is red on abc");

    const [line] = report();

    expect(line).toContain(`needs you: CI still red after ${AGENT_ROUNDS} agent rounds`);
    expect(line).toContain(`its worktree, ${worktree()}, is kept`);
    expect(recorded("notify-calls")).toContain("-u critical");
  });

  test("a red pull request gets two agent rounds in all, its first repair included", () => {
    listPr("failure");
    write(stub("land-exits"), "red\nred\nred\n");

    runScript();

    expect(agentRuns()).toBe(AGENT_ROUNDS);
  });

  test("retries a refusal that is not a red CI on the next run, with no agent round and nothing settled", () => {
    listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "review\n");

    runScript();

    expect(agentRuns()).toBe(0);
    expect(report()[0]).toContain("land.ts refused it: land: renovate/x-1.x touches risky paths");
    expect(report()[0]).toContain("the next daily run tries again");
    expect(handled()).toEqual({});
    expect(recorded("notify-calls")).toContain("-u normal");
  });

  test("gives the second refusal in a row to the human and settles the head", () => {
    const head = listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "review\n");
    runScript();
    write(stub("land-exits"), "review\n");

    runScript();

    expect(report()[1]).toContain("needs you: land.ts refused it 2 runs in a row, last: land:");
    expect(handled()).toEqual({ "7": [head] });
    expect(recorded("notify-calls")).toContain("-u critical");
  });

  test("gives no agent round to a refusal after a repair that is not a red CI", () => {
    listPr("failure");
    write(stub("land-exits"), "review\n");

    runScript();

    expect(agentRuns()).toBe(1);
    expect(report()[0]).toContain("land.ts refused it");
    expect(report()[0]).toContain("the next daily run tries again");
  });

  test("records only the heads it pushed, never one someone else pushed meanwhile", () => {
    const head = listPr("success", { labels: ["major"] });
    mkdirSync(state().dir, { recursive: true });
    write(state().refusals, JSON.stringify({ "7": REFUSALS_BEFORE_HUMAN - 1 }));
    write(stub("land-exits"), "foreign\n");

    runScript();

    const foreign = originHead();

    expect(git(origin, "log", "-1", "--format=%s", foreign)).toBe("someone else's");
    expect(handled()["7"]).not.toContain(foreign);
    expect(handled()["7"]).toContain(head);
  });

  test("refuses a branch Renovate moved since the listing, and leaves the new head free", () => {
    listPr("failure");
    renovatePushes();

    runScript();

    expect(agentRuns()).toBe(0);
    expect(report()[0]).toContain("Renovate moved it");
    expect(handled()).toEqual({});
  });

  test("pushes no repair that rewrites the branch's head", () => {
    const head = listPr("failure");
    write(stub("agent-mode"), "amend");

    runScript();

    expect(originHead()).toBe(head);
    expect(report()[0]).toContain("the agent rewrote");
  });

  test("leaves the head free when it fails before any agent round or landing", () => {
    listPr("failure");
    write(stub("install-fails"), "");

    runScript();

    expect(agentRuns()).toBe(0);
    expect(report()[0]).toContain("needs you: bun install --frozen-lockfile exited 1");
    expect(handled()).toEqual({});
  });

  test("ends as stopped on a signal, its agent with it, and leaves the head free", async () => {
    listPr("failure");
    write(stub("agent-mode"), "hold");

    const proc = Bun.spawn([process.execPath, SCRIPT, "run"], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    for (let tries = 0; tries < 100 && agentRuns() === 0; tries++) await Bun.sleep(100);

    const started = performance.now();
    proc.kill("SIGTERM");
    await proc.exited;

    expect(performance.now() - started).toBeLessThan(10_000);
    expect(report()).toHaveLength(1);
    expect(report()[0]).toContain("the run was stopped by SIGTERM");
    expect(handled()).toEqual({});
    expect(recorded("bun-calls")).not.toContain("land.ts");
  });

  test("stops the landing's own children with it", async () => {
    listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "hold\n");

    const proc = Bun.spawn([process.execPath, SCRIPT, "run"], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    for (let tries = 0; tries < 100 && !existsSync(stub("land-child")); tries++) {
      await Bun.sleep(100);
    }

    const child = Number(readFileSync(stub("land-child"), "utf8"));
    proc.kill("SIGTERM");
    await proc.exited;

    for (let tries = 0; tries < 50 && alive(child); tries++) await Bun.sleep(100);

    expect(alive(child)).toBe(false);
    expect(report()[0]).toContain("the run was stopped by SIGTERM");
  });

  test("reports the agent's own verdict when it cannot repair, and leaves that head alone after", () => {
    const head = listPr("failure");
    write(stub("agent-mode"), "cannot");

    runScript();

    expect(report()[0]).toContain(
      "needs you: the agent reports CANNOT REPAIR: the new version drops an API we need",
    );
    expect(recorded("bun-calls")).not.toContain("land.ts");
    expect(handled()["7"]).toContain(head);

    rmSync(stub("agent-runs"));
    runScript();

    expect(agentRuns()).toBe(0);
  });

  test("leaves a green non-major update off the e2e paths to Renovate", () => {
    listPr("success");

    expect(runScript().code).toBe(0);
    expect(agentRuns()).toBe(0);
    expect(recorded("bun-calls")).toBe("");
    expect(report()).toEqual([]);
  });

  test("a dry run prints each owner and starts, pushes and writes nothing", () => {
    listPr("failure");

    const result = runScript("--dry-run");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("#7 renovate/x-1.x: agent (red)\n");
    expect(agentRuns()).toBe(0);
    expect(recorded("bun-calls")).toBe("");
    expect(existsSync(state().dir)).toBe(false);
  });
});
