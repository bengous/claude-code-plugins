import { describe, expect, test, tier } from "claude-code/testing";

import {
  approved,
  batch,
  CWD,
  draftsPrompt,
  EXIT_WORKDIR_GONE,
  FINAL,
  HEARTBEAT_MS,
  LOST_RETRY_MS,
  OTHER_ID,
  OTHER_WORKDIR,
  POLL_MS,
  START_PROMPT,
  relayed,
  reply,
  SERVER,
  SESSION,
  SESSION_ID,
  STARTED,
  STOP_PROMPT,
  storedSession,
  tick,
  ticks,
  TURN_ABORTED,
  TURN_ANSWERED,
  TURN_OF_AGENT,
  typedCommand,
  WORKDIR,
  world,
} from "./fixtures/index.ts";

tier("user");

const DENIAL = `vellum is planning: files outside ${WORKDIR} change after the plan is approved`;

const ENGINE = { decision: "ask", reason: "the session's own flow" } as const;

describe("session.start", () => {
  test("registers the submit tool, and nothing in the global command namespace", async ($, on) => {
    const seen = world(on);

    expect(await $.session.start(SESSION)).toEqual({ cwd: CWD });
    expect(seen.tools).toContain("submit");
    expect(seen.commands).toEqual([]);
  });

  test("a reload finds the live server the store kept and polls again", async ($, on) => {
    const seen = world(on, { stored: storedSession() });

    await $.session.start(SESSION);
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.paths).toContain("/api/pending");
    expect(seen.paths).toContain("/api/heartbeat");
  });
});

describe("skill.prompt", () => {
  test("starts the server once, stores it, and appends the working directory", async ($, on) => {
    const seen = world(on);

    await $.skill.prompt(START_PROMPT);

    expect(await $.skill.prompt(START_PROMPT)).toEqual({
      text:
        `t\n\nWorking directory: ${WORKDIR}\n` +
        `Review page: http://127.0.0.1:${SERVER.port}/t/${SERVER.token}/`,
    });

    expect(seen.runs).toHaveLength(1);
    expect(seen.runs[0]?.slice(0, 3)).toEqual([
      "bun",
      expect.stringContaining("/src/core/server/cli.ts"),
      "start",
    ]);
    expect(seen.store.get(`session:${SESSION_ID}`)).toEqual(
      storedSession()[`session:${SESSION_ID}`],
    );
    expect(seen.statuses.at(-1)).toBe("planning");
    expect(seen.paths).toContain("/api/open");
  });

  test("returns the skill text without a directory when the launcher cannot start", async ($, on) => {
    world(on, { launch: () => ({ deny: "ENOENT bun" }) });

    expect(await $.skill.prompt(START_PROMPT)).toEqual({ text: "t" });
  });

  test("restarts the server when the stored one is dead", async ($, on) => {
    const seen = world(on, { stored: storedSession({ ...SERVER, port: 1 }) });

    await $.skill.prompt(START_PROMPT);

    expect(seen.paths[0]).toBe("/api/review");
    expect(seen.runs).toHaveLength(1);
    expect(seen.store.get(`session:${SESSION_ID}`)).toMatchObject({ server: SERVER });
  });

  test("the restarted server keeps the directory and the project the plan was started in", async ($, on) => {
    const workdir = "plans/2020-01-01/wip-4c2a9d93/";

    const seen = world(on, {
      stored: storedSession({ ...SERVER, port: 1 }, "/elsewhere", workdir),
    });

    expect(await $.skill.prompt(START_PROMPT)).toEqual({
      text:
        `t\n\nWorking directory: ${workdir}\n` +
        `Review page: http://127.0.0.1:${SERVER.port}/t/${SERVER.token}/`,
    });

    expect(seen.runs[0]?.slice(5, 9)).toEqual(["--project", "/elsewhere", "--workdir", workdir]);
  });

  test("a session id the live server does not belong to starts a second one", async ($, on) => {
    const seen = world(on);

    await $.skill.prompt(START_PROMPT);
    seen.id = OTHER_ID;
    await $.skill.prompt(START_PROMPT);

    expect(seen.runs).toHaveLength(2);
    expect(seen.runs[1]).toContain(OTHER_WORKDIR);
  });
});

