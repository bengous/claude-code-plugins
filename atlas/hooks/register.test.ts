import type {
  CommandRunInput,
  PromptSubmitInput,
  SessionEndInput,
  SessionStartInput,
  SkillPromptArgs,
} from "claude-code";
import { describe, expect, test, tier } from "claude-code/testing";

import {
  CWD,
  DRAFT,
  FIRST_PORT,
  LINKED,
  MAP,
  OTHER_MAP,
  page,
  running,
  SESSION_ID,
  type Stored,
  world,
} from "./fixtures.ts";
import { CRASHES, HEARTBEAT_MS } from "./register.ts";

tier("user");

/** `/atlas:board <words>`: with no `$ARGUMENTS` in the skill, Claude Code ends its text so. */
function board(...words: readonly string[]): SkillPromptArgs {
  return {
    skill: "atlas:board",
    text: words.length === 0 ? "t" : `t\n\n\nARGUMENTS: ${words.join(" ")}`,
  };
}

const STOP: SkillPromptArgs = { skill: "atlas:stop", text: "t" };

const SESSION: SessionStartInput = { surface: "terminal", isInteractive: true, cwd: CWD };

const ENDED = { code: 1, signal: null } as const;

const MAP_KEY = `map:${MAP}`;

const SESSION_KEY = `session:${SESSION_ID}`;

const SELECTION_KEY = `selection:${MAP}`;

/** Another session's server, on a port of its own. */
const THEIRS = 5000;

const PROMPT: PromptSubmitInput = {
  text: "what is this?",
  wait: false,
  origin: { kind: "composer" },
};

function ended(reason: SessionEndInput["reason"]): SessionEndInput {
  return { reason, sessionId: SESSION_ID, resume: { id: SESSION_ID } };
}

const CLEAR: CommandRunInput = {
  command: "clear",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: true, columns: 160 },
};

const BACKUP = { id: "backup", label: "Nightly backup" } as const;

const SELECTED = `On the atlas map ${MAP}, the human has selected backup (Nightly backup).`;

describe("/atlas:board", () => {
  test("starts the map folder's server as a child of the session, and says where its page is", async ($, on) => {
    const seen = world(on);
    const result = await $.skill.prompt(board("docs/map"));

    expect(seen.children.map((child) => [child.argv, child.cwd])).toEqual([
      [["bun", expect.stringContaining("/serve.ts"), MAP, "0", "--heartbeat"], MAP],
    ]);
    expect(result.text).toContain(
      `atlas shows the map ${MAP}.\nOpen ${page(FIRST_PORT)} in a browser.`,
    );
    expect(seen.store.get(MAP_KEY)).toEqual({ port: FIRST_PORT });
    expect(seen.store.get(SESSION_KEY)).toEqual({ folders: [MAP] });
  });

  test("a second call on the same folder keeps its server, named however it lands", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    const again = await $.skill.prompt(board(LINKED));

    expect(running(seen)).toHaveLength(1);
    expect(again.text).toContain(
      `atlas already shows the map ${MAP}.\nIt stays at ${page(FIRST_PORT)}.`,
    );
  });

  test("with no folder, it shows the one map folder under the session's directory", async ($, on) => {
    const seen = world(on, {
      files: [`${MAP}/atlas.config.ts`, `${CWD}/node_modules/x/atlas.config.ts`],
    });

    await $.skill.prompt(board());

    expect(seen.children[0]?.argv[2]).toBe(MAP);
  });

  test("with several, the person picks one, a map folder's drafts left out", async ($, on) => {
    const seen = world(on);
    seen.pick = "maps/other";
    await $.skill.prompt(board());

    expect(seen.asked).toEqual([["docs/map", "maps/other"]]);
    expect(seen.children[0]?.argv[2]).toBe(OTHER_MAP);
  });

  test("with several and nobody to ask, it lists them and starts nothing", async ($, on) => {
    const seen = world(on);
    const result = await $.skill.prompt(board());

    expect(result.text).toContain(
      `atlas found several map folders under ${CWD}: docs/map, maps/other.`,
    );
    expect(seen.children).toEqual([]);
  });

  test("with none, it says so", async ($, on) => {
    const seen = world(on, { files: [`${CWD}/README.md`] });
    const result = await $.skill.prompt(board());

    expect(result.text).toContain(
      `atlas found no map folder (a folder holding atlas.config.ts) under ${CWD}.`,
    );
    expect(seen.children).toEqual([]);
  });

  test("a draft name shows that draft of the map folder", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map", "rewire"));

    expect(seen.children[0]?.argv[2]).toBe(DRAFT);
  });

  test("a draft the map folder does not have starts nothing, and says where drafts are", async ($, on) => {
    const seen = world(on);
    const result = await $.skill.prompt(board("docs/map", "nope"));

    expect(result.text).toContain(`atlas: ${MAP} has no draft nope`);
    expect(seen.children).toEqual([]);
  });

  test("a folder with no atlas.config.ts is no map folder", async ($, on) => {
    const seen = world(on);
    const result = await $.skill.prompt(board("docs"));

    expect(result.text).toContain("atlas: docs is no map folder: it holds no atlas.config.ts.");
    expect(seen.children).toEqual([]);
  });

  test("a server that does not start says why, and the status line keeps it", async ($, on) => {
    const seen = world(on, { spawn: (child) => child.exit(ENDED) });
    const result = await $.skill.prompt(board("docs/map"));

    expect(result.text).toContain(`atlas: the server of ${MAP} did not start`);
    expect(seen.statuses.at(-1)).toContain("run /atlas:board");
    expect(seen.store.has(SESSION_KEY)).toBe(false);
  });
});

