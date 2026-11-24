import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

interface Step {
  readonly run?: string;
  readonly uses?: string;
}

interface Workflow {
  readonly on: {
    readonly workflow_run?: {
      readonly workflows?: readonly string[];
      readonly types?: readonly string[];
    };
  };
  readonly jobs: Readonly<
    Record<string, { readonly if?: string; readonly steps?: readonly Step[] }>
  >;
}

const ROOT = join(import.meta.dir, "../..");

async function workflow(): Promise<Workflow> {
  return parse(await Bun.file(join(ROOT, ".github/workflows/renovate-red.yml")).text());
}

let bin = "";

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "renovate-red-"));
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

const HEAD = "aaaa1111bbbb2222";

const TITLE = "Update dependency yaml to v2.9.0";

const KEY = `Renovate #7 is red: ${TITLE}`;

interface Issue {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly body: string;
  readonly labels: readonly { readonly name: string }[];
  readonly user: { readonly login: string };
}

interface Commit {
  readonly sha: string;
  readonly author: { readonly login: string };
  readonly committer: { readonly login: string };
  readonly commit: { readonly verification: { readonly verified: boolean } };
}

const RENOVATE: Commit = {
  sha: HEAD,
  author: { login: "renovate[bot]" },
  committer: { login: "web-flow" },
  commit: { verification: { verified: true } },
};

/** What the fake `gh` answers on one endpoint. */
type Answer =
  | {
      readonly state: string;
      readonly user: { readonly login: string };
      readonly head: { readonly sha: string };
      readonly base: { readonly ref: string };
      readonly labels: readonly { readonly name: string }[];
      readonly title: string;
    }
  | { readonly jobs: readonly { readonly name: string; readonly conclusion: string }[] }
  | { readonly workflow_runs: readonly { readonly conclusion: string }[] }
  | { readonly number: number }
  | readonly Commit[]
  | readonly Issue[]
  | readonly { readonly filename: string }[];

interface Fixtures {
  readonly pr?: string;
  readonly state?: string;
  readonly base?: string;
  readonly labels?: readonly string[];
  readonly head?: string;
  readonly title?: string;
  readonly author?: string;
  readonly test?: string;
  readonly commits?: readonly Commit[];
  readonly issues?: readonly Issue[];
  /** The conclusion of the newest completed CI run of dev. */
  readonly dev?: string;
  readonly files?: readonly string[];
  readonly attempt?: string;
}

function issue(
  number: number,
  state: Issue["state"],
  head: string,
  labels: readonly string[],
  title = KEY,
): Issue {
  return {
    number,
    title,
    state,
    body: `The CI workflow failed on the Renovate update #7 at ${head}: https://ci/1`,
    labels: ["renovate-red", ...labels].map((name) => ({ name })),
    user: { login: "github-actions[bot]" },
  };
}

/** Runs the job's step with a `gh` that records its calls and answers each endpoint from the fixtures through
 * the step's own `--jq` filter, and a `curl` that records the fire. */
async function runStep(
  fixtures: Fixtures,
): Promise<{ code: number; calls: string[]; out: string }> {
  const script = (await workflow()).jobs["renovate-red"]?.steps?.[0]?.run ?? "";
  const calls = join(bin, "calls");

  const data = (name: string, value: Answer): string => {
    const path = join(bin, `${name}.json`);
    writeFileSync(path, JSON.stringify(value));

    return path;
  };

  const pr = data("pr", {
    state: fixtures.state ?? "open",
    user: { login: fixtures.author ?? "renovate[bot]" },
    head: { sha: fixtures.head ?? HEAD },
    base: { ref: fixtures.base ?? "dev" },
    labels: (fixtures.labels ?? []).map((name) => ({ name })),
    title: fixtures.title ?? TITLE,
  });

  const jobs = data("jobs", {
    jobs: [
      { name: "validate", conclusion: "failure" },
      { name: "test", conclusion: fixtures.test ?? "failure" },
    ],
  });

  const commits = data("commits", fixtures.commits ?? [RENOVATE]);
  const issues = data("issues", fixtures.issues ?? []);
  const runs = data("runs", { workflow_runs: [{ conclusion: fixtures.dev ?? "success" }] });

  const files = data(
    "files",
    (fixtures.files ?? ["package.json", "bun.lock"]).map((filename) => ({ filename })),
  );

  const created = data("created", { number: 9 });

  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
line="gh $*"
printf '%s' "$line" | tr '\\n' ' ' >> "${calls}"
echo >> "${calls}"
filter=.
while [ $# -gt 0 ]; do [ "$1" = --jq ] && filter=$2; shift; done
case "$line" in
  "gh api repos/o/r/pulls/7 --jq"*) file=${pr} ;;
  *"/jobs?"*) file=${jobs} ;;
  *"/pulls/7/commits"*) file=${commits} ;;
  *"labels=renovate-red"*) file=${issues} ;;
  *"status=completed"*) file=${runs} ;;
  *"/pulls/7/files"*) file=${files} ;;
  *"-X POST repos/o/r/issues -f"*) file=${created} ;;
  "gh run view"*) echo "test	Run tests	2026-11-24T00:00:00Z error: yaml.parse is not a function"; exit 0 ;;
  *) exit 0 ;;
