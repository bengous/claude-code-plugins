import type { On, SessionMessage } from "claude-code";
import { type Engine, expect, type Plugin, test } from "claude-code/testing";

const PLUGIN = "griller";

const ROUND = [
  "First round.",
  "",
  "❓ **Q1** - **Database**: Which database?",
  "",
  "➡️ Postgres",
  "",
  "---",
  "",
  "❓ **Q2** - **Owner**: Who owns the migration?",
  "",
  "➡️ The platform team,",
  "with the DBA on call.",
  "",
  "---",
  "",
  "❓ **Q3** - **Date**: When does it ship: **(a)** this sprint, or **(b)** the one after?",
  "",
  "➡️ Next sprint",
  "",
  "---",
].join("\n");

const RECOMMENDATIONS = /Postgres|platform team|DBA|Next sprint/u;

const PANE = {
  plugin: PLUGIN,
  component: "Pane",
  requestId: PLUGIN,
  props: {
    title: "Grill",
    isFocused: true,
    bodyColumns: 80,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

/** The band above the prompt, where a round goes when its pane is not placed. */
const BAND = {
  plugin: PLUGIN,
  surface: "terminal",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 40,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

const SURFACES = ["terminal", "desktop"] as const;

type World = {
  /** The prompts the mod submitted, in order. */
  readonly prompts: string[];
  /** How many times the mod opened its pane. */
  readonly opens: () => number;
  /** How many times the mod closed its pane. */
  readonly closes: () => number;
  /** Whether the pane's next opens are placed: a narrow terminal leaves an unasked one undrawn. */
  readonly place: (isPlaced: boolean) => void;
  /** Why each of the next prompts is dropped, one per prompt, as a mod refusing it does. */
  readonly drops: string[];
  /** The toasts the mod raised, in order. */
  readonly toasts: string[];
  /** Points `$.session.id()` at another session, as a /clear or a resume does. */
  readonly moveTo: (id: string) => void;
  /** The props each drawing the engine made beneath the plugin received. */
  readonly drawn: unknown[];
  /** The conversation the session holds, as `$.session.messages()` answers it. */
  readonly messages: SessionMessage[];
  /** The files the mod wrote, by path. */
  readonly files: Map<string, string>;
  /** How many of the next writes to a path reject, as a file over 4 MiB does. */
  readonly failing: Map<string, number>;
  /** Holds the next write to the path until the test releases it. */
  readonly holdWrite: (path: string) => Hold;
  /** Holds the next read of the clock until the test releases it. */
  readonly holdClock: () => Hold;
};

/** A call the test holds: `reached` once it comes, and it goes on once `release` is called. */
type Hold = { readonly reached: Promise<void>; readonly release: () => void };

const STATE = "/work/.claude/griller/session-1.json";

const TRANSCRIPT = "/work/.claude/griller/session-1.md";

const JOURNAL = "/work/.claude/griller/session-1.jsonl";

/** The files of the session that takes the process after a /clear or a resume. */
const OTHER = {
  state: "/work/.claude/griller/session-2.json",
  transcript: "/work/.claude/griller/session-2.md",
  journal: "/work/.claude/griller/session-2.jsonl",
} as const;

function message(role: SessionMessage["role"], text: string): SessionMessage {
  return { role, text, toolUses: [] };
}

async function started(
  $: Engine,
  on: On,
  held: readonly SessionMessage[] = [],
  files = new Map<string, string>(),
): Promise<World> {
  const messages = [...held];
  const prompts: string[] = [];
  const drawn: unknown[] = [];
  const failing = new Map<string, number>();
  const holds = new Map<string, () => Promise<void>>();
  let opens = 0;
  let closes = 0;
  let isPlaced = true;
  const drops: string[] = [];
  const toasts: string[] = [];
  let id = "session-1";

  const holding = (call: string): Hold => {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();

    holds.set(call, () => {
      holds.delete(call);
      reached.resolve();

      return released.promise;
    });

    return { reached: reached.promise, release: () => released.resolve() };
  };

  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("prompt.submit", (_$, e) => {
    const drop = drops.shift();

    if (drop !== undefined) return { drop };
    prompts.push(e.text);

    return { text: e.text };
  });
  on("ui.open", () => {
    opens += 1;

    return { value: isPlaced ? { isPlaced } : { isPlaced, reason: "narrow terminal" } };
  });
  on("ui.close", () => {
    closes += 1;

    return { value: undefined };
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);

    return { value: undefined };
  });
  on("clock.now", async () => {
    await holds.get("clock.now")?.();

    return { value: Date.UTC(2026, 0, 1) };
  });
  on("clock.sleep", () => ({ value: undefined }));
  on("ui.focus", () => ({}));
  on("ui.render", (engine, e) => {
    drawn.push(e.props);
    const { Box } = engine.ui.resolve(e);

    return Box({ key: "engine" });
  });
  on("session.messages", () => ({ value: messages }));
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: id }));
  on("fs.exists", (_$, e) => ({ value: files.has(e.path) }));
  on("fs.read", (_$, e) => ({ value: files.get(e.path) ?? "" }));
  on("fs.write", async (_$, e) => {
    await holds.get(e.path)?.();
    const left = failing.get(e.path) ?? 0;

    if (left > 0) {
      failing.set(e.path, left - 1);

      return { deny: `${e.path}: over 4 MiB` };
    }

    files.set(e.path, e.text);

    return { value: undefined };
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("session.start", () => ({ cwd: "/work" }));
  on("classic.SessionStart", () => ({}));
  await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" });

  return {
    prompts,
    opens: () => opens,
    closes: () => closes,
    place: (next) => {
      isPlaced = next;
    },
    drops,
    toasts,
    moveTo: (next) => {
      id = next;
    },
    drawn,
    messages,
    files,
    failing,
    holdWrite: holding,
    holdClock: () => holding("clock.now"),
  };
}

/** Claude's turn ends on this reply. */
async function ended($: Engine, answer: string) {
  await $.turn.complete({
    answer,
    durationMs: 1,
    isAborted: false,
    turnId: "turn-1",
    reason: "answer",
  });
}

/** The text the engine was handed to draw for a reply, once the plugin drew it. */
async function drawnReply($: Engine, world: World, surface: "terminal" | "desktop", text: string) {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: "AssistantMessage",
    requestId: "message-1",
    props: { text, isFirstOfReply: true },
  });

  await ui.unmount();

  // SAFETY: the last drawing the engine made is this reply's, whose props carry its text.
  return (world.drawn.at(-1) as { text: string }).text;
}

