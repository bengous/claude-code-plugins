import { describe, expect, test, tier } from "claude-code/testing";

import {
  approved,
  band,
  changesRequested,
  channelLine,
  CRASH_WINDOW_MS,
  CRASHES_BEFORE_LOST,
  CWD,
  DRAFTING,
  emit,
  FINAL,
  HEARTBEAT_MS,
  inReview,
  LOST_RETRY_MS,
  OTHER_ID,
  OTHER_WORKDIR,
  READY,
  relayed,
  reply,
  sent,
  SERVER,
  SESSION,
  SESSION_ID,
  stage,
  START_PROMPT,
  START_TIMEOUT_MS,
  STARTS,
  STOP_PROMPT,
  storedSession,
  told,
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

const REVIVAL = ["--port", String(SERVER.port), "--token", SERVER.token, "--existing"];

const ENDED = { code: null, signal: "SIGKILL" } as const;

const REFUSED = { deny: "ENOENT bun" } as const;

describe("session.start", () => {
  test("registers the submit tool, and nothing in the global command namespace", async ($, on) => {
    const seen = world(on);

    expect(await $.session.start(SESSION)).toEqual({ cwd: CWD });
    expect(seen.tools).toContain("submit");
    expect(seen.commands).toEqual([]);
  });

  test("a reload relaunches the server the store kept, on its port and token, and beats it", async ($, on) => {
    const seen = world(on, { stored: storedSession() });

    await $.session.start(SESSION);
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.children[0]?.argv.slice(-5)).toEqual(REVIVAL);
    expect(seen.paths).toContain("/api/heartbeat");
  });
});

