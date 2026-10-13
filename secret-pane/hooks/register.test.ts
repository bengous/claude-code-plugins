import type { On, RenderSurface } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const TOOL = "mcp__secret-pane__request_secret";

const PLUGIN = "secret-pane";

const NOW = Date.UTC(2026, 9, 13);

const PAT = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

const TAG = /\[secret-pane:PARENT_REPO_PAT:[0-9a-f]{8}\]/u;

const ASK = { tool: TOOL, name: "PARENT_REPO_PAT", reason: "the sync workflow needs it" } as const;

const PANE = {
  plugin: PLUGIN,
  surface: "terminal",
  component: "Pane",
  requestId: PLUGIN,
  props: {
    title: PLUGIN,
    isFocused: true,
    bodyColumns: 80,
    placement: "inline",
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const;

const BAND = {
  plugin: PLUGIN,
  surface: "terminal",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

function ran(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false };
}

function bashRecord(stdout: string) {
  return { stdout, stderr: "", interrupted: false };
}

type Latch = { readonly wait: Promise<void>; readonly open: () => void };

function latch(): Latch {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { wait: promise, open: resolve };
}

type World = {
  readonly toasts: string[];
  readonly registered: { name: string; isDeferred: unknown; description: string }[];
  /** Resolves once the module has opened its box, so a test mounts a drawing the module answers. */
  readonly opened: Promise<void>;
  /** Lets the box's next poll return, so the module reads what the person did. */
  readonly release: () => void;
  readonly commands: string[];
  readonly prompts: string[];
};

type WorldOptions = {
  readonly surfaces?: readonly RenderSurface[];
  readonly isPlaced?: boolean;
  readonly bashStdout?: string;
};

function stubWorld(
  on: On,
  { surfaces = ["terminal"], isPlaced = true, bashStdout = "" }: WorldOptions = {},
): World {
  mock.clock(on, { now: NOW });
  const toasts: string[] = [];
  const registered: World["registered"] = [];
  const commands: string[] = [];
  const prompts: string[] = [];
  const opened = latch();
  let poll = latch();

  on("tool.register", (_$, e) => {
    registered.push({ name: e.name, isDeferred: e.isDeferred, description: e.description });

    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } };
  });
  on("session.surfaces", () => ({ value: surfaces }));
  on("ui.open", () => {
    opened.open();

    return {
      value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: "narrow terminal" },
    };
  });
  on("ui.close", () => ({ value: undefined }));
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);

    return { value: undefined };
  });
  on("ui.notice", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.render", ($, e) => {
    const { Box } = $.ui.resolve(e);

    return Box({ key: "engine" });
  });
  on("process.run", async () => {
    await poll.wait;
    poll = latch();

    return { value: ran("") };
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    commands.push(e.command);

    return { result: bashRecord(bashStdout) };
  });
  on("prompt.submit", (_$, e) => {
    prompts.push(e.text);

    return { text: e.text };
  });

  return {
    toasts,
    registered,
    opened: opened.wait,
    release: () => poll.open(),
    commands,
    prompts,
  };
}

