import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { commit, git } from "./git-fixture.ts";
import { agentOf, markerPath, parseStopInput, skipsGates, type StopInput } from "./stop-gates.ts";

const SESSION_ID = "0244f1e4-d3aa-44b3-8919-3fe7b1e82701";

// Shape measured on Claude Code 2.1.270: 16 hex characters.
const AGENT_ID = "ae64aaf2fc71fc3bd";

const OTHER_AGENT_ID = "b1c2d3e4f5a6b7c8d";

function gateRuns(dir: string): number {
  const runs = join(dir, "gates-runs");

  return existsSync(runs) ? readFileSync(runs, "utf8").length : 0;
}

function setGates(dir: string, exitCode: number, report: string) {
  writeFileSync(join(dir, "gates-exit"), String(exitCode));
  writeFileSync(join(dir, "gates-report"), report);
}

describe("parseStopInput", () => {
  test("returns null on invalid JSON", () => {
    expect(parseStopInput("not json")).toBeNull();
  });
});

describe("skipsGates", () => {
  test("skips in plan mode", () => {
    expect(skipsGates({ agent_id: AGENT_ID, permission_mode: "plan" })).toBe(true);
  });

  test("runs in every other mode", () => {
    expect(skipsGates({ agent_id: AGENT_ID, permission_mode: "acceptEdits" })).toBe(false);
    expect(skipsGates({ agent_id: AGENT_ID })).toBe(false);
  });
});

describe("agentOf", () => {
  test("names the subagent the payload carries, and no one for the main session", () => {
    expect(agentOf({ agent_id: AGENT_ID })).toBe(AGENT_ID);
    expect(agentOf({})).toBeNull();
  });

  test("refuses an id that is not a single path segment", () => {
    for (const id of ["", "..", "../etc", "a/b", "a b", "a.b"]) {
      expect(agentOf({ agent_id: id })).toBeNull();
    }
  });
});