describe("session.start into another session", () => {
  test("leaves the mode it finds: its heartbeat stops and its server ends", async ($, on) => {
    const other = {
      id: OTHER_ID,
      server: SERVER,
      project: CWD,
      workdir: OTHER_WORKDIR,
      final: null,
    };

    const seen = world(on, { stored: { [`session:${OTHER_ID}`]: other } });
    await $.skill.prompt(START_PROMPT);
    seen.id = OTHER_ID;
    await $.session.start(SESSION);
    const from = seen.paths.length;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.children[0]?.killed()).toBe(true);
    expect(seen.paths.slice(from).filter((path) => path === "/api/heartbeat")).toHaveLength(1);
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

    expect(seen.children).toHaveLength(1);
    expect(seen.children[0]?.argv.slice(0, 3)).toEqual([
      "bun",
      expect.stringContaining("/src/core/server/cli.ts"),
      "serve",
    ]);
    expect(seen.store.get(`session:${SESSION_ID}`)).toEqual(
      storedSession()[`session:${SESSION_ID}`],
    );
    expect(seen.statuses.at(-1)).toBeUndefined();
    expect(seen.paths).toContain("/api/open");
  });

  test("returns the skill text without a directory when the launcher cannot start", async ($, on) => {
    world(on, { spawn: () => REFUSED });

    expect(await $.skill.prompt(START_PROMPT)).toEqual({ text: "t" });
  });

  test("a server whose first line is not ready did not start, and is ended", async ($, on) => {
    const seen = world(on, {
      spawn: (child) => {
        child.print("Listening on 4242\n");
      },
    });

    expect(await $.skill.prompt(START_PROMPT)).toEqual({ text: "t" });
    expect(seen.logs.at(-1)).toContain("its first line is not ready: Listening on 4242");
    expect(seen.children[0]?.killed()).toBe(true);
  });

  test("a server that writes no ready line within five seconds did not start, and is ended", async ($, on) => {
    const seen = world(on, { spawn: () => {} });
    const entering = $.skill.prompt(START_PROMPT);
    await seen.clock.advance(START_TIMEOUT_MS);

    expect(await entering).toEqual({ text: "t" });
    expect(seen.logs.at(-1)).toBe(
      `the review server did not start: no ready line within ${START_TIMEOUT_MS} ms`,
    );
    expect(seen.children[0]?.killed()).toBe(true);
  });

  test("the session the store kept is relaunched on its port, its token and its directory", async ($, on) => {
    const seen = world(on, { stored: storedSession({ ...SERVER, port: 1 }) });

    await $.skill.prompt(START_PROMPT);

    expect(seen.children[0]?.argv.slice(-5)).toEqual([
      "--port",
      "1",
      "--token",
      SERVER.token,
      "--existing",
    ]);
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

    expect(seen.children[0]?.argv.slice(5, 9)).toEqual([
      "--project",
      "/elsewhere",
      "--workdir",
      workdir,
    ]);
  });

  test("a session id the live server does not belong to starts a second one", async ($, on) => {
    const seen = world(on);

    await $.skill.prompt(START_PROMPT);
    seen.id = OTHER_ID;
    await $.skill.prompt(START_PROMPT);

    expect(seen.children).toHaveLength(2);
    expect(seen.children[1]?.argv).toContain(OTHER_WORKDIR);
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

  test("a command a settings rule approved asks instead, one the mode allowed does not", async ($, on) => {
    const ruled = { decision: "allow", rule: "Bash(mkdir:*)" } as const;
    const answers = [ruled, { decision: "allow" } as const];
    world(on);
    on("tool.check", () => answers.shift() ?? ruled);
    await $.skill.prompt(START_PROMPT);
    const checked = () => $.tool.check({ tool: "Bash", input: { command: "mkdir -p out" } });

    expect(await checked(), "the rule decided, so the lock asks").toEqual({
      decision: "ask",
      rule: "Bash(mkdir:*)",
    });

    expect(await checked(), "no rule: the engine's allow stands").toEqual({ decision: "allow" });
  });

  test("a PowerShell command a settings rule approved asks instead, one the mode allowed does not", async ($, on) => {
    const ruled = { decision: "allow", rule: "PowerShell(Set-Content:*)" } as const;
    const answers = [ruled, { decision: "allow" } as const];
    world(on);
    on("tool.check", () => answers.shift() ?? ruled);
    await $.skill.prompt(START_PROMPT);
    const input = { command: "Set-Content README.md x" };
    const checked = () => $.tool.check({ tool: "PowerShell", input });

    expect(await checked(), "the rule decided, so the lock asks").toEqual({
      ...ruled,
      decision: "ask",
    });

    expect(await checked(), "no rule: the engine's allow stands").toEqual({ decision: "allow" });
  });

  test("a Monitor command a Bash rule approved asks instead: Monitor runs it through the shell", async ($, on) => {
    world(on);
    on("tool.check", () => ({ decision: "allow", rule: "Bash(sed -i *)" }));
    await $.skill.prompt(START_PROMPT);
    const input = { description: "rewrite", timeout_ms: 1000, command: "sed -i s/a/b/ src/cli.ts" };

    expect(await $.tool.check({ tool: "Monitor", input })).toEqual({
      decision: "ask",
      rule: "Bash(sed -i *)",
    });
  });

  test("a session directory the engine refuses fails the lock closed", async ($, on) => {
    const seen = world(on);
    on("tool.check", () => ENGINE);
    await $.skill.prompt(START_PROMPT);
    seen.refuseCwd = "boom";

    expect(await $.tool.check({ tool: "Edit", input: { file_path: "src/cli.ts" } })).toEqual({
      decision: "deny",
      reason: "the lock failed (throw); retry the call",
    });
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

    expect(seen.statuses.at(-1)).toBeUndefined();
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
  const HELD = "grill 1 is open: the plan is submitted once the reviewer ends it";

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
    expect([seen.statuses.at(-1), seen.logs, seen.prompts]).toEqual([undefined, [], []]);
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
    expect(seen.statuses.at(-1)).toBeUndefined();
    expect(seen.logs).toEqual(["plan v1 is under review in the browser"]);
  });

  test("a version the gate kept says nothing", async ($, on) => {
    const seen = world(on, {
      routes: { "/api/gate": () => reply(200, { version: 1, kept: true }) },
    });

    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);

    expect(seen.statuses.at(-1)).toBeUndefined();
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
    expect(seen.statuses.at(-1)).toBeUndefined();
    expect(seen.logs).toEqual([]);
  });

  test("a server that does not answer at the turn's end is no failure of the turn", async ($, on) => {
    world(on, { routes: { "/api/gate": () => null } });
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);

    expect(await $.turn.complete(TURN_ANSWERED)).toEqual({ text: "done" });
  });
});

