import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

interface Workflow {
  readonly jobs: Readonly<
    Record<string, { readonly steps?: readonly { readonly run?: string }[] }>
  >;
}

let bin = "";

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "trunk-red-"));
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

interface Issue {
  readonly number: number;
  readonly labels: readonly { readonly name: string }[];
  readonly user: { readonly login: string };
  readonly state_reason?: string;
  readonly closed_at?: string;
}

interface Run {
  readonly conclusion: string;
  readonly id: number;
  readonly head_sha: string;
  readonly html_url: string;
}

interface Fixtures {
  /** The newest completed CI run, as the runs endpoint answers. */
  readonly newest: Run;
  readonly open?: readonly Issue[];
  readonly closed?: readonly Issue[];
}

const GREEN: Run = {
  conclusion: "success",
  id: 11,
  head_sha: "abcdef123",
  html_url: "https://ci/11",
};

function issue(
  number: number,
  labels: readonly string[],
  closed: Pick<Issue, "state_reason" | "closed_at"> = {},
): Issue {
  return {
    number,
    labels: labels.map((name) => ({ name })),
    user: { login: "github-actions[bot]" },
    ...closed,
  };
}

/** Runs the job's step with a `gh` that records its calls and answers each endpoint from `fixtures`
 * through the step's own `--jq` filter, and a `curl` that records the fire. */
async function runStep(
  fixtures: Fixtures,
): Promise<{ code: number; calls: string[]; out: string }> {
  const workflow: Workflow = parse(
    await Bun.file(join(import.meta.dir, "../../.github/workflows/trunk-red.yml")).text(),
  );

  const script = workflow.jobs["trunk-red"]?.steps?.[0]?.run ?? "";
  const calls = join(bin, "calls");

  const data = (
    name: string,
    value:
      | { readonly workflow_runs: readonly Run[] }
      | readonly Issue[]
      | { readonly number: number },
  ): string => {
    const path = join(bin, `${name}.json`);
    writeFileSync(path, JSON.stringify(value));

    return path;
  };

  const runs = data("runs", { workflow_runs: [fixtures.newest] });
  const open = data("open", fixtures.open ?? []);
  const closed = data("closed", fixtures.closed ?? []);
  const created = data("created", { number: 9 });
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
line="gh $*"
printf '%s' "$line" | tr '\n' ' ' >> "${calls}"
echo >> "${calls}"
filter=.
while [ $# -gt 0 ]; do [ "$1" = --jq ] && filter=$2; shift; done
case "$line" in
  *"status=completed"*) file=${runs} ;;
  *"state=open"*) file=${open} ;;
  *"state=closed"*) file=${closed} ;;
  *"status=success"*) echo '{"workflow_runs":[]}' > ${bin}/none.json; file=${bin}/none.json ;;
  *"-X POST repos/o/r/issues -f"*) file=${created} ;;
  *) exit 0 ;;
esac
jq -r "$filter" "$file"
`,
  );
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\necho "curl" >> "${calls}"\necho '{}'\n`);
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
      FIRE_URL: "https://fire",
      FIRE_TOKEN: "t",
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

test("a green newest run closes the open trunk-red issue as not planned, with a comment that names the run", async () => {
  const { code, calls } = await runStep({
    newest: GREEN,
    open: [issue(4, ["trunk-red", "ready"])],
  });

  expect(code).toBe(0);
  expect(calls).toContainEqual(
    "gh api -X POST repos/o/r/issues/4/comments --silent -f body=The CI workflow is green on dev at abcdef1: https://ci/11. No repair is needed, and this issue closes as not planned.",
  );
  expect(calls).toContainEqual(
    "gh api -X PATCH repos/o/r/issues/4 -f state=closed -f state_reason=not_planned --silent",
  );
});

test("a green newest run leaves an issue a session is working on to its pull request", async () => {
  const { code, calls } = await runStep({
    newest: GREEN,
    open: [issue(4, ["trunk-red", "in-progress"]), issue(6, ["trunk-red", "blocked"])],
  });

  expect(code).toBe(0);
  expect(calls.filter((call) => call.includes("repos/o/r/issues/4"))).toEqual([]);
  expect(calls).toContainEqual(
    "gh api -X PATCH repos/o/r/issues/6 -f state=closed -f state_reason=not_planned --silent",
  );
});

test("a cancelled newest run proves nothing and closes nothing", async () => {
  const { code, calls, out } = await runStep({
    newest: { ...GREEN, conclusion: "cancelled" },
    open: [issue(4, ["trunk-red", "ready"])],
  });

  expect(code).toBe(0);
  expect(out).toContain("dev is not red: the newest CI run concluded cancelled.");
  expect(calls).toHaveLength(1);
});

test("an issue a green run closed is no repair: the next red run opens a ready issue and fires the routine", async () => {
  const { code, calls } = await runStep({
    newest: { ...GREEN, conclusion: "failure" },
    closed: [
      issue(4, ["trunk-red"], { state_reason: "not_planned", closed_at: "2026-11-01T00:00:00Z" }),
      issue(5, ["trunk-red"], { state_reason: "not_planned", closed_at: "2026-11-02T00:00:00Z" }),
    ],
  });

  expect(code).toBe(0);
  expect(calls.find((call) => call.startsWith("gh api -X POST repos/o/r/issues -f"))).toContain(
    "labels[]=ready",
  );
  expect(calls).toContain("curl");
});