describe("markerPath", () => {
  test("names one file per agent and checkout under the temp directory", () => {
    const project = markerPath(AGENT_ID, "/repo");

    expect(project).toStartWith(join(tmpdir(), "claude-code-plugins-stop", `${AGENT_ID}.`));
    expect(markerPath(AGENT_ID, "/repo/.claude/worktrees/w")).not.toBe(project);
    expect(markerPath(OTHER_AGENT_ID, "/repo")).not.toBe(project);
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

  const markerFile = (checkout: string, id: string = AGENT_ID) =>
    join(tempRoot, "claude-code-plugins-stop", basename(markerPath(id, checkout)));

  const verdictOf = (checkout: string, id: string = AGENT_ID) =>
    // SAFETY: setMarker and the hook write every marker as a Marker.
    (JSON.parse(readFileSync(markerFile(checkout, id), "utf8")) as { verdict: string }).verdict;

  async function makeWorktree(): Promise<string> {
    await git(["init", "-q"], projectDir);
    await git(["add", "scripts/run-gates.ts"], projectDir);
    await commit(["-m", "gates"], projectDir);
    const worktree = join(tempRoot, "worktree");
    await git(["worktree", "add", "-q", worktree], projectDir);

    return worktree;
  }

  function setMarker(checkout: string, verdict: string, id: string = AGENT_ID) {
    mkdirSync(join(tempRoot, "claude-code-plugins-stop"), { recursive: true });
    writeFileSync(markerFile(checkout, id), JSON.stringify({ checkout, verdict }));
  }

  // A SubagentStop payload: the parent's session_id, the subagent's agent_id,
  // and the subagent itself among the running background tasks. A null agent
  // stands for the main session's Stop, whose payload carries no agent_id.
  async function runHook(
    payload: StopInput & { cwd?: string; stop_hook_active?: boolean } = {},
    agent: string | null = AGENT_ID,
  ) {
    const main = {
      session_id: SESSION_ID,
      permission_mode: "default",
      background_tasks: [{ type: "subagent", status: "running" }],
    };

    const input = agent === null ? main : { ...main, agent_id: agent };

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

  test("ends the turn without running the gates when the subagent made no edit", async () => {
    setGates(projectDir, 1, RED_LINT);

    const { exitCode } = await runHook();

    expect(exitCode).toBe(0);
    expect(gateRuns(projectDir)).toBe(0);
  });

  // The main session's Stop belongs to the agent-hooks kit.
  test("ends a payload without an agent_id without running the gates", async () => {
    setMarker(projectDir, "", SESSION_ID);
    setGates(projectDir, 1, RED_LINT);

    const { exitCode } = await runHook({}, null);

    expect(exitCode).toBe(0);
    expect(gateRuns(projectDir)).toBe(0);
  });

  // The cwd follows a `cd` into another repository, here one nested in the
  // project; the marker still names the worktree the subagent edited.
  test("gates the checkout the marker names, wherever the cwd sits", async () => {
    const worktree = await makeWorktree();
    const nested = join(projectDir, "plans");
    mkdirSync(nested);
    await git(["init", "-q"], nested);
    setMarker(worktree, "");
    setGates(projectDir, 0, "");
    setGates(worktree, 1, RED_LINT);

    const { exitCode, stderr } = await runHook({ cwd: nested });

    expect(exitCode).toBe(2);
    expect(stderr).toContain(`is red in ${worktree}`);
    expect(gateRuns(worktree)).toBe(1);
    expect(gateRuns(projectDir)).toBe(0);
  });

  test("gates every checkout the subagent edited, and blocks on the red one", async () => {
    const worktree = await makeWorktree();
    setMarker(projectDir, "");
    setMarker(worktree, "");
    setGates(projectDir, 0, "");
    setGates(worktree, 1, RED_LINT);

    const { exitCode, stderr } = await runHook();

    expect(exitCode).toBe(2);
    expect(stderr).toContain("lint-ts: bun x oxlint");
    expect(existsSync(markerFile(projectDir))).toBe(false);
    expect(verdictOf(worktree)).toBe("Red gates: lint-ts");
  });

  test("drops the marker of a checkout removed since the edit", async () => {
    const gone = join(tempRoot, "removed-worktree");
    setMarker(gone, "");

    const { exitCode } = await runHook();

    expect(exitCode).toBe(0);
    expect(existsSync(markerFile(gone))).toBe(false);
  });

  test("releases the subagent and deletes the marker once the gates are green", async () => {
    setMarker(projectDir, "Red gates: lint-ts");
    setGates(projectDir, 0, "");

    const { exitCode } = await runHook();

    expect(exitCode).toBe(0);
    expect(gateRuns(projectDir)).toBe(1);
    expect(existsSync(markerFile(projectDir))).toBe(false);
  });

  test("blocks on a red gate after an edit and records the verdict", async () => {
    setMarker(projectDir, "");
    setGates(projectDir, 1, RED_LINT);

    const { exitCode, stderr } = await runHook({ stop_hook_active: true });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("lint-ts: bun x oxlint");
    expect(verdictOf(projectDir)).toBe("Red gates: lint-ts");
  });

  test("ends the turn with a note on the same verdict when nothing was edited since", async () => {
    setMarker(projectDir, "Red gates: lint-ts");
    setGates(projectDir, 1, RED_LINT);

    const { exitCode, stdout } = await runHook();

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      systemMessage: expect.stringContaining("Red gates: lint-ts"),
    });
    expect(verdictOf(projectDir)).toBe("Red gates: lint-ts");
  });

  test("blocks again on a changed verdict, even when nothing was edited since", async () => {
    setMarker(projectDir, "Red gates: lint-ts");
    setGates(projectDir, 1, RED_FMT);

    const { exitCode } = await runHook();

    expect(exitCode).toBe(2);
    expect(verdictOf(projectDir)).toBe("Red gates: fmt");
  });

  test("keeps the markers of two subagents of one session independent", async () => {
    const worktree = await makeWorktree();
    setMarker(projectDir, "Red gates: fmt", OTHER_AGENT_ID);
    setMarker(worktree, "Red gates: lint-ts");
    setGates(worktree, 0, "");
    setGates(projectDir, 0, "");

    const green = await runHook();

    expect(green.exitCode).toBe(0);
    expect(existsSync(markerFile(worktree))).toBe(false);
    expect(verdictOf(projectDir, OTHER_AGENT_ID)).toBe("Red gates: fmt");
  });

  test("keeps the marker and skips the gates in plan mode", async () => {
    setMarker(projectDir, "");
    setGates(projectDir, 1, RED_LINT);

    const { exitCode } = await runHook({ permission_mode: "plan" });

    expect(exitCode).toBe(0);
    expect(gateRuns(projectDir)).toBe(0);
    expect(verdictOf(projectDir)).toBe("");
  });
});