describe("a server that ends", () => {
  test("a revival while a prompt waits for the turn relays the entry once", async ($, on) => {
    const seen = world(on);
    seen.hold = () => seen.clock.sleep(5_000);
    await $.skill.prompt(START_PROMPT);
    emit(seen, sent());
    await seen.clock.settle();
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();
    await seen.clock.advance(5_000);

    expect(seen.children).toHaveLength(2);
    expect(seen.prompts).toEqual([`Reviewer sent: read ${WORKDIR}.review/v0.feedback-1.md.`]);
    expect(seen.store.get(`relayed:${SESSION_ID}`)).toEqual(relayed(1));
  });

  test("an approval not yet relayed when the server dies is relayed by one revived in the final directory", async ($, on) => {
    const seen = world(on);
    seen.hold = () => seen.clock.sleep(5_000);
    await $.skill.prompt(START_PROMPT);
    emit(seen, approved(1));
    seen.children[0]?.write(stage({ kind: "approved", dir: FINAL, version: 1, notes: false }));
    await seen.clock.settle();
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();
    await seen.clock.advance(5_000);

    expect(seen.children[1]?.argv.slice(-7)).toEqual([...REVIVAL, "--final", FINAL]);
    expect(seen.prompts).toEqual([`Plan v1 approved, at ${FINAL}.`]);
    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(false);
    expect(seen.statuses.at(-1)).toBeUndefined();
  });

  test("a server that leaves two heartbeats unanswered is ended, and revived", async ($, on) => {
    let answering = true;

    const seen = world(on, {
      routes: { "/api/heartbeat": () => (answering ? reply(204, null) : null) },
    });

    await $.skill.prompt(START_PROMPT);
    answering = false;
    await seen.clock.advance(HEARTBEAT_MS * 2);

    expect(seen.children[0]?.killed()).toBe(true);
    expect(seen.children[1]?.argv.slice(-5)).toEqual(REVIVAL);
  });

  test("a server that ends three times within a minute is not revived: `lost`, and the log names the last end", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);

    for (const index of [0, 1, 2]) {
      seen.children[index]?.exit(ENDED);
      await seen.clock.settle();
    }

    expect(seen.children).toHaveLength(3);
    expect(seen.statuses.at(-1)).toBe("server lost, retrying");
    expect(seen.logs.at(-1)).toBe(
      `the review server ended ${CRASHES_BEFORE_LOST} times within 60 s, the last with ${JSON.stringify(ENDED)}: not revived`,
    );
  });

  test("ends spread over more than a minute each revive the server", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);

    for (const index of [0, 1, 2]) {
      await seen.clock.advance(index === 0 ? 0 : CRASH_WINDOW_MS / 2);
      seen.children[index]?.exit(ENDED);
      await seen.clock.settle();
    }

    expect(seen.children).toHaveLength(4);
    expect(seen.statuses.at(-1)).toBeUndefined();
  });

  test("is revived on the port and the token it had", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(seen.children[1]?.argv.slice(-5)).toEqual(REVIVAL);
    expect(seen.statuses.at(-1)).toBeUndefined();
    expect(seen.logs).toContain(`the review server ended: ${JSON.stringify(ENDED)}`);
  });

  test("a revival that fails is `lost`: the lock still denies, and a slow timer brings the server back", async ($, on) => {
    const seen = world(on, { spawn: (child, run) => (run === 2 ? REFUSED : STARTS(child, run)) });
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(seen.statuses.at(-1)).toBe("server lost, retrying");
    expect(await $.tool.check({ tool: "Edit", input: { file_path: `${CWD}/src/cli.ts` } })).toEqual(
      { decision: "deny", reason: DENIAL },
    );
    await seen.clock.advance(LOST_RETRY_MS);

    expect(seen.children[2]?.argv.slice(-5)).toEqual(REVIVAL);
    expect(seen.statuses.at(-1)).toBeUndefined();
  });

  test("a working directory that is gone says so, and the lock holds", async ($, on) => {
    const seen = world(on, {
      stored: storedSession({ ...SERVER, port: 1 }),
      spawn: (child) => {
        child.exit({ code: 3, signal: null });
      },
    });

    await $.session.start(SESSION);

    expect(seen.statuses.at(-1)).toBe("working directory gone, run /vellum:stop");
    expect(
      await $.tool.check({ tool: "Write", input: { file_path: `${CWD}/src/cli.ts` } }),
    ).toEqual({ decision: "deny", reason: DENIAL });
  });

  test("a relaunch that finds its port taken keeps the port and the token it got", async ($, on) => {
    const rival = { ...SERVER, port: SERVER.port + 1, token: "rival" };

    const seen = world(on, {
      stored: storedSession(),
      spawn: (child) => {
        child.write({ ...READY, ...rival });
      },
    });

    await $.session.start(SESSION);

    expect(seen.store.get(`session:${SESSION_ID}`)).toMatchObject({ server: rival });
  });

  test("/vellum:stop during a revival resurrects nothing", async ($, on) => {
    const seen = world(on, {
      spawn: async (child, run) => {
        if (run === 2) await seen.clock.sleep(1_000);

        return STARTS(child, run);
      },
    });

    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();
    await $.skill.prompt(STOP_PROMPT);
    await seen.clock.advance(1_000);
    const from = seen.paths.length;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.children).toHaveLength(2);
    expect(seen.children[1]?.killed()).toBe(true);
    expect(seen.paths.slice(from)).toEqual([]);
    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(false);
  });

  test("/vellum:stop leaves `lost`, and the lock with it", async ($, on) => {
    world(on, { stored: storedSession({ ...SERVER, port: 1 }), spawn: () => REFUSED });
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
    expect(seen.paths.slice(from), "no heartbeat after the way out").toEqual([]);
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

    expect(seen.children).toEqual([]);
  });

  test("ends the server: the module owns its child", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    await $.skill.prompt(STOP_PROMPT);
    await seen.clock.settle();

    expect(seen.children[0]?.killed()).toBe(true);
    expect(seen.logs.filter((line) => line.startsWith("the review server ended"))).toEqual([]);
  });
});

