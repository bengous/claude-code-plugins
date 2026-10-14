import type { On, RenderSurface } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const TOOL = "mcp__secret-pane__request_secret";

const PLUGIN = "secret-pane";

const NOW = Date.UTC(2026, 9, 14);

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
    scroll: { offset: 0, bodyRows: 7 },
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

type Verdict = { readonly decision: "allow" | "ask" | "deny"; readonly rule?: string };

type World = {
  readonly toasts: string[];
  readonly registered: { name: string; isDeferred: unknown; description: string }[];
  /** Resolves once the module has opened its box, so a test mounts a drawing the module answers. */
  readonly opened: () => Promise<void>;
  /** Lets the box's next poll return, so the module reads what the person did. */
  readonly release: () => void;
  readonly commands: string[];
  /** The commands as the settings hooks beneath the plugin saw them. */
  readonly checked: string[];
  /** The questions the mod's own dialog put to the person. */
  readonly asked: string[];
  readonly prompts: { text: string; context: readonly string[] | undefined }[];
  /** The rows the session kept, as the plugins answered them. */
  readonly appended: () => readonly { readonly message: { readonly content: unknown } }[];
};

type WorldOptions = {
  readonly surfaces?: readonly RenderSurface[];
  readonly isPlaced?: boolean;
  readonly bashStdout?: string;
  readonly fileContent?: string;
  /** What the session decides for a Bash command beneath the plugin; none, and a check reaches nothing. */
  readonly verdict?: (command: string) => Verdict;
  /** What the person answers the mod's own dialog; none, and a dialog reaches nothing. */
  readonly answer?: () => string;
};

function stubWorld(
  on: On,
  {
    surfaces = ["terminal"],
    isPlaced = true,
    bashStdout = "",
    fileContent = "",
    verdict,
    answer,
  }: WorldOptions = {},
): World {
  mock.clock(on, { now: NOW });
  mock.env(on, {});
  const session = mock.session(on);
  const toasts: string[] = [];
  const registered: World["registered"] = [];
  const commands: string[] = [];
  const checked: string[] = [];
  const prompts: World["prompts"] = [];
  const asked: string[] = [];

  if (verdict !== undefined) {
    // SAFETY: the tests check Bash alone, whose input is `{ command }`; `String(undefined ?? "")` covers any other.
    on("tool.check", (_$, e) => verdict(String((e.input as { command?: unknown }).command ?? "")));
  }

  if (answer !== undefined) {
    on("tool.call", { tool: "AskUserQuestion" }, (_$, e) => {
      const question = e.questions[0]?.question ?? "";

      asked.push(question);

      return { result: { questions: e.questions, answers: { [question]: answer() } } };
    });
  }

  let opened = latch();
  let poll = latch();

  on("tool.register", (_$, e) => {
    registered.push({ name: e.name, isDeferred: e.isDeferred, description: e.description });

    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } };
  });
  on("session.surfaces", () => ({ value: surfaces }));
  on("ui.open", () => {
    opened.open();
    opened = latch();

    return {
      value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: "narrow terminal" },
    };
  });
  on("ui.close", () => ({ value: undefined }));
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);

    return { value: undefined };
  });
  on("ui.log", () => ({ value: undefined }));
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  on("ui.render", ($, e) => {
    const { Box } = $.ui.resolve(e);

    return Box({ key: "engine" });
  });
  on("process.run", async () => {
    await poll.wait;
    poll = latch();

    return { value: ran("") };
  });
  on("classic.PreToolUse", (_$, e, next) => {
    if (e.tool === "Bash") checked.push(e.command);

    return next(e);
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    commands.push(e.command);

    return { result: bashRecord(bashStdout) };
  });
  on("tool.call", { tool: "Read" }, (_$, e) => ({
    result: {
      type: "text",
      file: {
        filePath: e.file_path,
        content: fileContent,
        numLines: 1,
        startLine: 1,
        totalLines: 1,
      },
    },
  }));
  on("prompt.submit", (_$, e) => {
    prompts.push({ text: e.text, context: e.context });

    return { text: e.text };
  });

  return {
    toasts,
    registered,
    opened: () => opened.wait,
    release: () => poll.open(),
    commands,
    checked,
    asked,
    prompts,
    appended: () => session.appended(),
  };
}

