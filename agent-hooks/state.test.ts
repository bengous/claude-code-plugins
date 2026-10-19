import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { sha256 } from "./scope.ts";
import type { SessionState } from "./state.ts";
import {
  STATE_TTL_MS,
  STATE_VERSION,
  beat,
  beatPath,
  checkoutKey,
  endBeats,
  freshState,
  landedMark,
  latestStateForCheckout,
  liveOthers,
  loadMark,
  loadState,
  markPath,
  pruneStates,
  rootName,
  rootRecord,
  saveMark,
  saveState,
  stateDir,
  statePath,
  statesOf,
} from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import { beatAgo, createTempRepo, MINUTE_MS, removeTempRepo, scrubGitEnv } from "./test-support.ts";

const ENV_NAMES = ["AGENT_HOOKS_STATE_DIR", "XDG_STATE_HOME", "HOME"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest hook deadline, as SessionStart passes it. */
const STALE_TEMPORARY_MS = 200_000;

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

function fullState(sessionId: string, checkout: string): SessionState {
  return {
    ...freshState(sessionId, checkout, 1),
    photo: { head: "abc123", files: { "a.ts": sha256("a"), "b.ts": "deleted" }, takenAt: 42 },
    roots: {
      ".": {
        green: { "lint@.": "key-1" },
        lastRun: { at: 100, ms: 250, lanes: { lint: "fail", test: "green" } },
      },
      "packages/x": { green: {}, lastRun: null },
    },
    lastFailing: { lint: ["a.ts"], "packages/x/lint": ["src/b.ts"] },
    lastDiagnostics: { "lint\u0000a.ts": 3 },
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
    expect(path.basename(file)).toBe(`a_b_c__${checkoutKey(temp.repo)}.json`);
  });

  test("checkoutKey resolves the checkout first", () => {
    expect(checkoutKey(`${temp.repo}/sub/..`)).toBe(checkoutKey(temp.repo));
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

      writeFileSync(
        statePath("s", temp.repo),
        JSON.stringify({
          ...fullState("s", temp.repo),
          roots: { ".": { green: { "lint@.": 1 }, lastRun: null } },
        }),
      );

      expect(loadState("s", temp.repo, 9)).toEqual(freshState("s", temp.repo, 9));
    } finally {
      errors.mockRestore();
    }
  });

  test("rootName is the root's path from the checkout, `.` for the checkout itself", () => {
    expect(rootName(temp.repo, temp.repo)).toBe(".");
    expect(rootName(temp.repo, path.join(temp.repo, "packages", "x"))).toBe(
      path.join("packages", "x"),
    );
    expect(rootName(path.join(temp.repo, "sub"), temp.repo)).toBe("..");
  });

  test("rootRecord creates an empty record once, then returns the same", () => {
    const state = freshState("s", temp.repo);
    const record = rootRecord(state, path.join(temp.repo, "packages", "x"));

    expect(record).toEqual({ green: {}, lastRun: null });

    record.green["lint@."] = "key-1";

    expect(rootRecord(state, path.join(temp.repo, "packages", "x"))).toBe(record);
    expect(Object.keys(state.roots)).toEqual([path.join("packages", "x")]);
  });

  test("two checkouts for one agent give two files", () => {
    const other = path.join(temp.dir, "other");
    saveState(freshState("s", temp.repo));
    saveState(fullState("s", other));

    expect(stateFiles()).toHaveLength(2);
    expect(loadState("s", temp.repo).photo).toBeNull();
    expect(loadState("s", other).photo).not.toBeNull();
  });
});

describe("statesOf", () => {
  test("reads every state of this agent, sorted by checkout, and no other session's", () => {
    const photo = { head: null, files: {}, takenAt: 1 };
    saveState({ ...freshState("s", "/r/b"), photo });
    saveState({ ...freshState("s", "/r/a"), photo });
    saveState(freshState("s", "/r/c"));
    saveState({ ...freshState("other", "/r/d"), photo });
    saveState({ ...freshState("s.agent1", "/r/e"), photo });

    const states = statesOf("s");

    expect(states.map((state) => state.checkout)).toEqual(["/r/a", "/r/b", "/r/c"]);
    expect(states.map((state) => state.photo !== null)).toEqual([true, true, false]);
  });

  test("none without a state dir", () => {
    expect(statesOf("s")).toEqual([]);
  });
});