test("a reply's recommendations are hidden in the chat, while it streams too", async ($, on) => {
  const world = await started($, on);
  const streaming = ROUND.slice(0, ROUND.indexOf("with the DBA") + "with the".length);

  for (const surface of SURFACES) {
    const whole = await drawnReply($, world, surface, ROUND);

    expect(whole).toContain("Which database?");
    expect(whole).toContain("When does it ship");
    expect(whole).not.toMatch(RECOMMENDATIONS);

    const cut = await drawnReply($, world, surface, streaming);

    expect(cut).toContain("Who owns the migration?");
    expect(cut).not.toMatch(/platform team|with the/u);
  }

  const plain = "Use the ➡️ arrow key to move.";

  expect(await drawnReply($, world, "desktop", plain)).toBe(plain);
});

test("a turn that ends on a round opens it in the pane, recommendations hidden", async ($, on) => {
  const world = await started($, on);

  await ended($, "No round here.");
  expect(world.opens()).toBe(0);

  await ended($, ROUND);
  expect(world.opens()).toBe(1);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });

    expect((await ui.find({ key: "question-1" }))?.text).toContain("Which database?");
    expect((await ui.find({ key: "question-3" }))?.text).toContain("When does it ship");
    expect(await ui.find({ text: RECOMMENDATIONS })).toBeUndefined();
    expect((await ui.find({ key: "toggle-1" }))?.text).toBe("Peek at Claude's");
    expect(await ui.find({ key: "send" })).toBeUndefined();
    expect(await ui.find({ key: "drop" })).toBeUndefined();
    await ui.unmount();
  }
});

test("a round followed by a tool call in the same turn still opens", async ($, on) => {
  const world = await started($, on);

  world.messages.push(
    message("user", "/griller:grill the migration"),
    message("assistant", ROUND),
    message("assistant", ""),
  );
  await ended($, "");
  expect(world.opens()).toBe(1);
});

/** The round after `ROUND`, its questions numbered by Claude after the first round's. */
const NEXT = ["❓ **Q4** - **Backups**: Who restores a backup?", "", "➡️ The DBA", "", "---"].join(
  "\n",
);

/** Every question of the round answered with the recommendation hidden, then sent. */
async function answeredAndSent($: Engine, count: number) {
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  for (let n = 1; n <= count; n += 1) {
    await ui.input({ key: `answer-${n}`, text: `answer ${n}`, kind: "submit" });
  }

  await ui.press({ key: "send" });
  await ui.unmount();
}

/** The scribe's state for a session whose first round waits, its third question answered (a). */
function waiting(state = STATE): Map<string, string> {
  const questions = [
    ["Which database?", "Postgres", ""],
    ["Who owns the migration?", "The platform team", ""],
    ["When does it ship: **(a)** this sprint, or **(b)** the one after?", "Next sprint", "(a)"],
  ].map(([question, recommendation, answer], at) => ({
    question: `**Q${at + 1}** - ${question}`,
    recommendation,
    n: at + 1,
    answer,
    isShown: false,
    isTaken: false,
  }));

  return new Map([[state, JSON.stringify({ last: 3, closed: [], open: questions })]]);
}