describe("one server per map folder", () => {
  test("another session's live server is joined, not started again", async ($, on) => {
    const seen = world(on, { stored: new Map([[MAP_KEY, { port: THEIRS }]]) });
    seen.servers.set(THEIRS, MAP);
    const result = await $.skill.prompt(board("docs/map"));

    expect(seen.children).toEqual([]);
    expect(result.text).toContain(`Open ${page(THEIRS)} in a browser.`);
    expect(result.text).toContain("Another session's server serves it");
    expect(seen.store.get(SESSION_KEY)).toEqual({ folders: [MAP] });
  });

  test("a joined server is beaten too, so it outlives the session that started it no longer than this one", async ($, on) => {
    const seen = world(on, { stored: new Map([[MAP_KEY, { port: THEIRS }]]) });
    seen.servers.set(THEIRS, MAP);
    await $.skill.prompt(board("docs/map"));
    const before = seen.beats.length;
    await seen.clock.advance(HEARTBEAT_MS * 2);

    expect(seen.beats.slice(before)).toEqual([THEIRS, THEIRS]);
  });

  test("a joined server that stops answering is replaced by this session's own, on its port", async ($, on) => {
    const seen = world(on, { stored: new Map([[MAP_KEY, { port: THEIRS }]]) });
    seen.servers.set(THEIRS, MAP);
    await $.skill.prompt(board("docs/map"));
    seen.servers.delete(THEIRS);
    await seen.clock.advance(HEARTBEAT_MS);

    expect(running(seen).map((child) => child.argv[3])).toEqual([String(THEIRS)]);
    expect(seen.store.get(MAP_KEY)).toEqual({ port: THEIRS });
  });

  test("a record whose server is gone starts this session's own on its port, which the tabs hold", async ($, on) => {
    const seen = world(on, { stored: new Map([[MAP_KEY, { port: THEIRS }]]) });
    await $.skill.prompt(board("docs/map"));

    expect(seen.children.map((child) => child.argv[3])).toEqual([String(THEIRS)]);
  });

  test("a port that serves another map since starts it on a free one", async ($, on) => {
    const seen = world(on, { stored: new Map([[MAP_KEY, { port: THEIRS }]]) });
    seen.servers.set(THEIRS, OTHER_MAP);
    const result = await $.skill.prompt(board("docs/map"));

    expect(seen.children.map((child) => child.argv[3])).toEqual([String(THEIRS), "0"]);
    expect(seen.store.get(MAP_KEY)).toEqual({ port: FIRST_PORT });
    expect(result.text).toContain(page(FIRST_PORT));
  });
});

