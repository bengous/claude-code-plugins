import type { CommandRunInput, SessionStartInput, SkillPromptInput } from "claude-code";
import { describe, expect, test, tier } from "claude-code/testing";

import { deliveries, READY, ROOT, SERVER, SESSION_ID, world } from "./fixtures.ts";
import { CRASHES, HEARTBEAT_MS } from "./register.ts";

tier("user");

const START: SkillPromptInput = { skill: "pinpoint:start", text: "t" };

const STOP: SkillPromptInput = { skill: "pinpoint:stop", text: "t" };

const SESSION: SessionStartInput = { surface: "terminal", isInteractive: true, cwd: ROOT };

const KEPT = ["--port", String(SERVER.port), "--token", SERVER.token];

const RECORD = { serverSession: SESSION_ID, root: ROOT, ...SERVER, relayed: 0 };

const ENDED = { code: 1, signal: null } as const;

const KEY = `session:${SESSION_ID}`;

/** `/clear` as the person typed it at the composer. */
const CLEAR: CommandRunInput = {
  command: "clear",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: true, columns: 160 },
};

describe("/pinpoint:start", () => {
  test("spawns the server at the session's root and says where it listens", async ($, on) => {
    const seen = world(on);
    const result = await $.skill.prompt(START);

    expect(seen.children).toHaveLength(1);
    expect(seen.children[0]?.argv).toEqual([
      "bun",
      expect.stringContaining("/server/cli.ts"),
      "serve",
      "--session",
      SESSION_ID,
      "--root",
      ROOT,
    ]);
    expect(result.text).toContain(`pinpoint is live for ${ROOT}.`);
    expect(result.text).toContain(`http://localhost:${SERVER.port}/`);
    expect(seen.store.get(KEY)).toEqual(RECORD);
  });

  test("a second start keeps the server it has", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    await $.skill.prompt(START);

    expect(seen.children).toHaveLength(1);
  });

  test("a server that cannot start leaves no record, and says so", async ($, on) => {
    const seen = world(on, { spawn: () => ({ deny: "ENOENT bun" }) });
    const result = await $.skill.prompt(START);

    expect(result.text).toContain("pinpoint did not start its server");
    expect(seen.store.size).toBe(0);
  });
});

describe("a batch", () => {
  test("is handed to the session as a prompt, then told delivered", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    seen.children[0]?.write({ type: "batch", seq: 1, text: "pinpoint batch 1: a" });
    await seen.clock.settle();

    expect(seen.prompts).toEqual(["pinpoint batch 1: a"]);
    expect(deliveries(seen)).toEqual([JSON.stringify({ seq: 1, outcome: "delivered" })]);
    expect(seen.store.get(KEY)).toEqual({ ...RECORD, relayed: 1 });
  });

  test("two batches go in order", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    seen.children[0]?.write(
      { type: "batch", seq: 1, text: "one" },
      { type: "batch", seq: 2, text: "two" },
    );
    await seen.clock.settle();

    expect(seen.prompts).toEqual(["one", "two"]);
  });

  test("one the session refuses is told dropped, with the reason", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    seen.drop = "another plugin refused it";
    seen.children[0]?.write({ type: "batch", seq: 1, text: "one" });
    await seen.clock.settle();

    expect(seen.prompts).toEqual([]);
    expect(deliveries(seen)).toEqual([
      JSON.stringify({ seq: 1, outcome: "dropped", reason: "another plugin refused it" }),
    ]);
  });

  test("one already handed over, told again by a new server, is only acknowledged", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, { ...RECORD, relayed: 3 }]]) });
    await $.session.start(SESSION);
    seen.children[0]?.write(
      { type: "batch", seq: 3, text: "three" },
      { type: "batch", seq: 4, text: "four" },
    );
    await seen.clock.settle();

    expect(seen.prompts).toEqual(["four"]);
    expect(deliveries(seen)).toHaveLength(2);
  });

  test("one its server told before it died, told again by the next, enters once and in order", async ($, on) => {
    const seen = world(on);
    const turn = Promise.withResolvers<void>();
    seen.turn = turn.promise;
    await $.skill.prompt(START);
    seen.children[0]?.write({ type: "batch", seq: 1, text: "one" });
    await seen.clock.settle();
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();
    seen.children[1]?.write(
      { type: "batch", seq: 1, text: "one" },
      { type: "batch", seq: 2, text: "two" },
    );
    await seen.clock.settle();
    turn.resolve();
    await seen.clock.settle();

    expect(seen.prompts).toEqual(["one", "two"]);
    expect(seen.store.get(KEY)?.relayed).toBe(2);
  });
});

