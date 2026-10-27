import type { On, SessionMessage } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";

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

const SURFACES = ["terminal", "desktop"] as const;

type World = {
  /** The prompts the mod submitted, in order. */
  readonly prompts: string[];
  /** How many times the mod opened its pane. */
  readonly opens: () => number;
  /** The props each drawing the engine made beneath the plugin received. */
  readonly drawn: unknown[];
  /** The conversation the session holds, as `$.session.messages()` answers it. */
  readonly messages: SessionMessage[];
  /** The files the mod wrote, by path. */
  readonly files: Map<string, string>;
};

const STATE = "/work/.claude/griller/session-1.json";

const TRANSCRIPT = "/work/.claude/griller/session-1.md";

const JOURNAL = "/work/.claude/griller/session-1.jsonl";

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
  let opens = 0;

  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("prompt.submit", (_$, e) => {
    prompts.push(e.text);

    return { text: e.text };
  });
  on("ui.open", () => {
    opens += 1;

    return { value: { isPlaced: true } };
  });
  on("ui.close", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("clock.now", () => ({ value: Date.UTC(2026, 0, 1) }));
  on("ui.render", (engine, e) => {
    drawn.push(e.props);
    const { Box } = engine.ui.resolve(e);

    return Box({ key: "engine" });
  });
  on("session.messages", () => ({ value: messages }));
  on("session.root", () => ({ value: "/work" }));
  on("session.id", () => ({ value: "session-1" }));
  on("fs.exists", (_$, e) => ({ value: files.has(e.path) }));
  on("fs.read", (_$, e) => ({ value: files.get(e.path) ?? "" }));
  on("fs.write", (_$, e) => {
    files.set(e.path, e.text);

    return { value: undefined };
  });
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("session.start", () => ({ cwd: "/work" }));
  await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" });

  return { prompts, opens: () => opens, drawn, messages, files };
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
function waiting(): Map<string, string> {
  const questions = [
    ["Which database?", "Postgres", ""],
    ["Who owns the migration?", "The platform team", ""],
    ["When does it ship: **(a)** this sprint, or **(b)** the one after?", "Next sprint", "(a)"],
  ].map(([question, recommendation, answer], at) => ({
    question: `**Q${at + 1}** - ${question}`,
    recommendation,
    n: at + 1,
    answer,
    draft: "",
    isShown: false,
  }));

  return new Map([[STATE, JSON.stringify({ last: 3, sent: [], open: questions })]]);
}

test("a reload brings back the round nobody answered, with the answers recorded", async ($, on) => {
  const world = await started($, on, [], waiting());

  expect(world.opens()).toBe(1);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await ui.find({ key: "question-2" }))?.text).toContain("Who owns the migration?");
  expect((await ui.find({ key: "choice-3-a" }))?.props.variant).toBe("primary");
  await ui.unmount();
});

test("a round already sent is not brought back by a reload", async ($, on) => {
  const files = new Map([[STATE, JSON.stringify({ last: 3, sent: [], open: null })]]);

  // The answers wait in the queue for Claude's turn: the conversation does not hold them yet.
  const world = await started(
    $,
    on,
    [message("user", "/griller:grill"), message("assistant", ROUND)],
    files,
  );

  expect(world.opens()).toBe(0);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await ui.find({ type: "Text" }))?.text).toBe("No round is waiting for your answers.");
  await ui.unmount();
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

/** A line of the journal, as the mod writes it. */
type Logged = {
  readonly at: string;
  readonly kind: string;
  readonly q?: number;
  readonly text?: string;
  readonly questions?: readonly number[];
};

/** The journal's lines, without their timestamps. */
function eventsIn(world: World): Omit<Logged, "at">[] {
  return (world.files.get(JOURNAL) ?? "")
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
    { kind: "draft", q: 1, text: "MySQL" },
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

test("the transcript holds each question, Claude's answer and the final one, and nothing else", async ($, on) => {
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
  await ui.input({ key: "answer-2", text: "Ops", kind: "submit" });
  await ui.press({ key: "send" });
  await ui.unmount();

  expect(world.files.get(TRANSCRIPT)).toBe(
    [
      "# Grill",
      "",
      "---",
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
      "**Answer:** Ops",
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
});