async function started($: Engine, on: On, options: WorldOptions = {}) {
  const world = stubWorld(on, options);

  on("session.start", () => ({ cwd: "/work/repo" }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work/repo" });

  return world;
}

/** Claude asks, the person pastes the value in the pane and saves: the tool's answer and the placeholder. */
async function kept($: Engine, world: World, value = PAT) {
  const asking = $.tool.call(ASK);

  await world.opened();
  const ui = await $.ui.mount(PANE);

  await ui.input({ key: "secret", text: value, kind: "change" });
  await ui.input({ key: "secret", text: "", kind: "submit" });
  world.release();
  const answer = await asking;

  await ui.unmount();

  return { answer, tag: String(answer.result).match(TAG)?.[0] ?? "no tag" };
}

test("the session start registers request_secret in the prompt's tool list", async ($, on) => {
  const world = await started($, on);

  expect(world.registered).toHaveLength(1);
  expect(world.registered[0]?.name).toBe("request_secret");
  expect(world.registered[0]?.isDeferred).toBe(false);
  expect(world.registered[0]?.description).toContain("single-quoted word");
});

test("the box takes the value, Claude gets a placeholder and never the value", async ($, on) => {
  const world = await started($, on);
  const asking = $.tool.call(ASK);

  await world.opened();
  const ui = await $.ui.mount(PANE);

  expect((await ui.find({ type: "Text", text: /PARENT_REPO_PAT/u }))?.text).toContain(
    "Claude is asking for PARENT_REPO_PAT",
  );
  expect(await ui.find({ type: "Text", text: "the sync workflow needs it" })).toBeDefined();
  await ui.input({ key: "secret", text: ` ${PAT} `, kind: "change" });
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

test("typing after a paste appends, and the value kept is the one typed", async ($, on) => {
  const world = await started($, on);
  const asking = $.tool.call(ASK);

  await world.opened();
  const ui = await $.ui.mount(PANE);

  await ui.input({ key: "secret", text: "abcdefgh", kind: "change" });
  await ui.input({ key: "secret", text: "••••••••i", kind: "change" });
  const field = await ui.find({ type: "Input", key: "secret" });

  expect(field?.text).not.toContain("abcdefgh");
  expect(await ui.find({ type: "Text", text: /9 characters/u })).toBeDefined();
  await ui.input({ key: "secret", text: "", kind: "submit" });
  world.release();
  const answer = String((await asking).result);

  await $.tool.call({ tool: "Bash", command: `echo '${answer.match(TAG)?.[0] ?? "no tag"}'` });
  expect(world.commands).toEqual(["echo 'abcdefghi'"]);
});

test("an edit in the middle empties the field, and a short value is not kept", async ($, on) => {
  const world = await started($, on);
  const asking = $.tool.call(ASK);

  await world.opened();
  const ui = await $.ui.mount(PANE);

  await ui.input({ key: "secret", text: "abcdefgh", kind: "change" });
  await ui.input({ key: "secret", text: "•••x•••••", kind: "change" });
  expect(await ui.find({ type: "Text", text: /edit in the middle/u })).toBeDefined();
  expect(await ui.find({ type: "Text", text: /characters ·/u })).toBeUndefined();
  await ui.input({ key: "secret", text: "short", kind: "change" });
  await ui.input({ key: "secret", text: "", kind: "submit" });
  expect(await ui.find({ type: "Text", text: /at least 8 characters/u })).toBeDefined();
  await ui.input({ key: "secret", text: "•••••-long-enough", kind: "change" });
  await ui.input({ key: "secret", text: "", kind: "submit" });
  world.release();
  const answer = String((await asking).result);

  expect(answer).toContain("(17 characters)");
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

test("a value with shell characters goes into the command quoted", async ($, on) => {
  const world = await started($, on);
  const value = "pa ss$(id)'x-long";
  const { tag } = await kept($, world, value);

  await $.tool.call({ tool: "Bash", command: `printf '%s' '${tag}' | gh secret set X` });
  expect(world.commands).toEqual([`printf '%s' 'pa ss$(id)'\\''x-long' | gh secret set X`]);
});

test("a kept value printed by a later command is hidden too", async ($, on) => {
  const world = await started($, on, { bashStdout: `url https://x:${PAT}@github.com/o/r` });
  const { tag } = await kept($, world);
  const answer = await $.tool.call({ tool: "Bash", command: "git remote -v" });

  expect(world.commands).toEqual(["git remote -v"]);
  expect(JSON.stringify(answer.result)).toContain(`https://x:${tag}@github.com/o/r`);
  expect(JSON.stringify(answer.result)).not.toContain(PAT);
});

test("a result holding no kept value comes back as it came", async ($, on) => {
  const world = await started($, on, { bashStdout: "nothing secret here" });

  await kept($, world);
  const answer = await $.tool.call({ tool: "Bash", command: "echo hi" });

  expect(JSON.stringify(answer.result)).toContain("nothing secret here");
});

test("a file read that holds a kept value comes back with the placeholder", async ($, on) => {
  const world = await started($, on, { fileContent: `TOKEN=${PAT}\n` });
  const { tag } = await kept($, world);
  const answer = await $.tool.call({ tool: "Read", file_path: "/work/repo/.env" });

  expect(JSON.stringify(answer.result)).toContain(`TOKEN=${tag}`);
  expect(JSON.stringify(answer.result)).not.toContain(PAT);
});

test("a row any door appends is hidden before the model reads it", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);

  await $.session.append({
    message: {
      type: "user",
      content: [
        { type: "text", text: `a task finished: ${PAT}` },
        { type: "tool_result", tool_use_id: "t1", content: `stdout ${PAT}` },
      ],
    },
    door: "tool-result",
    origin: { kind: "tool", tool: "Bash" },
    uuid: "row-1",
  });
  const row = JSON.stringify(world.appended().at(-1)?.message.content);

  expect(row).toContain(`a task finished: ${tag}`);
  expect(row).toContain(`stdout ${tag}`);
  expect(row).not.toContain(PAT);
});

test("a command holding the placeholder is refused when it commits, posts or chains", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);
  const commit = await $.tool.call({ tool: "Bash", command: `git commit -m '${tag}'` });

  const chained = await $.tool.call({
    tool: "Bash",
    command: `printf '%s' '${tag}' | gh secret set PAT --repo o/r && gh api repos/o/r`,
  });

  const quoted = await $.tool.call({ tool: "Bash", command: `curl -H 'Bearer ${tag}' https://a` });

  expect(commit.deny).toContain("git command that writes history");
  expect(chained.deny).toContain("`&`");
  expect(quoted.deny).toContain("whole single-quoted word");
  expect(world.commands).toEqual([]);
  const plain = await $.tool.call({ tool: "Bash", command: "gh api repos/o/r" });

  expect(plain.deny).toBeUndefined();
  expect(world.commands).toEqual(["gh api repos/o/r"]);
});

test("a placeholder the session never minted refuses the command", async ($, on) => {
  const world = await started($, on);

  await kept($, world);
  const stale = "[secret-pane:PARENT_REPO_PAT:00000000]";

  const answer = await $.tool.call({
    tool: "Bash",
    command: `printf '%s' '${stale}' | gh secret set PARENT_REPO_PAT --repo o/r`,
  });

  expect(answer.deny).toContain("no placeholder of this session");
  expect(world.commands).toEqual([]);
});

test("a background command holding the placeholder is refused", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);

  const answer = await $.tool.call({
    tool: "Bash",
    command: `printf '%s' '${tag}' | gh secret set PAT --repo o/r`,
    run_in_background: true,
  });

  expect(answer.deny).toContain("background");
  expect(world.commands).toEqual([]);
});