test("a reload brings back the round nobody answered, with the answers recorded", async ($, on) => {
  const world = await started($, on, [], waiting());

  expect(world.opens()).toBe(1);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await ui.find({ key: "question-2" }))?.text).toContain("Who owns the migration?");
  expect((await ui.find({ key: "choice-3-a" }))?.props.variant).toBe("primary");
  await ui.unmount();
});

/** The mod reloaded: its variables go, and `session.start` gives them back from the saved state. */
async function reloaded($: Engine) {
  await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" });
}

test("a round brought back holds the answers recorded, and nothing typed and not recorded", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.input({ key: "answer-1", text: "MySQL", kind: "change" });
  await ui.input({ key: "answer-2", text: "Ops", kind: "submit" });
  await ui.input({ key: "answer-2", text: "Ops team", kind: "change" });
  await ui.press({ key: "choice-3-a" });
  await ui.unmount();

  expect(world.files.get(STATE)).not.toMatch(/MySQL|Ops team/u);

  await switched($, world, "session-2", "resume");
  await switched($, world, "session-1", "resume");
  const pane = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await pane.find({ key: "answer-1" }))?.props.value).toBe("");
  expect((await pane.find({ key: "answer-2" }))?.props.value).toBe("Ops");
  expect((await pane.find({ key: "answer-3" }))?.props.value).toBe("");
  await pane.unmount();
});

test("a round already sent is not brought back by a reload", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  await answeredAndSent($, 3);
  // The answers wait in the queue for Claude's turn: the conversation does not hold them yet.
  world.messages.push(message("user", "/griller:grill"), message("assistant", ROUND));
  await reloaded($);

  expect(world.opens()).toBe(1);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await ui.find({ type: "Text" }))?.text).toBe("No round is waiting for your answers.");
  await ui.unmount();
});

test("a state file cut short by a killed write is left as it is with the transcript, and the mod says so", async ($, on) => {
  const cut = '{\n  "last": 3,\n  "sent": [\n    [\n      {\n        "question": "**Q1**';

  const transcript =
    "# Grill\n\n**Q1** - Which database?\n\n**Claude:** Postgres\n\n**Answer:** MySQL\n";

  const journal = `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", kind: "send", questions: [1, 2, 3] })}\n`;

  const world = await started(
    $,
    on,
    [],
    new Map([
      [STATE, cut],
      [TRANSCRIPT, transcript],
      [JOURNAL, journal],
    ]),
  );

  expect(world.toasts).toEqual([expect.stringContaining(`${STATE} could not be read`)]);

  await ended($, NEXT);
  await answeredAndSent($, 1);

  expect(world.prompts).toEqual(["Grill answers:\nQ4: answer 1"]);
  expect(world.files.get(STATE)).toBe(cut);
  expect(world.files.get(TRANSCRIPT)).toBe(transcript);
  expect(eventsIn(world)).toEqual([
    { kind: "send", questions: [1, 2, 3] },
    { kind: "open", questions: [4] },
    { kind: "answer", q: 4, text: "answer 1" },
    { kind: "send", questions: [4] },
  ]);
});

test("the scribe's folder keeps itself out of git", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  expect(world.files.get("/work/.claude/griller/.gitignore")).toBe("*\n");
  expect(world.files.has(STATE)).toBe(true);
});

test("a press on Peek reveals that one recommendation, and Hide hides it", async ($, on) => {
  await started($, on);
  await ended($, ROUND);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });

    await ui.press({ key: "toggle-2" });
    expect((await ui.find({ key: "recommendation-2" }))?.text).toBe(
      "The platform team,\nwith the DBA on call.",
    );
    expect(await ui.find({ text: /Postgres|Next sprint/u })).toBeUndefined();
    expect((await ui.find({ key: "toggle-2" }))?.text).toBe("Hide");

    await ui.press({ key: "toggle-2" });
    expect(await ui.find({ text: /platform team/u })).toBeUndefined();
    await ui.unmount();
  }
});

test("an answer recorded with Enter keeps the recommendation hidden; typing alone records nothing", async ($, on) => {
  await started($, on);
  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.input({ key: "answer-1", text: "MySQL", kind: "change" });
  expect((await ui.find({ type: "Text", text: /answered/u }))?.text).toBe(
    "0 of 3 answered · 0 used Claude's",
  );

  await ui.input({ key: "answer-1", text: "MySQL", kind: "submit" });
  expect((await ui.find({ key: "answer-1" }))?.props.submitLabel).toBe("Update");
  expect(await ui.find({ text: RECOMMENDATIONS })).toBeUndefined();
  expect(await ui.find({ key: "take-1" })).toBeUndefined();
  expect((await ui.find({ key: "toggle-1" }))?.text).toBe("Peek at Claude's");
  await ui.unmount();
});

