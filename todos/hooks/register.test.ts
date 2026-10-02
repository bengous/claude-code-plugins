import type { CommandRunInput, On } from "claude-code";
import { expect, type MockClock, mock, test } from "claude-code/testing";

const ROOT = "/work/repo";

const NOW = Date.UTC(2026, 9, 2);

const DAY = 86_400_000;

const SHA = "9b6920bb8d4e6b85dc8012b168a827d4219fd016";

const OTHER_MOD = "drawn by another mod";

const GREP = [
  "src/a.ts\u000010\u0000  // TODO: newer comment",
  "src/b.sh\u00003\u0000# FIXME: older comment",
  "",
].join("\n");

const BAND = {
  plugin: "todos",
  component: "AbovePrompt",
  surface: "terminal",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

const TODOS: CommandRunInput = {
  command: "todos",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 100 },
};

function porcelain(line: number, authoredAt: number): string {
  return [
    `${SHA} ${line} ${line} 1`,
    "author-mail <me@example.com>",
    `author-time ${authoredAt / 1000}`,
    "\tline",
    "",
  ].join("\n");
}

function run(stdout: string, exitCode = 0, stderr = "") {
  return {
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  };
}

function stubRepo(on: On, { isRepo = true } = {}): MockClock {
  const clock = mock.clock(on, { now: NOW });
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("session.cwd", () => ({ value: ROOT }));
  on("fs.exists", () => ({ value: true }));
  on("fs.read", () => ({ value: "- list item from TODO.md\n" }));
  on("process.run", (_$, e) => {
    if (!isRepo) return run("", 128, "fatal: not a git repository");

    if (e.argv[1] === "rev-parse") return run(`${ROOT}\n`);

    if (e.argv[1] === "grep") return run(GREP);

    const blamed = new Map([
      ["src/a.ts", porcelain(10, NOW - DAY)],
      ["src/b.sh", porcelain(3, NOW - 400 * DAY)],
      ["TODO.md", porcelain(1, NOW - 30 * DAY)],
    ]);

    return run(blamed.get(e.argv.at(-1) ?? "") ?? "");
  });
  on("ui.render", () => ({ type: "Text", props: {}, children: [OTHER_MOD] }));

  return clock;
}

test("/todos reports the count and draws the list newest first", async ($, on) => {
  stubRepo(on);
  const answer = await $.command.run(TODOS);
  expect(answer.text).toBe("3 TODOs above the prompt.");

  const ui = await $.ui.mount(BAND);
  const texts = (await ui.findAll({ type: "Text" })).map((element) => element.text);

  const order = ["newer comment", "list item from TODO.md", "FIXME older comment"].map((title) =>
    texts.indexOf(title),
  );

  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  expect(texts).toContain("src/a.ts:10");
  expect(texts).toContain("1d");
  expect(texts).toContain("1y");
});

test("the band keeps what the mods after it draw", async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "todos" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: OTHER_MOD })).toBeDefined();
});

test("an interactive session start shows the band without holding the session", async ($, on) => {
  const clock = stubRepo(on);
  on("session.start", () => ({ cwd: ROOT }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: ROOT });
  await clock.settle();
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "todos" })).toBeDefined();
});

test("the next prompt hides the band", async ($, on) => {
  stubRepo(on);
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  await $.command.run(TODOS);
  await $.prompt.submit({ text: "hello", wait: false, origin: { kind: "composer" } });
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "todos" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: OTHER_MOD })).toBeDefined();
});

test("Hide hides the band", async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);
  await ui.press({ key: "hide" });
  expect(await ui.find({ type: "Text", text: "todos" })).toBeUndefined();
});

test("the band yields to a survey", async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } });
  expect(await ui.find({ type: "Text", text: "todos" })).toBeUndefined();
});

test("/todos outside a git repository says so", async ($, on) => {
  stubRepo(on, { isRepo: false });
  const answer = await $.command.run(TODOS);
  expect(answer.text).toBe("Not inside a git repository.");
});
