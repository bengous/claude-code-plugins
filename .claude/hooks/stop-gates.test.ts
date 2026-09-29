import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";

import { markerFor, markerPath, parseStopInput, skipsGates, type StopInput } from "./stop-gates.ts";

const SESSION_ID = "0244f1e4-d3aa-44b3-8919-3fe7b1e82701";

// Shape measured on Claude Code 2.1.270: 16 hex characters.
const AGENT_ID = "ae64aaf2fc71fc3bd";

function gateRuns(dir: string): number {
  const runs = join(dir, "gates-runs");

  return existsSync(runs) ? readFileSync(runs, "utf8").length : 0;
}

function setGates(dir: string, exitCode: number, report: string) {
  writeFileSync(join(dir, "gates-exit"), String(exitCode));
  writeFileSync(join(dir, "gates-report"), report);
}

const git = (args: string[], cwd: string) =>
  $`git ${args}`
    .cwd(cwd)
    .env({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })
    .quiet();

describe("parseStopInput", () => {
  test("returns null on invalid JSON", () => {
    expect(parseStopInput("not json")).toBeNull();
  });
});

describe("skipsGates", () => {
  test("skips in plan mode", () => {
    expect(skipsGates({ permission_mode: "plan", background_tasks: [] })).toBe(true);
  });

  test("skips while a subagent, a workflow or a teammate runs in the background", () => {
    for (const type of ["subagent", "workflow", "teammate"]) {
      expect(skipsGates({ permission_mode: "default", background_tasks: [{ type }] })).toBe(true);
    }
  });

  test("runs beside background tasks that do not edit", () => {
    const tasks = [{ type: "shell" }, { type: "monitor" }];

    expect(skipsGates({ permission_mode: "default", background_tasks: tasks })).toBe(false);
  });

  test("runs when the payload lists no background task", () => {
    expect(skipsGates({ permission_mode: "acceptEdits" })).toBe(false);
  });

  // A SubagentStop payload lists the stopping subagent itself as a running
  // background task, so the parent's rule would skip every subagent.
  test("runs for a subagent beside the background tasks of its parent session", () => {
    const tasks = [{ type: "subagent" }, { type: "teammate" }];

    expect(skipsGates({ agent_id: AGENT_ID, background_tasks: tasks })).toBe(false);
  });
});

describe("markerFor", () => {
  test("names the agent when the payload carries one, the session otherwise", () => {
    expect(markerFor({ session_id: SESSION_ID, agent_id: AGENT_ID })).toBe(markerPath(AGENT_ID));
    expect(markerFor({ session_id: SESSION_ID })).toBe(markerPath(SESSION_ID));
    expect(markerFor({})).toBeNull();
  });
});

describe("markerPath", () => {
  test("names one file per session under the temp directory", () => {
    expect(markerPath(SESSION_ID)).toBe(join(tmpdir(), "claude-code-plugins-stop", SESSION_ID));
  });

  test("refuses an id that is not a single path segment", () => {
    for (const id of ["", "..", "../etc", "a/b", "a b"]) {
      expect(markerPath(id)).toBeNull();
    }
  });
});