test("a picked choice records the answer and keeps the recommendation hidden", async ($, on) => {
  await started($, on);
  await ended($, ROUND);

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });

    expect(await ui.find({ key: "choice-1-a" })).toBeUndefined();
    expect((await ui.find({ key: "choice-3-a" }))?.text).toBe("(a)");
    expect((await ui.find({ key: "choice-3-b" }))?.text).toBe("(b)");
    await ui.unmount();
  }

  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.press({ key: "choice-3-b" });
  expect((await ui.find({ key: "choice-3-b" }))?.props.variant).toBe("primary");
  expect(await ui.find({ text: RECOMMENDATIONS })).toBeUndefined();
  expect((await ui.find({ type: "Text", text: /answered/u }))?.text).toBe(
    "1 of 3 answered · 0 used Claude's",
  );
  expect((await ui.find({ key: "answer-3" }))?.props.value).toBe("");
  await ui.unmount();
});

test("the answer that completes the round scrolls the pane to Send, and no edit after it does", async ($, on) => {
  const world = await started($, on);

  // The kit answers no module's `$.ui.scroll`: each scroll shows as the toast its failure raises.
  const scrolls = () =>
    world.toasts.filter((text) => text.includes("Send could not be scrolled to"));

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.input({ key: "answer-1", text: "MySQL", kind: "submit" });
  await ui.input({ key: "answer-2", text: "The DBA", kind: "submit" });
  expect(scrolls()).toHaveLength(0);

  await ui.press({ key: "choice-3-a" });
  expect(scrolls()).toHaveLength(1);

  await ui.input({ key: "answer-1", text: "SQLite", kind: "submit" });
  await ui.press({ key: "choice-3-b" });
  await ui.press({ key: "toggle-2" });
  await ui.press({ key: "take-2" });
  expect(scrolls()).toHaveLength(1);
  await ui.unmount();
});

test("an answer that matches the recommendation by chance stays the person's own", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.input({ key: "answer-1", text: "Postgres", kind: "submit" });
  expect((await ui.find({ key: "toggle-1" }))?.text).toBe("Peek at Claude's");
  expect(await ui.find({ text: /Using Claude's answer/u })).toBeUndefined();

  // Taken, then recorded again unchanged: still Claude's.
  await ui.press({ key: "toggle-2" });
  await ui.press({ key: "take-2" });
  await ui.input({
    key: "answer-2",
    text: "The platform team,\nwith the DBA on call.",
    kind: "submit",
  });
  await ui.press({ key: "choice-3-a" });
  expect((await ui.find({ type: "Text", text: /answered/u }))?.text).toBe(
    "3 of 3 answered · 1 used Claude's",
  );
  await ui.press({ key: "send" });
  await ui.unmount();

  expect(world.prompts).toEqual(["Grill answers:\nQ1: Postgres\nQ2: your recommendation\nQ3: (a)"]);
  expect(world.files.get(TRANSCRIPT)).toContain("**Answer:** Postgres");
});

/** A line of the journal, as the mod writes it. */
type Logged = {
  readonly at: string;
  readonly kind: string;
  readonly q?: number;
  readonly text?: string;
  readonly questions?: readonly number[];
};

/** The journal's lines, without their timestamps. */
function eventsIn(world: World, journal = JOURNAL): Omit<Logged, "at">[] {
  return (world.files.get(journal) ?? "")
    .trim()
    .split("\n")
    .map((line) => {
      // SAFETY: the mod writes one JSON object per line.
      const { at: _at, ...event } = JSON.parse(line) as Logged;

      return event;
    });
}

test("Send returns the final answers alone, and the journal keeps every gesture", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  // Q1: answered blind, then peeked and taken. Q2: peeked first, then taken. Q3: (a), then a text.
  await ui.input({ key: "answer-1", text: "MySQL", kind: "change" });
  await ui.input({ key: "answer-1", text: "MySQL", kind: "submit" });
  await ui.press({ key: "toggle-1" });
  await ui.press({ key: "take-1" });
  await ui.press({ key: "toggle-2" });
  await ui.press({ key: "take-2" });
  await ui.press({ key: "choice-3-a" });
  await ui.input({ key: "answer-3", text: "Not before the audit", kind: "submit" });
  await ui.press({ key: "send" });
  expect(await ui.find({ key: "send" })).toBeUndefined();
  await ui.unmount();

  expect(world.prompts).toEqual([
    [
      "Grill answers:",
      "Q1: your recommendation",
      "Q2: your recommendation",
      "Q3: Not before the audit",
    ].join("\n"),
  ]);

  expect(eventsIn(world)).toEqual([
    { kind: "open", questions: [1, 2, 3] },
    { kind: "answer", q: 1, text: "MySQL" },
    { kind: "peek", q: 1 },
    { kind: "take", q: 1 },
    { kind: "peek", q: 2 },
    { kind: "take", q: 2 },
    { kind: "choice", q: 3, text: "(a)" },
    { kind: "answer", q: 3, text: "Not before the audit" },
    { kind: "send", questions: [1, 2, 3] },
  ]);
  expect(world.files.get(JOURNAL)).toContain('"at":"2026-01-01T00:00:00.000Z"');

  const after = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect(await after.find({ key: "question-1" })).toBeUndefined();
  await after.unmount();
});

/** The person moving the pane's focus ring onto the element keyed `element`. */
async function focused($: Engine, element: string) {
  await $.ui.focus({
    component: "Pane",
    requestId: PLUGIN,
    plugin: PLUGIN,
    element,
    origin: { kind: "person" },
  });
}

test("the typing in a field is one journal line, written once the field loses the ring or another gesture comes", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
  const journaled = world.files.get(JOURNAL);

  for (const text of ["M", "My", "MySQL"]) {
    await ui.input({ key: "answer-1", text, kind: "change" });
  }

  expect(world.files.get(JOURNAL)).toBe(journaled);

  await focused($, "toggle-1");
  expect(eventsIn(world)).toEqual([
    { kind: "open", questions: [1, 2, 3] },
    { kind: "draft", q: 1, text: "MySQL" },
  ]);

  await ui.input({ key: "answer-2", text: "The platform", kind: "change" });
  await ui.press({ key: "choice-3-a" });
  await ui.unmount();

  expect(eventsIn(world)).toEqual([
    { kind: "open", questions: [1, 2, 3] },
    { kind: "draft", q: 1, text: "MySQL" },
    { kind: "draft", q: 2, text: "The platform" },
    { kind: "choice", q: 3, text: "(a)" },
  ]);
});