describe("tool.check", () => {
  test("outside the mode every call passes on", async ($, on) => {
    world(on);
    on("tool.check", () => ENGINE);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${CWD}/src/cli.ts` } }),
    ).toEqual(ENGINE);
  });

  test("in the mode a write under the project and outside the working directory is denied", async ($, on) => {
    world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.check({ tool: "Edit", input: { file_path: `${CWD}/src/cli.ts` } })).toEqual(
      {
        decision: "deny",
        reason: DENIAL,
      },
    );
  });

  test("in the mode a write under the working directory is allowed, whatever the session's mode", async ($, on) => {
    world(on);
    on("tool.check", () => ({ decision: "deny", reason: "the session refuses every write" }));
    await $.skill.prompt(START_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${WORKDIR}plan.md` } }),
    ).toEqual({ decision: "allow" });
  });

  test("a command a settings rule approved goes back to the person, one the mode allowed does not", async ($, on) => {
    const ruled = { decision: "allow", rule: "Bash(mkdir:*)" } as const;
    const answers = [ruled, { decision: "allow" } as const];
    world(on);
    on("tool.check", () => answers.shift() ?? ruled);
    await $.skill.prompt(START_PROMPT);
    const checked = () => $.tool.check({ tool: "Bash", input: { command: "mkdir -p out" } });

    expect(await checked(), "the rule decided, so the person does").toEqual({
      decision: "ask",
      rule: "Bash(mkdir:*)",
    });

    expect(await checked(), "no rule: the engine's allow stands").toEqual({ decision: "allow" });
  });

  test("a session directory the engine refuses fails the lock closed", async ($, on) => {
    const seen = world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);
    seen.refuseCwd = "boom";

    expect(await $.tool.check({ tool: "Edit", input: { file_path: `${CWD}/src/cli.ts` } })).toEqual(
      {
        decision: "deny",
        reason: "the lock failed (throw); retry the call",
      },
    );
  });

  test("outside the mode a failing session directory changes nothing", async ($, on) => {
    const seen = world(on);
    on("tool.check", () => ENGINE);
    seen.refuseCwd = "boom";

    expect(await $.tool.check({ tool: "Edit", input: { file_path: `${CWD}/src/cli.ts` } })).toEqual(
      ENGINE,
    );
  });

  test("in the mode a failing session directory leaves a tool that writes no file to the engine", async ($, on) => {
    const seen = world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);
    seen.refuseCwd = "boom";

    expect(await $.tool.check({ tool: "Read", input: { file_path: `${CWD}/src/cli.ts` } })).toEqual(
      ENGINE,
    );
  });

  test("in the mode a failure beneath the lock is a deny", async ($, on) => {
    world(on);
    on("tool.check", () => {
      throw new Error("the chain beneath broke");
    });
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.check({ tool: "Bash", input: { command: "ls" } })).toEqual({
      decision: "deny",
      reason: "the lock failed (throw); retry the call",
    });
  });

  test("outside the mode a failure beneath is not vellum's deny", async ($, on) => {
    world(on);
    on("tool.check", () => {
      throw new Error("the chain beneath broke");
    });

    await expect($.tool.check({ tool: "Bash", input: { command: "ls" } })).rejects.toThrow();
  });

  test("in the mode a write outside the project follows the session's own flow", async ($, on) => {
    world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);
    const file_path = "/tmp/claude-1000/project/session/scratchpad/issue.md";

    expect(await $.tool.check({ tool: "Write", input: { file_path } })).toEqual(ENGINE);
  });

  test("a rule on a tool that writes no file keeps the engine's allow", async ($, on) => {
    const engine = { decision: "allow", rule: "WebFetch(domain:x.test)" } as const;
    world(on);
    on("tool.check", () => engine);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.check({ tool: "WebFetch", input: { url: "https://x.test" } })).toEqual(
      engine,
    );
  });
});

