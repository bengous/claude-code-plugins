import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type CheckRun,
  type CheckRuns,
  isE2ePath,
  parsePushedRefs,
  refusalFor,
} from "./check-e2e-green.ts";

const SCRIPT = join(import.meta.dir, "check-e2e-green.ts");

const ZERO = "0".repeat(40);

const START_A_RUN = "git push --force-with-lease origin <branch>";

function e2eRun(run: number, job: number, status: string, conclusion: string | null): CheckRun {
  return {
    id: job,
    name: "e2e",
    status,
    conclusion,
    detailsUrl: `https://github.com/owner/repo/actions/runs/${run}/job/${job}`,
  };
}

const GREEN = e2eRun(11, 101, "completed", "success");

const CANCELLED = e2eRun(12, 102, "completed", "cancelled");

const FAILED = e2eRun(13, 103, "completed", "failure");

const RUNNING = e2eRun(14, 104, "in_progress", null);

const VALIDATE: CheckRun = { ...GREEN, id: 100, name: "validate" };

function listed(...runs: CheckRun[]): CheckRuns {
  return { kind: "listed", runs };
}

describe("isE2ePath", () => {
  test("keeps each path the suite loads", () => {
    for (const path of [
      "vellum/src/core/page/app.tsx",
      "vellum/e2e/labels.e2e.ts",
      "vellum/package.json",
      "docs/plugin-testing.md",
      "mise.toml",
      ".github/workflows/ci.yml",
    ]) {
      expect([path, isE2ePath(path)]).toEqual([path, true]);
    }
  });

  test("keeps a new directory under vellum/", () => {
    expect(isE2ePath("vellum/fresh/thing.ts")).toBe(true);
  });

  test("leaves out each path the suite never loads", () => {
    for (const path of [
      "vellum/src/core/engine/hooks.ts",
      "vellum/src/core/engine/deep/state.ts",
      "vellum/src/extensions/grill/engine.ts",
      "vellum/hooks/hooks.json",
      "vellum/skills/start/SKILL.md",
      "vellum/agents/plan-reviewer.md",
      "vellum/src/core/page/app.spec.ts",
      "vellum/src/core/server/routes.test.ts",
    ]) {
      expect([path, isE2ePath(path)]).toEqual([path, false]);
    }
  });

  test("leaves out a path outside the list", () => {
    for (const path of [
      "README.md",
      "docs/repo-ops/checks.md",
      ".github/workflows/other.yml",
      "scripts/run-gates.ts",
      "archive/vellum/src/page.tsx",
    ]) {
      expect([path, isE2ePath(path)]).toEqual([path, false]);
    }
  });

  test("keeps an extension file that is not its engine", () => {
    expect(isE2ePath("vellum/src/extensions/grill/page.tsx")).toBe(true);
  });
});

describe("parsePushedRefs", () => {
  const local = "a".repeat(40);
  const remote = "b".repeat(40);

  test("keeps a line whose remote ref is dev", () => {
    expect(parsePushedRefs(`refs/heads/feature/x ${local} refs/heads/dev ${remote}\n`)).toEqual([
      { local, remote },
    ]);
  });

  test("keeps a local ref typed with spaces", () => {
    expect(parsePushedRefs(`HEAD@{1 day ago} ${local} refs/heads/dev ${remote}\n`)).toEqual([
      { local, remote },
    ]);
  });

  test("reads git's zero oid as a remote without dev", () => {
    expect(parsePushedRefs(`refs/heads/dev ${local} refs/heads/dev ${ZERO}\n`)).toEqual([
      { local, remote: null },
    ]);
  });

  test("ignores a line to another ref", () => {
    expect(
      parsePushedRefs(
        `refs/heads/dev ${local} refs/heads/main ${remote}\nrefs/heads/x ${local} refs/heads/x ${remote}\n`,
      ),
    ).toEqual([]);
  });

  test("keeps the dev line after a line to another ref", () => {
    expect(
      parsePushedRefs(
        `refs/heads/x ${local} refs/heads/x ${remote}\nrefs/heads/x ${local} refs/heads/dev ${remote}\n`,
      ),
    ).toEqual([{ local, remote }]);
  });

  test("ignores a deletion of dev", () => {
    expect(parsePushedRefs(`(delete) ${ZERO} refs/heads/dev ${remote}\n`)).toEqual([]);
  });

  test("reads a 64-digit oid", () => {
    const long = "c".repeat(64);

    expect(parsePushedRefs(`refs/heads/x ${long} refs/heads/dev ${long}\n`)).toEqual([
      { local: long, remote: long },
    ]);
  });

  test("refuses a malformed line, naming it", () => {
    const line = `refs/heads/x ${local} refs/heads/dev`;

    expect(() => parsePushedRefs(`${line}\n`)).toThrow(line);
  });
});

