/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- this harness hands the hooks module the events, store values and JSON the engine would pass as unknown: the loose types ARE the boundary under test, and the fake `$` carries only the members the module calls. */
import { describe, expect, test } from "bun:test";

import type { EngineInterface, HttpResponse, Timer } from "claude-code";

import { register } from "./register.ts";

/**
 * The hooks module runs in the engine's own environment, which `bun test`
 * cannot host; `register` is called with a recording `on` and a `$` answered
 * from memory instead. `claude plugin test` has no way to raise a classic
 * event, so the ExitPlanMode answers are covered here.
 */

type Hook = ($: EngineInterface, e: unknown, next: (e: unknown) => unknown) => unknown;

type Calls = {
  readonly fetches: { url: string; body: string | undefined }[];
  readonly prompts: string[];
  readonly runs: string[][];
  readonly store: Map<string, unknown>;
  readonly timers: { ms: number; fn: () => void; cancelled: boolean }[];
  /** Ports of the servers `process.run` started in this test; any other port is dead. */
  readonly ports: Set<number>;
  status: string | undefined;
};

type Route = (body: string | undefined) => HttpResponse;

const SERVER = { port: 4242, token: "tok", pid: 7 };

const SESSION_ID = "4c2a9d93-c356-436e-bd4f-898a7b844bda";

const WORKDIR = `plans/${new Date().toISOString().slice(0, 10)}/wip-4c2a9d93/`;

function reply(status: number, value: unknown): HttpResponse {
  return { status, ok: status < 300, headers: {}, text: JSON.stringify(value) };
}

function fakeEngine(routes: Record<string, Route>, calls: Calls): EngineInterface {
  return {
    plugin: { name: "vellum", root: "/plugin" },
    session: { id: () => Promise.resolve(SESSION_ID), cwd: () => Promise.resolve("/project") },
    http: {
      fetch: (url: string, init?: { body?: string }) => {
        calls.fetches.push({ url, body: init?.body });
        const parsed = new URL(url);
        const route = calls.ports.has(Number(parsed.port)) ? routes[parsed.pathname] : undefined;

        return route === undefined
          ? Promise.reject(new Error(`ECONNREFUSED ${url}`))
          : Promise.resolve(route(init?.body));
      },
    },
    process: {
      run: (argv: readonly string[]) => {
        calls.runs.push([...argv]);
        calls.ports.add(SERVER.port);

        return Promise.resolve({ exitCode: 0, stdout: `${JSON.stringify(SERVER)}\n`, stderr: "" });
      },
    },
    store: {
      get: (key: string) => Promise.resolve(calls.store.get(key)),
      set: (key: string, value: unknown) => {
        calls.store.set(key, value);

        return Promise.resolve();
      },
      delete: (key: string) => {
        calls.store.delete(key);

        return Promise.resolve();
      },
    },
    clock: {
      every: (ms: number, fn: () => void): Timer => {
        const timer = { ms, fn, cancelled: false };
        calls.timers.push(timer);

        return {
          cancel: () => {
            timer.cancelled = true;
          },
        };
      },
    },
    prompt: {
      submit: (input: { text: string }) => {
        calls.prompts.push(input.text);

        return Promise.resolve({ text: input.text });
      },
    },
    ui: {
      status: (text: string | undefined) => {
        calls.status = text;
      },
      log: () => {},
    },
  } as unknown as EngineInterface;
}

function load(): { hooks: Map<string, Hook>; calls: Calls } {
  const hooks = new Map<string, Hook>();

  const calls: Calls = {
    fetches: [],
    prompts: [],
    runs: [],
    store: new Map(),
    timers: [],
    ports: new Set(),
    status: undefined,
  };

  register(
    ((event: string, _matcher: unknown, hook: Hook) => {
      hooks.set(event, hook);
    }) as never,
    {},
  );

  return { hooks, calls };
}

const LIVE = {
  "/api/review": () => reply(200, { workspace: { kind: "drafting" } }),
  "/api/heartbeat": () => reply(204, null),
  "/api/open": () => reply(204, null),
};

const PLAN_INPUT = { plan: "# P\n", planFilePath: "plans/p.md" };

function permissionEvent(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tool_name: "ExitPlanMode", tool_input: PLAN_INPUT, session_id: SESSION_ID, ...extra };
}

function skillText(): Promise<{ text: string }> {
  return Promise.resolve({ text: "skill text" });
}

function passed(e: unknown): unknown {
  return { passed: e };
}

