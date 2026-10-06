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
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const;

const WHEEL = {
  component: "AbovePrompt",
  requestId: "band",
  bodyRows: 19,
  contentRows: 6,
  origin: { kind: "person" },
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
  {
    isRepo = true,
    files = new Map([[`${ROOT}/TODO.md`, ["- list item from TODO.md\n"]]]),
    grepGate = Promise.resolve(),
    excludedPaths = new Set<string>(),
    draft = "",
    cwd = ROOT,
  } = {},
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
  on("session.cwd", () => ({ value: cwd }));
  on("prompt.read", () => ({ value: { text: draft, cursor: draft.length } }));
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
      case "rev-parse": {
        const prefix = (e.init?.cwd ?? ROOT).slice(ROOT.length + 1);

        return run(
          e.argv.includes("--show-prefix")
            ? `${ROOT}\n${prefix === "" ? "" : `${prefix}/`}\n`
            : `${ROOT}\n`,
        );
      }

      case "grep":
        return grepGate.then(() => run(GREP));
      case "config":
        return run(`${ME}\n`);
      case "remote":
        return run("git@github.com:bengous/claude-code-plugins.git\n");
      case "check-attr": {
        const path = e.argv.at(-1) ?? "";

        return run(`${path}\0todos\0${excludedPaths.has(path) ? "unset" : "unspecified"}\0`);
      }

      default:
        return run(blamed.get(e.argv.at(-1) ?? "") ?? "");
    }
  });
  on("ui.render", () => ({ type: "Text", props: {}, children: [OTHER_MOD] }));

  return { clock, toasts, reads };
}

const doNothing = (): void => undefined;

async function texts(ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) {
  return (await ui.findAll({ type: "Text" })).map((element) => element.text);
}

type Drawing = {
  findAll: (query: { type: string }) => Promise<{ key: string | undefined; text: string }[]>;
};

async function pickKey(ui: Drawing, index: number): Promise<string> {
  const picks = (await ui.findAll({ type: "Button" })).filter((button) =>
    button.key?.startsWith("pick"),
  );

  return picks[index]?.key ?? `no pick at ${index}`;
}

async function pickMarks(ui: Drawing): Promise<string[]> {
  return (await ui.findAll({ type: "Button" }))
    .filter((button) => button.key?.startsWith("pick"))
    .map((button) => button.text);
}

function engineScrolls(on: On): number[] {
  const passed: number[] = [];

  on("ui.scroll", (_$, e) => {
    passed.push(e.by);

    return {};
  });

  return passed;
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
  let releaseGrep = doNothing;

  const grepGate = new Promise<void>((resolve) => {
    releaseGrep = resolve;
  });

  const { clock } = stubRepo(on, { grepGate });

  on("session.start", () => ({ cwd: ROOT }));
  // A session.start that awaited the scan would never resolve here: git grep is held until after it.
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: ROOT });
  const ui = await $.ui.mount(BAND);

  expect(await ui.find({ type: "Text", text: "todos" })).toBeUndefined();
  releaseGrep();
  await clock.settle();
  expect(await ui.find({ type: "Text", text: "todos" })).toBeDefined();
});

test(
  "after /clear the band comes back with mine_only",
  { options: { mine_only: true } },
  async ($, on) => {
    const { clock } = stubRepo(on);

    on("classic.SessionStart", () => ({}));
    await $.classic.SessionStart({ source: "clear" });
    await clock.settle();
    const shown = await texts(await $.ui.mount(BAND));

    expect(shown).toContain("· 2 of 3 yours");
    expect(shown).not.toContain("FIXME older comment");
  },
);

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

test(
  "rows sets the list's window and says where it stands",
  { options: { rows: 2 } },
  async ($, on) => {
    stubRepo(on);
    await $.command.run(TODOS);
    const shown = await texts(await $.ui.mount(BAND));

    expect(shown).not.toContain("FIXME older comment");
    expect(shown.some((text) => text.startsWith("1–2 of 3"))).toBe(true);
  },
);

