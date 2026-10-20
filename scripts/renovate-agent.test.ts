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
  classify,
  combinedVerdict,
  MAJOR_LABEL,
  outcomeLine,
  parsePrList,
  prLogPath,
  recordHandled,
  type RenovatePr,
  reportLines,
  type RiskyPath,
  statePaths,
} from "./renovate-agent.ts";

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

// Stands in for the installs and for land.ts, whose verdicts stub/land-exits gives one per call:
// 0 lands, red and review refuse, deferred defers, foreign first pushes a commit of someone else's
// to the branch, and a rebased- prefix first pushes a commit of land.ts's own, as its rebase does.
const BUN_STUB = `#!/usr/bin/env bash
stub="$(dirname "$0")/../stub"
echo "$PWD $*" >>"$stub/bun-calls"
if [[ "$1" == install && -f $stub/install-fails ]]; then exit 1; fi
if [[ "$1" == ./scripts/land.ts ]]; then
  exits="$stub/land-exits"
  verdict="$(head -n1 "$exits")"
  sed -i 1d "$exits"
  if [[ "$verdict" == rebased-* ]]; then
    git commit -q --allow-empty -m "rebased by land.ts"
    git push -q origin "HEAD:refs/heads/$2"
    verdict="\${verdict#rebased-}"
  fi
  case "$verdict" in
    0) echo "landed $2 on dev at abc (#7)"; exit 0 ;;
    deferred) echo "land: origin/dev moved during each of 3 attempts: land again" >&2; exit 3 ;;
    red) echo "land: CI is red on abc, the head of #7: https://ci/9. Fix it and push" >&2 ;;
    review) echo "land: $2 touches risky paths (.github/workflows/ci.yml); #7 carries no clean review verdict" >&2 ;;
    foreign)
      foreign="$(git commit-tree "HEAD^{tree}" -p HEAD -m "someone else's")"
      git push -qf origin "$foreign:refs/heads/$2"
      echo "land: $2 is at x here and y on #7: push it, then land again" >&2
      ;;
  esac
  exit 1
fi
`;

const NOTIFY_STUB = `#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../stub/notify-calls"
`;

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
  git(project, "add", "-A");
  git(project, "commit", "-qm", "initial commit");
  git(project, "push", "-q", "origin", "dev");
  git(project, "switch", "-qc", "renovate/x-1.x");
  write(join(project, "package.json"), '{"devDependencies":{"x":"1.2.3"}}\n');
  git(project, "commit", "-qam", "chore(deps): update dependency x to v1.2.3");
  git(project, "push", "-q", "origin", "renovate/x-1.x");
  git(project, "switch", "-q", "dev");
  git(project, "branch", "-qD", "renovate/x-1.x");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

  test("sends a review refusal of land.ts to the human with no agent round", () => {
    const head = listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "review\n");

    runScript();

    expect(agentRuns()).toBe(0);
    expect(report()[0]).toContain(
      "needs you: land.ts refused it: land: renovate/x-1.x touches risky paths",
    );
    expect(handled()).toEqual({ "7": [head] });
  });

  test("leaves a landing land.ts deferred to the next daily run, settling no head, with a normal notice", () => {
    listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "deferred\n0\n");

    expect(runScript().code).toBe(0);
    expect(handled()).toEqual({});
    expect(report()).toEqual([
      `Renovate #7 (chore(deps): update dependency x to v1.2.3): land.ts deferred it, land: origin/dev moved during each of 3 attempts: land again (log: ${prLogPath(state(), 7)}; its worktree, ${worktree()}, is kept as it is); the next daily run takes it again`,
    ]);
    expect(recorded("notify-calls")).toContain("-u normal");
    expect(recorded("notify-calls")).not.toContain("-u critical");

    runScript();

    expect(report()[1]).toContain("landed renovate/x-1.x");
  });

  test("leaves free the head land.ts pushed before it deferred", () => {
    const head = listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "rebased-deferred\n");

    runScript();

    expect(originHead()).not.toBe(head);
    expect(handled()).toEqual({});

    listPr("success", { labels: ["major"] });

    expect(runScript("--dry-run").stdout).toBe("#7 renovate/x-1.x: agent (major)\n");
  });

  test("settles none of an agent round's heads when the landing after it is deferred", () => {
    listPr("failure");
    write(stub("land-exits"), "deferred\n");

    runScript();

    expect(agentRuns()).toBe(1);
    expect(handled()).toEqual({});
  });

  test("settles the listed head and the one land.ts pushed when it refuses for good", () => {
    const head = listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "rebased-review\n");

    runScript();

    expect(handled()).toEqual({ "7": [head, originHead()] });
    expect(report()[0]).toContain("needs you: land.ts refused it");
  });

  test("sends a refusal after a repair to the human when it is not a red CI", () => {
    listPr("failure");
    write(stub("land-exits"), "review\n");

    runScript();

    expect(agentRuns()).toBe(1);
    expect(report()[0]).toContain("needs you: land.ts refused it");
  });

  test("records only the heads it pushed, never one someone else pushed meanwhile", () => {
    const head = listPr("failure");
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