describe("the server's life", () => {
  test("the module beats its server", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    await seen.clock.advance(HEARTBEAT_MS * 2);

    expect(seen.beats).toEqual([FIRST_PORT, FIRST_PORT]);
  });

  test("a server that ends on its own comes back on its port", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(running(seen).map((child) => child.argv[3])).toEqual([String(FIRST_PORT)]);
    expect(seen.children).toHaveLength(2);
  });

  test("a server ended from outside by SIGTERM, as Claude Code ends its children on exit, is not revived, and its records go", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    seen.children[0]?.select(BACKUP);
    await seen.clock.settle();
    seen.children[0]?.exit({ code: null, signal: "SIGTERM" });
    await seen.clock.settle();

    expect(seen.children).toHaveLength(1);
    expect(seen.store.has(MAP_KEY)).toBe(false);
    expect(seen.store.has(SELECTION_KEY)).toBe(false);
    expect(seen.logs.join("\n")).toContain(`the server of ${MAP} was ended from outside`);
    expect((await $.skill.prompt(STOP)).text).toContain("No atlas board was open in this session.");
  });

  test("a read loop that fails is an end like any other: the server comes back", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    seen.children[0]?.fail("EPIPE");
    await seen.clock.settle();

    expect(seen.logs.join("\n")).toContain("the server's read loop failed");
    expect(running(seen)).toHaveLength(1);
  });

  test("past the crash window the board is lost, and the status line says so", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));

    for (let end = 0; end < CRASHES; end += 1) {
      seen.children.at(-1)?.exit(ENDED);
      await seen.clock.settle();
    }

    expect(seen.children).toHaveLength(CRASHES);
    expect(running(seen)).toEqual([]);
    expect(seen.statuses.at(-1)).toContain(
      `the server of ${MAP} ended ${CRASHES} times within a minute`,
    );
  });

  test("a reload attaches the session's boards again, on their ports", async ($, on) => {
    const seen = world(on, {
      stored: new Map([
        [SESSION_KEY, { folders: [MAP] }],
        [MAP_KEY, { port: FIRST_PORT }],
      ]),
    });

    await $.session.start(SESSION);

    expect(running(seen).map((child) => child.argv[3])).toEqual([String(FIRST_PORT)]);
  });

  test("a session with no record attaches nothing", async ($, on) => {
    const seen = world(on);
    await $.session.start(SESSION);

    expect(seen.children).toEqual([]);
  });

  test("a session record that does not read is said, and attaches nothing", async ($, on) => {
    const seen = world(on, { stored: new Map([[SESSION_KEY, { broken: true }]]) });
    await $.session.start(SESSION);

    expect(seen.children).toEqual([]);
    expect(seen.logs.join("\n")).toContain("the session's record does not read");
  });
});

describe("the end of a board", () => {
  test("/atlas:stop ends the server, its heartbeat and its records", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    seen.children[0]?.select(BACKUP);
    await seen.clock.settle();
    const result = await $.skill.prompt(STOP);
    await seen.clock.advance(HEARTBEAT_MS * 2);

    expect(seen.children[0]?.killed()).toBe(true);
    expect(seen.children).toHaveLength(1);
    expect(seen.beats).toEqual([]);
    expect([...seen.store.keys()]).toEqual([]);
    expect(result.text).toContain(`atlas stopped showing ${MAP}.`);
  });

  test("/atlas:stop leaves another session's server and its record", async ($, on) => {
    const seen = world(on, { stored: new Map([[MAP_KEY, { port: THEIRS }]]) });
    seen.servers.set(THEIRS, MAP);
    await $.skill.prompt(board("docs/map"));
    await $.skill.prompt(STOP);

    expect(seen.servers.get(THEIRS)).toBe(MAP);
    expect(seen.store.get(MAP_KEY)).toEqual({ port: THEIRS });
    expect(seen.store.has(SESSION_KEY)).toBe(false);
  });

  test("/atlas:stop while the server starts ends it as it comes up", async ($, on) => {
    const seen = world(on, { spawn: () => {} });
    const starting = $.skill.prompt(board("docs/map"));
    await seen.clock.settle();
    await $.skill.prompt(STOP);
    seen.children[0]?.write(page(FIRST_PORT));
    const result = await starting;

    expect(seen.children[0]?.killed()).toBe(true);
    expect(result.text).toContain(`atlas: the board of ${MAP} was stopped meanwhile.`);
    expect([...seen.store.keys()]).toEqual([]);
  });

  test("/atlas:stop with no board says so", async ($, on) => {
    world(on);

    expect((await $.skill.prompt(STOP)).text).toContain("No atlas board was open in this session.");
  });

  test("the session's end ends its server and forgets its records", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    await $.session.end(ended("prompt_input_exit"));

    expect(seen.children[0]?.killed()).toBe(true);
    expect([...seen.store.keys()]).toEqual([]);
  });

  test("a /clear keeps the server, its record moved to the new session id", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    await $.session.end(ended("clear"));
    seen.id = "new-session";
    await $.command.run(CLEAR);

    expect(seen.children[0]?.killed()).toBe(false);
    expect(seen.store.has(SESSION_KEY)).toBe(false);
    expect(seen.store.get("session:new-session")).toEqual({ folders: [MAP] });
  });
});

