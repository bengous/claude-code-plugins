import type {
  ModelCompleteInput,
  ModelCompleteResult,
  On,
  PromptOrigin,
  TurnCompleteInput,
} from "claude-code";
import { type Engine, expect, type MockClock, mock, test } from "claude-code/testing";

const PLUGIN = "wrap-archive";

const SERVER = "ccd_session_mgmt";

const USAGE = {
  input_tokens: 10,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const DONE: ModelCompleteResult = { isAnswered: true, text: "done", usage: USAGE };

const NOT_DONE: ModelCompleteResult = { isAnswered: true, text: "not_done", usage: USAGE };

const REFUSAL = "Session is open on screen; not archived.";

const PERSON: PromptOrigin = { kind: "composer" };

const BAND = {
  plugin: PLUGIN,
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const;

const SURFACES = ["terminal", "desktop"] as const;

const OTHER_MOD = "drawn by another mod";

type World = {
  readonly clock: MockClock;
  readonly judged: ModelCompleteInput[];
  readonly archived: string[];
  readonly statusCalls: (string | undefined)[];
  readonly statuses: () => string[];
  readonly aborts: () => number;
};

function stubEngine(
  on: On,
  {
    verdicts = [DONE],
    isReachable = true,
    archiveText = REFUSAL,
    judgeDelayMs = 0,
    probeDelayMs = 0,
  }: {
    verdicts?: readonly ModelCompleteResult[];
    isReachable?: boolean;
    archiveText?: string;
    judgeDelayMs?: number;
    probeDelayMs?: number;
  } = {},
): World {
  const clock = mock.clock(on);
  const judged: ModelCompleteInput[] = [];
  const archived: string[] = [];
  const statusCalls: (string | undefined)[] = [];
  let aborts = 0;

  on("model.complete", async (_$, e, next) => {
    const verdict = verdicts[judged.length] ?? verdicts.at(-1) ?? DONE;

    judged.push(e);
    next.signal.addEventListener("abort", () => {
      aborts += 1;
    });

    if (judgeDelayMs > 0) await clock.sleep(judgeDelayMs);

    return { value: verdict };
  });
  on("mcp.call", async (_$, e) => {
    if (e.server !== SERVER || !isReachable)
      return { deny: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` };

    if (e.tool === "get_session") {
      if (probeDelayMs > 0) await clock.sleep(probeDelayMs);

      return {
        value: { content: [{ type: "text", text: '{"sessionId":"local_1"}' }], isError: false },
      };
    }

    archived.push(JSON.stringify(e.args));

    return { value: { content: [{ type: "text", text: archiveText }], isError: false } };
  });
  on("ui.status", (_$, e) => {
    statusCalls.push(e.text);

    return { value: undefined };
  });
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("ui.render", () => ({ type: "Text", props: {}, children: [OTHER_MOD] }));

  return {
    clock,
    judged,
    archived,
    statusCalls,
    statuses: () => statusCalls.filter((text) => text !== undefined),
    aborts: () => aborts,
  };
}

function prompt($: Engine, text: string, origin: PromptOrigin = PERSON, isMeta = false) {
  if (isMeta) return $.prompt.submit({ text, origin, wait: false, isMeta: true });

  return $.prompt.submit({ text, origin, wait: false });
}

function promptOverTurn($: Engine, text: string, turnId: string) {
  return $.prompt.submit({ text, origin: PERSON, wait: true, turnId });
}

const ANSWERED: TurnCompleteInput = {
  answer: "Renamed the function and the tests pass.",
  durationMs: 1000,
  isAborted: false,
  turnId: "turn-1",
  reason: "answer",
};

async function finishTurn($: Engine, world: World, end: TurnCompleteInput = ANSWERED) {
  await $.turn.complete(end);
  await world.clock.settle();
}

async function bandShown($: Engine, surface: (typeof SURFACES)[number] = "desktop") {
  const ui = await $.ui.mount({ ...BAND, surface });

  return (await ui.find({ type: "Button", key: "archive" })) !== undefined;
}

test("a person's answered turn judged done draws the band, and Archive archives self", async ($, on) => {
  const world = stubEngine(on, {
    verdicts: [DONE, { isAnswered: true, text: " Done.\n", usage: USAGE }],
  });

  for (const [index, surface] of SURFACES.entries()) {
    await prompt($, "Rename parseFoo to parseBar");
    await finishTurn($, world);
    const ui = await $.ui.mount({ ...BAND, surface });

    expect(await ui.find({ type: "Text", text: "Task finished?" })).toBeDefined();
    expect(await ui.find({ type: "Text", text: OTHER_MOD })).toBeDefined();
    expect(world.judged[index]?.prompt).toContain("Rename parseFoo to parseBar");
    expect(world.judged[index]?.prompt).toContain("Renamed the function and the tests pass.");
    await ui.press({ key: "archive" });
    expect(world.archived[index]).toBe(
      JSON.stringify({ session_id: "self", reason: "wrap-archive: task finished" }),
    );
    await prompt($, "reset for the next surface");
  }
});

test("not_done, unexpected text or no answer draw no band; an api-error adds one status line", async ($, on) => {
  const verdicts: ModelCompleteResult[] = [
    NOT_DONE,
    { isAnswered: true, text: "Done! The task is complete.", usage: USAGE },
    { isAnswered: false, reason: "empty-reply", usage: USAGE },
    { isAnswered: false, reason: "api-error", status: 529, error: "overloaded", usage: USAGE },
  ];

  const world = stubEngine(on, { verdicts });

  for (const [index] of verdicts.entries()) {
    await prompt($, "Fix the flaky test");
    await finishTurn($, world);
    expect(world.judged).toHaveLength(index + 1);
    expect(await bandShown($)).toBe(false);
  }

  expect(world.judged).toHaveLength(verdicts.length);
  expect(world.statuses()).toEqual(["wrap-archive: the judge failed (overloaded, status 529)"]);
});

test("an aborted, refused or failed turn makes no judge call", async ($, on) => {
  const world = stubEngine(on);

  const ends: TurnCompleteInput[] = [
    { ...ANSWERED, reason: "aborted", isAborted: true },
    { ...ANSWERED, reason: "refusal", refusal: { category: null, explanation: null } },
    { ...ANSWERED, reason: "error" },
  ];

  await prompt($, "Do the thing");

  for (const end of ends) await finishTurn($, world, end);
  expect(world.judged).toHaveLength(0);
  expect(await bandShown($)).toBe(false);
});

test("a subagent's turn makes no judge call", async ($, on) => {
  const world = stubEngine(on);

  await prompt($, "Explore the repository");
  await finishTurn($, world, { ...ANSWERED, agentId: "agent-1" });
  expect(world.judged).toHaveLength(0);
});

test("a turn prompted by a schedule, a task notification, a plugin or an isMeta delivery makes no judge call", async ($, on) => {
  const world = stubEngine(on);

  const sources: [PromptOrigin, boolean][] = [
    [{ kind: "scheduled-trigger" }, false],
    [{ kind: "task-notification" }, false],
    [{ kind: "plugin", name: "other" }, false],
    [PERSON, true],
  ];

  for (const [origin, isMeta] of sources) {
    await prompt($, "automated", origin, isMeta);
    await finishTurn($, world);
  }

  expect(world.judged).toHaveLength(0);
});

test("after Keep a task-notification turn is not judged; a person's prompt rearms the offer", async ($, on) => {
  const world = stubEngine(on);

  await prompt($, "Write the changelog");
  await finishTurn($, world);
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });

  await ui.press({ key: "keep" });
  expect(await ui.find({ type: "Button", key: "archive" })).toBeUndefined();
  await prompt($, "task finished", { kind: "task-notification" });
  await finishTurn($, world);
  expect(world.judged).toHaveLength(1);
  expect(await bandShown($)).toBe(false);
  await prompt($, "Also update the README");
  await finishTurn($, world);
  expect(world.judged).toHaveLength(2);
  expect(await bandShown($)).toBe(true);
});

test("a person's prompt while judging aborts the judge and draws no band", async ($, on) => {
  const world = stubEngine(on, { judgeDelayMs: 5000 });

  await prompt($, "Bump the dependency");
  await finishTurn($, world);
  expect(world.judged).toHaveLength(1);
  await prompt($, "Wait, also run the tests");
  await world.clock.advance(5000);
  expect(world.aborts()).toBe(1);
  expect(await bandShown($)).toBe(false);
});

test("a person's prompt during the first turn's probe withdraws that judgment; the next turn is judged", async ($, on) => {
  const world = stubEngine(on, { probeDelayMs: 2000 });

  await prompt($, "Bump the dependency");
  await $.turn.complete(ANSWERED);
  await prompt($, "Wait, also run the tests");
  await world.clock.advance(2000);
  expect(world.judged).toHaveLength(0);
  expect(await bandShown($)).toBe(false);
  await finishTurn($, world, { ...ANSWERED, turnId: "turn-2", answer: "Bumped; tests pass." });
  expect(world.judged).toHaveLength(1);
  expect(world.judged[0]?.prompt).toContain("Wait, also run the tests");
  expect(world.judged[0]?.prompt).not.toContain("Bump the dependency");
  expect(await bandShown($)).toBe(true);
});

test("a person's prompt typed over a running turn joins the request that turn is judged on", async ($, on) => {
  const world = stubEngine(on);

  await prompt($, "Rename parseFoo to parseBar");
  await promptOverTurn($, "Also run the tests", "turn-1");
  await finishTurn($, world);
  expect(world.judged).toHaveLength(1);
  expect(world.judged[0]?.prompt).toContain("Rename parseFoo to parseBar\n\nAlso run the tests");
  expect(await bandShown($)).toBe(true);
});

test("the band stays hidden while a model turn runs", async ($, on) => {
  const world = stubEngine(on);

  await prompt($, "Format the files");
  await finishTurn($, world);

  const ui = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, isWorking: true },
    surface: "desktop",
  });

  expect(await ui.find({ type: "Button", key: "archive" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: OTHER_MOD })).toBeDefined();
  expect(await bandShown($)).toBe(true);
});

test("two presses on Archive make one archive call", async ($, on) => {
  const world = stubEngine(on);

  await prompt($, "Delete the dead code");
  await finishTurn($, world);
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });

  await Promise.allSettled([ui.press({ key: "archive" }), ui.press({ key: "archive" })]);
  expect(world.archived).toHaveLength(1);
});

test("a person's prompt while offering hides the band", async ($, on) => {
  const world = stubEngine(on);

  await prompt($, "Format the files");
  await finishTurn($, world);
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });

  expect(await ui.find({ type: "Button", key: "archive" })).toBeDefined();
  await prompt($, "One more thing");
  await ui.redraw();
  expect(await ui.find({ type: "Button", key: "archive" })).toBeUndefined();
});

test("an archive refusal goes quiet with its text as the status line, cleared at the next prompt", async ($, on) => {
  const world = stubEngine(on);

  await prompt($, "Delete the dead code");
  await finishTurn($, world);
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });

  await ui.press({ key: "archive" });
  expect(await ui.find({ type: "Button", key: "archive" })).toBeUndefined();
  expect(world.statuses()).toEqual([`wrap-archive: ${REFUSAL}`]);
  await finishTurn($, world);
  expect(world.judged).toHaveLength(1);
  await prompt($, "Next task");
  expect(world.statusCalls.at(-1)).toBeUndefined();
});

test("a session the archive tool cannot reach makes no judge call", async ($, on) => {
  const world = stubEngine(on, { isReachable: false });

  for (const text of ["First task", "Second task"]) {
    await prompt($, text);
    await finishTurn($, world);
  }

  expect(world.judged).toHaveLength(0);
  expect(world.statuses()).toEqual([]);
  expect(await bandShown($)).toBe(false);
});