describe("hook subprocess", () => {
  const HOOK = join(import.meta.dir, "stop-gates.ts");
  const RED_LINT = "Red gates: lint-ts\n\nlint-ts: bun x oxlint\nscripts/a.ts:1:7: no-unused-vars";
  const RED_FMT = "Red gates: fmt\n\nfmt: bun x oxfmt --check\nscripts/a.ts";

  // Stands in for scripts/run-gates.ts: exits with the code in gates-exit,
  // prints gates-report on stderr, and counts its runs in gates-runs.
  const GATES_STUB = [
    'import { appendFileSync, readFileSync } from "node:fs";',
    'appendFileSync("gates-runs", "x");',
    'const exitCode = Number(readFileSync("gates-exit", "utf8"));',
    'if (exitCode !== 0) console.error(readFileSync("gates-report", "utf8"));',
    "process.exit(exitCode);",
  ].join("\n");

  let projectDir = "";
  let tempRoot = "";

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "stop-gates-project-"));
    tempRoot = mkdtempSync(join(tmpdir(), "stop-gates-tmp-"));
    mkdirSync(join(projectDir, "scripts"));
    writeFileSync(join(projectDir, "scripts", "run-gates.ts"), GATES_STUB);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const markerFile = (id: string = SESSION_ID) => join(tempRoot, "claude-code-plugins-stop", id);

  async function makeWorktree(): Promise<string> {
    await git(["init", "-q"], projectDir);
    await git(["add", "scripts/run-gates.ts"], projectDir);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "gates"], projectDir);
    const worktree = join(tempRoot, "worktree");
    await git(["worktree", "add", "-q", worktree], projectDir);
    mkdirSync(join(worktree, "sub"));

    return worktree;
  }

  function setMarker(content: string, id: string = SESSION_ID) {
    mkdirSync(dirname(markerFile(id)), { recursive: true });
    writeFileSync(markerFile(id), content);
  }

  async function runHook(payload: StopInput & { stop_hook_active?: boolean } = {}) {
    const input = { session_id: SESSION_ID, permission_mode: "default", background_tasks: [] };

    const proc = Bun.spawn([process.execPath, HOOK], {
      stdin: new Blob([JSON.stringify({ ...input, ...payload })]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, TMPDIR: tempRoot },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { exitCode, stdout, stderr };
  }

  test("ends the turn without running the gates when the session made no edit", async () => {
    setGates(projectDir, 1, RED_LINT);

    const { exitCode } = await runHook();

    expect(exitCode).toBe(0);
    expect(gateRuns(projectDir)).toBe(0);
  });

  test("gates the repository around the hook's cwd, a worktree, not the project", async () => {
    const worktree = await makeWorktree();
    setMarker("");
    setGates(projectDir, 1, RED_LINT);
    setGates(worktree, 0, "");

    const { exitCode } = await runHook({ cwd: join(worktree, "sub") });

    expect(exitCode).toBe(0);
    expect(gateRuns(worktree)).toBe(1);
    expect(gateRuns(projectDir)).toBe(0);
  });

  test("gates the project when the cwd sits in another repository nested in it", async () => {
    await git(["init", "-q"], projectDir);
    const nested = join(projectDir, "plans");
    mkdirSync(join(nested, "sub"), { recursive: true });
    await git(["init", "-q"], nested);
    setMarker("");
    setGates(projectDir, 0, "");

    const { exitCode, stderr } = await runHook({ cwd: join(nested, "sub") });

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(gateRuns(projectDir)).toBe(1);
  });

  test("gates the project when the cwd sits outside any repository", async () => {
    setMarker("");
    setGates(projectDir, 0, "");

    const { exitCode } = await runHook({ cwd: tempRoot });

    expect(exitCode).toBe(0);
    expect(gateRuns(projectDir)).toBe(1);
  });

  test("deletes the marker once the gates are green", async () => {
    setMarker("");
    setGates(projectDir, 0, "");

    const { exitCode } = await runHook();

    expect(exitCode).toBe(0);
    expect(gateRuns(projectDir)).toBe(1);
    expect(existsSync(markerFile())).toBe(false);
  });

  test("blocks on a red gate after an edit and records the verdict", async () => {
    setMarker("");
    setGates(projectDir, 1, RED_LINT);

    const { exitCode, stderr } = await runHook({ stop_hook_active: true });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("lint-ts: bun x oxlint");
    expect(readFileSync(markerFile(), "utf8")).toBe("Red gates: lint-ts");
  });

  test("ends the turn with a note on the same verdict when nothing was edited since", async () => {
    setMarker("Red gates: lint-ts");
    setGates(projectDir, 1, RED_LINT);

    const { exitCode, stdout } = await runHook();

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      systemMessage: expect.stringContaining("Red gates: lint-ts"),
    });
    expect(readFileSync(markerFile(), "utf8")).toBe("Red gates: lint-ts");
  });

  test("blocks again on a changed verdict, even when nothing was edited since", async () => {
    setMarker("Red gates: lint-ts");
    setGates(projectDir, 1, RED_FMT);

    const { exitCode } = await runHook();

    expect(exitCode).toBe(2);
    expect(readFileSync(markerFile(), "utf8")).toBe("Red gates: fmt");
  });

  // The four below replay a worktree-isolated subagent: its payload carries the
  // parent's session_id, its own agent_id and the cwd of its worktree.
  const asSubagent = (worktree: string) => ({
    agent_id: AGENT_ID,
    cwd: join(worktree, "sub"),
    background_tasks: [{ type: "subagent" }],
  });

  test("blocks a worktree-isolated subagent on a red gate in its own worktree", async () => {
    const worktree = await makeWorktree();
    setMarker("", AGENT_ID);
    setGates(worktree, 1, RED_LINT);
    setGates(projectDir, 0, "");

    const { exitCode, stderr } = await runHook(asSubagent(worktree));

    expect(exitCode).toBe(2);
    expect(stderr).toContain("lint-ts: bun x oxlint");
    expect(gateRuns(worktree)).toBe(1);
    expect(gateRuns(projectDir)).toBe(0);
    expect(readFileSync(markerFile(AGENT_ID), "utf8")).toBe("Red gates: lint-ts");
  });

  test("releases the subagent once its worktree is green", async () => {
    const worktree = await makeWorktree();
    setMarker("Red gates: lint-ts", AGENT_ID);
    setGates(worktree, 0, "");

    const { exitCode } = await runHook(asSubagent(worktree));

    expect(exitCode).toBe(0);
    expect(existsSync(markerFile(AGENT_ID))).toBe(false);
  });

  test("releases the subagent on an unchanged verdict with no edit since", async () => {
    const worktree = await makeWorktree();
    setMarker("Red gates: lint-ts", AGENT_ID);
    setGates(worktree, 1, RED_LINT);

    const { exitCode, stdout } = await runHook(asSubagent(worktree));

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      systemMessage: expect.stringContaining("Red gates: lint-ts"),
    });
  });

  test("keeps the subagent's marker and the parent session's independent", async () => {
    const worktree = await makeWorktree();
    setMarker("Red gates: fmt");
    setMarker("Red gates: lint-ts", AGENT_ID);
    setGates(worktree, 0, "");
    setGates(projectDir, 0, "");

    const green = await runHook(asSubagent(worktree));

    expect(green.exitCode).toBe(0);
    expect(readFileSync(markerFile(), "utf8")).toBe("Red gates: fmt");

    setMarker("Red gates: lint-ts", AGENT_ID);

    const parent = await runHook();

    expect(parent.exitCode).toBe(0);
    expect(existsSync(markerFile())).toBe(false);
    expect(readFileSync(markerFile(AGENT_ID), "utf8")).toBe("Red gates: lint-ts");
  });

  test("keeps the marker and skips the gates in plan mode and beside a background subagent", async () => {
    setMarker("");
    setGates(projectDir, 1, RED_LINT);

    for (const payload of [
      { permission_mode: "plan" },
      { background_tasks: [{ type: "subagent" }] },
    ]) {
      const { exitCode } = await runHook(payload);

      expect(exitCode).toBe(0);
    }

    expect(gateRuns(projectDir)).toBe(0);
    expect(readFileSync(markerFile(), "utf8")).toBe("");
  });
});