describe("tool.call mcp__vellum__submit", () => {
  const submit = "mcp__vellum__submit";

  test("posts the gate and names the version, without running the tool", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: submit })).toEqual({
      result: "Plan v1 under review. End your turn.",
    });

    expect(seen.statuses.at(-1)).toBe("plan v1 under review");
  });

  test("a gate that refuses is the deny the model reads", async ($, on) => {
    world(on, {
      routes: { "/api/gate": () => reply(409, { error: `write plan.md in ${WORKDIR} first` }) },
    });
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: submit })).toEqual({
      deny: `write plan.md in ${WORKDIR} first`,
    });
  });

  test("outside the mode it names the way in", async ($, on) => {
    world(on);

    expect(await $.tool.call({ tool: submit })).toEqual({
      deny: "no vellum planning in progress; run /vellum:start",
    });
  });

  test("a server that does not answer is a deny too", async ($, on) => {
    world(on, { routes: { "/api/gate": () => null } });
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: submit })).toEqual({
      deny: "the vellum review server is not answering; run /vellum:start again",
    });
  });
});

describe("a review an open grill holds", () => {
  const HELD = "grill-2.md is open: the plan is submitted once the reviewer ends it";

  const held = { routes: { "/api/gate": () => reply(409, { error: HELD }) } };

  test("submit is refused with the reason the server gives", async ($, on) => {
    world(on, held);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: "mcp__vellum__submit" })).toEqual({ deny: HELD });
  });

  test("the turn's end says nothing: no status, no log, no prompt", async ($, on) => {
    const seen = world(on, held);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);

    expect(seen.paths).toContain("/api/gate");
    expect([seen.statuses.at(-1), seen.logs, seen.prompts]).toEqual(["planning", [], []]);
  });
});

describe("turn.complete", () => {
  test("a turn that answers while live submits plan.md, and keeps an unchanged text", async ($, on) => {
    const bodies: (string | undefined)[] = [];

    const seen = world(on, {
      routes: {
        "/api/gate": (body) => {
          bodies.push(body);

          return reply(200, { version: 1, kept: false });
        },
      },
    });

    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.turn.complete(TURN_ANSWERED)).toEqual({ text: "done" });
    expect(bodies).toEqual([JSON.stringify({ unchanged: "keep" })]);
    expect(seen.statuses.at(-1)).toBe("plan v1 under review");
    expect(seen.logs).toEqual(["plan v1 is under review in the browser"]);
  });

  test("a version the gate kept says nothing", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/gate": () => reply(200, { version: 1, kept: true }) },
    });

    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);

    expect(seen.statuses.at(-1)).toBe("planning");
    expect(seen.logs).toEqual([]);
  });

  test("an aborted turn, a subagent's turn, and an idle session submit nothing", async ($, on) => {
    const seen = world(on);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.turn.complete(TURN_ANSWERED);
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ABORTED);
    await $.turn.complete(TURN_OF_AGENT);

    expect(seen.paths).not.toContain("/api/gate");
  });

  test("before plan.md exists, the turn's end says nothing the reviewer must act on", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/gate": () => reply(409, { error: `write plan.md in ${WORKDIR} first` }) },
    });

    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);

    expect(seen.paths).toContain("/api/gate");
    expect(seen.statuses.at(-1)).toBe("planning");
    expect(seen.logs).toEqual([]);
  });

  test("a server that does not answer at the turn's end is no failure of the turn", async ($, on) => {
    world(on, { routes: { "/api/gate": () => null } });
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.turn.complete(TURN_ANSWERED)).toEqual({ text: "done" });
  });
});

