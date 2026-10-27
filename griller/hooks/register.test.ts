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
};

function message(role: SessionMessage["role"], text: string): SessionMessage {
  return { role, text, toolUses: [] };
}

async function started($: Engine, on: On, held: readonly SessionMessage[] = []): Promise<World> {
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
  on("ui.render", (engine, e) => {
    drawn.push(e.props);
    const { Box } = engine.ui.resolve(e);

    return Box({ key: "engine" });
  });
  on("session.messages", () => ({ value: messages }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("session.start", () => ({ cwd: "/work" }));
  await $.session.start({ surface: "desktop", isInteractive: true, cwd: "/work" });

  return { prompts, opens: () => opens, drawn, messages };
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

test("a reload brings back the round nobody answered, and only that one", async ($, on) => {
  const waiting = await started($, on, [
    message("user", "/griller:grill the migration"),
    message("assistant", ROUND),
  ]);

  expect(waiting.opens()).toBe(1);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await ui.find({ key: "question-2" }))?.text).toContain("Who owns the migration?");
  await ui.unmount();
});

test("a round the user already answered is not brought back", async ($, on) => {
  const answered = await started($, on, [
    message("user", "/griller:grill the migration"),
    message("assistant", ROUND),
    message("user", "Grill answers:\nQ1: MySQL (recommendation not seen)"),
  ]);

  expect(answered.opens()).toBe(0);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect((await ui.find({ type: "Text" }))?.text).toBe("No round is waiting for your answers.");
  await ui.unmount();
});

test("a press on Show reveals that one recommendation, and Hide hides it", async ($, on) => {
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

test("an answer sent with Enter reveals its recommendation; typing alone does not", async ($, on) => {
  await started($, on);
  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  await ui.input({ key: "answer-1", text: "MySQL", kind: "change" });
  expect(await ui.find({ text: /Postgres/u })).toBeUndefined();
  expect((await ui.find({ type: "Text", text: /answered/u }))?.text).toBe(
    "0 of 3 answered · 0 used Claude's",
  );

  await ui.input({ key: "answer-1", text: "MySQL", kind: "submit" });
  expect((await ui.find({ key: "recommendation-1" }))?.text).toBe("Postgres");
  expect((await ui.find({ key: "answer-1" }))?.props.submitLabel).toBe("Update");
  expect(await ui.find({ key: "take-1" })).toBeDefined();
  expect(await ui.find({ text: /platform team|Next sprint/u })).toBeUndefined();
  await ui.unmount();
});

test("a picked choice records the answer and reveals its recommendation", async ($, on) => {
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
  expect((await ui.find({ key: "recommendation-3" }))?.text).toBe("Next sprint");
  expect((await ui.find({ type: "Text", text: /answered/u }))?.text).toBe(
    "1 of 3 answered · 0 used Claude's",
  );
  expect((await ui.find({ key: "answer-3" }))?.props.value).toBe("");
  await ui.unmount();
});

test("Send returns the answers to Claude as the user's next message", async ($, on) => {
  const world = await started($, on);

  await ended($, ROUND);
  const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

  // Q1: answered blind, then the recommendation taken. Q2: peeked first, then taken. Q3: answered blind.
  await ui.input({ key: "answer-1", text: "MySQL", kind: "submit" });
  await ui.press({ key: "take-1" });
  await ui.press({ key: "toggle-2" });
  await ui.press({ key: "take-2" });
  await ui.input({ key: "answer-3", text: "Not before the audit", kind: "submit" });
  await ui.press({ key: "send" });
  expect(await ui.find({ key: "send" })).toBeUndefined();
  await ui.unmount();

  expect(world.prompts).toEqual([
    [
      "Grill answers:",
      "Q1: your recommendation (recommendation seen after answering; first answer: MySQL)",
      "Q2: your recommendation (recommendation seen before answering)",
      "Q3: Not before the audit (recommendation seen after answering)",
    ].join("\n"),
  ]);

  const after = await $.ui.mount({ ...PANE, surface: "desktop" });

  expect(await after.find({ key: "question-1" })).toBeUndefined();
  await after.unmount();
});