describe("the browser", () => {
  test("a session in the desktop app opens it in its built-in browser", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["desktop"];
    const result = await $.skill.prompt(board("docs/map"));

    expect(result.text).toContain(
      `Open ${page(FIRST_PORT)} in your built-in browser, beside the conversation.`,
    );
    expect(seen.runs).toEqual([]);
  });

  test("a session in a terminal opens the system browser", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal"];
    const result = await $.skill.prompt(board("docs/map"));

    expect(seen.runs.map((ran) => ran.argv)).toEqual([
      ["bun", expect.stringContaining("/open.ts"), page(FIRST_PORT)],
    ]);
    expect(result.text).toContain(`The system browser opens ${page(FIRST_PORT)}`);
  });

  test("an opener that does not run leaves the address to open, and says why", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal"];
    seen.noOpener = "open: could not run xdg-open";
    const result = await $.skill.prompt(board("docs/map"));

    expect(result.text).toContain(`Open ${page(FIRST_PORT)} in a browser.`);
    expect(seen.logs.join("\n")).toContain("could not run xdg-open");
  });

  test("a board already shown opens nothing again", async ($, on) => {
    const seen = world(on);
    seen.surfaces = ["terminal"];
    await $.skill.prompt(board("docs/map"));
    await $.skill.prompt(board("docs/map"));

    expect(seen.runs).toHaveLength(1);
  });
});

describe("the selection", () => {
  test("what the human selects reaches the next prompt's context, once", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    seen.children[0]?.select(BACKUP);
    await seen.clock.settle();
    await $.prompt.submit(PROMPT);
    await $.prompt.submit(PROMPT);

    expect(seen.store.get(SELECTION_KEY)).toEqual(BACKUP);
    expect(seen.contexts).toEqual([[SELECTED], []]);
  });

  test("a cleared selection says nothing, and the same one selected again is said again", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    seen.children[0]?.select(BACKUP);
    await seen.clock.settle();
    await $.prompt.submit(PROMPT);
    seen.children[0]?.select({ id: null });
    await seen.clock.settle();
    await $.prompt.submit(PROMPT);
    seen.children[0]?.select(BACKUP);
    await seen.clock.settle();
    await $.prompt.submit(PROMPT);

    expect(seen.contexts).toEqual([[SELECTED], [], [SELECTED]]);
  });

  test("another session's server's selection reaches a session that joined it", async ($, on) => {
    const seen = world(on, {
      stored: new Map<string, Stored>([
        [MAP_KEY, { port: THEIRS }],
        [SELECTION_KEY, BACKUP],
      ]),
    });

    seen.servers.set(THEIRS, MAP);
    await $.skill.prompt(board("docs/map"));
    await $.prompt.submit(PROMPT);

    expect(seen.contexts).toEqual([[SELECTED]]);
  });

  test("a /clear says the current selection again to the new conversation", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(board("docs/map"));
    seen.children[0]?.select(BACKUP);
    await seen.clock.settle();
    await $.prompt.submit(PROMPT);
    seen.id = "new-session";
    await $.command.run(CLEAR);
    await $.prompt.submit(PROMPT);

    expect(seen.contexts).toEqual([[SELECTED], [SELECTED]]);
  });

  test("a session showing no map adds nothing, and a rebuild's line is no selection", async ($, on) => {
    const seen = world(on, { stored: new Map([[SELECTION_KEY, BACKUP]]) });
    await $.prompt.submit(PROMPT);
    seen.store.clear();
    await $.skill.prompt(board("docs/map"));
    seen.children[0]?.write("atlas: built in 12 ms, reload sent to 1 tab(s)");
    await seen.clock.settle();
    await $.prompt.submit(PROMPT);

    expect(seen.contexts).toEqual([[], []]);
    expect(seen.store.has(SELECTION_KEY)).toBe(false);
  });
});

const OPEN_POINTS = [
  "backup-restore-untested  brick backup  waits: human  No restore from the nightly dump has been tried: whether a dump restores is unknown.",
  "1 open points: 0 wait for agent, 1 wait for human",
].join("\n");

