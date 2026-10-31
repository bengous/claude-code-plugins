import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";

const PLUGIN = "cloud-pull";

const HOME = "/home/me";

const HUB_ID = "hub-session";

const PANE = {
  plugin: PLUGIN,
  component: "Pane",
  requestId: PLUGIN,
  surface: "desktop",
  props: {
    title: "Cloud sessions",
    isFocused: false,
    bodyColumns: 98,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

const BAND = {
  plugin: PLUGIN,
  component: "AbovePrompt",
  surface: "desktop",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 40,
    bodyColumns: 98,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

const cloudSession = (id: string, repo: string, title: string) => ({
  id,
  title,
  session_status: "idle",
  updated_at: "2026-01-01T00:00:00Z",
  environment_kind: "anthropic_cloud",
  session_context: {
    model: "claude-haiku-5-5",
    sources: [{ type: "git_repository", url: `https://github.com/${repo}` }],
  },
});

const SESSIONS = [
  cloudSession("session_a1", "me/app", "Fix the login"),
  cloudSession("session_b2", "me/site", "Write the blog"),
  cloudSession("session_c3", "me/app", "Add dark mode"),
];

type World = {
  readonly session: string;
  readonly turns: number;
  readonly repo: { root: string; remote: string } | null;
  readonly hub?: { sessionId: string; cwd: string };
  /** False stands for a screen too narrow to draw the pane. */
  readonly isPlaced?: boolean;
};

const REPO_SESSION: World = {
  session: "work-session",
  turns: 0,
  repo: { root: `${HOME}/Work/app`, remote: "git@github.com:me/app.git" },
};

/** Stands for the engine beneath the plugin: a computer with `me/app` cloned (and a worktree of it), `me/site` not cloned. */
async function start($: Engine, on: On, world: World) {
  const store = new Map<string, unknown>(world.hub === undefined ? [] : [["hub", world.hub]]);
  const opens: boolean[] = [];
  const isPlaced = world.isPlaced !== false;
  let isOpen = false;

  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("classic.SessionStart", () => ({}));
  on("prompt.submit", (_$, e) => ({ text: e.text }));
  on("ui.open", () => {
    opens.push(true);
    isOpen = true;

    return { value: isPlaced ? { isPlaced } : { isPlaced, reason: "narrow" } };
  });
  on("ui.panes", () => ({
    value: isOpen
      ? [{ id: PLUGIN, title: "Cloud sessions", isShown: isPlaced, isFocused: false, isPlaced }]
      : [],
  }));
  on("ui.close", () => {
    isOpen = false;

    return { value: undefined };
  });
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.render", (engine, e) => engine.ui.resolve(e).Box({ key: "engine" }));
  on("env.get", (_$, e) => ({ value: e.name === "HOME" ? HOME : undefined }));
  on("store.get", (_$, e) => ({ value: store.get(e.key) }));
  on("store.set", (_$, e) => {
    store.set(e.key, e.value);

    return { value: undefined };
  });
  on("session.id", () => ({ value: world.session }));
  on("session.turns", () => ({ value: world.turns }));
  on("session.repo", () => ({
    value: world.repo === null ? null : { ...world.repo, internal: false, name: null },
  }));
  on("session.authorize", () => ({ value: { handle: "credential", kind: "bearer" as const } }));
  on("http.fetch", () => ({
    value: { ok: true, status: 200, text: JSON.stringify({ data: SESSIONS }), headers: {} },
  }));
  on("fs.read", (_$, e) =>
    e.path === `${HOME}/.claude.json`
      ? {
          value: JSON.stringify({
            githubRepoPaths: {
              "me/app": [`${HOME}/Work/app.wt/feature`, `${HOME}/Work/app`],
              "me/site": [`${HOME}/gone/site`],
            },
          }),
        }
      : { deny: `${e.path}: missing` },
  );
  on("fs.stat", (_$, e) =>
    e.path === `${HOME}/Work/app/.git`
      ? { value: { kind: "dir", size: 0, mtimeMs: 0, isLink: false } }
      : e.path === `${HOME}/Work/app.wt/feature/.git`
        ? { value: { kind: "file", size: 40, mtimeMs: 0, isLink: false } }
        : { deny: `${e.path}: missing` },
  );

  await $.session.start({
    cwd: world.repo?.root ?? `${HOME}/Work`,
    surface: "desktop",
    isInteractive: true,
  });

  return { opens };
}

async function texts(ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) {
  return (await ui.findAll({ type: "Text" })).map((element) => element.text);
}

/** The plugin's lookups run after `session.start` returns; this waits for the band to reflect them. */
async function band($: Engine, expected: boolean) {
  for (let tries = 0; tries < 50; tries += 1) {
    const ui = await $.ui.mount(BAND);
    const button = await ui.find({ type: "Button", key: "continue-cloud" });

    if ((button !== undefined) === expected) {
      return ui;
    }

    await ui.unmount();
  }

  throw new Error(`the band never became ${expected ? "shown" : "hidden"}`);
}

test("the hub opens its pane by itself and lists every repository, grouped, with the uncloned one marked", async ($, on) => {
  const world = await start($, on, {
    session: HUB_ID,
    turns: 0,
    repo: null,
    hub: { sessionId: HUB_ID, cwd: `${HOME}/Work` },
  });

  expect(world.opens.length).toBe(1);

  for (let tries = 0; tries < 50; tries += 1) {
    const ui = await $.ui.mount(PANE);
    const shown = await texts(ui);

    if (shown.includes("3 cloud sessions")) {
      expect(shown).toContain("me/app");
      expect(shown).toContain("~/Work/app");
      expect(shown).toContain("me/site");
      expect(shown).toContain("Not cloned here");
      expect(await ui.find({ type: "Button", key: "open:session_a1" })).toBeDefined();
      expect(await ui.find({ type: "Button", key: "open:session_b2" })).toBeUndefined();
      await ui.unmount();

      return;
    }

    await ui.unmount();
  }

  throw new Error("the hub's pane never listed the sessions");
});

test("a session that is not the hub keeps to its own repository", async ($, on) => {
  await start($, on, { ...REPO_SESSION, hub: { sessionId: HUB_ID, cwd: `${HOME}/Work` } });
  const ui = await band($, true);

  expect(await texts(ui)).toContain(" · 2");
  await ui.unmount();
});

test("the band shows in a fresh session and stays hidden once closed", async ($, on) => {
  await start($, on, REPO_SESSION);
  const ui = await band($, true);
  await ui.press({ key: "dismiss-cloud" });
  await ui.unmount();

  await band($, false);
});

// An undrawn pane leaves the band to its own rule: hidden once pressed.
test("the band stays hidden once used", async ($, on) => {
  await start($, on, { ...REPO_SESSION, isPlaced: false });
  const ui = await band($, true);
  await ui.press({ key: "continue-cloud" });
  await ui.unmount();

  await band($, false);
});

test("the band leaves a session past its first prompt alone", async ($, on) => {
  await start($, on, { ...REPO_SESSION, turns: 2 });

  await band($, false);
});

test("the band hides when a second prompt is sent", async ($, on) => {
  await start($, on, { ...REPO_SESSION, turns: 1 });
  (await band($, true)).unmount();
  await $.prompt.submit({ text: "next task", wait: false, origin: { kind: "composer" } });

  await band($, false);
});

const HUB_COMMAND = {
  command: "cloud-pull",
  args: "hub",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 98 },
} as const;

/** `/cloud-pull hub` with a hub on record: it reopens it, then asks Desktop for the hub's model, answered by `answer`. */
async function reopenHub($: Engine, on: On, answer: { deny: string } | { isError: boolean }) {
  const calls: { session_id: unknown; model: unknown; consent: unknown }[] = [];

  on("process.run", (_$, e) => {
    const stdout = e.argv[0] === "uname" ? "Linux" : "claude-desktop.desktop";

    return {
      value: {
        exitCode: 0,
        stdout,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
        stream: "stdout" as const,
        text: stdout,
      },
    };
  });
  on("clock.sleep", () => ({ value: undefined }));
  on("tool.call", { tool: "mcp__ccd_session_mgmt__set_session_model" }, (_$, e) => {
    calls.push({ session_id: e["session_id"], model: e["model"], consent: e["consent"] });

    if ("deny" in answer) {
      return answer;
    }

    return answer.isError
      ? { result: "no such session", text: "no such session", isError: true as const }
      : { result: "ok", text: "ok" };
  });
  await start($, on, { ...REPO_SESSION, hub: { sessionId: HUB_ID, cwd: `${HOME}/Work` } });
  const done = await $.command.run(HUB_COMMAND);

  return { calls, text: "text" in done ? done.text : undefined };
}

test("/cloud-pull hub puts the hub on Haiku, the typed command as consent", async ($, on) => {
  const { calls, text } = await reopenHub($, on, { isError: false });

  expect(calls.length).toBe(1);
  expect(calls[0]?.session_id).toBe(`local_${HUB_ID}`);
  expect(calls[0]?.model).toBe("claude-haiku-5-5");
  expect(String(calls[0]?.consent)).toContain("/cloud-pull hub");
  expect(text).toBe(`Opened the hub "☁ Cloud sessions" in Desktop.`);
});

test("a refused model change still opens the hub, and says how to pick Haiku", async ($, on) => {
  const { calls, text } = await reopenHub($, on, { deny: "classifier said no" });

  expect(calls.length).toBe(5);
  expect(text).toContain("pick Haiku in its model menu (classifier said no)");
});
