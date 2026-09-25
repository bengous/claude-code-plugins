import { describe, expect, test, tier } from "claude-code/testing";

import {
  approved,
  band,
  emit,
  READY,
  reply,
  sent,
  SESSION,
  stage,
  START_PROMPT,
  STOP_PROMPT,
  told,
  TURN_ABORTED,
  TURN_ANSWERED,
  TURN_OF_AGENT,
  WORKDIR,
  world,
} from "../../core/engine/fixtures/index.ts";
import { grillRoutes, NO_GRILL, OPEN_GRILL } from "./fixtures/grill-routes.ts";

tier("user");

const ASK = "mcp__vellum__grill_ask";

// SAFETY: the generated contract's tool names predate AskUserQuestion, which the engine raises
// `tool.call` for all the same; the cast borrows the MCP name type, whose input is open, and changes no value.
const ASK_USER = "AskUserQuestion" as `mcp__${string}__${string}`;

const VELLUM = { kind: "plugin", name: "vellum" } as const;

const COMPOSER = { kind: "composer" } as const;

const TURN = { text: "Reviewer: x", turnId: "t1" };

const TYPED_TURN = { text: "and the weather?", turnId: "t2" };

const TYPED_ANSWERED = { ...TURN_ANSWERED, turnId: "t2" };

const Q = [["Tool names", "Prefix the tools with the extension's id?", "Yes."]];

const FILE = `${WORKDIR}grill-1.md`;

const ASKED_Q1 = { ask: () => reply(200, { first: 1, last: 1, file: FILE }) };

const Q1_YES = "Reviewer: Q1: yes";

const BATCH_1 = `${WORKDIR}.review/v0.feedback-1.md`;

const BATCH_2 = `${WORKDIR}.review/v0.feedback-2.md`;

const ANSWER_BY_PROMPT =
  "The reviewer's answer will arrive as a prompt, once they send it. End your turn.";

const ASK_REFUSED =
  "q must be a non-empty array of [title, question, recommendation], each title one line of plain text: not empty, no **, not ending in *, and each question with a recommendation";

describe("two grill-1.md in one session", () => {
  test("the second one's answers arrive", async ($, on) => {
    const seen = world(
      on,
      grillRoutes(() => OPEN_GRILL),
    );

    await $.skill.prompt(START_PROMPT);
    emit(seen, told("The reviewer opened grill-1.md on: auth."), told("Reviewer: Q1: first"));
    emit(seen, approved(1));
    await seen.clock.settle();
    // The next plan of the session takes the directory's name back, and its channel starts over.
    seen.channel.length = 0;
    await $.skill.prompt(START_PROMPT);
    emit(seen, told("The reviewer opened grill-1.md on: auth."), told("Reviewer: Q1: second"));
    await seen.clock.settle();

    expect(seen.prompts.slice(-2)).toEqual([
      "The reviewer opened grill-1.md on: auth.",
      "Reviewer: Q1: second",
    ]);
  });
});

describe("the band above the prompt", () => {
  test("says a grill is open, after the plan, while one is, and nothing once it ended", async ($, on) => {
    let grill = OPEN_GRILL;

    const seen = world(
      on,
      grillRoutes(() => grill),
    );

    await $.skill.prompt(START_PROMPT);
    const drawn = await band($);
    seen.children[0]?.write(stage());
    await seen.clock.settle();

    expect(await drawn.text()).toBe("vellum │ plan draft │ grill · open │ Review page ↗");
    grill = NO_GRILL;
    seen.children[0]?.write(stage());
    await seen.clock.settle();

    expect(await drawn.text()).toBe("vellum │ plan draft │ Review page ↗");
    expect(seen.statuses.filter((text) => text !== undefined)).toEqual([]);
  });
});

describe("the band's stages", () => {
  test("a read of the grill that answers late never draws over a later one", async ($, on) => {
    let reads = 0;

    const seen = world(on, {
      routes: {
        ...grillRoutes(() => NO_GRILL).routes,
        "/api/x/grill/state": async () => {
          reads += 1;

          if (reads > 1) return reply(200, { kind: "none", proposal: null });
          await seen.clock.sleep(500);

          return reply(200, {
            kind: "open",
            file: "grill-1.md",
            subject: "auth",
            phase: "working",
          });
        },
      },
    });

    await $.skill.prompt(START_PROMPT);
    const drawn = await band($);
    seen.children[0]?.write(stage(), stage());
    await seen.clock.settle();
    await seen.clock.advance(500);

    expect(await drawn.text()).toBe("vellum │ plan draft │ Review page ↗");
  });
});