async function started($: Engine, on: On, options: WorldOptions = {}) {
  const world = stubWorld(on, options);

  on("session.start", () => ({ cwd: "/work/repo" }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work/repo" });

  return world;
}

/** Claude asks, the person pastes the value in the pane and saves: the tool's answer. */
async function kept($: Engine, world: World, value = PAT) {
  const asking = $.tool.call(ASK);

  await world.opened;
  const ui = await $.ui.mount(PANE);

  await ui.input({ key: "secret", text: value, kind: "change" });
  await ui.input({ key: "secret", text: "", kind: "submit" });
  world.release();
  const answer = await asking;

  return { answer, tag: String(answer.result).match(TAG)?.[0] ?? "no tag" };
}

test("the session start registers request_secret in the prompt's tool list", async ($, on) => {
  const world = await started($, on);

  expect(world.registered).toHaveLength(1);
  expect(world.registered[0]?.name).toBe("request_secret");
  expect(world.registered[0]?.isDeferred).toBe(false);
  expect(world.registered[0]?.description).toContain("placeholder");
});

test("the box takes the value, Claude gets a placeholder and never the value", async ($, on) => {
  const world = await started($, on);
  const asking = $.tool.call(ASK);

  await world.opened;
  const ui = await $.ui.mount(PANE);

  expect((await ui.find({ type: "Text", text: /PARENT_REPO_PAT/u }))?.text).toContain(
    "Claude is asking for PARENT_REPO_PAT",
  );
  expect(await ui.find({ type: "Text", text: "the sync workflow needs it" })).toBeDefined();
  await ui.input({ key: "secret", text: PAT, kind: "change" });
  expect(await ui.find({ type: "Text", text: /characters/u })).toBeDefined();
  await ui.input({ key: "secret", text: "", kind: "submit" });
  world.release();
  const answer = await asking;

  expect(answer.deny).toBeUndefined();
  expect(String(answer.result)).toMatch(TAG);
  expect(String(answer.result)).not.toContain(PAT);
  expect(String(answer.result)).toContain(`${PAT.length} characters`);
  expect(world.toasts).toContain("PARENT_REPO_PAT kept for this session");
});

test("typing after a paste appends; the field only ever draws dots", async ($, on) => {
  const world = await started($, on);
  const asking = $.tool.call(ASK);

  await world.opened;
  const ui = await $.ui.mount(PANE);

  await ui.input({ key: "secret", text: "abc", kind: "change" });
  await ui.input({ key: "secret", text: "•••d", kind: "change" });
  const field = await ui.find({ type: "Input", key: "secret" });

  expect(field?.text).not.toContain("abc");
  expect(await ui.find({ type: "Text", text: /4 characters/u })).toBeDefined();
  await ui.input({ key: "secret", text: "", kind: "submit" });
  world.release();
  expect(String((await asking).result)).toContain("(4 characters)");
});

test("a placeholder in a Bash command becomes the value, and the output hides it again", async ($, on) => {
  const world = await started($, on, { bashStdout: `token ${PAT} accepted` });
  const { tag } = await kept($, world);

  const answer = await $.tool.call({
    tool: "Bash",
    command: `printf '%s' '${tag}' | gh secret set PARENT_REPO_PAT --repo o/r`,
  });

  expect(world.commands).toEqual([
    `printf '%s' '${PAT}' | gh secret set PARENT_REPO_PAT --repo o/r`,
  ]);
  expect(answer.deny).toBeUndefined();
  expect(JSON.stringify(answer.result)).toContain(`token ${tag} accepted`);
  expect(JSON.stringify(answer.result)).not.toContain(PAT);
  expect(answer.ref).toBeUndefined();
});

test("a command that commits or posts to GitHub keeps the placeholder", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);

  await $.tool.call({ tool: "Bash", command: `git commit -m "key ${tag}"` });
  await $.tool.call({
    tool: "Bash",
    command: `gh api -H "Authorization: Bearer ${tag}" repos/o/r`,
  });
  expect(world.commands).toEqual([
    `git commit -m "key ${tag}"`,
    `gh api -H "Authorization: Bearer ${tag}" repos/o/r`,
  ]);
});

test("a value the shell would read as code is refused, never put into Bash", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world, "pa ss$(id)");
  const answer = await $.tool.call({ tool: "Bash", command: `echo '${tag}'` });

  expect(answer.deny).toContain("characters the shell reads as code");
  expect(answer.deny).not.toContain("pa ss");
  expect(world.commands).toEqual([]);
});

test("a narrow terminal gets the box in the band, where Enter on empty cancels", async ($, on) => {
  const world = await started($, on, { isPlaced: false });
  const asking = $.tool.call(ASK);

  await world.opened;
  const ui = await $.ui.mount(BAND);

  expect(
    await ui.find({ type: "Text", text: /Claude is asking for PARENT_REPO_PAT/u }),
  ).toBeDefined();
  expect(await ui.find({ type: "Text", text: /ctrl\+x then tab/u })).toBeDefined();
  await ui.input({ key: "secret", text: "", kind: "submit" });
  world.release();
  const answer = await asking;

  expect(String(answer.result)).toBe("The user cancelled. PARENT_REPO_PAT was not kept.");
  expect(world.toasts.some((text) => text.includes("ctrl+x then tab"))).toBe(true);
  const bash = await $.tool.call({ tool: "Bash", command: `echo ${PAT}` });

  expect(bash.deny).toBeUndefined();
  expect(world.commands).toEqual([`echo ${PAT}`]);
});

test("a kept value pasted into the prompt is swapped for its placeholder", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);

  await $.prompt.submit({
    text: `here is the token: ${PAT}`,
    wait: false,
    origin: { kind: "composer" },
  });
  expect(world.prompts).toEqual([`here is the token: ${tag}`]);
});

test("a headless run has nobody to type: the tool says so", async ($, on) => {
  await started($, on, { surfaces: [] });
  const answer = await $.tool.call(ASK);

  expect(String(answer.result)).toContain("needs an interactive session");
});

test("a name that is no variable name is refused before any box opens", async ($, on) => {
  const world = await started($, on);
  const answer = await $.tool.call({ tool: TOOL, name: "9 lives", reason: "" });

  expect(String(answer.result)).toContain("is not a variable name");
  expect(world.toasts).toEqual([]);
});