describe("a server that stops answering", () => {
  const REFUSED = { deny: "ENOENT bun" } as const;

  const NONE = { kind: "none" };

  const REVIVAL = ["--port", String(SERVER.port), "--token", SERVER.token, "--existing"];

  test("three polls a dead server fails revive it on the port and the token it had", async ($, on) => {
    let down = false;
    const seen = world(on, { routes: { "/api/pending": () => (down ? null : reply(200, NONE)) } });
    await $.skill.prompt(START_PROMPT);
    down = true;
    await tick(seen);
    await tick(seen);

    expect(seen.runs).toHaveLength(1);
    await tick(seen);

    expect(seen.runs[1]?.slice(-5)).toEqual(REVIVAL);
    expect(seen.statuses.at(-1)).toBe("planning");
  });

  test("a status outside the contract is a failure of the server, a dropped prompt is none", async ($, on) => {
    let status = 200;
    const seen = world(on, { routes: { "/api/pending": () => reply(status, approved(1)) } });
    seen.drop = "refused";
    await $.skill.prompt(START_PROMPT);
    await ticks(seen, 3);

    expect(seen.runs, "three dropped prompts").toHaveLength(1);
    status = 503;
    await ticks(seen, 3);

    expect(seen.runs, "three 503").toHaveLength(2);
  });

  test("a revival that fails is `lost`: the lock still denies, and a slow timer brings the server back", async ($, on) => {
    let down = false;

    const seen = world(on, {
      routes: { "/api/pending": () => (down ? null : reply(200, NONE)) },
      launch: (run) => (run === 2 ? REFUSED : STARTED),
    });

    await $.skill.prompt(START_PROMPT);
    down = true;
    await ticks(seen, 3);

    expect(seen.statuses.at(-1)).toBe("server lost, retrying");
    expect(await $.tool.check({ tool: "Edit", input: { file_path: `${CWD}/src/cli.ts` } })).toEqual(
      { decision: "deny", reason: DENIAL },
    );
    down = false;
    await seen.clock.advance(LOST_RETRY_MS);
    await seen.clock.settle();

    expect(seen.runs[2]?.slice(-5)).toEqual(REVIVAL);
    expect(seen.statuses.at(-1)).toBe("planning");
  });

  test("a working directory that is gone says so, and the lock holds", async ($, on) => {
    const seen = world(on, {
      stored: storedSession({ ...SERVER, port: 1 }),
      launch: () => EXIT_WORKDIR_GONE,
    });

    await $.session.start(SESSION);

    expect(seen.statuses.at(-1)).toBe("working directory gone, run /vellum:stop");
    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${CWD}/src/cli.ts` } }),
    ).toEqual({ decision: "deny", reason: DENIAL });
  });

  test("session.start on a dead stored server revives it and polls again", async ($, on) => {
    const seen = world(on, { stored: storedSession({ ...SERVER, port: 1 }) });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.runs[0]?.slice(-5)).toEqual(["--port", "1", "--token", SERVER.token, "--existing"]);
    expect(seen.store.get(`session:${SESSION_ID}`)).toMatchObject({ server: SERVER });
    expect(seen.paths).toContain("/api/pending");
  });

  test("a kept server that missed one probe is kept: a rival on another port is not adopted", async ($, on) => {
    let probes = 0;
    const rival = { ...SERVER, port: SERVER.port + 1, token: "rival" };

    const seen = world(on, {
      stored: storedSession(),
      routes: { "/api/review": () => ((probes += 1) === 1 ? null : reply(200, {})) },
      launch: () => ({ value: { exitCode: 0, stdout: JSON.stringify(rival), stderr: "" } }),
    });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.runs).toHaveLength(1);
    expect(seen.store.get(`session:${SESSION_ID}`)).toMatchObject({ server: SERVER });
    expect(seen.paths).toContain("/api/pending");
  });

  test("/vellum:stop during a revival resurrects nothing", async ($, on) => {
    let down = false;

    const seen = world(on, {
      routes: { "/api/pending": () => (down ? null : reply(200, NONE)) },
      launch: async (run) => {
        if (run === 2) await seen.clock.sleep(POLL_MS / 2);

        return STARTED;
      },
    });

    await $.skill.prompt(START_PROMPT);
    down = true;
    await ticks(seen, 3);
    await $.skill.prompt(STOP_PROMPT);
    await seen.clock.advance(POLL_MS / 2);
    const from = seen.paths.length;
    await tick(seen);

    expect(seen.runs).toHaveLength(2);
    expect(seen.paths.slice(from)).toEqual([]);
    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(false);
  });

  test("/vellum:stop leaves `lost`, and the lock with it", async ($, on) => {
    world(on, { stored: storedSession({ ...SERVER, port: 1 }), launch: () => REFUSED });
    on("tool.check", () => ENGINE);
    await $.session.start(SESSION);
    await $.skill.prompt(STOP_PROMPT);

    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${CWD}/src/cli.ts` } }),
    ).toEqual(ENGINE);
  });
});