describe("the band above the prompt", () => {
  const LINK = `http://localhost:${SERVER.port}/t/${SERVER.token}/`;

  test("the way in draws the name and the page's link on localhost, and pins no status", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    const drawn = await band($);

    expect(await drawn.text()).toBe("vellum │ Review page ↗");
    expect(await drawn.href()).toBe(LINK);
    expect(seen.statuses.filter((text) => text !== undefined)).toEqual([]);
  });

  test("each stage the server writes draws where the plan stands", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    const drawn = await band($);
    const server = seen.children[0];
    server?.write(stage(DRAFTING));
    await seen.clock.settle();

    expect(await drawn.text()).toBe("vellum │ plan draft │ Review page ↗");
    server?.write(stage(inReview(2)));
    server?.write(stage(changesRequested(2)));
    await seen.clock.settle();

    expect(await drawn.text()).toBe("vellum │ plan v2 · changes requested │ Review page ↗");
  });

  test("/vellum:stop takes the band away", async ($, on) => {
    world(on);
    await $.skill.prompt(START_PROMPT);
    const drawn = await band($);

    expect(await drawn.text()).toBe("vellum │ Review page ↗");
    await $.skill.prompt(STOP_PROMPT);

    expect([await drawn.text(), await drawn.href()]).toEqual(["", undefined]);
  });

  test("a survey holds the band: vellum draws nothing there", async ($, on) => {
    world(on);
    await $.skill.prompt(START_PROMPT);

    expect(await (await band($, true)).text()).toBe("");
  });

  test("a lost server keeps its warning, and the band shrinks to the name and the link", async ($, on) => {
    const seen = world(on, { spawn: (child, run) => (run === 2 ? REFUSED : STARTS(child, run)) });
    await $.skill.prompt(START_PROMPT);
    const drawn = await band($);
    seen.children[0]?.write(stage(inReview(1)));
    seen.children[0]?.exit(ENDED);
    await seen.clock.settle();

    expect(seen.statuses.at(-1)).toBe("server lost, retrying");
    expect(await drawn.text()).toBe("vellum │ Review page ↗");
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
    expect(seen.paths.slice(from), "no heartbeat after a clear").toEqual([]);
  });

  test("/clear ends the server, and a later way in relaunches it on the kept port and token", async ($, on) => {
    const seen = world(on);
    on("command.run", () => ({}));
    await $.skill.prompt(START_PROMPT);
    await $.command.run(typedCommand("clear"));
    await seen.clock.settle();

    expect(seen.children[0]?.killed()).toBe(true);
    await $.skill.prompt(START_PROMPT);

    expect(seen.children[1]?.argv.slice(-5)).toEqual(REVIVAL);
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
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.statuses.at(-1)).toBeUndefined();
    expect(seen.paths.slice(from), "the heartbeat still runs").toEqual(["/api/heartbeat"]);
  });

  test("outside the mode a /clear runs and touches nothing", async ($, on) => {
    const seen = world(on);
    on("command.run", () => ({ text: "conversation cleared" }));

    expect(await $.command.run(typedCommand("clear"))).toEqual({ text: "conversation cleared" });
    expect(seen.statuses).toEqual([]);
    expect(seen.store.size).toBe(0);
  });
});