/** Every question of the round answered, the pane still mounted for the press on Send. */
async function answered($: Engine, count: number) {
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  for (let n = 1; n <= count; n += 1) {
    await ui.input({ key: `answer-${n}`, text: `answer ${n}`, kind: "submit" });
  }

  return ui;
}

test("a save that fails is tried again before the answers go", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await answered($, 3);

  world.failing.set(JOURNAL, 2);
  await ui.press({ key: "send" });
  await ui.unmount();

  expect(world.prompts).toEqual([
    ["Grill answers:", "Q1: answer 1", "Q2: answer 2", "Q3: answer 3"].join("\n"),
  ]);
  expect(eventsIn(world).at(-1)).toEqual({ kind: "send", questions: [1, 2, 3] });
});

test("a save that keeps failing keeps the answers in the pane with the failure, until Send anyway", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await answered($, 3);

  world.failing.set(JOURNAL, Infinity);
  await ui.press({ key: "send" });

  expect(world.prompts).toEqual([]);
  expect((await ui.find({ key: "question-1" }))?.text).toContain("Which database?");
  expect((await ui.find({ text: /could not be saved/u }))?.text).toContain(
    `${JOURNAL}: over 4 MiB`,
  );
  expect(await ui.find({ key: "send-anyway" })).toBeDefined();
  // SAFETY: the mod writes its state as a `Saved`, here the round back as the one waiting.
  expect((JSON.parse(world.files.get(STATE) ?? "") as { open: unknown }).open).not.toBeNull();

  await ui.press({ key: "send-anyway" });
  await ui.unmount();

  expect(world.prompts).toEqual([
    ["Grill answers:", "Q1: answer 1", "Q2: answer 2", "Q3: answer 3"].join("\n"),
  ]);
  const after = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect(await after.find({ key: "question-1" })).toBeUndefined();
  await after.unmount();
});

/**
 * The kit has no act for the person's close mark, so this plugin closes griller's pane instead:
 * griller's `ui.close` hook hears the same event, but for its origin, which it does not read.
 */
const HAND: Plugin = {
  name: "hand",
  register(on) {
    on("tool.call", { tool: "mcp__hand__close" }, async ($) => {
      await $.ui.close({ id: "griller" });

      return { result: "closed" };
    });
  },
};

/** The person closing the pane with its mark, in a test that loads `HAND`. */
async function closedByHand($: Engine) {
  await $.tool.call({ tool: "mcp__hand__close" });
}

