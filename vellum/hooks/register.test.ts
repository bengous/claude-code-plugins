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

type Route = (body: string | undefined) => HttpResponse;

type FakeTimer = { ms: number; fn: () => void; cancelled: boolean };

/** One loaded module, its fake engine, and what the module did to it. */
type Harness = {
  $: EngineInterface;
  readonly hooks: Map<string, Hook>;
  readonly prompts: string[];
  readonly runs: string[][];
  readonly store: Map<string, unknown>;
  readonly timers: FakeTimer[];
  /** Ports of the servers `process.run` started in this test; any other port is dead. */
  readonly ports: Set<number>;
  status: string | undefined;
};

const SERVER = { port: 4242, token: "tok", pid: 7 };

const SESSION_ID = "4c2a9d93-c356-436e-bd4f-898a7b844bda";

const WORKDIR = `plans/${new Date().toISOString().slice(0, 10)}/wip-4c2a9d93/`;

const PLAN_INPUT = { plan: "# P\n", planFilePath: "plans/p.md" };

const LIVE: Record<string, Route> = {
  "/api/review": () => reply(200, { workspace: { kind: "drafting" } }),
  "/api/heartbeat": () => reply(204, null),
  "/api/open": () => reply(204, null),
  "/api/gate": () => reply(200, { version: 1 }),
};

const DENIED_V1 = {
  decision: {
    behavior: "deny",
    message:
      "Plan v1 is open for review in the browser. End your turn; the review arrives as a new prompt.",
  },
};

function reply(status: number, value: unknown): HttpResponse {
  return { status, ok: status < 300, headers: {}, text: JSON.stringify(value) };
}

function harness(routes: Record<string, Route>): Harness {
  const h: Harness = {
    $: {} as EngineInterface,
    hooks: new Map(),
    prompts: [],
    runs: [],
    store: new Map(),
    timers: [],
    ports: new Set(),
    status: undefined,
  };

  h.$ = {
    plugin: { name: "vellum", root: "/plugin" },
    session: { id: () => Promise.resolve(SESSION_ID), cwd: () => Promise.resolve("/project") },
    http: {
      fetch: (url: string, init?: { body?: string }) => {
        const parsed = new URL(url);
        const route = h.ports.has(Number(parsed.port)) ? routes[parsed.pathname] : undefined;

        return route === undefined
          ? Promise.reject(new Error(`ECONNREFUSED ${url}`))
          : Promise.resolve(route(init?.body));
      },
    },
    process: {
      run: (argv: readonly string[]) => {
        h.runs.push([...argv]);
        h.ports.add(SERVER.port);

        return Promise.resolve({ exitCode: 0, stdout: `${JSON.stringify(SERVER)}\n`, stderr: "" });
      },
    },
    store: {
      get: (key: string) => Promise.resolve(h.store.get(key)),
      set: (key: string, value: unknown) => Promise.resolve(void h.store.set(key, value)),
      delete: (key: string) => Promise.resolve(void h.store.delete(key)),
    },
    clock: {
      every: (ms: number, fn: () => void): Timer => {
        const timer = { ms, fn, cancelled: false };
        h.timers.push(timer);

        return { cancel: () => void (timer.cancelled = true) };
      },
    },
    prompt: {
      submit: (input: { text: string }) => {
        h.prompts.push(input.text);

        return Promise.resolve({ text: input.text });
      },
    },
    ui: { status: (text: string | undefined) => void (h.status = text), log: () => {} },
  } as unknown as EngineInterface;

  register(
    ((event: string, _matcher: unknown, fn: Hook) => void h.hooks.set(event, fn)) as never,
    {},
  );

  return h;
}

function hook(h: Harness, event: string): Hook {
  const found = h.hooks.get(event);

  if (found === undefined) throw new Error(`no ${event} hook`);

  return found;
}

function invokeSkill(h: Harness): Promise<unknown> {
  const e = { skill: "vellum:plan", text: "t" };

  return Promise.resolve(hook(h, "skill.prompt")(h.$, e, () => Promise.resolve({ text: "t" })));
}

function passed(event: unknown): unknown {
  return { passed: event };
}

function exitPlanMode(h: Harness, extra: Record<string, unknown> = {}): Promise<unknown> {
  const e = { tool_name: "ExitPlanMode", tool_input: PLAN_INPUT, session_id: SESSION_ID, ...extra };

  return Promise.resolve(hook(h, "classic.PermissionRequest")(h.$, e, passed));
}