describe("refusalFor", () => {
  test("passes one green run whatever the others say", () => {
    expect(refusalFor(listed(CANCELLED, GREEN, FAILED, RUNNING))).toBeNull();
  });

  test("asks for a run on a SHA with none", () => {
    const refusal = refusalFor(listed());

    expect(refusal?.reason).toBe("it has no green e2e check run (found: none)");
    expect(refusal?.next).toStartWith(`Start a run on that commit: ${START_A_RUN}`);
  });

  test("waits for a run still in progress, naming its workflow run", () => {
    expect(refusalFor(listed(FAILED, RUNNING))).toEqual({
      reason: "it has no green e2e check run (found: failure, in_progress)",
      next: "Wait for the run in progress: gh run watch 14.",
    });
  });

  test("re-runs the newest job when every run ended red", () => {
    expect(refusalFor(listed(FAILED, CANCELLED))).toEqual({
      reason: "it has no green e2e check run (found: failure, cancelled)",
      next: "Re-run it: gh run rerun --job 103.",
    });
  });

  test("refuses a run in progress that links no workflow run, naming it", () => {
    expect(() => refusalFor(listed({ ...RUNNING, detailsUrl: null }))).toThrow("104");
  });

  test("counts only the check named e2e", () => {
    expect(refusalFor(listed(VALIDATE))?.reason).toBe(
      "it has no green e2e check run (found: none)",
    );
  });

  test("refuses when gh could not list the runs, saying so", () => {
    const refusal = refusalFor({ kind: "unreadable", error: "gh: HTTP 401: Bad credentials" });

    expect(refusal?.reason).toBe("gh could not list its check runs: gh: HTTP 401: Bad credentials");
    expect(refusal?.next).toContain(START_A_RUN);
  });
});