describe("what the reviewer sends comes back as a prompt", () => {
  const feedback = `${WORKDIR}.review/v1.feedback.md`;

  test("a file sent is named once, and the mode stays live", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    emit(seen, sent(feedback));
    await seen.clock.settle();
    seen.children[0]?.write(channelLine({ seq: 1, entry: sent(feedback) }));
    await seen.clock.settle();

    expect(seen.prompts).toEqual([`Reviewer sent: read ${feedback}.`]);
    expect(seen.store.get(`relayed:${SESSION_ID}`)).toEqual(relayed(1));
    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(true);
  });

  test("a text an extension worded reaches Claude as it is", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    emit(seen, told("Reviewer: Q1: yes\n\nQ2: no"));
    await seen.clock.settle();

    expect(seen.prompts).toEqual(["Reviewer: Q1: yes\n\nQ2: no"]);
  });

  test("an approval names the final directory, then the mode is idle", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    emit(seen, approved(2));
    await seen.clock.settle();

    expect(seen.prompts).toEqual([`Plan v2 approved, at ${FINAL}.`]);

    const from = seen.paths.length;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.paths.slice(from), "the heartbeat stopped with the mode").toEqual([]);
    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(false);
  });

  test("an approval with notes says to read the notes file first", async ($, on) => {
    const notes = `${FINAL}.review/v2.notes.md`;
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    emit(seen, approved(2, notes));
    await seen.clock.settle();

    expect(seen.prompts).toEqual([`Plan v2 approved, at ${FINAL}. Read ${notes} first.`]);
  });

  test("an approval drops the record, so the next plan's first entry is named", async ($, on) => {
    const seen = world(on, { stored: { [`relayed:${SESSION_ID}`]: relayed(2) } });
    await $.skill.prompt(START_PROMPT);
    seen.channel.push({ seq: 1, entry: sent() }, { seq: 2, entry: sent() });
    emit(seen, approved(1));
    await seen.clock.settle();

    expect(seen.store.has(`relayed:${SESSION_ID}`)).toBe(false);
  });

  test("entries written together are named one by one, in order", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    emit(
      seen,
      sent(`${WORKDIR}.review/v0.feedback-1.md`),
      sent(`${WORKDIR}.review/v0.feedback-2.md`),
    );
    await seen.clock.settle();

    expect(seen.prompts).toEqual([
      `Reviewer sent: read ${WORKDIR}.review/v0.feedback-1.md.`,
      `Reviewer sent: read ${WORKDIR}.review/v0.feedback-2.md.`,
    ]);
    expect(seen.store.get(`relayed:${SESSION_ID}`)).toEqual(relayed(2));
  });

  test("an entry is relayed once, across a module reload and a server relaunch", async ($, on) => {
    const seen = world(on, {
      stored: { ...storedSession(), [`relayed:${SESSION_ID}`]: relayed(1) },
      channel: [
        { seq: 1, entry: told("Reviewer: Q1: yes") },
        { seq: 2, entry: told("Reviewer: Q2: no") },
      ],
    });

    await $.session.start(SESSION);
    await seen.clock.settle();

    expect(seen.children[0]?.argv.slice(-5)).toEqual(REVIVAL);
    expect(seen.prompts, "read past the record, from the file").toEqual(["Reviewer: Q2: no"]);
    seen.children[0]?.write(channelLine({ seq: 2, entry: told("Reviewer: Q2: no") }));
    emit(seen, told("Reviewer: Q3: maybe"));
    await seen.clock.settle();

    expect(seen.prompts).toEqual(["Reviewer: Q2: no", "Reviewer: Q3: maybe"]);
    expect(seen.store.get(`relayed:${SESSION_ID}`)).toEqual(relayed(3));
  });

  test("a number past the next one reads the entries it missed first, in order", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    await seen.clock.settle();
    seen.channel.push({ seq: 1, entry: told("first") }, { seq: 2, entry: told("second") });
    emit(seen, told("third"));
    await seen.clock.settle();

    expect(seen.prompts).toEqual(["first", "second", "third"]);
  });

  test("a record of another channel counts for nothing: a new plan at the same path is read from its first entry", async ($, on) => {
    const seen = world(on, {
      stored: { [`relayed:${SESSION_ID}`]: relayed(4, "the approved plan's channel") },
      channel: [
        { seq: 1, entry: sent() },
        { seq: 2, entry: sent(`${WORKDIR}.review/v0.feedback-2.md`) },
      ],
    });

    await $.skill.prompt(START_PROMPT);
    await seen.clock.settle();

    expect(seen.prompts).toHaveLength(2);
    expect(seen.store.get(`relayed:${SESSION_ID}`)).toEqual(relayed(2));
  });

  test("a reload before the approval was relayed relaunches the server in the final directory, which relays it", async ($, on) => {
    const seen = world(on, {
      stored: {
        ...storedSession(SERVER, CWD, WORKDIR, FINAL),
        [`relayed:${SESSION_ID}`]: relayed(1),
      },
      channel: [
        { seq: 1, entry: sent() },
        { seq: 2, entry: approved(1) },
      ],
    });

    await $.session.start(SESSION);
    await seen.clock.settle();

    expect(seen.children[0]?.argv.slice(-2)).toEqual(["--final", FINAL]);
    expect(seen.prompts).toEqual([`Plan v1 approved, at ${FINAL}.`]);
    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(false);
  });

  test("an approved stage keeps the final directory in the session's record", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(stage({ kind: "approved", dir: FINAL, version: 1, notes: false }));
    await seen.clock.settle();

    expect(seen.store.get(`session:${SESSION_ID}`)).toMatchObject({ final: FINAL });
  });

  test("an approval whose closing failed is closed at the next heartbeat, and told once", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    seen.refuseStore = "disk full";
    emit(seen, approved(1));
    await seen.clock.settle();

    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(true);
    seen.refuseStore = undefined;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.store.has(`session:${SESSION_ID}`)).toBe(false);
    expect(seen.prompts).toHaveLength(1);
  });

  test("a line the server could not read is skipped, and the log says so", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    seen.channel.push({ seq: 2, entry: sent() });
    seen.children[0]?.write(channelLine({ seq: 2, entry: sent() }));
    await seen.clock.settle();

    expect(seen.prompts).toHaveLength(1);
    expect(seen.logs).toContain("the channel holds no entry 1 to 1");
  });

  test("a record of the shape before the channel starts over", async ($, on) => {
    const seen = world(on, {
      stored: {
        ...storedSession(),
        [`relayed:${SESSION_ID}`]: { workdir: WORKDIR, drafts: 1, version: 0 },
      },
      channel: [{ seq: 1, entry: sent() }],
    });

    await $.session.start(SESSION);
    await seen.clock.settle();

    expect(seen.prompts).toHaveLength(1);
  });

  test("a store that refuses the record does not name an entry twice", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    seen.refuseStore = "disk full";
    emit(seen, sent());
    seen.children[0]?.write(channelLine({ seq: 1, entry: sent() }));
    await seen.clock.settle();

    expect(seen.prompts).toHaveLength(1);
    expect(seen.logs.at(-1)).toContain("disk full");
  });

  test("an approval of a mode that was left reaches nobody, and leaves the new mode live", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    seen.id = OTHER_ID;
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.write(channelLine({ seq: 1, entry: approved(1) }));
    await seen.clock.settle();

    expect(seen.prompts).toEqual([]);
    expect(seen.store.has(`session:${OTHER_ID}`)).toBe(true);
  });

  test("a line cut in two pieces is read once it is whole", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    const whole = `${JSON.stringify(channelLine({ seq: 1, entry: sent() }))}\n`;
    seen.channel.push({ seq: 1, entry: sent() });
    seen.children[0]?.print(whole.slice(0, 20));
    await seen.clock.settle();

    expect(seen.prompts).toEqual([]);
    seen.children[0]?.print(whole.slice(20));
    await seen.clock.settle();

    expect(seen.prompts).toHaveLength(1);
  });

  test("a line the module does not read is logged, and relays nothing", async ($, on) => {
    const seen = world(on);
    await $.skill.prompt(START_PROMPT);
    seen.children[0]?.print('{"type":"pending","pending":{"kind":"none"}}\n');
    await seen.clock.settle();

    expect(seen.prompts).toEqual([]);
    expect(seen.logs.at(-1)).toBe(
      'the review server wrote a line this module does not read: {"type":"pending","pending":{"kind":"none"}}',
    );
  });

  test("a dropped prompt is not counted, and the heartbeat retries it", async ($, on) => {
    const seen = world(on);
    seen.drop = "refused";
    await $.skill.prompt(START_PROMPT);
    emit(seen, sent());
    await seen.clock.settle();

    expect(seen.prompts).toEqual([]);
    seen.drop = undefined;
    await seen.clock.advance(HEARTBEAT_MS);

    expect(seen.prompts).toHaveLength(1);
    expect(seen.children).toHaveLength(1);
  });
});