esac
jq -r "$filter" "$file"
`,
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash\necho "curl $*" >> "${calls}"\necho '{}'\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);

  const step = Bun.spawn(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"]}`,
      REPO: "o/r",
      BRANCH: "dev",
      WORKFLOW: "5",
      CI: "CI",
      RUN: "1",
      RUN_URL: "https://ci/1",
      HEAD,
      PR: fixtures.pr ?? "7",
      FIRE_URL: "https://fire",
      FIRE_TOKEN: "t",
      GITHUB_RUN_ATTEMPT: fixtures.attempt ?? "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err] = await Promise.all([
    new Response(step.stdout).text(),
    new Response(step.stderr).text(),
  ]);

  const code = await step.exited;
  const recorded = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];

  return { code, calls: recorded, out: `${out}${err}` };
}

const opened = (calls: readonly string[]): string | undefined =>
  calls.find((call) => call.startsWith("gh api -X POST repos/o/r/issues -f"));

const fired = (calls: readonly string[]): boolean => calls.some((call) => call.startsWith("curl"));

const stopped = (calls: readonly string[]): boolean =>
  calls.includes("gh api -X POST repos/o/r/issues/7/labels -f labels[]=needs-human --silent");

test("it listens to the failed CI runs of Renovate's pull requests and uses no action", async () => {
  const flow = await workflow();
  const job = flow.jobs["renovate-red"];

  expect(flow.on.workflow_run?.workflows).toEqual(["CI"]);
  expect(job?.if).toContain("github.event.workflow_run.event == 'pull_request'");
  expect(job?.if).toContain("github.event.workflow_run.conclusion == 'failure'");
  expect(job?.if).toContain("startsWith(github.event.workflow_run.head_branch, 'renovate/')");
  expect(job?.steps?.filter((step) => step.uses !== undefined)).toEqual([]);
  expect(await Bun.file(join(ROOT, ".github/workflows/actions.lock")).text()).toContain(
    "'.github/workflows/renovate-red.yml': []",
  );
});

test("a first failure opens a ready repair issue named after the update, which records its head, and fires the routine", async () => {
  const { code, calls } = await runStep({});

  expect(code).toBe(0);
  const post = opened(calls);
  expect(post).toContain(`-f title=${KEY}`);
  expect(post).toContain(`at ${HEAD}: https://ci/1`);
  expect(post).toContain("error: yaml.parse is not a function");
  expect(post).toContain("labels[]=renovate-red");
  expect(post).toContain("labels[]=ready");
  expect(fired(calls)).toBe(true);
  expect(stopped(calls)).toBe(false);
});

test("a re-run of a head already counted opens nothing and stops nothing", async () => {
  const { code, calls, out } = await runStep({ issues: [issue(4, "closed", HEAD, [])] });

  expect(code).toBe(0);
  expect(out).toContain("aaaa111 of #7 is already counted: #4.");
  expect(opened(calls)).toBeUndefined();
  expect(fired(calls)).toBe(false);
  expect(stopped(calls)).toBe(false);
});