async function tick(calls: Calls): Promise<void> {
  for (const timer of calls.timers) if (!timer.cancelled && timer.ms === 1000) timer.fn();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("skill.prompt", () => {
  test("starts the server once, stores it, and appends the working directory", async () => {
    const { hooks, calls } = load();
    const $ = fakeEngine(LIVE, calls);
    const skill = hooks.get("skill.prompt");

    if (skill === undefined) throw new Error("no skill.prompt hook");
    const first = await skill($, { skill: "vellum:plan", text: "skill text" }, skillText);
    const second = await skill($, { skill: "vellum:plan", text: "skill text" }, skillText);
    expect(first).toEqual({
      text: `skill text\n\nWorking directory: ${WORKDIR}`,
    });
    expect(second).toEqual(first);
    expect(calls.runs).toHaveLength(1);
    expect(calls.runs[0]?.slice(0, 3)).toEqual(["bun", "/plugin/src/cli.ts", "start"]);
    expect(calls.store.get(`session:${SESSION_ID}`)).toEqual({
      server: SERVER,
      workdir: WORKDIR,
    });
    expect(calls.timers.some((timer) => timer.ms === 30_000)).toBe(true);
  });

  test("returns the skill text without a directory when the launcher cannot start", async () => {
    const { hooks, calls } = load();
    const $ = fakeEngine(LIVE, calls);
    $.process.run = () => Promise.reject(new Error("ENOENT bun"));
    const skill = hooks.get("skill.prompt");

    if (skill === undefined) throw new Error("no skill.prompt hook");

    const result = await skill($, { skill: "vellum:plan", text: "t" }, () =>
      Promise.resolve({ text: "t" }),
    );

    expect(result).toEqual({ text: "t" });
  });

  test("restarts the server when the stored one is dead", async () => {
    const { hooks, calls } = load();
    calls.store.set(`session:${SESSION_ID}`, { server: { ...SERVER, port: 1 }, workdir: "x/" });
    const $ = fakeEngine(LIVE, calls);
    const skill = hooks.get("skill.prompt");

    if (skill === undefined) throw new Error("no skill.prompt hook");
    await skill($, { skill: "vellum:plan", text: "t" }, () => Promise.resolve({ text: "t" }));
    expect(calls.runs).toHaveLength(1);
    expect(calls.store.get(`session:${SESSION_ID}`)).toMatchObject({ server: SERVER });
  });
});

describe("classic.PermissionRequest on ExitPlanMode", () => {
  test("passes to the terminal for a subagent and without a session", async () => {
    const { hooks, calls } = load();
    const $ = fakeEngine(LIVE, calls);
    const hook = hooks.get("classic.PermissionRequest");

    if (hook === undefined) throw new Error("no hook");
    expect(await hook($, permissionEvent({ agent_id: "sub" }), passed)).toMatchObject({
      passed: {},
    });
    expect(await hook($, permissionEvent(), passed)).toMatchObject({ passed: {} });
  });

  test("a session restored from the store gets its heartbeat back", async () => {
    const { hooks, calls } = load();
    calls.ports.add(SERVER.port);
    calls.store.set(`session:${SESSION_ID}`, { server: SERVER, workdir: WORKDIR });

    const $ = fakeEngine({ ...LIVE, "/api/gate": () => reply(200, { version: 1 }) }, calls);
    const hook = hooks.get("classic.PermissionRequest");

    if (hook === undefined) throw new Error("no hook");
    const denied = await hook($, permissionEvent(), () => null);
    expect(denied).toMatchObject({ decision: { behavior: "deny" } });
    expect(calls.timers.some((timer) => timer.ms === 30_000 && !timer.cancelled)).toBe(true);
  });

  test("a dropped prompt keeps the poll alive; the next tick retries", async () => {
    const { hooks, calls } = load();
    let drop = true;

    const $ = fakeEngine(
      {
        ...LIVE,
        "/api/gate": () => reply(200, { version: 1 }),
        "/api/pending": () => reply(200, { kind: "approved", version: 1 }),
      },
      calls,
    );

    $.prompt.submit = (input: { text: string }) => {
      if (drop) return Promise.resolve({ drop: "another plugin refused it" });
      calls.prompts.push(input.text);

      return Promise.resolve({ text: input.text });
    };

    const skill = hooks.get("skill.prompt");
    const hook = hooks.get("classic.PermissionRequest");

    if (skill === undefined || hook === undefined) throw new Error("no hook");
    await skill($, { skill: "vellum:plan", text: "t" }, () => Promise.resolve({ text: "t" }));
    await hook($, permissionEvent(), () => null);
    await tick(calls);
    await tick(calls);
    expect(calls.prompts).toEqual([]);
    expect(calls.status).toBe("plan v1 under review");
    drop = false;
    await tick(calls);
    await tick(calls);
    expect(calls.prompts).toHaveLength(1);
    expect(calls.status).toBeUndefined();
  });

  test("gates, denies, polls, then submits one feedback prompt and stops polling", async () => {
    const { hooks, calls } = load();
    let pending: unknown = { kind: "none" };

    const $ = fakeEngine(
      {
        ...LIVE,
        "/api/gate": () => reply(200, { version: 1 }),
        "/api/pending": () => reply(200, pending),
      },
      calls,
    );

    const skill = hooks.get("skill.prompt");
    const hook = hooks.get("classic.PermissionRequest");

    if (skill === undefined || hook === undefined) throw new Error("no hook");
    await skill($, { skill: "vellum:plan", text: "t" }, () => Promise.resolve({ text: "t" }));
    const denied = await hook($, permissionEvent(), () => null);
    expect(denied).toEqual({
      decision: {
        behavior: "deny",
        message:
          "Plan v1 is open for review in the browser. End your turn; the review arrives as a new prompt.",
      },
    });
    expect(calls.status).toBe("plan v1 under review");
    await tick(calls);
    expect(calls.prompts).toEqual([]);
    pending = {
      kind: "feedback",
      version: 1,
      path: `${WORKDIR}.review/v1.feedback.md`,
    };
    await tick(calls);
    await tick(calls);
    expect(calls.prompts).toEqual([
      `Plan review v1: changes requested. Read ${WORKDIR}.review/v1.feedback.md, revise the plan, then call ExitPlanMode.`,
    ]);
    expect(
      calls.timers.filter((timer) => timer.ms === 1000).every((timer) => timer.cancelled),
    ).toBe(true);
    expect(calls.status).toBeUndefined();
  });

  test("an approval prompts, then the next ExitPlanMode is allowed with the finalized plan", async () => {
    const { hooks, calls } = load();

    const $ = fakeEngine(
      {
        ...LIVE,
        "/api/gate": () => reply(200, { version: 2 }),
        "/api/pending": () => reply(200, { kind: "approved", version: 2 }),
        "/api/finalize": (body) =>
          body === JSON.stringify({ version: 2 })
            ? reply(200, { workspace: { kind: "approved" }, plan: "# P (final)\n" })
            : reply(400, null),
      },
      calls,
    );

    const skill = hooks.get("skill.prompt");
    const hook = hooks.get("classic.PermissionRequest");

    if (skill === undefined || hook === undefined) throw new Error("no hook");
    await skill($, { skill: "vellum:plan", text: "t" }, () => Promise.resolve({ text: "t" }));
    await hook($, permissionEvent(), () => null);
    await tick(calls);
    await tick(calls);
    expect(calls.prompts).toEqual([
      "Plan v2 was approved in the browser. Call ExitPlanMode again with the same plan.",
    ]);

    const allowed = await hook($, permissionEvent(), () => null);
    expect(allowed).toEqual({
      decision: {
        behavior: "allow",
        updatedInput: { ...PLAN_INPUT, plan: "# P (final)\n" },
        updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
      },
    });
    expect(calls.store.has(`session:${SESSION_ID}`)).toBe(false);
    expect(calls.timers.every((timer) => timer.cancelled)).toBe(true);

    const afterwards = await hook($, permissionEvent(), () => ({ passed: true }));
    expect(afterwards).toEqual({ passed: true });
  });

  test("a failed finalize denies with the error and keeps polling", async () => {
    const { hooks, calls } = load();

    const $ = fakeEngine(
      {
        ...LIVE,
        "/api/gate": () => reply(200, { version: 1 }),
        "/api/pending": () => reply(200, { kind: "approved", version: 1 }),
        "/api/finalize": () =>
          reply(409, { workspace: { kind: "inReview", finalizeError: "EACCES on plans/" } }),
      },
      calls,
    );

    const skill = hooks.get("skill.prompt");
    const hook = hooks.get("classic.PermissionRequest");

    if (skill === undefined || hook === undefined) throw new Error("no hook");
    await skill($, { skill: "vellum:plan", text: "t" }, () => Promise.resolve({ text: "t" }));
    await hook($, permissionEvent(), () => null);
    await tick(calls);
    await tick(calls);
    const denied = await hook($, permissionEvent(), () => null);
    expect(denied).toMatchObject({
      decision: { behavior: "deny", message: expect.stringContaining("EACCES on plans/") },
    });
    expect(
      calls.timers.filter((timer) => timer.ms === 1000).some((timer) => !timer.cancelled),
    ).toBe(true);
  });
});