describe("skill.prompt vellum:stop", () => {
  test("closes the mode, keeps the directory, and stops every timer", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);

    expect(await $.skill.prompt(STOP_PROMPT)).toEqual({
      text: `t\n\nvellum planning closed; ${WORKDIR} is kept`,
    });

    const from = seen.paths.length;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(false);
    expect(seen.paths.slice(from), "no poll and no heartbeat after the way out").toEqual([]);
    expect(seen.statuses.at(-1)).toBeUndefined();
  });

  test("keeps the relayed record, so a plan after a stop names no batch twice", async ($, on) => {
    const seen = world(on, { stored: { [`relayed:${SESSION_ID}`]: relayed(2) } });
    await $.skill.prompt(START_PROMPT);
    await $.skill.prompt(STOP_PROMPT);

    expect(seen.store.get(`relayed:${SESSION_ID}`)).toEqual(relayed(2));
  });

  test("outside the mode it says so and starts nothing", async ($, on) => {
    const seen = world(on);

    expect(await $.skill.prompt(STOP_PROMPT)).toEqual({
      text: "t\n\nno vellum planning in progress",
    });

    expect(seen.runs).toEqual([]);
  });
});

describe("command.run", () => {
  test("/clear stops the mode's timers and keeps the session's record", async ($, on) => {
    const seen = world(on);
    on("command.run", () => ({}));
    await $.skill.prompt(START_PROMPT);
    await $.command.run(typedCommand("clear"));

    const from = seen.paths.length;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.store.has(`session:${SESSION_ID}`), "a later /resume finds its directory").toBe(
      true,
    );
    expect(seen.statuses.at(-1)).toBeUndefined();
    expect(seen.paths.slice(from), "no poll and no heartbeat after a clear").toEqual([]);
  });

  test("/resume to another session stops the timers the same way", async ($, on) => {
    const seen = world(on);
    on("command.run", () => {
      seen.id = OTHER_ID;

      return {};
    });
    await $.skill.prompt(START_PROMPT);
    await $.command.run(typedCommand("resume"));

    const from = seen.paths.length;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.statuses.at(-1)).toBeUndefined();
    expect(seen.paths.slice(from)).toEqual([]);
  });

  test("/resume that keeps the session leaves the mode live", async ($, on) => {
    const seen = world(on);
    on("command.run", () => ({}));
    await $.skill.prompt(START_PROMPT);
    await $.command.run(typedCommand("resume"));

    const from = seen.paths.length;
    await tick(seen);

    expect(seen.statuses.at(-1)).toBe("planning");
    expect(seen.paths.slice(from), "the poll still runs").toEqual(["/api/pending"]);
  });

  test("outside the mode a /clear runs and touches nothing", async ($, on) => {
    const seen = world(on);
    on("command.run", () => ({ text: "conversation cleared" }));

    expect(await $.command.run(typedCommand("clear"))).toEqual({ text: "conversation cleared" });
    expect(seen.statuses).toEqual([]);
    expect(seen.store.size).toBe(0);
  });
});

