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
  AGENT_TRAILER,
  type BranchCommit,
  type BranchRead,
  classify,
  combinedVerdict,
  DEFERRALS,
  landVerdict,
  MAJOR_LABEL,
  openCounts,
  outcomeLine,
  parseCommits,
  parsePrList,
  prLogPath,
  recordHandled,
  RENOVATE_EMAIL,
  type RenovatePr,
  reportLines,
  type RiskyPath,
  statePaths,
  updateOf,
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

const RENOVATE_COMMIT: BranchCommit = {
  sha: "c".repeat(40),
  email: RENOVATE_EMAIL,
  identity: "2026-10-20T11:06:14Z chore(deps): update dependency x to v1.2.3",
  agentRun: "",
};

const RENOVATE_ONLY: BranchRead = { kind: "read", commits: [RENOVATE_COMMIT] };

const UPDATE = RENOVATE_COMMIT.identity;

const run = { id: 1, status: "completed", url: "https://ci/1" } as const;

const GREEN: CiVerdict = { kind: "green", runs: [{ ...run, conclusion: "success" }] };

const RED: CiVerdict = { kind: "red", red: [{ ...run, id: 2, conclusion: "failure" }] };

const RUNNING: CiVerdict = {
  kind: "running",
  running: [{ ...run, id: 3, status: "in_progress", conclusion: null }],
};

const owner = (
  verdict: CiVerdict,
  {
    change = {},
    branch = RENOVATE_ONLY,
  }: { change?: Partial<RenovatePr>; branch?: BranchRead } = {},
) => classify(pr(change), branch, verdict, {}, NOTHING_RISKY);

describe("classify", () => {
  test("leaves a green non-major update off the e2e and risky paths to Renovate", () => {
    expect(owner(GREEN).owner).toBe("renovate");
  });

  test("owns a red update, naming the Renovate update it carries", () => {
    expect(owner(RED)).toEqual({ owner: "agent", reasons: ["red"], update: UPDATE });
  });

  test("owns a major, read from Renovate's label", () => {
    expect(owner(GREEN, { change: { labels: [MAJOR_LABEL] } })).toEqual({
      owner: "agent",
      reasons: ["major"],
      update: UPDATE,
    });
  });

  test("owns an update whose files touch the e2e paths, with every reason that holds", () => {
    expect(
      owner(RED, { change: { files: ["vellum/package.json"], labels: [MAJOR_LABEL] } }),
    ).toEqual({ owner: "agent", reasons: ["red", "major", "e2e"], update: UPDATE });
  });

  test("gives an update touching a risky path to the human, red or green", () => {
    for (const verdict of [GREEN, RED]) {
      expect(
        classify(pr({ files: [".github/workflows/ci.yml"] }), RENOVATE_ONLY, verdict, {}, isRisky),
      ).toEqual({
        owner: "human",
        why: "touches risky paths (.github/workflows/ci.yml): land.ts lands it only with a human review verdict",
      });
    }
  });

  test("waits while CI runs or has not started, or while the branch does not read", () => {
    expect(owner(RUNNING, { change: { labels: [MAJOR_LABEL] } }).owner).toBe("wait");
    expect(owner({ kind: "none" }).owner).toBe("wait");
    expect(owner(RED, { branch: { kind: "unread", why: "not fetched" } })).toEqual({
      owner: "wait",
      why: "not fetched",
    });
  });

  test("owns a green update carrying the agent's repair, its trailer's commit", () => {
    const repair = {
      ...RENOVATE_COMMIT,
      sha: "d".repeat(40),
      email: "me@example.com",
      agentRun: "r1",
    };

    expect(owner(GREEN, { branch: { kind: "read", commits: [repair, RENOVATE_COMMIT] } })).toEqual({
      owner: "agent",
      reasons: ["repaired"],
      update: UPDATE,
    });
  });

  test("gives the human an update carrying a commit neither Renovate's nor the agent's", () => {
    const human = { ...RENOVATE_COMMIT, sha: "e".repeat(40), email: "me@example.com" };

    for (const verdict of [GREEN, RED]) {
      expect(
        owner(verdict, { branch: { kind: "read", commits: [human, RENOVATE_COMMIT] } }),
      ).toEqual({
        owner: "human",
        why: `carries eeeeeeee, a commit neither renovate[bot]'s nor the agent's (no ${AGENT_TRAILER} trailer): nothing unattended lands a change nobody reviewed`,
      });
    }
  });

  test("leaves a head an earlier run handled, until Renovate pushes another", () => {
    expect(classify(pr(), RENOVATE_ONLY, RED, { "7": [SHA] }, NOTHING_RISKY).owner).toBe("handled");
    expect(classify(pr(), RENOVATE_ONLY, RED, { "7": ["b".repeat(40)] }, NOTHING_RISKY).owner).toBe(
      "agent",
    );
  });
});

