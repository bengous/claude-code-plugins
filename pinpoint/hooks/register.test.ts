import type { CommandRunInput, SessionStartInput, Settings, SkillPromptArgs } from "claude-code";
import { describe, expect, test, tier } from "claude-code/testing";

import {
  type Child,
  deliveries,
  posted,
  READY,
  ROOT,
  SERVER,
  SESSION_ID,
  world,
} from "./fixtures.ts";
import { CRASHES, HEARTBEAT_MS } from "./register.ts";

tier("user");

const START: SkillPromptArgs = { skill: "pinpoint:start", text: "t" };

const APP = "http://localhost:5173/admin";

/** `/pinpoint:start <typed>`: with no `$ARGUMENTS` in the skill, Claude Code ends its text so. */
function startWith(typed: string): SkillPromptArgs {
  return { skill: "pinpoint:start", text: `t\n\n\nARGUMENTS: ${typed}` };
}

const STOP: SkillPromptArgs = { skill: "pinpoint:stop", text: "t" };

const SESSION: SessionStartInput = { surface: "terminal", isInteractive: true, cwd: ROOT };

const KEPT = ["--port", String(SERVER.port), "--token", SERVER.token];

const RECORD = { serverSession: SESSION_ID, root: ROOT, ...SERVER, target: null, relayed: 0 };

const ENDED = { code: 1, signal: null } as const;

const KEY = `session:${SESSION_ID}`;

/** What the module passed `child` after `name`, `null` when it passed no `name`. */
function flag(child: Child | undefined, name: string): string | null {
  const argv = child?.argv ?? [];
  const at = argv.indexOf(name);

  return at === -1 ? null : (argv[at + 1] ?? null);
}

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
      "--relayed",
      "0",
      "--keep-days",
      "30",
    ]);
    expect(result.text).toContain(`pinpoint is live for ${ROOT}.`);
    expect(result.text).toContain(
      `Open http://localhost:${SERVER.port}/ in the browser: "Which app?"`,
    );
    expect(seen.store.get(KEY)).toEqual(RECORD);
  });

  test("with an address, the server serves that app, and the address opens it at its path", async ($, on) => {
    const seen = world(on);
    const result = await $.skill.prompt(startWith(APP));

    expect(seen.children[0]?.argv.slice(-2)).toEqual(["--target", APP]);
    expect(result.text).toContain(`Open http://localhost:${SERVER.port}/admin in the browser`);
    expect(result.text).toContain("it serves http://localhost:5173 with the overlay");
    expect(seen.store.get(KEY)).toEqual({ ...RECORD, target: APP });
  });

  for (const [how, typed] of [
    ["ending in a newline", `${APP}\n`],
    ["broken over two lines", "http://localhost:5173/ad\nmin"],
  ] as const) {
    test(`an address ${how} is read whole`, async ($, on) => {
      const seen = world(on);
      await $.skill.prompt(startWith(typed));

      expect(seen.children[0]?.argv.slice(-2)).toEqual(["--target", APP]);
    });
  }

  test("a bare port is an app on this machine", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(startWith("5173"));

    expect(seen.children[0]?.argv.slice(-2)).toEqual(["--target", "http://localhost:5173/"]);
  });

  test("what is not an http(s) address starts nothing, and says so", async ($, on) => {
    const seen = world(on);
    const result = await $.skill.prompt(startWith("ftp://files.example/"));

    expect(seen.children).toEqual([]);
    expect(result.text).toContain('"ftp://files.example/" is not an http(s) address');
  });

  test("the server's own address is refused: it starts asking which app, and says why", async ($, on) => {
    const seen = world(on, {
      spawn: (child) => {
        child.write(READY);
      },
    });

    const own = `http://localhost:${SERVER.port}/`;
    const result = await $.skill.prompt(startWith(own));

    expect(result.text).toContain(
      `pinpoint did not take ${own}: it is this pinpoint server's own address`,
    );
    expect(seen.store.get(KEY)).toEqual(RECORD);
  });

  test("a second start keeps the server it has", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    await $.skill.prompt(START);

    expect(seen.children).toHaveLength(1);
  });

  test("an address while live switches the app, the server and its address kept", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    const result = await $.skill.prompt(startWith(APP));

    expect(seen.children).toHaveLength(1);
    expect(posted(seen, "api/target")).toEqual([JSON.stringify({ url: APP })]);
    expect(result.text).toContain(
      `pinpoint now serves http://localhost:5173 at http://localhost:${SERVER.port}/admin`,
    );

    seen.children[0]?.write({ type: "target", target: APP });
    await seen.clock.settle();

    expect(seen.store.get(KEY)).toEqual({ ...RECORD, target: APP });
  });

  test("a switch the server refuses keeps the app, and says why", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(startWith("http://localhost:3000/"));
    seen.refuse = "http://localhost:4242 is this pinpoint server: name the app's own address.";
    const result = await $.skill.prompt(startWith(`http://localhost:${SERVER.port}/`));

    expect(result.text).toContain(`pinpoint kept the app it serves: ${seen.refuse}`);
    expect(seen.store.get(KEY)).toEqual({ ...RECORD, target: "http://localhost:3000/" });
  });

  test("a start with no address while live keeps the app, and names it", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(startWith(APP));
    const result = await $.skill.prompt(START);

    expect(seen.children).toHaveLength(1);
    expect(posted(seen, "api/target")).toEqual([]);
    expect(result.text).toContain("it serves http://localhost:5173 with the overlay");
  });

  test("a server that cannot start leaves no record, and says so", async ($, on) => {
    const seen = world(on, { spawn: () => ({ deny: "ENOENT bun" }) });
    const result = await $.skill.prompt(START);

    expect(result.text).toContain("pinpoint did not start its server");
    expect(seen.store.size).toBe(0);
  });
});