test(
  "a Send refused from the band brings the round back in the pane alone, which the person's close drops",
  { plugins: [HAND] },
  async ($, on) => {
    const world = await started($, on);

    world.place(false);
    await ended($, ROUND);
    const band = await $.ui.mount(BAND);

    for (let n = 1; n <= 3; n += 1) {
      await band.input({ key: `answer-${n}`, text: `answer ${n}`, kind: "submit" });
    }

    expect(await band.find({ key: "drop" })).toBeDefined();
    // The press on Send is the person's, so the pane it opens is placed at any width.
    world.place(true);
    world.drops.push("held by another mod");
    await band.press({ key: "send" });

    expect(world.prompts).toEqual([]);
    expect(world.toasts.at(-1)).toBe("griller: the answers were not sent: held by another mod");
    expect(await band.find({ key: "question-1" })).toBeUndefined();
    const pane = await $.ui.mount({ ...PANE, surface: "desktop" });

    expect((await pane.find({ key: "answer-1" }))?.props.value).toBe("answer 1");
    await pane.unmount();
    await band.unmount();

    await closedByHand($);
    const after = await $.ui.mount({ ...PANE, surface: "desktop" });

    expect((await after.find({ type: "Text" }))?.text).toBe(
      "No round is waiting for your answers.",
    );
    await after.unmount();
  },
);

test("a Send refused while the pane cannot be placed brings the round back in the band", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await answered($, 3);

  world.place(false);
  world.drops.push("held by another mod");
  await ui.press({ key: "send" });
  await ui.unmount();

  expect(world.prompts).toEqual([]);
  const band = await $.ui.mount(BAND);

  expect((await band.find({ key: "answer-1" }))?.props.value).toBe("answer 1");
  await band.unmount();
});

/** The transcript of a session whose one round, `ROUND`, was closed unsent with Q1 answered `MySQL`. */
const ABANDONED = [
  "# Grill",
  "",
  "_Abandoned: not sent to Claude._",
  "",
  "**Q1** - **Database**: Which database?",
  "",
  "**Answer:** MySQL",
  "",
  "**Q2** - **Owner**: Who owns the migration?",
  "",
  "**Answer:** _not answered_",
  "",
  "**Q3** - **Date**: When does it ship: **(a)** this sprint, or **(b)** the one after?",
  "",
  "**Answer:** _not answered_",
  "",
].join("\n");

test(
  "the person's close drops the round unsent, and the transcript keeps it as abandoned",
  { plugins: [HAND] },
  async ($, on) => {
    const world = await started($, on);

    await ended($, ROUND);
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    await ui.input({ key: "answer-1", text: "MySQL", kind: "submit" });
    await ui.unmount();
    await closedByHand($);

    expect(eventsIn(world).at(-1)).toEqual({ kind: "close", questions: [1, 2, 3] });
    expect(world.files.get(TRANSCRIPT)).toBe(ABANDONED);

    await reloaded($);
    expect(world.opens()).toBe(1);

    await ended($, NEXT);
    expect(world.files.get(TRANSCRIPT)).toBe(
      `${ABANDONED}\n---\n\n**Q4** - **Backups**: Who restores a backup?\n\n**Answer:** _not answered yet_\n`,
    );
  },
);

test("in the band, Drop round drops the round unsent, as the pane's close does", async ($, on) => {
  const world = await started($, on);

  world.place(false);
  await ended($, ROUND);
  const band = await $.ui.mount(BAND);

  expect((await band.find({ type: "Text", text: /ctrl\+x/u }))?.text).toBe(
    "ctrl+x then tab to focus",
  );
  await band.input({ key: "answer-1", text: "MySQL", kind: "submit" });
  expect(await band.find({ key: "send" })).toBeUndefined();
  await band.press({ key: "drop" });

  expect(await band.find({ key: "question-1" })).toBeUndefined();
  await band.unmount();
  expect(eventsIn(world).at(-1)).toEqual({ kind: "close", questions: [1, 2, 3] });
  expect(world.files.get(TRANSCRIPT)).toBe(ABANDONED);

  await reloaded($);
  expect(world.opens()).toBe(1);
  const after = await $.ui.mount(BAND);

  expect(await after.find({ key: "question-1" })).toBeUndefined();
  await after.unmount();
});

test("in the band, Enter on an empty field records nothing and keeps the round", async ($, on) => {
  const world = await started($, on);

  world.place(false);
  await ended($, ROUND);
  const band = await $.ui.mount(BAND);

  // A choice leaves its field empty: the Enter that follows by reflex must not lose the round.
  await band.press({ key: "choice-3-a" });
  await band.input({ key: "answer-3", text: "", kind: "submit" });

  expect((await band.find({ type: "Text", text: /answered/u }))?.text).toBe(
    "1 of 3 answered · 0 used Claude's",
  );
  await band.unmount();
  expect(eventsIn(world).at(-1)).toEqual({ kind: "choice", q: 3, text: "(a)" });
});

