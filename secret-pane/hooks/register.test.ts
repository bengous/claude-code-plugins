import type { FsStat, On, RenderSurface } from "claude-code";
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

function ran(stdout: string, exitCode = 0, stderr = "") {
  return { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false };
}

/** The git subcommand of the mod's own run, past its `-c` settings and their values. */
function verbOf(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-") && !arg.includes("="));
}

/** A clean repository at /work/repo: its root, no change, no untracked file. */
function cleanRepo(args: readonly string[]) {
  return ran(args.includes("rev-parse") ? "/work/repo\n" : "");
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
  /** The git commands the mod ran itself, the scan's. */
  readonly gitRuns: (readonly string[])[];
  /** The files a Write, an Edit or a NotebookEdit reached. */
  readonly written: string[];
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
  /** What the mod's own git answers, its arguments after `git`; none, a clean repository. */
  readonly git?: (args: readonly string[]) => ReturnType<typeof ran>;
  /** What a `$.fs.read` of the mod finds, by path. */
  readonly files?: Readonly<Record<string, string>>;
  /** What a `$.fs.stat` answers for a path that is no small regular file, which a read of it rejects. */
  readonly stats?: Readonly<Record<string, FsStat>>;
  /** The paths `$.fs.exists` answers false for. */
  readonly missing?: readonly string[];
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
    git = cleanRepo,
    files = {},
    stats = {},
    missing = [],
    answer,
  }: WorldOptions = {},
): World {
  mock.clock(on, { now: NOW });
  mock.env(on, {});
  const session = mock.session(on);
  const toasts: string[] = [];
  const registered: World["registered"] = [];
  const commands: string[] = [];
  const gitRuns: (readonly string[])[] = [];
  const written: string[] = [];
  const checked: string[] = [];
  const prompts: World["prompts"] = [];
  const asked: string[] = [];
  const unreadable = Object.keys(stats);

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
  on("process.run", async (_$, e) => {
    if (e.argv[0] === "git") {
      gitRuns.push(e.argv.slice(1));

      return { value: git(e.argv.slice(1)) };
    }

    await poll.wait;
    poll = latch();

    return { value: ran("") };
  });
  on("fs.stat", (_$, e) => ({
    value: stats[e.path] ?? {
      kind: "file",
      size: files[e.path]?.length ?? 0,
      mtimeMs: 0,
      isLink: false,
    },
  }));
  on("fs.read", (_$, e) => {
    if (unreadable.includes(e.path)) throw new Error(`${e.path}: EISDIR or over 4 MiB`);

    return { value: files[e.path] ?? "" };
  });
  on("fs.exists", (_$, e) => ({ value: !missing.includes(e.path) }));
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
  on("tool.call", { tool: "Write" }, (_$, e) => {
    written.push(e.file_path);

    return {
      result: {
        type: "update",
        filePath: e.file_path,
        content: e.content,
        structuredPatch: [],
        originalFile: fileContent,
      },
    };
  });
  on("tool.call", { tool: "Edit" }, (_$, e) => {
    written.push(e.file_path);

    return {
      result: {
        filePath: e.file_path,
        oldString: e.old_string,
        newString: e.new_string,
        originalFile: fileContent,
        structuredPatch: [],
        userModified: false,
        replaceAll: false,
      },
    };
  });
  on("tool.call", { tool: "NotebookEdit" }, (_$, e) => {
    written.push(e.notebook_path);

    return {
      result: {
        new_source: e.new_source,
        cell_type: "code",
        language: "python",
        edit_mode: "replace",
        notebook_path: e.notebook_path,
        original_file: fileContent,
        updated_file: "",
      },
    };
  });
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
    gitRuns,
    written,
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

test("a placeholder of this session in a written file is refused, with the Bash way to write it", async ($, on) => {
  const world = await started($, on);
  const { tag } = await kept($, world);

  const write = await $.tool.call({
    tool: "Write",
    file_path: "/work/repo/.env",
    content: `PARENT_REPO_PAT=${tag}\n`,
  });

  const edit = await $.tool.call({
    tool: "Edit",
    file_path: "/work/repo/.env",
    old_string: "PARENT_REPO_PAT=",
    new_string: `PARENT_REPO_PAT=${tag}`,
  });

  const cell = await $.tool.call({
    tool: "NotebookEdit",
    notebook_path: "/work/repo/a.ipynb",
    new_source: `token = "${tag}"`,
  });

  expect(write.deny).toContain(`printf 'PARENT_REPO_PAT=%s\\n' '${tag}' >> .env`);
  expect(write.deny).toContain("write PARENT_REPO_PAT");
  expect(edit.deny).toContain("the file was not written");
  expect(cell.deny).toContain("the file was not written");
  expect(world.written).toEqual([]);
});

test("a placeholder this session never minted is written as text, an example", async ($, on) => {
  const world = await started($, on);

  await kept($, world);

  const answer = await $.tool.call({
    tool: "Write",
    file_path: "/work/repo/README.md",
    content: "Claude gets [secret-pane:PARENT_REPO_PAT:3f9a1c2e].\n",
  });

  expect(answer.deny).toBeUndefined();
  expect(world.written).toEqual(["/work/repo/README.md"]);
});

test("a Write over a file that held a kept value keeps its placeholder in the record", async ($, on) => {
  const world = await started($, on, { fileContent: `TOKEN=${PAT}\n` });
  const { tag } = await kept($, world);

  const answer = await $.tool.call({
    tool: "Write",
    file_path: "/work/repo/.env",
    content: "TOKEN=rotated\n",
  });

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

  expect(commit.deny).toContain("`git commit` may write the value into history");
  expect(chained.deny).toContain("`&`");
  expect(quoted.deny).toContain("whole single-quoted word");
  expect(world.commands).toEqual([]);
  const plain = await $.tool.call({ tool: "Bash", command: "gh api repos/o/r" });

  expect(plain.deny).toBeUndefined();
  expect(world.commands).toEqual(["gh api repos/o/r"]);
});

test("a commit is refused while a change it could carry holds a kept value, naming the file", async ($, on) => {
  const world = await started($, on, {
    git: (args) => (args.includes("ls-files") ? ran(".env\0") : cleanRepo(args)),
    files: { "/work/repo/.env": `TOKEN=${PAT}\n` },
  });

  await kept($, world);
  const answer = await $.tool.call({ tool: "Bash", command: "git add -A && git commit -m t" });

  expect(answer.deny).toContain("`git commit` may commit or publish");
  expect(answer.deny).toContain(".env (untracked: add it to .gitignore)");
  expect(world.commands).toEqual([]);
});

test("a tracked file holding a kept value is named with the quoted command that stops tracking it", async ($, on) => {
  const diff = [
    "diff --git a/my file.txt b/my file.txt",
    "+++ b/my file.txt\t",
    "@@ -0,0 +1 @@",
    `+${PAT}`,
    "",
  ];

  const world = await started($, on, {
    git: (args) => (args.includes("--cached") ? ran(diff.join("\n")) : cleanRepo(args)),
  });

  await kept($, world);
  const answer = await $.tool.call({ tool: "Bash", command: "git commit -m t" });

  expect(answer.deny).toContain(
    "my file.txt (tracked: take the value out, or stop tracking it with git rm --cached 'my file.txt' and add it to .gitignore)",
  );
});

test("a commit whose changes hold no kept value runs, and a local git runs unscanned", async ($, on) => {
  const world = await started($, on);

  await kept($, world);
  await $.tool.call({ tool: "Bash", command: "git status" });
  expect(world.gitRuns).toEqual([]);
  const commit = await $.tool.call({ tool: "Bash", command: "git commit -am t" });

  expect(commit.deny).toBeUndefined();
  expect(world.commands).toEqual(["git status", "git commit -am t"]);
  expect(world.gitRuns.map(verbOf)).toEqual(["rev-parse", "diff", "diff", "ls-files"]);
  expect(world.gitRuns.every((args) => args.join(" ").includes("-c core.fsmonitor=false"))).toBe(
    true,
  );
});

test("a scan that cannot read the changes refuses the command, saying why", async ($, on) => {
  const world = await started($, on, {
    git: (args) =>
      args.includes("rev-parse") ? ran("", 128, "fatal: not a git repository\n") : cleanRepo(args),
  });

  await kept($, world);
  const answer = await $.tool.call({ tool: "Bash", command: "cd /tmp/x && git commit -m t" });

  expect(answer.deny).toContain(
    "that check failed: git rev-parse --show-toplevel exited 128 in /tmp/x: fatal: not a git repository",
  );
  expect(world.commands).toEqual([]);
});

test("outside any repository gh runs, unless it is handed a file that holds a kept value", async ($, on) => {
  const world = await started($, on, {
    git: () =>
      ran("", 128, "fatal: not a git repository (or any of the parent directories): .git\n"),
    files: { "/tmp/x/.env": `TOKEN=${PAT}\n` },
  });

  await kept($, world);
  const api = await $.tool.call({ tool: "Bash", command: "gh api user" });
  const gist = await $.tool.call({ tool: "Bash", command: "cd /tmp/x && gh gist create .env" });

  expect(api.deny).toBeUndefined();
  expect(gist.deny).toContain(
    "/tmp/x/.env (read by the command: leave it out, or take the value out of it)",
  );
  expect(world.commands).toEqual(["gh api user"]);
});

test("a message or body file that holds a kept value refuses the commit or the pull request", async ($, on) => {
  const world = await started($, on, {
    files: { "/tmp/msg": `Uses ${PAT}\n`, "/tmp/pr-body.md": `## Summary\nSets ${PAT}\n` },
  });

  await kept($, world);
  const commit = await $.tool.call({ tool: "Bash", command: "git commit -F /tmp/msg" });

  const pr = await $.tool.call({
    tool: "Bash",
    command: "gh pr create --title 'Sync secret' --body-file /tmp/pr-body.md",
  });

  expect(commit.deny).toContain("/tmp/msg (read by the command");
  expect(pr.deny).toContain("/tmp/pr-body.md (read by the command");
  expect(world.commands).toEqual([]);
});

test("an untracked directory or a file over a read's limit is skipped, and the commit runs", async ($, on) => {
  const directory: FsStat = { kind: "dir", size: 0, mtimeMs: 0, isLink: false };
  const large: FsStat = { kind: "file", size: 5 * 1024 * 1024, mtimeMs: 0, isLink: false };

  const world = await started($, on, {
    git: (args) => (args.includes("ls-files") ? ran("sub/\0big.bin\0") : cleanRepo(args)),
    stats: { "/work/repo/sub/": directory, "/work/repo/big.bin": large },
  });

  await kept($, world);
  const commit = await $.tool.call({ tool: "Bash", command: "git commit -am t" });

  expect(commit.deny).toBeUndefined();
  expect(world.commands).toEqual(["git commit -am t"]);
});

test("a commit in a directory the same command makes is refused, saying to make it first", async ($, on) => {
  const world = await started($, on, { missing: ["/tmp/new"] });

  await kept($, world);

  const answer = await $.tool.call({
    tool: "Bash",
    command: "mkdir /tmp/new && cd /tmp/new && git init && git commit --allow-empty -m x",
  });

  expect(answer.deny).toContain("/tmp/new does not exist yet: run the command that makes it");
  expect(world.commands).toEqual([]);
});

test("with no value kept, a commit runs unscanned", async ($, on) => {
  const world = await started($, on);

  await $.tool.call({ tool: "Bash", command: "git commit -am t" });
  expect(world.gitRuns).toEqual([]);
  expect(world.commands).toEqual(["git commit -am t"]);
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