test("the wheel scrolls the list under its header", { options: { rows: 2 } }, async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await $.ui.scroll({ ...WHEEL, offset: 1, by: 1 });
  const shown = await texts(ui);

  expect(shown).toContain("todos");
  expect(shown).toContain("FIXME older comment");
  expect(shown).not.toContain("newer comment");
  expect(shown.some((text) => text.startsWith("2–3 of 3"))).toBe(true);
  await $.ui.scroll({ ...WHEEL, offset: 0, by: -5 });
  expect(await texts(ui)).toContain("newer comment");
});

test("a list that fits leaves the wheel to the engine", async ($, on) => {
  stubRepo(on);
  const passed = engineScrolls(on);

  await $.command.run(TODOS);
  await $.ui.mount(BAND);
  await $.ui.scroll({ ...WHEEL, offset: 1, by: 1 });

  expect(passed).toEqual([1]);
});

test("Show Claude puts the picked TODOs in the prompt box", async ($, on) => {
  stubRepo(on);
  const fills: string[] = [];

  on("prompt.fill", (_$, e) => {
    fills.push(e.text);

    return { isFilled: true };
  });
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  expect(await ui.find({ type: "Button", key: "show" })).toBeUndefined();
  await ui.press({ key: await pickKey(ui, 0) });
  await ui.press({ key: await pickKey(ui, 2) });
  expect(await pickMarks(ui)).toEqual(["●", "○", "●"]);
  expect((await texts(ui)).some((text) => text.includes("2 selected"))).toBe(true);
  await ui.press({ key: "show" });

  expect(fills).toEqual([
    "Read these TODOs:\n- src/a.ts:10: newer comment (#12)\n- src/b.sh:3: FIXME older comment\n",
  ]);
  expect(await ui.find({ type: "Button", key: "show" })).toBeUndefined();
});

test("Show Claude starts the TODOs on a line of their own", async ($, on) => {
  stubRepo(on, { draft: "look at" });
  const fills: string[] = [];

  on("prompt.fill", (_$, e) => {
    fills.push(e.text);

    return { isFilled: true };
  });
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await ui.press({ key: await pickKey(ui, 1) });
  await ui.press({ key: "show" });

  expect(fills).toEqual(["\nRead these TODOs:\n- TODO.md:1: list item from TODO.md\n"]);
});

test("a pick pressed twice is dropped, and Clear drops them all", async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await ui.press({ key: await pickKey(ui, 0) });
  await ui.press({ key: await pickKey(ui, 0) });
  expect(await ui.find({ type: "Button", key: "show" })).toBeUndefined();
  await ui.press({ key: await pickKey(ui, 1) });
  await ui.press({ key: "clear" });
  expect(await pickMarks(ui)).toEqual(["○", "○", "○"]);
});

test("a prompt box that refuses the TODOs keeps them picked", async ($, on) => {
  const { toasts } = stubRepo(on);

  on("prompt.fill", () => ({ isFilled: false }));
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await ui.press({ key: await pickKey(ui, 0) });
  await ui.press({ key: "show" });

  expect(toasts).toEqual(["The prompt box did not take the TODOs."]);
  expect(await ui.find({ type: "Button", key: "show" })).toBeDefined();
});

test("a tick off the list leaves it to the engine", { options: { rows: 2 } }, async ($, on) => {
  stubRepo(on);
  const passed = engineScrolls(on);

  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await $.ui.scroll({ ...WHEEL, offset: 1, by: 1, pointer: { row: 4, column: 3 } });
  expect(passed).toEqual([1]);
  expect(await texts(ui)).toContain("newer comment");
  await $.ui.scroll({ ...WHEEL, offset: 1, by: 1, pointer: { row: 3, column: 3 } });
  expect(passed).toEqual([1]);
  expect(await texts(ui)).not.toContain("newer comment");
});

test(
  "a band taller than its window scrolls its list first, then hands the edge to the engine",
  { options: { rows: 2 } },
  async ($, on) => {
    stubRepo(on);
    const passed = engineScrolls(on);

    await $.command.run(TODOS);
    const ui = await $.ui.mount(BAND);
    const overflowing = { ...WHEEL, bodyRows: 3, contentRows: 7 };

    await $.ui.scroll({ ...overflowing, offset: 1, by: 1, pointer: { row: 9, column: 3 } });
    expect((await texts(ui)).some((text) => text.startsWith("2–3 of 3"))).toBe(true);
    await $.ui.scroll({ ...overflowing, offset: 2, by: 1 });
    expect(passed).toEqual([1]);
  },
);

