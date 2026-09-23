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
  refusalReason,
} from "./check-e2e-green.ts";

const SCRIPT = join(import.meta.dir, "check-e2e-green.ts");

const ZERO = "0".repeat(40);

const GREEN: CheckRun = { name: "e2e", status: "completed", conclusion: "success" };

const CANCELLED: CheckRun = { name: "e2e", status: "completed", conclusion: "cancelled" };

const FAILED: CheckRun = { name: "e2e", status: "completed", conclusion: "failure" };

const RUNNING: CheckRun = { name: "e2e", status: "in_progress", conclusion: null };

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

describe("refusalReason", () => {
  test("passes one green run whatever the others say", () => {
    expect(refusalReason(listed(CANCELLED, GREEN, FAILED, RUNNING))).toBeNull();
  });

  test("refuses a SHA with no e2e run", () => {
    expect(refusalReason(listed())).toBe("it has no green e2e check run (found: none)");
  });

  test("refuses runs that are cancelled, failed or still running, naming each", () => {
    expect(refusalReason(listed(CANCELLED, FAILED, RUNNING))).toBe(
      "it has no green e2e check run (found: cancelled, failure, in_progress)",
    );
  });

  test("counts only the check named e2e", () => {
    expect(
      refusalReason(listed({ name: "validate", status: "completed", conclusion: "success" })),
    ).toBe("it has no green e2e check run (found: none)");
  });

  test("refuses when gh could not list the runs, saying so", () => {
    expect(refusalReason({ kind: "unreadable", error: "gh: HTTP 401: Bad credentials" })).toBe(
      "gh could not list its check runs: gh: HTTP 401: Bad credentials",
    );
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

  function run(stdin: string) {
    const result = Bun.spawnSync([process.execPath, SCRIPT], {
      cwd: repo,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}` },
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

  test("refuses a push to dev that touches an e2e path while its SHA has no green e2e", () => {
    write("vellum/src/core/page/app.tsx", "changed\n");
    const head = commit("Change the page");
    ghLists(CANCELLED, { name: "validate", status: "completed", conclusion: "success" });
    const result = run(`refs/heads/feature/x ${head} refs/heads/dev ${base}\n`);

    expect(result.code).toBe(1);
    expect(result.err).toContain(`refs/heads/dev at ${head} touches vellum/src/core/page/app.tsx`);
    expect(result.err).toContain("it has no green e2e check run (found: cancelled)");
    expect(result.err).toContain("git push --force-with-lease origin <branch>");
    expect(ghCalls()).toContain(`repos/{owner}/{repo}/commits/${head}/check-runs`);
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
