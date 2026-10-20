import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isE2ePath } from "./check-e2e-green.ts";
import type { CiVerdict } from "./ci-wait.ts";
import { write } from "./claude-code-types.fixture.ts";
import {
  classify,
  MAJOR_LABEL,
  outcomeLine,
  parsePrList,
  recordHandled,
  type RenovatePr,
  statePaths,
} from "./renovate-agent.ts";

const SCRIPT = join(import.meta.dir, "renovate-agent.ts");

const REPO = join(import.meta.dir, "..");

const SHA = "a".repeat(40);

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

const RED: CiVerdict = { kind: "red", red: [{ ...run, conclusion: "failure" }] };

describe("classify", () => {
  test("leaves a green non-major update off the e2e paths to Renovate", () => {
    expect(classify(pr(), GREEN, {}).owner).toBe("renovate");
  });

  test("owns a red update", () => {
    expect(classify(pr(), RED, {})).toEqual({ owner: "agent", reasons: ["red"] });
  });

  test("owns a major, read from Renovate's label", () => {
    expect(classify(pr({ labels: [MAJOR_LABEL] }), GREEN, {})).toEqual({
      owner: "agent",
      reasons: ["major"],
    });
  });

  test("owns an update whose files touch the e2e paths, with every reason that holds", () => {
    expect(
      classify(pr({ files: [".github/workflows/ci.yml"], labels: [MAJOR_LABEL] }), RED, {}),
    ).toEqual({ owner: "agent", reasons: ["red", "major", "e2e"] });
  });

  test("waits while CI runs or has not started, whoever owns the update", () => {
    const running: CiVerdict = {
      kind: "running",
      running: [{ ...run, status: "in_progress", conclusion: null }],
    };

    expect(classify(pr({ labels: [MAJOR_LABEL] }), running, {}).owner).toBe("wait");
    expect(classify(pr(), { kind: "none" }, {}).owner).toBe("wait");
  });

  test("leaves a head an earlier run handled, until Renovate pushes another", () => {
    expect(classify(pr(), RED, { "7": [SHA] }).owner).toBe("handled");
    expect(classify(pr(), RED, { "7": ["b".repeat(40)] }).owner).toBe("agent");
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
      outcomeLine({ kind: "failed", pr: pr(), reason: "boom", log: "/l", worktree: "/w" }),
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

  test("keeps automerge off exactly for the package files on check-e2e-green's e2e paths", () => {
    const e2eRule = config.packageRules.find((rule) => rule.matchFileNames !== undefined);
    const globs = (e2eRule?.matchFileNames ?? []).map((glob) => new Bun.Glob(glob));

    const packageFiles = Bun.spawnSync(["git", "ls-files"], { cwd: REPO })
      .stdout.toString()
      .split("\n")
      .filter((path) =>
        /(?:^|\/)(?:package\.json|bun\.lock|mise\.toml)$|^\.github\/workflows\/[^/]+\.ya?ml$/u.test(
          path,
        ),
      );

    expect(e2eRule?.automerge).toBe(false);
    expect(packageFiles.length).toBeGreaterThan(0);

    for (const path of packageFiles) {
      expect({ path, matched: globs.some((glob) => glob.match(path)) }).toEqual({
        path,
        matched: isE2ePath(path),
      });
    }
  });
});

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
echo "$*" >>"$stub/gh-calls"
if [[ "$1 $2" == "pr list" ]]; then cat "$stub/prs.json"; exit 0; fi
if [[ "$1" == api && "$*" =~ head_sha=([0-9a-f]+) ]]; then
  sha="\${BASH_REMATCH[1]}"
  if [[ -f $stub/runs-$sha ]]; then cat "$stub/runs-$sha"; fi
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
  cannot) echo "CANNOT REPAIR: the new version drops an API we need" ;;
esac
`;

// Stands in for the installs and for land.ts, whose exits stub/land-exits gives one per call.
const BUN_STUB = `#!/usr/bin/env bash
stub="$(dirname "$0")/../stub"
echo "$PWD $*" >>"$stub/bun-calls"
if [[ "$1" == ./scripts/land.ts ]]; then
  exits="$stub/land-exits"
  code="$(head -n1 "$exits")"
  sed -i 1d "$exits"
  if [[ $code == 0 ]]; then echo "landed $2 on dev at abc (#7)"; exit 0; fi
  echo "land: CI is red on abc" >&2
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

const state = () => statePaths(join(project, ".git"));

const worktree = () => `${project}.wt/renovate/7`;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);

  return result.stdout.toString().trim();
}

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

/** Lists the branch's pull request as gh does, with CI `conclusion` on its head. */
function listPr(conclusion: string, overrides: Partial<RenovatePr> = {}) {
  const head = git(project, "rev-parse", "origin/renovate/x-1.x");

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

  write(stub(`runs-${head}`), `1\tcompleted\t${conclusion}\thttps://ci/1\n`);

  return head;
}

const handled = (): Record<string, string[]> =>
  existsSync(state().handled) ? JSON.parse(readFileSync(state().handled, "utf8")) : {};

const report = (): string[] =>
  existsSync(state().report) ? JSON.parse(readFileSync(state().report, "utf8")) : [];

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
    expect(recorded("agent-runs")).toBe(`${worktree()} 1\n`);

    const repaired = git(project, "rev-parse", "origin/renovate/x-1.x");

    expect(git(project, "log", "-1", "--format=%s", repaired)).toBe("fix: adopt the update");
    expect(recorded("bun-calls")).toContain(`${worktree()} ./scripts/land.ts renovate/x-1.x`);
    expect(existsSync(worktree())).toBe(false);
    expect(handled()).toEqual({ "7": [head, repaired] });

    const [line] = report();

    expect(line).toBe(
      "Renovate #7 (chore(deps): update dependency x to v1.2.3): landed renovate/x-1.x on dev at abc (#7)",
    );
    expect(recorded("notify-calls")).toContain("-u normal");
  });

  test("lands a green e2e update without the agent", () => {
    listPr("success", { files: ["vellum/package.json"] });

    expect(runScript().code).toBe(0);
    expect(recorded("agent-runs")).toBe("");
    expect(report()[0]).toContain("landed renovate/x-1.x");
  });

  test("gives a refused landing to the agent, then reports to the human after its last round", () => {
    listPr("success", { labels: ["major"] });
    write(stub("land-exits"), "1\n1\n1\n");

    expect(runScript().code).toBe(0);
    expect(recorded("agent-runs").split("\n").filter(Boolean)).toHaveLength(2);
    expect(recorded("agent-prompt")).toContain("refused it: land: CI is red on abc");

    const [line] = report();

    expect(line).toContain("needs you: still not landed after 2 agent rounds");
    expect(line).toContain(`its worktree, ${worktree()}, is kept`);
    expect(recorded("notify-calls")).toContain("-u critical");
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

    expect(recorded("agent-runs")).toBe("");
  });

  test("leaves a green non-major update off the e2e paths to Renovate", () => {
    listPr("success");

    expect(runScript().code).toBe(0);
    expect(recorded("agent-runs")).toBe("");
    expect(recorded("bun-calls")).toBe("");
    expect(report()).toEqual([]);
  });

  test("a dry run prints each owner and starts, pushes and writes nothing", () => {
    listPr("failure");

    const result = runScript("--dry-run");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("#7 renovate/x-1.x: agent (red)\n");
    expect(recorded("agent-runs")).toBe("");
    expect(recorded("bun-calls")).toBe("");
    expect(existsSync(state().dir)).toBe(false);
  });
});