test("a plugin's scroll is the engine's", { options: { rows: 2 } }, async ($, on) => {
  stubRepo(on);
  const passed = engineScrolls(on);

  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await $.ui.scroll({ ...WHEEL, offset: 1, by: 1, origin: { kind: "plugin", name: "other" } });
  expect(passed).toEqual([1]);
  expect(await texts(ui)).toContain("newer comment");
});

test(
  "a rows setting with a fraction reads as whole rows",
  { options: { rows: 2.5 } },
  async ($, on) => {
    stubRepo(on);
    await $.command.run(TODOS);
    const ui = await $.ui.mount(BAND);

    await $.ui.scroll({ ...WHEEL, offset: 1, by: 1 });
    const shown = await texts(ui);

    expect(shown.some((text) => text.startsWith("2–3 of 3"))).toBe(true);
    expect(shown).toContain("src/b.sh:3");
  },
);

test("Mine starts the list at its top", { options: { rows: 1 } }, async ($, on) => {
  stubRepo(on);
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await $.ui.scroll({ ...WHEEL, offset: 1, by: 1 });
  await ui.press({ key: "mine" });
  expect(await texts(ui)).toContain("newer comment");
});

test("a scan that moves a picked TODO drops the pick", async ($, on) => {
  stubRepo(on, {
    files: new Map([
      [
        `${ROOT}/TODO.md`,
        ["- list item from TODO.md\n", "- new first\n- list item from TODO.md\n"],
      ],
    ]),
  });
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await ui.press({ key: await pickKey(ui, 1) });
  expect(await ui.find({ type: "Button", key: "show" })).toBeDefined();
  await $.command.run(TODOS);
  expect(await ui.find({ type: "Button", key: "show" })).toBeUndefined();
});

test("Show Claude names paths from the root when the session starts elsewhere", async ($, on) => {
  stubRepo(on, { cwd: `${ROOT}/src` });
  const fills: string[] = [];

  on("prompt.fill", (_$, e) => {
    fills.push(e.text);

    return { isFilled: true };
  });
  await $.command.run(TODOS);
  const ui = await $.ui.mount(BAND);

  await ui.press({ key: await pickKey(ui, 0) });
  await ui.press({ key: "show" });

  expect(fills).toEqual([`Read these TODOs:\n- ${ROOT}/src/a.ts:10: newer comment (#12)\n`]);
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

test("an edit in a path marked -todos raises no toast", async ($, on) => {
  const path = `${ROOT}/archive/c.ts`;

  const { toasts } = stubRepo(on, {
    files: new Map([[path, ["code();\n", "code();\n// TODO: archived\n"]]]),
    excludedPaths: new Set(["archive/c.ts"]),
  });

  on("tool.call", () => ({ result: { filePath: path } }));
  await $.tool.call({
    tool: "Edit",
    file_path: path,
    old_string: "code();",
    new_string: "code();\n// TODO: archived",
  });

  expect(toasts).toEqual([]);
});

test("an item added to TODO.md raises a toast whatever its attributes", async ($, on) => {
  const path = `${ROOT}/TODO.md`;

  const { toasts } = stubRepo(on, {
    files: new Map([[path, ["- old item\n", "- old item\n- new item\n"]]]),
    excludedPaths: new Set(["TODO.md"]),
  });

  on("tool.call", () => ({ result: { filePath: path } }));
  await $.tool.call({
    tool: "Edit",
    file_path: path,
    old_string: "- old item",
    new_string: "- old item\n- new item",
  });

  expect(toasts).toEqual(["New TODO at TODO.md: new item"]);
});

test("an edit that fails raises no toast", async ($, on) => {
  const path = `${ROOT}/src/c.ts`;

  const { toasts } = stubRepo(on, {
    files: new Map([[path, ["code();\n", "code();\n"]]]),
  });

  on("tool.call", () => ({ result: "String to replace not found in file.", isError: true }));
  await $.tool.call({
    tool: "Edit",
    file_path: path,
    old_string: "missing",
    new_string: "// TODO: never written",
  });

  expect(toasts).toEqual([]);
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