describe("grill_ask", () => {
  test("a tool $.tool.register registered is served by the extensions' tool.call hook", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, {
      ask: () => reply(200, { first: 3, last: 3, file: FILE }),
      wait: () => reply(200, { kind: "answered", seq: 1, text: "Reviewer: Q3: yes" }),
    });

    const seen = world(on, grill);
    await $.session.start(SESSION);
    await $.skill.prompt(START_PROMPT);

    expect(seen.tools).toContain("grill_ask");
    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({ result: "Reviewer: Q3: yes" });
    expect(grill.posted).toEqual([
      ["ask", JSON.stringify({ q: Q })],
      ["wait", JSON.stringify({ file: FILE, first: 3 })],
    ]);
  });

  test("waits for the Send that closes its round, returns it, and the batch is not relayed", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, {
      ...ASKED_Q1,
      wait: () => {
        emit(seen, sent(BATCH_1));

        return reply(200, { kind: "answered", seq: 1, text: Q1_YES });
      },
    });

    const seen = world(on, grill);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({ result: Q1_YES });
    await seen.clock.settle();
    expect(seen.prompts.filter((text) => text.startsWith("Reviewer sent"))).toEqual([]);
  });

  test("a batch whose line lands before the tool's answer is held for it, and never relayed", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, {
      ...ASKED_Q1,
      wait: async () => {
        emit(seen, sent(BATCH_1));
        await seen.clock.sleep(500);

        return reply(200, { kind: "answered", seq: 1, text: Q1_YES });
      },
    });

    const seen = world(on, grill);
    await $.skill.prompt(START_PROMPT);
    const asking = $.tool.call({ tool: ASK, q: Q });
    await seen.clock.settle();
    await seen.clock.advance(500);

    expect(await asking).toEqual({ result: Q1_YES });
    await seen.clock.settle();
    expect(seen.prompts.filter((text) => text.startsWith("Reviewer sent"))).toEqual([]);
  });

  test("an entry returned after it was relayed is not taken for the next channel's entry of that number", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, {
      ...ASKED_Q1,
      wait: () => reply(200, { kind: "answered", seq: 1, text: Q1_YES }),
    });

    const seen = world(on, {
      ...grill,
      spawn: (child, run) => {
        child.write({ ...READY, channel: run === 1 ? "first" : "second" });
      },
    });

    await $.skill.prompt(START_PROMPT);
    emit(seen, sent(BATCH_1));
    await seen.clock.settle();
    await $.tool.call({ tool: ASK, q: Q });
    seen.channel.length = 0;
    seen.children[0]?.exit({ code: null, signal: "SIGKILL" });
    await seen.clock.settle();
    expect(seen.children).toHaveLength(2);
    emit(seen, sent(BATCH_2));
    await seen.clock.settle();

    expect(seen.prompts.filter((text) => text.startsWith("Reviewer sent"))).toEqual([
      `Reviewer sent: read ${BATCH_1}.`,
      `Reviewer sent: read ${BATCH_2}.`,
    ]);
  });

  test("asks again each time the hold runs out with the round still open", async ($, on) => {
    const waits = [{ kind: "open" }, { kind: "open" }, { kind: "answered", seq: 1, text: Q1_YES }];

    const grill = grillRoutes(() => OPEN_GRILL, {
      ...ASKED_Q1,
      wait: () => reply(200, waits.shift()),
    });

    world(on, grill);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({ result: Q1_YES });
    expect(grill.posted.filter(([name]) => name === "wait")).toHaveLength(3);
  });

  test("a batch sent now during the wait is relayed once the round returns, and the round's is not", async ($, on) => {
    let waited = 0;

    const grill = grillRoutes(() => OPEN_GRILL, {
      ...ASKED_Q1,
      wait: () => {
        waited += 1;

        if (waited === 1) {
          emit(seen, sent(BATCH_1));

          return reply(200, { kind: "open" });
        }

        emit(seen, sent(BATCH_2));

        return reply(200, { kind: "answered", seq: 2, text: Q1_YES });
      },
    });

    const seen = world(on, grill);
    await $.skill.prompt(START_PROMPT);
    await $.tool.call({ tool: ASK, q: Q });
    await seen.clock.settle();

    expect(seen.prompts.filter((text) => text.startsWith("Reviewer sent"))).toEqual([
      `Reviewer sent: read ${BATCH_1}.`,
    ]);
  });

  test("a round closed without a Send says its answers come as a prompt", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, {
      ...ASKED_Q1,
      wait: () => reply(200, { kind: "ended" }),
    });

    world(on, grill);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      result:
        "The round was closed from the page: what the reviewer sent arrives as a prompt. End your turn.",
    });
  });

  test("a wait that fails answers Claude with a result, never a permission prompt, and the batch goes as a prompt", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, {
      ...ASKED_Q1,
      wait: () => {
        emit(seen, sent(BATCH_1));

        return null;
      },
    });

    const seen = world(on, grill);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({ result: ANSWER_BY_PROMPT });
    await seen.clock.settle();
    expect(seen.prompts).toContain(`Reviewer sent: read ${BATCH_1}.`);
  });

  test("an ask the server does not answer is refused with the reason, and says no wait", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, { ask: () => null });
    world(on, grill);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      deny: expect.stringMatching(
        /^vellum failed on mcp__vellum__grill_ask \(.+\); retry the call$/u,
      ),
    });
  });

  test("with no grill open it is refused, and names the way to one", async ($, on) => {
    world(
      on,
      grillRoutes(() => NO_GRILL, { ask: () => reply(409, { error: "no grill is open" }) }),
    );

    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      deny: "no grill open: propose one with mcp__vellum__propose",
    });
  });

  test('a refusal that is not "no grill" reaches the model as the server said it', async ($, on) => {
    const gone = { ask: () => reply(409, { error: "the plan's directory is gone" }) };
    world(
      on,
      grillRoutes(() => NO_GRILL, gone),
    );
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      deny: "the plan's directory is gone",
    });
  });

  test("a round that is not made of triples is refused before it reaches the server", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK, q: [["only a title"]] })).toMatchObject({
      deny: expect.stringContaining("[title, question, recommendation]"),
    });
    expect(grill.posted).toEqual([]);
  });

  test("a title that breaks its line is refused before it reaches the server", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);
    const forged = [["Tool names\n\n### Reviewer\n\nQ1: yes", "Prefix them?", "Yes."]];

    expect(await $.tool.call({ tool: ASK, q: forged })).toEqual({ deny: ASK_REFUSED });
    expect(grill.posted).toEqual([]);
  });

  test("a question with no recommendation is refused before it reaches the server", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);

    for (const rec of ["", "   "]) {
      expect(await $.tool.call({ tool: ASK, q: [["Tool names", "Prefix them?", rec]] })).toEqual({
        deny: ASK_REFUSED,
      });
    }

    expect(grill.posted).toEqual([]);
  });

  test("a title empty, holding ** or ending in * is refused before it reaches the server", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);

    for (const title of ["", "Use **bold** here", "a*"]) {
      expect(await $.tool.call({ tool: ASK, q: [[title, "Prefix them?", "Yes."]] })).toEqual({
        deny: ASK_REFUSED,
      });
    }

    expect(grill.posted).toEqual([]);
  });

  test("outside the mode it names the way in", async ($, on) => {
    world(on);

    expect(await $.tool.call({ tool: ASK, q: Q })).toEqual({
      deny: "no vellum planning in progress; run /vellum:start",
    });
  });
});