test("re-running this job on a ready issue of the same head fires the routine again", async () => {
  const { calls } = await runStep({ issues: [issue(4, "open", HEAD, ["ready"])], attempt: "2" });

  expect(opened(calls)).toBeUndefined();
  expect(fired(calls)).toBe(true);
});

test("a new head while the repair issue is open opens nothing: Renovate rewrote its branch under the repair", async () => {
  const { code, calls, out } = await runStep({
    issues: [issue(4, "open", "cccc3333", ["in-progress"])],
  });

  expect(code).toBe(0);
  expect(out).toContain("The repair of #7 is under way: #4.");
  expect(opened(calls)).toBeUndefined();
  expect(stopped(calls)).toBe(false);
});

test("a second failure of the same update once its repair is closed starts no session and labels it needs-human", async () => {
  const { code, calls } = await runStep({ issues: [issue(4, "closed", "cccc3333", [])] });

  expect(code).toBe(0);
  expect(opened(calls)).toContain("labels[]=needs-human");
  expect(opened(calls)).toContain("one attempt per update");
  expect(stopped(calls)).toBe(true);
  expect(fired(calls)).toBe(false);
});

test("a new version under the same pull request is a new update, which gets its own attempt", async () => {
  const { calls } = await runStep({
    issues: [
      issue(4, "closed", "cccc3333", [], "Renovate #7 is red: Update dependency yaml to v2.8.0"),
    ],
  });

  expect(opened(calls)).toContain("labels[]=ready");
  expect(fired(calls)).toBe(true);
});

test("no repair issue opens while the newest CI run of dev is red", async () => {
  const { code, calls, out } = await runStep({ dev: "failure" });

  expect(code).toBe(0);
  expect(out).toContain("dev is red");
  expect(opened(calls)).toBeUndefined();
  expect(fired(calls)).toBe(false);
});

test("an update that touches .github/workflows/ starts no session and is labelled needs-human", async () => {
  const { calls } = await runStep({
    files: [".github/workflows/ci.yml", ".github/workflows/actions.lock"],
  });

  expect(opened(calls)).toContain("labels[]=needs-human");
  expect(opened(calls)).toContain("gh actions-lock");
  expect(stopped(calls)).toBe(true);
  expect(fired(calls)).toBe(false);
});

test("re-run CI on a head whose issue is still ready fires nothing: only a re-run of this job fires again", async () => {
  const { calls } = await runStep({ issues: [issue(4, "open", HEAD, ["ready"])], attempt: "1" });

  expect(opened(calls)).toBeUndefined();
  expect(fired(calls)).toBe(false);
});

test("a major starts no session and is labelled needs-human: the owner merges it himself", async () => {
  const { calls } = await runStep({ labels: ["dependencies", "major"] });

  expect(opened(calls)).toContain("labels[]=needs-human");
  expect(opened(calls)).toContain("a major");
  expect(stopped(calls)).toBe(true);
  expect(fired(calls)).toBe(false);
});

test("a Renovate pull request that carries a commit of someone else gets no repair", async () => {
  const { calls, out } = await runStep({
    commits: [RENOVATE, { ...RENOVATE, sha: "dddd", author: { login: "bengous" } }],
  });

  expect(out).toContain("#7 carries a commit of someone else than Renovate: no repair.");
  expect(opened(calls)).toBeUndefined();
  expect(fired(calls)).toBe(false);
});

test("a run that names no pull request asks GitHub nothing", async () => {
  const { code, calls, out } = await runStep({ pr: "" });

  expect(code).toBe(0);
  expect(out).toContain("The CI run names no pull request.");
  expect(calls).toEqual([]);
});

test.each([
  ["a pull request someone else opened", { author: "bengous" }],
  ["the run of a head Renovate has since rewritten", { head: "eeee5555" }],
  ["a run whose test did not fail", { test: "success" }],
  ["a pull request Renovate closed", { state: "closed" }],
  ["a pull request against another base", { base: "main" }],
])("%s gets no repair", async (_name, fixtures: Fixtures) => {
  const { code, calls } = await runStep(fixtures);

  expect(code).toBe(0);
  expect(opened(calls)).toBeUndefined();
  expect(fired(calls)).toBe(false);
});