test("a gesture noted as the last write of the one before ends is written too", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  // The second gesture's note ends a few ticks after the first one's last write: at some count it
  // falls between the writer's last look at what is left and its letting go.
  for (let ticks = 0; ticks <= 8; ticks += 1) {
    const write = world.holdWrite(JOURNAL);
    const first = ui.press({ key: "toggle-1" });

    await write.reached;
    const clock = world.holdClock();
    const second = ui.press({ key: "toggle-2" });

    await clock.reached;
    write.release();

    for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
    clock.release();
    await Promise.all([first, second]);

    expect(eventsIn(world).at(-1), `${ticks} ticks apart`).toEqual({
      kind: ticks % 2 === 0 ? "peek" : "hide",
      q: 2,
    });
  }

  await ui.unmount();
});

test("the transcript holds each question, Claude's answer and the final one, and nothing else twice", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.input({ key: "answer-1", text: "MySQL", kind: "submit" });
  await ui.press({ key: "toggle-1" });
  await ui.input({ key: "answer-1", text: "SQLite", kind: "submit" });

  // While the round waits, the file beside the pane gives no recommendation away.
  const pending = world.files.get(TRANSCRIPT) ?? "";

  expect(pending).toContain("**Answer:** SQLite");
  expect(pending).not.toMatch(RECOMMENDATIONS);

  await ui.press({ key: "choice-3-b" });
  await ui.press({ key: "toggle-2" });
  await ui.press({ key: "take-2" });
  await ui.press({ key: "send" });
  await ui.unmount();

  expect(world.files.get(TRANSCRIPT)).toBe(
    [
      "# Grill",
      "",
      "**Q1** - **Database**: Which database?",
      "",
      "**Claude:** Postgres",
      "",
      "**Answer:** SQLite",
      "",
      "**Q2** - **Owner**: Who owns the migration?",
      "",
      "**Claude:** The platform team,\nwith the DBA on call.",
      "",
      "**Answer:** Claude's",
      "",
      "**Q3** - **Date**: When does it ship: **(a)** this sprint, or **(b)** the one after?",
      "",
      "**Claude:** Next sprint",
      "",
      "**Answer:** (b)",
      "",
    ].join("\n"),
  );
});

test("questions keep the numbers Claude gave them, and an unnumbered one follows the last", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  await answeredAndSent($, 3);
  world.messages.push(message("user", world.prompts[0] ?? ""));
  await ended($, NEXT);
  await answeredAndSent($, 1);
  world.messages.push(message("user", world.prompts[1] ?? ""));
  await ended($, "❓ **Rollback**: Who decides a rollback?\n\n➡️ The on-call lead\n\n---");
  await answeredAndSent($, 1);

  expect(world.prompts.slice(1)).toEqual([
    "Grill answers:\nQ4: answer 1",
    "Grill answers:\nQ5: answer 1",
  ]);

  // One rule between two rounds, none under the title.
  expect(world.files.get(TRANSCRIPT)?.split("\n---\n")).toHaveLength(3);
});

/** `ROUND` asked again after the person asked Claude a question instead of sending: Q3 reworded. */
const RESTATED = ROUND.replace(
  "When does it ship: **(a)** this sprint, or **(b)** the one after?",
  "Which sprint ships it: **(a)** this one, or **(b)** the next?",
);

