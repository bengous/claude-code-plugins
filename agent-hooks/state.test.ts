import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sha256 } from "./scope.ts";
import type { SessionState } from "./state.ts";
import {
  STATE_TTL_MS,
  STATE_VERSION,
  freshState,
  latestStateForRoot,
  loadState,
  photographedRoots,
  pruneStates,
  rootKey,
  saveState,
  stateDir,
  statePath,
} from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import { createTempRepo, removeTempRepo, scrubGitEnv } from "./test-support.ts";

const ENV_NAMES = ["AGENT_HOOKS_STATE_DIR", "XDG_STATE_HOME", "HOME"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

let temp: TempRepo;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  scrubGitEnv();
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  temp = createTempRepo("agent-hooks-state-");
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = savedEnv[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  removeTempRepo(temp);
});

function fullState(sessionId: string, root: string): SessionState {
  return {
    ...freshState(sessionId, root, 1),
    photo: { head: "abc123", files: { "a.ts": sha256("a"), "b.ts": "deleted" }, takenAt: 42 },
    green: { "lint@/r": "key-1" },
    lastFailing: { lint: ["a.ts", "b.ts"] },
    lastDiagnostics: { "lint\u0000a.ts": 3 },
    lastRun: { at: 100, ms: 250, lanes: { lint: "fail", test: "green" } },
    blocksInTurn: 2,
    promptId: "prompt-7",
  };
}

function stateFiles(): string[] {
  return readdirSync(temp.stateDir).toSorted();
}

describe("stateDir and statePath", () => {
  test("statePath is <stateDir>/<sanitized session>__<16 hex>.json", () => {
    const file = statePath("a/b:c", temp.repo);

    expect(path.dirname(file)).toBe(temp.stateDir);
    expect(path.basename(file)).toMatch(/^a_b_c__[0-9a-f]{16}\.json$/u);
    expect(path.basename(file)).toBe(`a_b_c__${rootKey(temp.repo)}.json`);
  });

  test("rootKey resolves the root first", () => {
    expect(rootKey(`${temp.repo}/sub/..`)).toBe(rootKey(temp.repo));
  });

  test("AGENT_HOOKS_STATE_DIR wins, then XDG_STATE_HOME, then ~/.local/state", () => {
    process.env["AGENT_HOOKS_STATE_DIR"] = "/override";
    process.env["XDG_STATE_HOME"] = "/xdg";
    process.env["HOME"] = "/fixture/test";

    expect(stateDir()).toBe("/override");

    process.env["AGENT_HOOKS_STATE_DIR"] = "";

    expect(stateDir()).toBe("/xdg/agent-hooks");

    delete process.env["AGENT_HOOKS_STATE_DIR"];
    process.env["XDG_STATE_HOME"] = "";

    expect(stateDir()).toBe("/fixture/test/.local/state/agent-hooks");

    delete process.env["XDG_STATE_HOME"];

    expect(stateDir()).toBe("/fixture/test/.local/state/agent-hooks");
  });
});

describe("loadState and saveState", () => {
  test("a missing file gives a fresh state", () => {
    const state = loadState("s", temp.repo, 7);

    expect(state).toEqual(freshState("s", temp.repo, 7));
    expect(state.photo).toBeNull();
    expect(state.blocksInTurn).toBe(0);
    expect(state.version).toBe(STATE_VERSION);
  });

  test("saveState then loadState round-trips every field", () => {
    const state = fullState("s", temp.repo);
    saveState(state, 1234);

    expect(state.updatedAt).toBe(1234);
    expect(loadState("s", temp.repo)).toEqual(state);
  });

  test("saveState leaves no .tmp file", () => {
    saveState(freshState("s", temp.repo));

    expect(stateFiles()).toEqual([path.basename(statePath("s", temp.repo))]);
  });

  test("concurrent saves of one state, from several processes, all succeed", async () => {
    const script = path.join(temp.dir, "saver.ts");
    const stateModule = JSON.stringify(path.join(import.meta.dir, "state.ts"));
    writeFileSync(
      script,
      `import { freshState, saveState } from ${stateModule};\n` +
        `for (let round = 0; round < 300; round += 1) saveState(freshState("s1", ${JSON.stringify(temp.repo)}));\n`,
    );

    const savers = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, script], {
        env: { ...process.env, AGENT_HOOKS_STATE_DIR: temp.stateDir },
        stdout: "ignore",
        stderr: "pipe",
      }),
    );

    const codes = await Promise.all(savers.map((saver) => saver.exited));

    expect(codes).toEqual([0, 0, 0, 0]);
    expect(loadState("s1", temp.repo).sessionId).toBe("s1");
    expect(readdirSync(temp.stateDir).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  test("a corrupt file gives a fresh state and one error line", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      mkdirSync(temp.stateDir, { recursive: true });
      writeFileSync(statePath("s", temp.repo), "{garbage");

      expect(loadState("s", temp.repo, 9)).toEqual(freshState("s", temp.repo, 9));
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("unreadable state");
    } finally {
      errors.mockRestore();
    }
  });

  test("a file with the wrong version gives a fresh state", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      mkdirSync(temp.stateDir, { recursive: true });
      writeFileSync(
        statePath("s", temp.repo),
        JSON.stringify({ ...fullState("s", temp.repo), version: STATE_VERSION + 1 }),
      );

      expect(loadState("s", temp.repo, 9)).toEqual(freshState("s", temp.repo, 9));
    } finally {
      errors.mockRestore();
    }
  });

  test("a file with a field of the wrong shape gives a fresh state", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});

    try {
      mkdirSync(temp.stateDir, { recursive: true });
      writeFileSync(
        statePath("s", temp.repo),
        JSON.stringify({
          ...fullState("s", temp.repo),
          lastDiagnostics: { "lint\u0000a.ts": "3" },
        }),
      );

      expect(loadState("s", temp.repo, 9)).toEqual(freshState("s", temp.repo, 9));
    } finally {
      errors.mockRestore();
    }
  });

  test("two roots for one session give two files", () => {
    const other = path.join(temp.dir, "other");
    saveState(freshState("s", temp.repo));
    saveState(fullState("s", other));

    expect(stateFiles()).toHaveLength(2);
    expect(loadState("s", temp.repo).photo).toBeNull();
    expect(loadState("s", other).photo).not.toBeNull();
  });
});