describe("the browser", () => {
  test("a first start seen at this machine opens it at the address, and says so", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal"];
    const result = await $.skill.prompt(START);

    expect(posted(seen, "api/open")).toHaveLength(1);
    expect(result.text).toContain(
      `The browser opens http://localhost:${SERVER.port}/: "Which app?"`,
    );
    expect(result.text).toContain("If no tab comes up, open that address yourself.");
  });

  test("a first start with an app opens it at the app's path", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["desktop"];
    const result = await $.skill.prompt(startWith(APP));

    expect(posted(seen, "api/open")).toHaveLength(1);
    expect(result.text).toContain(`The browser opens http://localhost:${SERVER.port}/admin:`);
  });

  test("a start nobody sees here opens nothing and gives the address: a -p run, a phone", async ($, on) => {
    const seen = world(on);
    const unseen = await $.skill.prompt(START);
    await $.skill.prompt(STOP);
    seen.surfaces = ["mobile"];
    const remote = await $.skill.prompt(START);

    expect(posted(seen, "api/open")).toEqual([]);
    expect(unseen.text).toContain(`Open http://localhost:${SERVER.port}/ in the browser`);
    expect(remote.text).toContain(`Open http://localhost:${SERVER.port}/ in the browser`);
  });

  test("a terminal with a phone attached opens it: Remote Control stays on at the desk", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal", "mobile"];
    await $.skill.prompt(START);

    expect(posted(seen, "api/open")).toHaveLength(1);
  });

  test("an opener that does not run leaves the address to open", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal"];
    seen.noOpener = "could not run xdg-open: Executable not found";
    const result = await $.skill.prompt(START);

    expect(posted(seen, "api/open")).toHaveLength(1);
    expect(result.text).toContain(`Open http://localhost:${SERVER.port}/ in the browser`);
    expect(result.text).not.toContain("The browser opens");
  });

  test("a stop while the browser opens is what the start says", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal"];
    const { promise, resolve } = Promise.withResolvers<void>();
    seen.opening = promise;
    const starting = $.skill.prompt(START);
    await seen.clock.settle();
    const stopped = $.skill.prompt(STOP);
    await seen.clock.settle();
    resolve();
    const result = await starting;
    await stopped;

    expect(result.text).toContain("pinpoint was stopped meanwhile");
    expect(result.text).not.toContain("The browser opens");
  });

  test('the server\'s own address refused, it opens "Which app?" and says so', async ($, on) => {
    const seen = world(on, {
      spawn: (child) => {
        child.write(READY);
      },
    });

    seen.surfaces = ["terminal"];
    const result = await $.skill.prompt(startWith(`http://localhost:${SERVER.port}/`));

    expect(posted(seen, "api/open")).toHaveLength(1);
    expect(result.text).toContain(
      `The browser opens http://localhost:${SERVER.port}/ to pick the app`,
    );
  });

  test("a start or a switch while live opens nothing: the tab is there", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal"];
    await $.skill.prompt(START);
    const again = await $.skill.prompt(START);
    const switched = await $.skill.prompt(startWith(APP));

    expect(posted(seen, "api/open")).toHaveLength(1);
    expect(again.text).toContain(
      `pinpoint is already live for ${ROOT}.\nIts address stays http://localhost:${SERVER.port}/:`,
    );
    expect(switched.text).not.toContain("The browser opens");
  });

  test("a server that comes back on its own, or after a reload, opens nothing", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, RECORD]]) });
    seen.surfaces = ["terminal"];
    await $.session.start(SESSION);
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(seen.children).toHaveLength(2);
    expect(posted(seen, "api/open")).toEqual([]);
  });

  test("a start after the server was lost opens nothing: its address is the tabs' already", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal"];
    await $.skill.prompt(START);

    for (let end = 0; end < CRASHES; end += 1) {
      seen.children.at(-1)?.exit(ENDED);
      await seen.clock.settle();
    }

    const result = await $.skill.prompt(START);

    expect(seen.children.at(-1)?.argv.slice(-4)).toEqual(KEPT);
    expect(posted(seen, "api/open")).toHaveLength(1);
    expect(result.text).toContain(`Open http://localhost:${SERVER.port}/ in the browser`);
  });

  test("a start from a record a gone process left opens it: no tab of this one holds it", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, RECORD]]) });
    seen.surfaces = ["terminal"];
    const result = await $.skill.prompt(START);

    expect(seen.children[0]?.argv.slice(-4)).toEqual(KEPT);
    expect(posted(seen, "api/open")).toHaveLength(1);
    expect(result.text).toContain(`The browser opens http://localhost:${SERVER.port}/`);
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

  test("a server that comes back is told the last batch handed over, which its numbers pass", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, { ...RECORD, relayed: 3 }]]) });
    await $.session.start(SESSION);
    seen.children[0]?.write({ type: "batch", seq: 4, text: "four" });
    await seen.clock.settle();
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(seen.children.map((child) => flag(child, "--relayed"))).toEqual(["3", "4"]);
  });

  test("a server sweeps the other sessions after Claude Code's cleanupPeriodDays, 30 unset, and none past a value Claude Code refuses", async ($, on) => {
    const seen = world(on);

    const keepDays = async (settings: Settings): Promise<string | null> => {
      seen.settings = settings;
      await $.skill.prompt(START);
      await $.skill.prompt(STOP);

      return flag(seen.children.at(-1), "--keep-days");
    };

    expect(await keepDays({})).toBe("30");
    expect(await keepDays({ cleanupPeriodDays: 7 })).toBe("7");
    expect(await keepDays({ cleanupPeriodDays: 0 })).toBeNull();
    expect(await keepDays({ cleanupPeriodDays: 2.5 })).toBeNull();
    expect(await keepDays({ cleanupPeriodDays: "7" })).toBeNull();
    expect(await keepDays({ cleanupPeriodDays: 1e21 })).toBeNull();
  });

  test("settings that do not read start the server all the same, sweeping nothing, and say why", async ($, on) => {
    const seen = world(on);
    seen.noSettings = "the engine is going away";
    const result = await $.skill.prompt(START);

    expect(result.text).toContain(`pinpoint is live for ${ROOT}.`);
    expect(flag(seen.children[0], "--keep-days")).toBeNull();
    expect(seen.logs).toEqual([
      expect.stringMatching(/no other session is swept: .*the engine is going away$/u),
    ]);
  });

  test("the app a page picked is recorded, and the server that comes back serves it", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START);
    seen.children[0]?.write({ type: "target", target: APP });
    await seen.clock.settle();

    expect(seen.store.get(KEY)).toEqual({ ...RECORD, target: APP });

    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(seen.children[1]?.argv.slice(-6)).toEqual([...KEPT, "--target", APP]);
  });

  test("a record stored before the module kept an app comes back on its port and token, its last batch not handed over twice", async ($, on) => {
    const { target: _none, ...before } = RECORD;
    const seen = world(on, { stored: new Map([[KEY, { ...before, relayed: 3 }]]) });
    await $.session.start(SESSION);

    expect(seen.children[0]?.argv.slice(-4)).toEqual(KEPT);
    seen.children[0]?.write({ type: "batch", seq: 3, text: "three" });
    await seen.clock.settle();

    expect(seen.prompts).toEqual([]);
  });

  test("a stored record that does not read is said, and brings no server back", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, { ...RECORD, target: "not an address" }]]) });
    await $.session.start(SESSION);

    expect(seen.children).toEqual([]);
    expect(seen.logs.join("\n")).toContain("the session's stored record does not read");
  });

  test("a stored record whose last batch is no batch number does not read: no server it would stop", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, { ...RECORD, relayed: -1 }]]) });
    await $.session.start(SESSION);

    expect(seen.children).toEqual([]);
    expect(seen.logs.join("\n")).toContain("the session's stored record does not read");
  });

  test("a reload starts the stored server serving its app again", async ($, on) => {
    const seen = world(on, { stored: new Map([[KEY, { ...RECORD, target: APP }]]) });
    await $.session.start(SESSION);

    expect(seen.children[0]?.argv.slice(-6)).toEqual([...KEPT, "--target", APP]);
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
  expect(READY).toEqual({ type: "ready", port: SERVER.port, token: SERVER.token, target: null });
});