describe("the command", () => {
  let root = "";

  let repo = "";

  let base = "";

  function write(path: string, content: string) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }

  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());

    return result.stdout.toString().trim();
  }

  function commit(message: string): string {
    git("add", "-A");
    git("commit", "-qm", message);

    return git("rev-parse", "HEAD");
  }

  function fakeGh(body: string) {
    const path = join(root, "bin", "gh");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho "$@" >> '${root}/calls'\n${body}\n`);
    chmodSync(path, 0o755);
  }

  function ghLists(...runs: CheckRun[]) {
    fakeGh(`cat <<'EOF'\n${runs.map((checkRun) => JSON.stringify(checkRun)).join("\n")}\nEOF`);
  }

  function ghCalls(): string {
    const path = join(root, "calls");

    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  function run(stdin: string, env: Record<string, string> = {}) {
    const result = Bun.spawnSync([process.execPath, SCRIPT], {
      cwd: repo,
      env: { ...process.env, ...env, PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}` },
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });

    return { code: result.exitCode, err: result.stderr.toString() };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-e2e-green-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    git("init", "-q", "-b", "dev");
    // A CI runner carries no identity, and signing is on globally here.
    git("config", "user.name", "E2e gate test");
    git("config", "user.email", "e2e-gate@example.test");
    git("config", "commit.gpgsign", "false");
    write("vellum/src/core/page/app.tsx", "original\n");
    write("vellum/src/core/engine/hooks.ts", "original\n");
    write("README.md", "docs\n");
    base = commit("Base");
    fakeGh(`echo 'gh: not expected in this test' >&2\nexit 1`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("refuses a push to dev that touches an e2e path while its SHA has no e2e run", () => {
    write("vellum/src/core/page/app.tsx", "changed\n");
    const head = commit("Change the page");
    ghLists(VALIDATE);
    const result = run(`refs/heads/feature/x ${head} refs/heads/dev ${base}\n`);

    expect(result.code).toBe(1);
    expect(result.err).toContain(`refs/heads/dev at ${head} touches vellum/src/core/page/app.tsx`);
    expect(result.err).toContain("it has no green e2e check run (found: none)");
    expect(result.err).toContain(START_A_RUN);
    expect(ghCalls()).toContain(`repos/{owner}/{repo}/commits/${head}/check-runs`);
  });

  test("names the job to re-run when the SHA's e2e ended red", () => {
    write("vellum/src/core/page/app.tsx", "changed\n");
    const head = commit("Change the page");
    ghLists(CANCELLED);
    const result = run(`refs/heads/feature/x ${head} refs/heads/dev ${base}\n`);

    expect(result.code).toBe(1);
    expect(result.err).toContain("it has no green e2e check run (found: cancelled)");
    expect(result.err).toContain("Re-run it: gh run rerun --job 102.");
  });

  test("asks gh for every page and every attempt of the SHA's check runs", () => {
    write("vellum/src/core/page/app.tsx", "changed\n");
    const head = commit("Change the page");
    ghLists(GREEN);
    run(`refs/heads/feature/x ${head} refs/heads/dev ${base}\n`);

    expect(ghCalls().split(" ")).toContain("--paginate");
    expect(ghCalls()).toContain("filter=all");
  });

  test("reads gh's output when the pusher forces its colors", () => {
    write("vellum/src/core/page/app.tsx", "changed\n");
    const head = commit("Change the page");
    // What gh does with either variable set: its jq results come out indented.
    fakeGh(
      `if [ "\${CLICOLOR_FORCE:-0}" != 0 ] || [ -n "\${GH_FORCE_TTY:-}" ]; then printf '{\\n  "id": 101\\n}\\n'; exit 0; fi\ncat <<'EOF'\n${JSON.stringify(GREEN)}\nEOF`,
    );

    expect(
      run(`refs/heads/feature/x ${head} refs/heads/dev ${base}\n`, {
        CLICOLOR_FORCE: "1",
        GH_FORCE_TTY: "1",
      }),
    ).toEqual({ code: 0, err: "" });
  });

  test("passes a push to dev whose SHA has one green e2e beside a cancelled and a failed one", () => {
    write("vellum/src/core/page/app.tsx", "changed\n");
    const head = commit("Change the page");
    ghLists(CANCELLED, GREEN, FAILED);

    expect(run(`refs/heads/feature/x ${head} refs/heads/dev ${base}\n`)).toEqual({
      code: 0,
      err: "",
    });
  });

  test("passes a push to dev that touches no e2e path without calling gh", () => {
    write("README.md", "more docs\n");
    write("vellum/src/core/engine/hooks.ts", "changed\n");
    const head = commit("Docs and engine");

    expect(run(`refs/heads/dev ${head} refs/heads/dev ${base}\n`)).toEqual({ code: 0, err: "" });
    expect(ghCalls()).toBe("");
  });

  test("passes a push to another ref untouched", () => {
    write("vellum/src/core/page/app.tsx", "changed\n");
    const head = commit("Change the page");

    expect(run(`refs/heads/feature/x ${head} refs/heads/feature/x ${base}\n`)).toEqual({
      code: 0,
      err: "",
    });
    expect(ghCalls()).toBe("");
  });

  test("refuses the push when gh fails, saying so", () => {
    write("vellum/src/core/page/app.tsx", "changed\n");
    const head = commit("Change the page");
    fakeGh(`echo 'error connecting to api.github.com' >&2\nexit 1`);
    const result = run(`refs/heads/feature/x ${head} refs/heads/dev ${base}\n`);

    expect(result.code).toBe(1);
    expect(result.err).toContain(`refs/heads/dev at ${head}`);
    expect(result.err).toContain(
      "gh could not list its check runs: error connecting to api.github.com",
    );
  });

  test("reads the whole tree when the remote has no dev", () => {
    ghLists();
    const result = run(`refs/heads/dev ${base} refs/heads/dev ${ZERO}\n`);

    expect(result.code).toBe(1);
    expect(result.err).toContain(`refs/heads/dev at ${base} touches vellum/src/core/page/app.tsx`);
  });

  test("refuses a remote oid this repository does not have", () => {
    const unknown = "1".repeat(40);
    const result = run(`refs/heads/dev ${base} refs/heads/dev ${unknown}\n`);

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      `refs/heads/dev is at ${unknown} on the remote, a commit this repository does not have: fetch origin first`,
    );
  });
});