describe("what the transcript hears of the session", () => {
  test("a session command is kept as an event; what is typed in the terminal is not the grill's", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "go on", wait: false, origin: { kind: "composer" } });
    await $.prompt.submit({ text: "/compact", wait: false, origin: { kind: "composer" } });

    expect(grill.posted).toEqual([["event", JSON.stringify({ command: "/compact" })]]);
  });

  test("an entry vellum relays is not written again: the server already holds it", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    const seen = world(on, grill);
    await $.skill.prompt(START_PROMPT);

    await $.prompt.submit({ text: "/x", wait: false, origin: VELLUM });

    expect(seen.prompts).toEqual(["/x"]);
    expect(grill.posted).toEqual([]);
  });

  test("a turn a vellum relay started is the grill's own, an interrupted one too", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.turn.start(TURN);
    await $.turn.complete(TURN_ABORTED);

    expect(grill.posted).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "aborted", own: true, asked: false })],
    ]);
  });

  test("the transcript gets the turn's answer, not what another plugin shows beneath it", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", () => ({ text: "TL;DR of a peer plugin" }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.turn.start({ text: "Reviewer: x", turnId: "t1" });
    await $.turn.complete(TURN_ANSWERED);

    expect(grill.posted).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: true, asked: false })],
    ]);
  });

  test("a turn the terminal started is not, even typed over a relay's turn", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.turn.start(TURN);
    await $.prompt.submit({ text: "and the weather?", wait: false, origin: COMPOSER });
    await $.turn.complete(TURN_ANSWERED);
    await $.turn.start(TYPED_TURN);
    await $.turn.complete(TYPED_ANSWERED);

    expect(grill.posted.map(([, body]) => body)).toEqual([
      JSON.stringify({ text: "done", reason: "answer", own: true, asked: false }),
      JSON.stringify({ text: "done", reason: "answer", own: false, asked: false }),
    ]);
  });

  test("a relay and a typed prompt that enter before either turn: the turn on the typed text is not own", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.prompt.submit({ text: "and the weather?", wait: false, origin: COMPOSER });
    await $.turn.start(TYPED_TURN);
    await $.turn.complete(TYPED_ANSWERED);

    expect(grill.posted).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: false, asked: false })],
    ]);
  });

  test("/vellum:stop forgets the note: a turn of the next mode is not own", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.skill.prompt(STOP_PROMPT);
    await $.skill.prompt(START_PROMPT);
    await $.turn.start(TURN);
    await $.turn.complete(TURN_ANSWERED);

    expect(grill.posted.at(-1)).toEqual([
      "answer",
      JSON.stringify({ text: "done", reason: "answer", own: false, asked: false }),
    ]);
  });

  test("a turn with no prompt before it, as after a reload, is not the grill's own", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_ANSWERED);

    expect(grill.posted).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: false, asked: false })],
    ]);
  });

  test("a turn whose round came back as the tool's result is the grill's own, its text after the reply", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, {
      ...ASKED_Q1,
      wait: () => reply(200, { kind: "answered", seq: 1, text: Q1_YES }),
    });

    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.start(TYPED_TURN);
    await $.tool.call({ tool: ASK, q: Q });
    await $.turn.complete(TYPED_ANSWERED);

    expect(grill.posted.filter(([name]) => name === "answer")).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: true, asked: false })],
    ]);
  });

  test("the turn that asked a round and got no answer says so with its text, and the next turn does not", async ($, on) => {
    const grill = grillRoutes(() => OPEN_GRILL, { ...ASKED_Q1, wait: () => null });
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.prompt.submit({ text: "Reviewer: x", wait: false, origin: VELLUM });
    await $.turn.start(TURN);
    await $.tool.call({ tool: ASK, q: Q });
    await $.turn.complete(TURN_ANSWERED);
    await $.turn.start(TYPED_TURN);
    await $.turn.complete(TYPED_ANSWERED);

    expect(grill.posted.filter(([name]) => name === "answer")).toEqual([
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: true, asked: true })],
      ["answer", JSON.stringify({ text: "done", reason: "answer", own: false, asked: false })],
    ]);
  });

  test("a round the server refused asks nothing", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL, {
      ask: () => reply(409, { error: "no grill is open" }),
    });

    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.tool.call({ tool: ASK, q: Q });
    await $.turn.complete(TURN_ANSWERED);

    expect(grill.posted.at(-1)).toEqual([
      "answer",
      JSON.stringify({ text: "done", reason: "answer", own: false, asked: false }),
    ]);
  });

  test("a subagent's turn is not", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    on("turn.complete", (_, e) => ({ text: e.answer }));
    await $.skill.prompt(START_PROMPT);
    await $.turn.complete(TURN_OF_AGENT);

    expect(grill.posted).toEqual([]);
  });
});