test("a round asked while another waits closes it unsent, and each question asked again unchanged keeps its answer", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.input({ key: "answer-1", text: "MySQL", kind: "submit" });
  await ui.press({ key: "toggle-2" });
  await ui.press({ key: "take-2" });
  await ui.press({ key: "choice-3-a" });
  await ui.unmount();

  await ended($, RESTATED);
  const pane = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await pane.find({ key: "question-3" }))?.text).toContain("Which sprint ships it");
  expect((await pane.find({ key: "answer-1" }))?.props.value).toBe("MySQL");
  expect((await pane.find({ key: "answer-1" }))?.props.submitLabel).toBe("Update");
  expect(await pane.find({ text: /Using Claude's answer/u })).toBeDefined();
  expect((await pane.find({ key: "choice-3-a" }))?.props.variant).toBeUndefined();
  expect((await pane.find({ type: "Text", text: /answered/u }))?.text).toBe(
    "2 of 3 answered · 1 used Claude's",
  );
  await pane.unmount();

  expect(eventsIn(world).slice(-2)).toEqual([
    { kind: "close", questions: [1, 2, 3] },
    { kind: "open", questions: [1, 2, 3] },
  ]);
  expect(world.files.get(TRANSCRIPT)).toBe(
    [
      "# Grill",
      "",
      "_Abandoned: not sent to Claude._",
      "",
      "**Q1** - **Database**: Which database?",
      "",
      "**Answer:** MySQL",
      "",
      "**Q2** - **Owner**: Who owns the migration?",
      "",
      "**Answer:** Claude's",
      "",
      "**Q3** - **Date**: When does it ship: **(a)** this sprint, or **(b)** the one after?",
      "",
      "**Answer:** (a)",
      "",
      "---",
      "",
      "**Q1** - **Database**: Which database?",
      "",
      "**Answer:** MySQL",
      "",
      "**Q2** - **Owner**: Who owns the migration?",
      "",
      "**Answer:** Claude's",
      "",
      "**Q3** - **Date**: Which sprint ships it: **(a)** this one, or **(b)** the next?",
      "",
      "**Answer:** _not answered yet_",
      "",
    ].join("\n"),
  );
});

test("a question asked again with a new recommendation keeps the answer taken from the old one as the person's own", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.press({ key: "toggle-2" });
  await ui.press({ key: "take-2" });
  await ui.unmount();

  await ended($, ROUND.replace("➡️ The platform team,\nwith the DBA on call.", "➡️ The DBA alone"));
  const pane = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await pane.find({ key: "answer-2" }))?.props.value).toBe(
    "The platform team,\nwith the DBA on call.",
  );
  expect(await pane.find({ text: /Using Claude's answer/u })).toBeUndefined();
  expect((await pane.find({ type: "Text", text: /answered/u }))?.text).toBe(
    "1 of 3 answered · 0 used Claude's",
  );
  await pane.unmount();
  expect(world.files.get(TRANSCRIPT)).toMatch(
    /Who owns the migration\?\n\n\*\*Answer:\*\* The platform team,\nwith the DBA on call\.\n\n\*\*Q3\*\*[^\n]*\n\n\*\*Answer:\*\* _not answered yet_\n$/u,
  );
});

/**
 * Session `id` takes the process as the engine puts it there: `classic.SessionStart`, and no
 * `session.start`. A /clear answers the new id from `$.session.id()` at once, a resume only once
 * its command is over (docs/plugin-testing/hook-runtime.md).
 */
async function switched($: Engine, world: World, id: string, source: "clear" | "resume") {
  if (source === "clear") world.moveTo(id);
  await $.classic.SessionStart({ source, session_id: id });
  world.moveTo(id);
}

/** The files of session-1 as they stand now. */
function firstSessionFiles(world: World): Map<string, string> {
  return new Map([...world.files].filter(([path]) => path.includes("/session-1.")));
}

test("after a /clear the old round leaves the pane, and nothing of the old conversation is written under the new id", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  await answeredAndSent($, 3);
  world.messages.push(message("user", world.prompts[0] ?? ""));
  await ended($, NEXT);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.input({ key: "answer-1", text: "The DBA on", kind: "change" });
  await ui.unmount();
  const before = firstSessionFiles(world);
  const closed = world.closes();

  await switched($, world, "session-2", "clear");
  world.messages.splice(0);
  expect(world.closes()).toBe(closed + 1);

  const pane = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await pane.find({ type: "Text" }))?.text).toBe("No round is waiting for your answers.");
  await pane.unmount();

  await ended($, "❓ **Rollback**: Who decides a rollback?\n\n➡️ The on-call lead\n\n---");
  await answeredAndSent($, 1);

  expect(world.prompts.at(-1)).toBe("Grill answers:\nQ1: answer 1");
  expect(eventsIn(world, OTHER.journal)).toEqual([
    { kind: "open", questions: [1] },
    { kind: "answer", q: 1, text: "answer 1" },
    { kind: "send", questions: [1] },
  ]);
  expect(world.files.get(OTHER.transcript)).not.toMatch(/Which database|Who restores/u);
  expect(firstSessionFiles(world)).toEqual(before);
});

test("a resume reopens the resumed session's own waiting round, and leaves the other session's files as they were", async ($, on) => {
  const world = await started($, on, [], waiting(OTHER.state));

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.press({ key: "choice-3-b" });
  await ui.unmount();
  const before = firstSessionFiles(world);

  await switched($, world, "session-2", "resume");
  expect(world.opens()).toBe(2);

  const pane = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await pane.find({ key: "choice-3-a" }))?.props.variant).toBe("primary");
  expect((await pane.find({ key: "choice-3-b" }))?.props.variant).toBeUndefined();
  await pane.unmount();

  expect(eventsIn(world, OTHER.journal)).toEqual([{ kind: "reopen", questions: [1, 2, 3] }]);
  expect(firstSessionFiles(world)).toEqual(before);
});