/** Fires every live one-second poll twice, letting the promises settle in between. */
async function tick(h: Harness): Promise<void> {
  for (let n = 0; n < 2; n += 1) {
    for (const timer of h.timers) if (!timer.cancelled && timer.ms === 1000) timer.fn();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** A module that gated a plan and heard the browser approve it: the poll ran, the prompt entered. */
async function afterApproval(routes: Record<string, Route>, version: number): Promise<Harness> {
  const h = harness({
    ...routes,
    "/api/gate": () => reply(200, { version }),
    "/api/pending": () => reply(200, { kind: "approved", version }),
  });

  await invokeSkill(h);
  await exitPlanMode(h);
  await tick(h);

  return h;
}

const ALLOWED_FINAL = {
  decision: {
    behavior: "allow",
    updatedInput: { ...PLAN_INPUT, plan: "# P (final)\n" },
    updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
  },
};

function polling(h: Harness): boolean {
  return h.timers.some((timer) => timer.ms === 1000 && !timer.cancelled);
}

function beating(h: Harness): boolean {
  return h.timers.some((timer) => timer.ms === 30_000 && !timer.cancelled);
}

describe("skill.prompt", () => {
  test("starts the server once, stores it, and appends the working directory", async () => {
    const h = harness(LIVE);
    const first = await invokeSkill(h);
    const second = await invokeSkill(h);
    expect(first).toEqual({ text: `t\n\nWorking directory: ${WORKDIR}` });
    expect(second).toEqual(first);
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]?.slice(0, 3)).toEqual(["bun", "/plugin/src/cli.ts", "start"]);
    expect(h.store.get(`session:${SESSION_ID}`)).toEqual({ server: SERVER, workdir: WORKDIR });
    expect(beating(h)).toBe(true);
  });

  test("returns the skill text without a directory when the launcher cannot start", async () => {
    const h = harness(LIVE);
    h.$.process.run = () => Promise.reject(new Error("ENOENT bun"));
    expect(await invokeSkill(h)).toEqual({ text: "t" });
  });

  test("restarts the server when the stored one is dead", async () => {
    const h = harness(LIVE);
    h.store.set(`session:${SESSION_ID}`, { server: { ...SERVER, port: 1 }, workdir: "x/" });
    await invokeSkill(h);
    expect(h.runs).toHaveLength(1);
    expect(h.store.get(`session:${SESSION_ID}`)).toMatchObject({ server: SERVER });
  });
});

describe("classic.PermissionRequest on ExitPlanMode", () => {
  test("passes to the terminal for a subagent and without a session", async () => {
    const h = harness(LIVE);
    expect(await exitPlanMode(h, { agent_id: "sub" })).toMatchObject({ passed: {} });
    expect(await exitPlanMode(h)).toMatchObject({ passed: {} });
  });

  test("a session restored from the store gets its heartbeat back", async () => {
    const h = harness(LIVE);
    h.ports.add(SERVER.port);
    h.store.set(`session:${SESSION_ID}`, { server: SERVER, workdir: WORKDIR });
    expect(await exitPlanMode(h)).toEqual(DENIED_V1);
    expect(beating(h)).toBe(true);
  });

  test("gates, denies, and polls until the feedback prompt enters", async () => {
    let pending: unknown = { kind: "none" };
    const h = harness({ ...LIVE, "/api/pending": () => reply(200, pending) });
    await invokeSkill(h);
    expect(await exitPlanMode(h)).toEqual(DENIED_V1);
    expect(h.status).toBe("plan v1 under review");
    await tick(h);
    expect(h.prompts).toEqual([]);
    pending = { kind: "feedback", version: 1, path: `${WORKDIR}.review/v1.feedback.md` };
    await tick(h);
    expect(h.prompts).toEqual([
      `Plan review v1: changes requested. Read ${WORKDIR}.review/v1.feedback.md, revise the plan, then call ExitPlanMode.`,
    ]);
    expect(polling(h)).toBe(false);
    expect(h.status).toBeUndefined();
  });

  test("a dropped prompt keeps the poll alive; the next tick retries", async () => {
    let drop = true;
    const approved = (): HttpResponse => reply(200, { kind: "approved", version: 1 });
    const h = harness({ ...LIVE, "/api/pending": approved });
    const submit = h.$.prompt.submit;
    h.$.prompt.submit = (input) => (drop ? Promise.resolve({ drop: "refused" }) : submit(input));
    await invokeSkill(h);
    await exitPlanMode(h);
    await tick(h);
    expect(h.prompts).toEqual([]);
    expect(polling(h)).toBe(true);
    drop = false;
    await tick(h);
    expect(h.prompts).toHaveLength(1);
    expect(polling(h)).toBe(false);
  });

  test("an approval prompts, then the next ExitPlanMode is allowed with the finalized plan", async () => {
    const finalized = (body: string | undefined): HttpResponse =>
      body === JSON.stringify({ version: 2 })
        ? reply(200, { workspace: { kind: "approved" }, plan: "# P (final)\n" })
        : reply(400, null);

    const h = await afterApproval({ ...LIVE, "/api/finalize": finalized }, 2);
    expect(h.prompts).toEqual([
      "Plan v2 was approved in the browser. Call ExitPlanMode again with the same plan.",
    ]);
    expect(await exitPlanMode(h)).toEqual(ALLOWED_FINAL);
    expect(h.store.has(`session:${SESSION_ID}`)).toBe(false);
    expect(h.timers.every((timer) => timer.cancelled)).toBe(true);
    expect(await exitPlanMode(h)).toMatchObject({ passed: {} });
  });

  test("a failed finalize denies with the error and polls again", async () => {
    const failed = (): HttpResponse =>
      reply(409, { workspace: { kind: "inReview", finalizeError: "EACCES on plans/" } });

    const h = await afterApproval({ ...LIVE, "/api/finalize": failed }, 1);
    expect(await exitPlanMode(h)).toMatchObject({
      decision: { behavior: "deny", message: expect.stringContaining("EACCES on plans/") },
    });
    expect(polling(h)).toBe(true);
  });
});