describe("updateOf", () => {
  test("is Renovate's newest commit by author date and subject, whatever the agent added on top", () => {
    const repair = { ...RENOVATE_COMMIT, email: "me@example.com", agentRun: "r1", identity: "x" };

    expect(updateOf([repair, RENOVATE_COMMIT])).toBe(UPDATE);
    expect(updateOf([repair])).toBeNull();
  });
});

describe("parseCommits", () => {
  test("reads each record git log printed, its trailer's value trimmed", () => {
    const log = [
      `${"d".repeat(40)}\u001Fme@example.com\u001F2026-10-20T12:00:00Z\u001Ffix: adopt\u001Fr1\n\u001E`,
      `\n${"c".repeat(40)}\u001F${RENOVATE_EMAIL}\u001F2026-10-20T11:06:14Z\u001Fchore(deps): update dependency x to v1.2.3\u001F\u001E\n`,
    ].join("");

    expect(parseCommits(log)).toEqual([
      {
        sha: "d".repeat(40),
        email: "me@example.com",
        identity: "2026-10-20T12:00:00Z fix: adopt",
        agentRun: "r1",
      },
      RENOVATE_COMMIT,
    ]);
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

describe("landVerdict", () => {
  test("takes land.ts's verdict line, not git's lines printed after it", () => {
    expect(
      landVerdict(
        "lefthook output\nland: the push of renovate/x was refused:\nerror: failed to push some refs\n",
      ),
    ).toBe("land: the push of renovate/x was refused:");
    expect(landVerdict("landed renovate/x on dev at abc (#7)\n")).toBe(
      "landed renovate/x on dev at abc (#7)",
    );
  });
});

describe("openCounts", () => {
  test("forgets the counts of the updates no open pull request carries", () => {
    expect(openCounts({ old: 2, live: 1 }, ["live", "new"])).toEqual({ live: 1 });
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
if [[ "$1" == api && -f $stub/ci-unreachable ]]; then echo "error connecting to api.github.com" >&2; exit 1; fi
if [[ "$1" == api && "$*" =~ head_sha=([0-9a-f]+)\\&event=([a-z_]+) ]]; then
  runs="$stub/runs-\${BASH_REMATCH[1]}-\${BASH_REMATCH[2]}"
  if [[ -f $runs ]]; then cat "$runs"; fi
  exit 0
fi
`;

// The agent: records its prompt, then makes the move stub/agent-mode names, its commits carrying
// the trailer the prompt asks for, but for notrailer's.
const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
printf '%s' "\${!#}" >"$stub/agent-prompt"
echo "$PWD \${CLAUDE_CODE_TYPES_RUN:-unset}" >>"$stub/agent-runs"
trailer="$(grep -o '${AGENT_TRAILER}: [^\`"]*' "$stub/agent-prompt" | head -n1 || true)"
case "$(cat "$stub/agent-mode")" in
  commit)
    echo "fix $(wc -l <"$stub/agent-runs")" >>fix.txt
    git add fix.txt
    git commit -qm "fix: adopt the update" \${trailer:+--trailer "$trailer"}
    ;;
  notrailer)
    echo "fix" >>fix.txt
    git add fix.txt
    git commit -qm "fix: adopt the update"
    ;;
  amend) git commit -q --amend -m "chore(deps): rewritten" ;;
  cannot) echo "CANNOT REPAIR: the new version drops an API we need" ;;
  hold) exec sleep 30 ;;
esac
`;

// Stands in for the installs, which fail as stub/install-fails says (network: on the network), and
// for land.ts, whose verdicts stub/land-exits gives one per call: 0 lands, red, review and
// multiline refuse, deferred defers, broken defers after breaking the worktree, foreign first
// pushes a commit of someone else's to the branch, and a rebased- prefix first rebases every commit
// of the branch on dev and pushes them, as land.ts's rebase does.
const BUN_STUB = `#!/usr/bin/env bash
stub="$(dirname "$0")/../stub"
echo "$PWD $*" >>"$stub/bun-calls"
if [[ "$1" == install && -f $stub/install-fails ]]; then
  if [[ "$(cat "$stub/install-fails")" == network ]]; then echo "error: ConnectionRefused downloading package manifest x" >&2; fi
  exit 1
fi
if [[ "$1" == */scripts/land.ts ]]; then
  exits="$stub/land-exits"
  verdict="$(head -n1 "$exits")"
  sed -i 1d "$exits"
  if [[ "$verdict" == rebased-* ]]; then
    git rebase -q --force-rebase origin/dev
    git push -qf origin "HEAD:refs/heads/$2"
    verdict="\${verdict#rebased-}"
  fi
  case "$verdict" in
    0) echo "landed $2 on dev at abc (#7)"; exit 0 ;;
    deferred) echo "land: origin/dev moved during each of 3 attempts: land again" >&2; exit 3 ;;
    broken) rm -f .git; echo "land: git fetch: Could not resolve host: github.com" >&2; exit 3 ;;
    multiline) printf 'land: the push of %s was refused; it is back at abc:\\nerror: failed to push some refs\\n' "$2" >&2 ;;
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

// Git itself, but for the fetch of one branch's head while stub/fetch-unreachable exists, which
// fails as git does when the network is down.
const GIT_STUB = `#!/usr/bin/env bash
stub="$(dirname "$0")/../stub"
if [[ -f $stub/fetch-unreachable && "$*" == *"fetch --quiet origin +refs/heads/"* ]]; then
  echo "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com" >&2
  exit 128
fi
exec ${Bun.which("git") ?? "/usr/bin/git"} "$@"
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

const AS_RENOVATE = ["-c", "user.name=renovate[bot]", "-c", `user.email=${RENOVATE_EMAIL}`];

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
  git(clone, ...AS_RENOVATE, "commit", "-qam", "chore(deps): update dependency x to v1.2.4");
  git(clone, "push", "-q", "origin", "renovate/x-1.x");
}

/** Renovate recreating its branch from dev as one commit, as its rebase does. */
function renovateRecreates() {
  const clone = join(root, "renovate-recreate");
  git(root, "clone", "-q", "-b", "dev", origin, clone);
  write(join(clone, "package.json"), '{"devDependencies":{"x":"1.2.4"}}\n');
  git(clone, ...AS_RENOVATE, "commit", "-qam", "chore(deps): update dependency x to v1.2.4");
  git(clone, "push", "-qf", "origin", "HEAD:refs/heads/renovate/x-1.x");
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
    ["git", GIT_STUB],
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
  git(project, ...AS_RENOVATE, "commit", "-qam", "chore(deps): update dependency x to v1.2.3");
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
    expect(recorded("bun-calls")).toContain(
      `${worktree()} ${join(import.meta.dir, "land.ts")} renovate/x-1.x`,
    );
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
      `Renovate #7 (chore(deps): update dependency x to v1.2.3): deferred, land: origin/dev moved during each of 3 attempts: land again (log: ${prLogPath(state(), 7)}); the next daily run takes it again`,
    ]);
    expect(existsSync(worktree())).toBe(false);
    expect(recorded("notify-calls")).toContain("-u normal");
    expect(recorded("notify-calls")).not.toContain("-u critical");

    runScript();

    expect(report()[1]).toContain("landed renovate/x-1.x");
  });

  test("takes a deferred pull request again once Renovate recreated its branch", () => {
    listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "deferred\n0\n");

    runScript();
    renovateRecreates();
    listPr("success", { labels: ["major"] });
    runScript();

    expect(report()[1]).toContain("landed renovate/x-1.x");
    expect(recorded("notify-calls")).not.toContain("-u critical");
  });

  test("lands a repair whose landing was deferred, though its head is green and no major", () => {
    listPr("failure");
    write(stub("land-exits"), "deferred\n0\n");

    runScript();
    listPr("success");

    expect(runScript("--dry-run").stdout).toBe("#7 renovate/x-1.x: agent (repaired)\n");

    runScript();

    expect(agentRuns()).toBe(1);
    expect(report()[1]).toContain("landed renovate/x-1.x");
  });

  test("counts the agent rounds across runs, a deferred landing between them", () => {
    listPr("failure");
    write(stub("land-exits"), "deferred\nred\nred\n");

    runScript();
    listPr("failure");
    runScript();

    expect(agentRuns()).toBe(AGENT_ROUNDS);
    expect(report()[1]).toContain(`needs you: CI still red after ${AGENT_ROUNDS} agent rounds`);
  });

  test("hands a red update whose rounds are spent to the human before any worktree or install", () => {
    listPr("failure");
    write(stub("land-exits"), "deferred\ndeferred\n");

    runScript();
    listPr("failure");
    runScript();

    const repaired = listPr("failure");

    rmSync(stub("bun-calls"));
    runScript();

    expect(agentRuns()).toBe(AGENT_ROUNDS);
    expect(report()[2]).toContain(`needs you: CI still red after ${AGENT_ROUNDS} agent rounds`);
    expect(recorded("bun-calls")).toBe("");
    expect(handled()).toEqual({ "7": [repaired] });
  });

  test("counts the rounds per Renovate update: Renovate's next one starts with none spent", () => {
    listPr("failure");
    write(stub("land-exits"), "red\nred\n");

    runScript();
    git(project, "worktree", "remove", "--force", worktree());
    renovateRecreates();
    listPr("failure");
    write(stub("land-exits"), "red\nred\n");
    runScript();

    expect(agentRuns()).toBe(2 * AGENT_ROUNDS);
  });

  test("keeps an update's rounds through land.ts's rebase of its branch", () => {
    listPr("failure");
    write(stub("land-exits"), "rebased-deferred\nred\nred\n");

    runScript();
    listPr("failure");
    runScript();

    expect(agentRuns()).toBe(AGENT_ROUNDS);
  });

  test("spends no round on an agent the run's stop ended", async () => {
    listPr("failure");
    write(stub("agent-mode"), "hold");

    const proc = Bun.spawn([process.execPath, SCRIPT, "run"], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    for (let tries = 0; tries < 100 && agentRuns() === 0; tries++) await Bun.sleep(100);
    proc.kill("SIGTERM");
    await proc.exited;

    write(stub("agent-mode"), "commit");
    write(stub("land-exits"), "red\nred\nred\n");
    runScript();

    expect(agentRuns()).toBe(1 + AGENT_ROUNDS);
  });

  test("gives the human an update deferred three times in a row, critically, its head settled", () => {
    const head = listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "deferred\ndeferred\ndeferred\n");

    for (let deferral = 1; deferral <= DEFERRALS; deferral++) runScript();

    expect(report()).toHaveLength(DEFERRALS);
    expect(report()[DEFERRALS - 1]).toContain(
      `needs you: deferred ${DEFERRALS} times in a row, the last: land: origin/dev moved`,
    );
    expect(recorded("notify-calls").trim().split("\n").at(-1)).toContain("-u critical");
    expect(handled()).toEqual({ "7": [head] });
  });

  test("pushes none of an agent's commits that lack its trailer, and hands the update to the human", () => {
    const head = listPr("failure");
    write(stub("agent-mode"), "notrailer");

    runScript();

    expect(originHead()).toBe(head);
    expect(report()[0]).toContain(`without the trailer ${AGENT_TRAILER}: `);
    expect(recorded("bun-calls")).not.toContain("land.ts");
  });

  test("gives the human a branch carrying a commit neither Renovate's nor the agent's, never landing it", () => {
    const clone = join(root, "human-clone");
    git(root, "clone", "-q", "-b", "renovate/x-1.x", origin, clone);
    write(join(clone, "notes.txt"), "a human's change\n");
    git(clone, "add", "notes.txt");
    git(clone, "commit", "-qm", "docs: a human's change");
    git(clone, "push", "-q", "origin", "renovate/x-1.x");
    const head = listPr("success", { labels: ["major"] });

    runScript();

    expect(report()[0]).toContain("a commit neither renovate[bot]'s nor the agent's");
    expect(recorded("bun-calls")).toBe("");
    expect(handled()).toEqual({ "7": [head] });
  });

  test("lists the pull requests without gh's commits field, which GitHub refuses past 500,000 nodes", () => {
    listPr("success");

    runScript();

    const list = recorded("gh-calls")
      .split("\n")
      .find((call) => call.startsWith("pr list"));

    expect(list).toContain("--json number,title,url,headRefName,headRefOid,labels,files");
    expect(list).not.toContain("commits");
  });

  test("ends the run with a normal notice when its fetch cannot reach origin", () => {
    listPr("failure");
    git(project, "remote", "set-url", "origin", "http://127.0.0.1:9/origin.git");

    runScript();

    expect(report()[0]).toContain("the run could not reach origin or GitHub");
    expect(recorded("notify-calls")).not.toContain("-u critical");
  });

  test("fails the run critically when its fetch fails on the request", () => {
    listPr("failure");
    git(project, "remote", "set-url", "origin", join(root, "gone.git"));

    runScript();

    expect(report()[0]).toContain("Renovate agent: the run failed");
    expect(recorded("notify-calls")).toContain("-u critical");
  });

  test("lets a pull request whose CI gh cannot reach wait, the run going on", () => {
    listPr("failure");
    write(stub("ci-unreachable"), "");

    expect(runScript("--dry-run").stdout).toContain(
      "#7 renovate/x-1.x: wait, gh could not read the CI of",
    );

    runScript();

    expect(report()).toEqual([]);
    expect(recorded("notify-calls")).toBe("");
  });

  test.each([
    ["the fetch of its head cannot reach origin", "fetch-unreachable", ""],
    ["an install cannot reach the registry", "install-fails", "network"],
  ])("defers an update when %s", (_, file, content) => {
    listPr("failure");
    write(stub(file), content);

    runScript();

    expect(report()[0]).toContain("deferred,");
    expect(recorded("notify-calls")).not.toContain("-u critical");
    expect(handled()).toEqual({});
  });

  test("keeps a deferral a deferral when the worktree it would remove does not read", () => {
    listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "broken\n");

    runScript();

    expect(report()[0]).toContain("deferred, land: git fetch: Could not resolve host");
    expect(recorded("notify-calls")).not.toContain("-u critical");
    expect(handled()).toEqual({});
  });

  test("reports land.ts's verdict line, not git's lines printed after it", () => {
    listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "multiline\n");

    runScript();

    expect(report()[0]).toContain(
      "needs you: land.ts refused it: land: the push of renovate/x-1.x was refused; it is back at abc:",
    );
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