describe("the agent's tools", () => {
  test("are registered as the session starts", async ($, on) => {
    const seen = world(on);
    await $.session.start(SESSION);

    expect(seen.registered).toEqual([
      "atlas_open_points",
      "atlas_reply",
      "atlas_query",
      "atlas_check",
    ]);
  });

  test("atlas_open_points lists the open points and who each waits for", async ($, on) => {
    const seen = world(on);
    seen.answer = () => ({ stdout: `${OPEN_POINTS}\n` });
    const result = await $.tool.call({ tool: "mcp__atlas__atlas_open_points", folder: "docs/map" });

    expect(seen.runs).toEqual([
      { argv: ["bun", expect.stringContaining("/cli.ts"), "check", MAP, "--open"], cwd: MAP },
    ]);
    expect(result).toEqual({ result: OPEN_POINTS });
  });

  test("atlas_reply answers an open point as the agent", async ($, on) => {
    const seen = world(on);
    seen.answer = () => ({ stdout: "backup-restore-untested: 2 entries, waits for human\n" });

    const result = await $.tool.call({
      tool: "mcp__atlas__atlas_reply",
      folder: MAP,
      id: "backup-restore-untested",
      text: "A restore was tried on a copy.",
    });

    expect(seen.runs.map((ran) => ran.argv)).toEqual([
      [
        "bun",
        expect.stringContaining("/cli.ts"),
        "reply",
        MAP,
        "backup-restore-untested",
        "--as",
        "agent",
        "A restore was tried on a copy.",
      ],
    ]);
    expect(result).toEqual({ result: "backup-restore-untested: 2 entries, waits for human" });
  });

  test("atlas_reply refuses what the command line refuses, in its words", async ($, on) => {
    const seen = world(on);
    seen.answer = () => ({ exitCode: 1, stderr: "reply: unknown open id nope\n" });

    const result = await $.tool.call({
      tool: "mcp__atlas__atlas_reply",
      folder: MAP,
      id: "nope",
      text: "x",
    });

    expect(result).toEqual({ deny: "atlas: reply: unknown open id nope" });
  });

  test("atlas_query reads a node", async ($, on) => {
    const seen = world(on);
    const node = JSON.stringify({ map: "Bookshop", path: [{ id: "server", label: "Server" }] });
    seen.answer = () => ({ stdout: node });

    const result = await $.tool.call({
      tool: "mcp__atlas__atlas_query",
      folder: "docs/map",
      id: "server",
    });

    expect(seen.runs.map((ran) => ran.argv)).toEqual([
      ["bun", expect.stringContaining("/query.ts"), MAP, "server"],
    ]);
    expect(result).toEqual({ result: node });
  });

  test("atlas_check says ok, or lists each problem", async ($, on) => {
    const seen = world(on);
    seen.answer = () => ({ stdout: "plan: ok, 4 zones, 8 bricks, 10 arrows\ntsgo: ok" });
    const ok = await $.tool.call({ tool: "mcp__atlas__atlas_check", folder: "docs/map" });

    seen.answer = () => ({
      exitCode: 1,
      stdout: "plan: failed\narrow web → nowhere: unknown end nowhere",
      stderr: "check: plan failed",
    });

    const failed = await $.tool.call({ tool: "mcp__atlas__atlas_check", folder: "docs/map" });

    expect(ok).toEqual({ result: "plan: ok, 4 zones, 8 bricks, 10 arrows\ntsgo: ok" });
    expect(failed).toEqual({
      result:
        "The map has problems:\nplan: failed\narrow web → nowhere: unknown end nowhere\ncheck: plan failed",
    });
  });

  test("a folder that is no map folder, or none, is refused before any command runs", async ($, on) => {
    const seen = world(on);
    const none = await $.tool.call({ tool: "mcp__atlas__atlas_check" });
    const missing = await $.tool.call({ tool: "mcp__atlas__atlas_check", folder: "nowhere" });
    const notMap = await $.tool.call({ tool: "mcp__atlas__atlas_check", folder: "docs" });

    expect(none).toEqual({ deny: "atlas: name the map folder, the one holding atlas.config.ts" });
    expect(missing).toEqual({ deny: "atlas: nowhere does not exist" });
    expect(notMap).toEqual({ deny: "atlas: docs is no map folder: it holds no atlas.config.ts" });
    expect(seen.runs).toEqual([]);
  });
});