describe("the server's life", () => {
  test("a reload starts the stored server again on its port and token", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, RECORD]]) });
    await $.session.start(SESSION);

    expect(seen.children[0]?.argv.slice(-4)).toEqual(KEPT);
  });

  test("a session with no record starts nothing", async ($, on) => {
    const seen = world(on);
    await $.session.start(SESSION);

    expect(seen.children).toEqual([]);
  });

  test("the module beats the server's heartbeat", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    await seen.clock.advance(HEARTBEAT_MS * 2);

    expect(seen.requests.filter((request) => request.path === "api/heartbeat")).toHaveLength(2);
  });

  test("a server that ends on its own comes back on its port and token", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(seen.children).toHaveLength(2);
    expect(seen.children[1]?.argv.slice(-4)).toEqual(KEPT);
  });

  test("a read loop that fails is an end like any other: the server comes back", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    seen.children[0]?.fail("EPIPE");
    await seen.clock.settle();

    expect(seen.logs.join("\n")).toContain("the server's read loop failed");
    expect(seen.children).toHaveLength(2);
    expect(seen.children[1]?.argv.slice(-4)).toEqual(KEPT);
  });

  test("a start while the server starts starts no second one", async ($, on) => {
    const seen = world(on, {
      stored: new Map([[KEY, RECORD]]),
      spawn: (child) => {
        if (seen.children.length > 1) child.write(READY);
      },
    });

    const restored = $.session.start(SESSION);
    await seen.clock.settle();
    const result = await $.skill.prompt(START);
    seen.children[0]?.write(READY);
    await restored;

    expect(seen.children).toHaveLength(1);
    expect(result.text).toContain("pinpoint is starting");
  });

  test("past the crash window the server is lost, and the status line says so", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);

    for (let end = 0; end < CRASHES; end += 1) {
      seen.children.at(-1)?.exit(ENDED);
      await seen.clock.settle();
    }

    expect(seen.children).toHaveLength(CRASHES);
    expect(seen.statuses.at(-1)).toContain("run /pinpoint:start");
  });
});

describe("/pinpoint:stop", () => {
  test("closes the server and forgets the record", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    const result = await $.skill.prompt(STOP);

    expect(seen.requests.map((request) => request.path)).toContain("api/close");
    expect(seen.store.size).toBe(0);
    expect(seen.runs).toEqual([]);
    expect(result.text).toContain("pinpoint stopped");
  });

  test("with no server running says so", async ($, on) => {
    world(on);

    expect((await $.skill.prompt(STOP)).text).toContain("No pinpoint server was running.");
  });

  test("a server that exits as it closes is not revived, and its record stays forgotten", async ($, on) => {
    const seen = world(on, {
      spawn: (child) => {
        if (seen.children.length === 1) child.write(READY);
      },
    });

    await $.skill.prompt(START);
    const deleting = Promise.withResolvers<void>();
    seen.deleting = deleting.promise;
    const stopped = $.skill.prompt(STOP);
    await seen.clock.settle();
    deleting.resolve();
    await stopped;
    seen.children[1]?.write(READY);
    await seen.clock.settle();

    expect(seen.store.size).toBe(0);
    expect(seen.children).toHaveLength(1);
  });

  test("a batch waiting for its turn as the stop runs writes no record back and tells nobody", async ($, on) => {
    const seen = world(on);
    const turn = Promise.withResolvers<void>();
    seen.turn = turn.promise;
    await $.skill.prompt(START);
    seen.children[0]?.write({ type: "batch", seq: 1, text: "one" });
    await seen.clock.settle();
    await $.skill.prompt(STOP);
    turn.resolve();
    await seen.clock.settle();

    expect(seen.store.size).toBe(0);
    expect(seen.requests.map((request) => request.path)).toEqual(["api/close"]);
  });

  test("from a lost server removes the session's files, no server being left to", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);

    for (let end = 0; end < CRASHES; end += 1) {
      seen.children.at(-1)?.exit(ENDED);
      await seen.clock.settle();
    }

    const result = await $.skill.prompt(STOP);

    expect(seen.runs).toEqual([
      ["bun", expect.stringContaining("/server/cli.ts"), "clean", "--session", SESSION_ID],
    ]);
    expect(seen.store.size).toBe(0);
    expect(result.text).toContain("pinpoint stopped");
  });

  test("while the server starts ends it as it comes up, and removes the session's files", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, RECORD]]), spawn: () => {} });
    const restored = $.session.start(SESSION);
    await seen.clock.settle();
    await $.skill.prompt(STOP);
    seen.children[0]?.write(READY);
    await restored;

    expect(seen.children).toHaveLength(1);
    expect(seen.children[0]?.killed()).toBe(true);
    expect(seen.runs).toHaveLength(1);
    expect(seen.store.size).toBe(0);
  });
});

describe("/clear", () => {
  test("carries the server over to the new session id", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    seen.id = "new-session";
    await $.command.run(CLEAR);

    expect(seen.store.has(KEY)).toBe(false);
    expect(seen.store.get("session:new-session")).toEqual(RECORD);
    expect(seen.children[0]?.killed()).toBe(false);
  });

  test("a server that ends after it still comes back", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    seen.id = "new-session";
    await $.command.run(CLEAR);
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(seen.children).toHaveLength(2);
  });
});

test("the ready line the fixtures write is the one the server prints", () => {
  expect(READY).toEqual({ type: "ready", port: SERVER.port, token: SERVER.token });
});
