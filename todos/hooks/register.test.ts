import type { CommandRunInput, On } from "claude-code";
import { expect, type MockClock, mock, test } from "claude-code/testing";

const ROOT = "/work/repo";

const NOW = Date.UTC(2026, 9, 2);

const DAY = 86_400_000;

const SHA = "9b6920bb8d4e6b85dc8012b168a827d4219fd016";

const ME = "me@example.com";

const OTHER_MOD = "drawn by another mod";

const GREP = [
  "src/a.ts\u000010\u0000  // TODO(#12): newer comment",
  "src/b.sh\u00003\u0000# FIXME: older comment",
  "",
].join("\n");

const TODOS: CommandRunInput = {
  command: "todos",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 100 },
};

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

function porcelain(line: number, authoredAt: number, email: string): string {
  return [
    `${SHA} ${line} ${line} 1`,
    `author-mail <${email}>`,
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

type Repo = { readonly clock: MockClock; readonly toasts: string[]; readonly reads: string[] };

function stubRepo(
  on: On,
  { isRepo = true, files = new Map([[`${ROOT}/TODO.md`, ["- list item from TODO.md\n"]]]) } = {},
): Repo {
  const clock = mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  const reads: string[] = [];

  const blamed = new Map([
    ["src/a.ts", porcelain(10, NOW - DAY, ME)],
    ["src/b.sh", porcelain(3, NOW - 400 * DAY, "other@example.com")],
    ["TODO.md", porcelain(1, NOW - 30 * DAY, ME)],
  ]);

  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("session.cwd", () => ({ value: ROOT }));
  on("fs.exists", (_$, e) => ({ value: files.has(e.path) }));
  on("fs.read", (_$, e) => {
    reads.push(e.path);
    const versions = files.get(e.path) ?? [""];

    return { value: versions.length > 1 ? (versions.shift() ?? "") : (versions[0] ?? "") };
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);

    return { value: undefined };
  });
  on("process.run", (_$, e) => {
    if (!isRepo) return run("", 128, "fatal: not a git repository");

    switch (e.argv[1]) {
      case "rev-parse":
        return run(`${ROOT}\n`);
      case "grep":
        return run(GREP);
      case "config":
        return run(`${ME}\n`);
      case "remote":
        return run("git@github.com:bengous/claude-code-plugins.git\n");
      default:
        return run(blamed.get(e.argv.at(-1) ?? "") ?? "");
    }
  });
  on("ui.render", () => ({ type: "Text", props: {}, children: [OTHER_MOD] }));

  return { clock, toasts, reads };
}

async function texts(ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) {
  return (await ui.findAll({ type: "Text" })).map((element) => element.text);
}

test("/todos reports the count and draws the list newest first", async ($, on) => {
  stubRepo(on);
  const answer = await $.command.run(TODOS);

  expect(answer.text).toBe("3 TODOs above the prompt.");
  const shown = await texts(await $.ui.mount(BAND));

  const order = ["newer comment", "list item from TODO.md", "FIXME older comment"].map((title) =>
    shown.indexOf(title),
  );

  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  expect(shown).toContain("src/a.ts:10");
  expect(shown).toContain("1d");
  expect(shown).toContain("1y");
});

test("the band keeps what the mods after it draw", async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  expect(await ui.find({ type: "Text", text: "todos" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: OTHER_MOD })).toBeDefined();
});

test("the desktop app draws the same band", async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount({ ...BAND, surface: "desktop" });

  expect(await ui.find({ type: "Text", text: "newer comment" })).toBeDefined();
});

test("an interactive session start shows the band without holding the session", async ($, on) => {
  const { clock } = stubRepo(on);

  on("session.start", () => ({ cwd: ROOT }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: ROOT });
  await clock.settle();
  const ui = await $.ui.mount(BAND);

  expect(await ui.find({ type: "Text", text: "todos" })).toBeDefined();
});

test(
  "show_on_start off keeps the band closed until /todos",
  { options: { show_on_start: false } },
  async ($, on) => {
    const { clock } = stubRepo(on);

    on("session.start", () => ({ cwd: ROOT }));
    await $.session.start({ surface: "terminal", isInteractive: true, cwd: ROOT });
    await clock.settle();
    const ui = await $.ui.mount(BAND);

    expect(await ui.find({ type: "Text", text: "todos" })).toBeUndefined();
    await $.command.run(TODOS);
    expect(await ui.find({ type: "Text", text: "todos" })).toBeDefined();
  },
);

test("rows caps the list and counts the rest", { options: { rows: 2 } }, async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const shown = await texts(await $.ui.mount(BAND));

  expect(shown).not.toContain("FIXME older comment");
  expect(shown.some((text) => text.startsWith("+1 more"))).toBe(true);
});

test("markers sets which comment words count", { options: { markers: "FIXME" } }, async ($, on) => {
  stubRepo(on);
  const answer = await $.command.run(TODOS);

  expect(answer.text).toBe("2 TODOs above the prompt.");
});

test("Mine keeps the TODOs whose git author is you", async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await ui.press({ key: "mine" });
  const shown = await texts(ui);

  expect(shown).toContain("· 2 of 3 yours");
  expect(shown).not.toContain("FIXME older comment");
  await ui.press({ key: "mine" });
  expect(await texts(ui)).toContain("FIXME older comment");
});

test("mine_only starts filtered", { options: { mine_only: true } }, async ($, on) => {
  stubRepo(on);
  on("session.start", () => ({ cwd: ROOT }));
  await $.session.start({ surface: "terminal", isInteractive: false, cwd: ROOT });
  const answer = await $.command.run(TODOS);

  expect(answer.text).toBe("3 TODOs above the prompt, 2 of them yours.");
  expect(await texts(await $.ui.mount(BAND))).not.toContain("FIXME older comment");
});

test("TODO(#12) links to the GitHub issue", async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const link = await (await $.ui.mount(BAND)).find({ type: "Link" });

  expect(link?.props).toMatchObject({
    href: "https://github.com/bengous/claude-code-plugins/issues/12",
    label: "#12",
  });
});

test("an edit that adds a TODO comment raises a toast", async ($, on) => {
  const path = `${ROOT}/src/c.ts`;

  const { toasts } = stubRepo(on, {
    files: new Map([[path, ["code();\n", "code();\n// TODO: added by Claude\n"]]]),
  });

  on("tool.call", () => ({ result: { filePath: path } }));
  await $.tool.call({
    tool: "Edit",
    file_path: path,
    old_string: "code();",
    new_string: "code();\n// TODO: added by Claude",
  });

  expect(toasts).toEqual(["New TODO at src/c.ts:2: added by Claude"]);
});

test("an edit without a marker reads nothing", async ($, on) => {
  const { reads, toasts } = stubRepo(on);

  on("tool.call", () => ({ result: { filePath: `${ROOT}/src/c.ts` } }));
  await $.tool.call({
    tool: "Edit",
    file_path: `${ROOT}/src/c.ts`,
    old_string: "a",
    new_string: "b",
  });

  expect(reads).toEqual([]);
  expect(toasts).toEqual([]);
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