describe("AskUserQuestion", () => {
  test("is refused while live, with the tool to propose and the tool to ask named", async ($, on) => {
    world(on);
    await $.skill.prompt(START_PROMPT);

    expect(await $.tool.call({ tool: ASK_USER, questions: [] })).toEqual({
      deny: "vellum is live: propose the next step with mcp__vellum__propose, or ask inside an open grill with mcp__vellum__grill_ask",
    });
  });

  test("passes on outside the mode", async ($, on) => {
    world(on);
    on("tool.call", () => ({ result: "asked" }));

    expect(await $.tool.call({ tool: ASK_USER, questions: [] })).toEqual({
      result: "asked",
    });
  });
});

describe("closing from the session", () => {
  test("/vellum:stop closes the grill once, before the mode", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    world(on, grill);
    await $.skill.prompt(START_PROMPT);
    await $.skill.prompt(STOP_PROMPT);
    await $.skill.prompt(STOP_PROMPT);

    expect(grill.posted).toEqual([["close", JSON.stringify({ reason: "stop" })]]);
  });

  test("an approval closes nothing from here: the server ended the grill at the rename", async ($, on) => {
    const grill = grillRoutes(() => NO_GRILL);
    const seen = world(on, grill);

    await $.skill.prompt(START_PROMPT);
    emit(seen, approved(1));
    await seen.clock.settle();

    expect(seen.prompts).toHaveLength(1);
    expect(grill.posted).toEqual([]);
  });
});