test("the settings hooks beneath see the command with the value in it", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);

  await $.tool.call({ tool: "Bash", command: `printf '%s' '${tag}' | gh secret set PAT` });
  expect(world.checked).toEqual([`printf '%s' '${PAT}' | gh secret set PAT`]);
});

test("a query of a permission is not the mod's: it runs nothing and asks nobody", async ($, on) => {
  const world = await started($, on, {
    verdict: () => ({ decision: "ask" }),
    answer: () => "Run it",
  });

  await kept($, world);
  const query = await $.tool.check({ tool: "Bash", input: { command: `echo '${PAT}'` } });

  expect(query.decision).toBe("ask");
  expect(world.asked).toEqual([]);
});

test("/clear forgets every value: its placeholder then refuses the command", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);

  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });

  const answer = await $.tool.call({
    tool: "Bash",
    command: `printf '%s' '${tag}' | gh secret set X`,
  });

  expect(world.commands).toEqual([]);
  expect(answer.deny ?? "not refused").toContain("no placeholder of this session");
});

test("the slot frees after an answer: a second request opens a second box", async ($, on) => {
  const world = await started($, on);
  const first = await kept($, world);
  const again = await kept($, world, "another-long-value");

  expect(first.tag).toMatch(TAG);
  expect(again.tag).toMatch(TAG);
  expect(again.tag).not.toBe(first.tag);
});

test("a narrow terminal gets the box in the band, where Enter on empty cancels", async ($, on) => {
  const world = await started($, on, { isPlaced: false });
  const asking = $.tool.call(ASK);

  await world.opened();
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
});

test("a kept value pasted into the prompt or its context is swapped for its placeholder", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);

  await $.prompt.submit({
    text: `here is the token: ${PAT}`,
    context: [`a hook's note: ${PAT}`],
    wait: false,
    origin: { kind: "composer" },
  });
  expect(world.prompts).toEqual([
    { text: `here is the token: ${tag}`, context: [`a hook's note: ${tag}`] },
  ]);
});

test("a headless run has nobody to type: the tool says so", async ($, on) => {
  await started($, on, { surfaces: [] });
  const answer = await $.tool.call(ASK);

  expect(String(answer.result)).toContain("needs an interactive session");
});

test("a session drawn on a phone alone has no box: the tool says so", async ($, on) => {
  await started($, on, { surfaces: ["mobile"] });
  const answer = await $.tool.call(ASK);

  expect(String(answer.result)).toContain("needs an interactive session");
});

test("a name that is no variable name is refused before any box opens", async ($, on) => {
  const world = await started($, on);
  const answer = await $.tool.call({ tool: TOOL, name: "9 lives", reason: "" });

  expect(String(answer.result)).toContain("is not a variable name");
  expect(world.toasts).toEqual([]);
});