describe("the decision comes back as a prompt", () => {
  const feedback = `${WORKDIR}.review/v1.feedback.md`;

  test("a feedback names the file once, and the mode stays live", async ($, on) => {
    const NONE = { kind: "none" };
    const CHANGES = { kind: "feedback", version: 1, path: feedback };
    let pending: typeof NONE | typeof CHANGES = NONE;
    const seen = world(on, { routes: { "/api/pending": () => reply(200, pending) } });
    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
    pending = CHANGES;
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toEqual([`Changes requested on v1: read ${feedback}.`]);

    const from = seen.paths.length;
    await tick(seen);

    expect(seen.paths.slice(from), "the poll is still running").toEqual(["/api/pending"]);
  });

  test("an approval names the final directory, then the mode is idle", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/pending": () => reply(200, approved(2)) },
    });

    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    expect(seen.prompts).toEqual([`Plan v2 approved, at ${FINAL}.`]);

    const from = seen.paths.length;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.paths.slice(from), "the poll stopped with the mode").toEqual([]);
    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(false);
  });

  test("an approval with notes says to read the notes file first", async ($, on) => {
    const notes = `${FINAL}.review/v2.notes.md`;
    const seen = world(on, { routes: { "/api/pending": () => reply(200, approved(2, notes)) } });
    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    expect(seen.prompts).toEqual([`Plan v2 approved, at ${FINAL}. Read ${notes} first.`]);
  });

  test("a drafting batch is named once, and the next batches in one prompt", async ($, on) => {
    let batches = [batch(1)];
    const drafts = () => reply(200, { kind: "drafts", batches });
    const seen = world(on, { routes: { "/api/pending": drafts } });
    await $.skill.prompt(START_PROMPT);
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toEqual([draftsPrompt(1)]);
    batches = [batch(1), batch(2), batch(3)];
    await tick(seen);

    expect(seen.prompts).toEqual([draftsPrompt(1), draftsPrompt(2, 3)]);
    expect(seen.store.get(`relayed:${SESSION_ID}`)).toEqual(relayed(3));
  });

  test("a batch the store says was relayed is not named again after a reload", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/pending": () => reply(200, { kind: "drafts", batches: [batch(1)] }) },
      stored: { ...storedSession(), [`relayed:${SESSION_ID}`]: relayed(1) },
    });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });

  test("a feedback the store says was relayed is not named again after a reload", async ($, on) => {
    const seen = world(on, {
      routes: {
        "/api/pending": () => reply(200, { kind: "feedback", version: 1, path: feedback }),
      },
      stored: { ...storedSession(), [`relayed:${SESSION_ID}`]: relayed(0, 1) },
    });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
  });

  test("a record kept for another working directory counts for nothing", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/pending": () => reply(200, { kind: "drafts", batches: [batch(1)] }) },
      stored: {
        ...storedSession(),
        [`relayed:${SESSION_ID}`]: relayed(1, 0, "plans/2020-01-01/wip-x/"),
      },
    });

    await $.session.start(SESSION);
    await tick(seen);

    expect(seen.prompts).toEqual([draftsPrompt(1)]);
  });

  test("an approval drops the record, so the next plan's first batch is named", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/pending": () => reply(200, approved(1)) },
      stored: { [`relayed:${SESSION_ID}`]: relayed(2) },
    });

    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    expect(seen.store.has(`relayed:${SESSION_ID}`)).toBe(false);
  });

  test("a store that refuses the record does not name a batch twice", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/pending": () => reply(200, { kind: "drafts", batches: [batch(1)] }) },
    });

    await $.skill.prompt(START_PROMPT);
    seen.refuseStore = "disk full";
    await tick(seen);
    await tick(seen);

    expect(seen.prompts).toEqual([draftsPrompt(1)]);
    expect(seen.logs.at(-1)).toContain("disk full");
  });

  test("an approval that lands during a new way in leaves the new mode live", async ($, on) => {
    let answered = false;

    const seen = world(on, {
      routes: {
        "/api/pending": async () => {
          if (answered) return reply(200, { kind: "none" });
          answered = true;
          await seen.clock.sleep(POLL_MS / 2);

          return reply(200, approved(1));
        },
      },
    });

    await $.skill.prompt(START_PROMPT);
    await seen.clock.advance(POLL_MS);
    seen.id = OTHER_ID;
    await $.skill.prompt(START_PROMPT);
    await seen.clock.advance(POLL_MS / 2);

    expect(seen.prompts, "the old mode's approval was relayed").toHaveLength(1);
    const from = seen.paths.length;
    await tick(seen);

    expect(seen.paths.slice(from), "the new poll still runs").toContain("/api/pending");
    expect(seen.store.has(`session:${OTHER_ID}`)).toBe(true);
  });

  test("a dropped prompt keeps the poll alive; the next tick retries", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/pending": () => reply(200, approved(1)) },
    });

    seen.drop = "refused";
    await $.skill.prompt(START_PROMPT);
    await tick(seen);

    expect(seen.prompts).toEqual([]);
    seen.drop = undefined;
    await tick(seen);

    expect(seen.prompts).toHaveLength(1);
  });
});