describe("pruneStates", () => {
  test("removes files older than the TTL and unreadable json files, keeps the rest", () => {
    const now = 100 * DAY_MS;
    saveState(freshState("old", temp.repo), now - 8 * DAY_MS);
    saveState(freshState("recent", temp.repo), now - 6 * DAY_MS);
    writeFileSync(path.join(temp.stateDir, "broken.json"), "{garbage");
    writeFileSync(path.join(temp.stateDir, "notes.txt"), "keep me");

    pruneStates(STALE_TEMPORARY_MS, now);

    expect(stateFiles()).toEqual(
      [path.basename(statePath("recent", temp.repo)), "notes.txt"].toSorted(),
    );
  });

  test("keeps a temporary file younger than the longest hook deadline, even half written", () => {
    mkdirSync(temp.stateDir, { recursive: true });
    const live = `${statePath("live", temp.repo)}.4243.uuid.tmp`;
    writeFileSync(live, '{"version":1,"sessionId":"li');

    pruneStates(STALE_TEMPORARY_MS);

    expect(existsSync(live)).toBe(true);
  });

  test("removes a temporary file older than the longest hook deadline, whatever it holds", () => {
    mkdirSync(temp.stateDir, { recursive: true });
    const leftover = `${statePath("crashed", temp.repo)}.4242.uuid.tmp`;
    writeFileSync(leftover, JSON.stringify(freshState("crashed", temp.repo)));
    const before = new Date(Date.now() - 2 * STALE_TEMPORARY_MS);
    utimesSync(leftover, before, before);

    pruneStates(STALE_TEMPORARY_MS);

    expect(existsSync(leftover)).toBe(false);
  });

  test("removes a heartbeat older than the TTL, keeps a younger one", () => {
    beat("old", temp.repo);
    beat("recent", temp.repo);
    const old = new Date(Date.now() - STATE_TTL_MS - DAY_MS);
    utimesSync(beatPath("old", temp.repo), old, old);

    pruneStates(STALE_TEMPORARY_MS);

    expect(stateFiles()).toEqual([path.basename(beatPath("recent", temp.repo))]);
  });

  test("keeps a file exactly at the TTL", () => {
    const now = 100 * DAY_MS;
    saveState(freshState("edge", temp.repo), now - STATE_TTL_MS);

    pruneStates(STALE_TEMPORARY_MS, now);

    expect(existsSync(statePath("edge", temp.repo))).toBe(true);
  });

  test("a missing state dir is not an error", () => {
    expect(existsSync(temp.stateDir)).toBe(false);
    expect(() => {
      pruneStates(STALE_TEMPORARY_MS);
    }).not.toThrow();
  });
});

describe("latestStateForCheckout", () => {
  test("returns the most recently updated state of that checkout", () => {
    const other = path.join(temp.dir, "other");
    saveState(freshState("a", temp.repo), 100);
    saveState(freshState("b", temp.repo), 300);
    saveState(freshState("c", temp.repo), 200);
    saveState(freshState("d", other), 900);

    const latest = latestStateForCheckout(temp.repo);

    expect(latest?.sessionId).toBe("b");
    expect(latest?.updatedAt).toBe(300);
  });

  test("reads only the main sessions' states, never a subagent's, whose file it does not open", () => {
    saveState(freshState("main", temp.repo), 100);
    saveState(freshState("main.agent1", temp.repo), 500);
    const reads = spyOn(fs, "readFileSync");

    try {
      expect(latestStateForCheckout(temp.repo)?.sessionId).toBe("main");
      expect(reads.mock.calls.map(([file]) => file)).not.toContain(
        statePath("main.agent1", temp.repo),
      );
    } finally {
      reads.mockRestore();
    }
  });

  test("skips an unreadable file of that checkout", () => {
    saveState(freshState("a", temp.repo), 100);
    writeFileSync(statePath("z", temp.repo), "{garbage");

    expect(latestStateForCheckout(temp.repo)?.sessionId).toBe("a");
  });

  test("null when the checkout has no state", () => {
    expect(latestStateForCheckout(temp.repo)).toBeNull();

    saveState(freshState("d", path.join(temp.dir, "other")));

    expect(latestStateForCheckout(temp.repo)).toBeNull();
  });
});