describe("photographedRoots", () => {
  test("lists, sorted, the roots of this session whose state holds a photo", () => {
    const photo = { head: null, files: {}, takenAt: 1 };
    saveState({ ...freshState("s", "/r/b"), photo });
    saveState({ ...freshState("s", "/r/a"), photo });
    saveState(freshState("s", "/r/c"));
    saveState({ ...freshState("other", "/r/d"), photo });

    expect(photographedRoots("s")).toEqual(["/r/a", "/r/b"]);
  });

  test("none without a state dir", () => {
    expect(photographedRoots("s")).toEqual([]);
  });
});

describe("pruneStates", () => {
  test("removes files older than the TTL and unreadable json files, keeps the rest", () => {
    const now = 100 * DAY_MS;
    saveState(freshState("old", temp.repo), now - 8 * DAY_MS);
    saveState(freshState("recent", temp.repo), now - 6 * DAY_MS);
    writeFileSync(path.join(temp.stateDir, "broken.json"), "{garbage");
    writeFileSync(path.join(temp.stateDir, "notes.txt"), "keep me");

    pruneStates(now);

    expect(stateFiles()).toEqual(
      [path.basename(statePath("recent", temp.repo)), "notes.txt"].toSorted(),
    );
  });

  test("removes the temporary file a save cut short left behind, once past the TTL", () => {
    const now = 100 * DAY_MS;
    mkdirSync(temp.stateDir, { recursive: true });
    const leftover = `${statePath("crashed", temp.repo)}.4242.uuid.tmp`;
    writeFileSync(leftover, JSON.stringify(freshState("crashed", temp.repo, now - 8 * DAY_MS)));
    const fresh = `${statePath("live", temp.repo)}.4243.uuid.tmp`;
    writeFileSync(fresh, JSON.stringify(freshState("live", temp.repo, now - DAY_MS)));

    pruneStates(now);

    expect(existsSync(leftover)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("keeps a file exactly at the TTL", () => {
    const now = 100 * DAY_MS;
    saveState(freshState("edge", temp.repo), now - STATE_TTL_MS);

    pruneStates(now);

    expect(existsSync(statePath("edge", temp.repo))).toBe(true);
  });

  test("a missing state dir is not an error", () => {
    expect(existsSync(temp.stateDir)).toBe(false);
    expect(() => {
      pruneStates();
    }).not.toThrow();
  });
});

describe("latestStateForRoot", () => {
  test("returns the most recently updated state of that root", () => {
    const other = path.join(temp.dir, "other");
    saveState(freshState("a", temp.repo), 100);
    saveState(freshState("b", temp.repo), 300);
    saveState(freshState("c", temp.repo), 200);
    saveState(freshState("d", other), 900);

    const latest = latestStateForRoot(temp.repo);

    expect(latest?.sessionId).toBe("b");
    expect(latest?.updatedAt).toBe(300);
  });

  test("skips an unreadable file of that root", () => {
    saveState(freshState("a", temp.repo), 100);
    writeFileSync(statePath("z", temp.repo), "{garbage");

    expect(latestStateForRoot(temp.repo)?.sessionId).toBe("a");
  });

  test("null when the root has no state", () => {
    expect(latestStateForRoot(temp.repo)).toBeNull();

    saveState(freshState("d", path.join(temp.dir, "other")));

    expect(latestStateForRoot(temp.repo)).toBeNull();
  });
});