describe("heartbeats", () => {
  test("a beat is a file per agent and checkout, its mtime the last hook the agent ran there", () => {
    const before = Date.now() - 1000;
    beat("s1.a1", temp.repo);

    expect(path.basename(beatPath("s1.a1", temp.repo))).toBe(
      `s1.a1__${checkoutKey(temp.repo)}.beat`,
    );
    expect(statSync(beatPath("s1.a1", temp.repo)).mtimeMs).toBeGreaterThan(before);
  });

  test("a beat on an agent's old beat moves its mtime to now", () => {
    beatAgo("s1", temp.repo, 60 * MINUTE_MS);
    const before = Date.now() - 1000;

    beat("s1", temp.repo);

    expect(statSync(beatPath("s1", temp.repo)).mtimeMs).toBeGreaterThan(before);
  });

  test("liveOthers counts a beat removed after the state dir was listed as not live", () => {
    beatAgo("s2", temp.repo, MINUTE_MS);
    const vanished = path.basename(beatPath("s3", temp.repo));
    const listed = readdirSync(temp.stateDir);
    // SAFETY: liveOthers calls readdirSync with a path alone, whose overload returns string[].
    const list = spyOn(fs, "readdirSync").mockReturnValue([...listed, vanished] as never);

    try {
      expect(liveOthers(temp.repo, "s1", Date.now() - 10 * MINUTE_MS)).toEqual(["s2"]);
    } finally {
      list.mockRestore();
    }
  });

  test("liveOthers: the agents of other sessions that beat in this checkout since `since`", () => {
    const other = path.join(temp.dir, "other");
    beatAgo("s1", temp.repo, MINUTE_MS);
    beatAgo("s1.a1", temp.repo, MINUTE_MS);
    beatAgo("s10", temp.repo, MINUTE_MS);
    beatAgo("s2.a1", temp.repo, 2 * MINUTE_MS);
    beatAgo("s3", temp.repo, 20 * MINUTE_MS);
    beatAgo("s4", other, MINUTE_MS);
    saveState(freshState("s5", temp.repo));

    expect(liveOthers(temp.repo, "s1", Date.now() - 10 * MINUTE_MS).toSorted()).toEqual([
      "s10",
      "s2.a1",
    ]);
  });

  test("none without a state dir", () => {
    expect(liveOthers(temp.repo, "s1", 0)).toEqual([]);
  });

  test("endBeats removes the beats of a session and its subagents, in every checkout, and no other's", () => {
    const other = path.join(temp.dir, "other");
    beat("s1", temp.repo);
    beat("s1", other);
    beat("s1.a1", temp.repo);
    beat("s10", temp.repo);
    saveState(freshState("s1", temp.repo));

    endBeats("s1");

    expect(stateFiles()).toEqual(
      [
        path.basename(beatPath("s10", temp.repo)),
        path.basename(statePath("s1", temp.repo)),
      ].toSorted(),
    );
  });
});

describe("commit marks", () => {
  const earlier = { at: 1000, promptId: "p1" };
  const mark = { at: 2000, promptId: "p2", head: "abc", previous: earlier };

  test("a saved mark reads back; an absent one reads as none, an unreadable one as none, reported", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(loadMark("s1", temp.repo)).toBeNull();

      saveMark("s1", temp.repo, mark);

      expect(loadMark("s1", temp.repo)).toEqual(mark);

      writeFileSync(markPath("s1", temp.repo), '{"at":"soon"}');

      expect(loadMark("s1", temp.repo)).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  test("a mark whose commit left HEAD where it was gives way to the one before it", () => {
    expect(landedMark(mark, "def")).toEqual({ at: 2000, promptId: "p2" });
    expect(landedMark(mark, "abc")).toEqual(earlier);
    expect(landedMark({ ...mark, previous: null }, "abc")).toBeNull();
    expect(landedMark({ ...mark, head: null }, null)).toEqual({ at: 2000, promptId: "p2" });
    expect(landedMark(null, "abc")).toBeNull();
  });

  test("a mark ages out with the beats", () => {
    const now = 100 * DAY_MS;
    saveMark("old", temp.repo, mark);
    saveMark("recent", temp.repo, mark);
    const old = new Date(now - 8 * DAY_MS);
    const recent = new Date(now - 6 * DAY_MS);
    utimesSync(markPath("old", temp.repo), old, old);
    utimesSync(markPath("recent", temp.repo), recent, recent);

    pruneStates(STALE_TEMPORARY_MS, now);

    expect(existsSync(markPath("old", temp.repo))).toBe(false);
    expect(existsSync(markPath("recent", temp.repo))).toBe(true);
  });
});
