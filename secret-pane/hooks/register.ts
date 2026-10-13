import type { EngineInterface, Register, ToolCallResult } from "claude-code";

import {
  createVault,
  isShellActive,
  mergeTyped,
  PLUGIN,
  publishes,
  VARIABLE_NAME,
  walkStrings,
} from "./vault.ts";

export const TOOL = `mcp__${PLUGIN}__request_secret`;

export const PANE = PLUGIN;

export const FIELD = "secret";

const DOT = "•";

const WAIT_MS = 10 * 60_000;

/** A hook's own time is capped; a wait spent inside a host call is not counted, so the box is waited for in short sleeps. */
const POLL = ["sleep", "0.3"] as const;

/** Native Windows has no `sleep` executable; PowerShell's is the one every install carries. */
const POLL_WINDOWS = [
  "powershell",
  "-NoProfile",
  "-Command",
  "Start-Sleep -Milliseconds 300",
] as const;

const PANE_ROWS = 6;

/** The tools whose results a kept value could come back through on this build: a command's output, a file. */
type Reader = "Bash" | "Read";

const DESCRIPTION = [
  "Asks the user for a secret (an API key, a token, a password) in a masked box beside the transcript, so the value never enters the conversation.",
  "Answers the variable name and a placeholder of the form [secret-pane:NAME:xxxxxxxx].",
  "A placeholder written in a Bash command becomes the real value when the command runs; the value is hidden again in every Bash and Read result.",
  "A command that holds a placeholder is refused when it writes git history or sends anything to GitHub (git commit, git tag, gh api, gh pr; only gh secret takes the value), or runs in the background: split it so the command that needs the value runs alone, in the foreground.",
  "No other tool restores a placeholder. The value lives in this session's memory only: the mod writes nothing to disk, and a new session asks the user again.",
  "Use it in place of asking the user to paste a secret into the chat.",
].join(" ");

const WITHHELD = `${PLUGIN}: could not check this result for a kept value, so the result was withheld. Narrow the call (head, grep, offset) and retry.`;

const NOT_RUN = `${PLUGIN}: could not put the kept value into this command, so it was not run.`;

type Pending = {
  readonly name: string;
  readonly reason: string;
  value: string;
  answer: string | undefined;
  isInBand: boolean;
};

let pending: Pending | null = null;

const vault = createVault();

const RUN = "Run it";

const SKIP = "Don't run it";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- a tool argument is the model's own, `unknown` as the engine hands it; these reads ARE the boundary. */
function argument(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The command a permission check reads for Bash, or nothing where the input is no Bash input. */
function shellCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null || !("command" in input)) return null;

  return typeof input.command === "string" ? input.command : null;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

type ReadResult = ToolCallResult<Reader>;

type Answer = Exclude<ReadResult, { deny: string }>;

type Errored = Extract<ReadResult, { isError: true }>;

type Answered = Exclude<Answer, Errored>;

/** The tool's answer with every kept value hidden, and without `ref`: core would read its own messages verbatim with it. */
function hidden(ran: Answer, hide: (text: string) => string): ReadResult {
  if (ran.isError === true) {
    const errored: Errored = { isError: true, result: walkStrings(ran.result, hide) };

    if (ran.text !== undefined) errored.text = hide(ran.text);

    if (ran.context !== undefined) errored.context = ran.context.map(hide);

    return errored;
  }

  // SAFETY: `walkStrings` keeps a plain value's shape and rewrites its strings alone, and a tool's record is plain data.
  const result = walkStrings(ran.result, hide) as Answered["result"];
  const answered: Answered = { result };

  if (ran.context !== undefined) answered.context = ran.context.map(hide);

  return answered;
}

function entered(name: string, tag: string, length: number): string {
  return [
    `The user entered ${name} (${length} characters). The value is kept in this session's memory; you can't see it.`,
    `Write the placeholder ${tag} in a Bash command: it becomes the real value when the command runs, and the value is hidden again in every result.`,
    `A command holding the placeholder is refused when it writes git history, sends anything to GitHub (gh secret set alone takes the value), or runs in the background: run the command that needs the value alone, in the foreground. No other tool restores it.`,
    `A command that reads the value on stdin takes printf '%s' '${tag}' | <command>.`,
  ].join(" ");
}

/** Why a command holding a placeholder must not run as written, or nothing. */
function refusal(
  command: string,
  isBackground: boolean,
  handed: readonly string[],
  tagFor: (value: string) => string | undefined,
): string | undefined {
  if (publishes(command)) {
    return `${PLUGIN}: this command writes git history or sends text to GitHub, so its placeholder was not put in and the command was not run (gh secret set alone takes the value). Run the command that needs the value alone, and the publishing one without it.`;
  }

  if (isBackground) {
    return `${PLUGIN}: a background command's output never comes back through ${PLUGIN}, so its placeholder was not put in and the command was not run. Run it in the foreground.`;
  }

  const active = handed.find((value) => isShellActive(value));

  if (active !== undefined) {
    return `${PLUGIN}: the value behind ${tagFor(active) ?? "the placeholder"} holds characters the shell reads as code, so it cannot go through a command. Ask the user to enter it where it is needed themselves (gh secret set prompts for it in their own terminal); no tool of this session can carry it.`;
  }

  return undefined;
}

type Drawn = Parameters<EngineInterface["ui"]["resolve"]>[0];

/** A surface that draws an `Input`: every one but mobile, whose table has none. */
type Typed = Drawn & { readonly surface: "terminal" | "desktop" | "vscode" };

function drawBox($: EngineInterface, e: Typed, p: Pending) {
  const { Box, Text, Input } = $.ui.resolve(e);
  const focusHint = p.isInBand ? "ctrl+x then tab to focus, Enter on empty cancels" : "Esc cancels";
  const count = p.value.length === 0 ? "" : `${p.value.length} characters · `;

  return Box({
    flexDirection: "column",
    paddingX: 1,
    children: [
      Text({ bold: true, children: `Claude is asking for ${p.name}` }),
      ...(p.reason === "" ? [] : [Text({ dimColor: true, children: p.reason })]),
      Input({
        key: FIELD,
        label: "value ",
        placeholder: "paste it here, it stays masked",
        value: DOT.repeat(p.value.length),
        submitLabel: "save",
        autoFocus: true,
        onInput: (drawn) => {
          p.value = mergeTyped(p.value, drawn, DOT);
          $.ui.invalidate("ui.render");
        },
        onSubmit: () => {
          p.answer = p.value;
        },
      }),
      Text({
        dimColor: true,
        children: `${count}Enter saves · ${focusHint} · Claude never sees the value`,
      }),
    ],
  });
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: "request_secret",
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The variable name the secret is known by, such as PARENT_REPO_PAT",
          },
          reason: {
            type: "string",
            description: "One short line telling the user why it is needed",
          },
        },
        required: ["name", "reason"],
      },
      isDeferred: false,
    });

    return next(e);
  });

  on("tool.call", { tool: "mcp__secret-pane__request_secret" }, async ($, e, next) => {
    const name = argument(e.name);

    if (!VARIABLE_NAME.test(name)) {
      return {
        result: `"${name}" is not a variable name: letters, digits and underscores, not starting with a digit.`,
      };
    }

    if (!(await $.session.surfaces()).some((surface) => surface !== "mobile")) {
      return {
        result: `${PLUGIN} needs an interactive session with a terminal or a desktop to collect ${name}: nobody can type into the box here.`,
      };
    }

    if (pending !== null) {
      return {
        result: `${PLUGIN} is already waiting for ${pending.name}. Ask for one secret at a time.`,
      };
    }

    const request: Pending = {
      name,
      reason: argument(e.reason),
      value: "",
      answer: undefined,
      isInBand: false,
    };

    pending = request;

    const opened = await $.ui.open({
      id: PANE,
      title: PLUGIN,
      focus: true,
      closeOnEscape: true,
      holdToasts: true,
      rows: PANE_ROWS,
    });

    if (!opened.isPlaced) {
      request.isInBand = true;
      await $.ui.close({ id: PANE });
      $.ui.invalidate("ui.render");
      $.ui.toast(
        `Claude asks for ${name}: press ctrl+x then tab to type it in the box above the prompt`,
        {
          timeoutMs: 10_000,
        },
      );
    }

    const poll = (await $.env.get("OS")) === "Windows_NT" ? POLL_WINDOWS : POLL;
    const deadline = (await $.clock.now()) + WAIT_MS;

    try {
      while (
        request.answer === undefined &&
        !next.signal.aborted &&
        (await $.clock.now()) < deadline
      ) {
        await $.process.run(poll);
      }
    } finally {
      // An Escape of the call skips the hook with no `.catch`: the box and the slot are released here, whatever ended the wait.
      if (pending === request) pending = null;
      await $.ui.close({ id: PANE });
      $.ui.invalidate("ui.render");
    }

    const value = request.answer;

    if (value === undefined) {
      return { result: `${PLUGIN} waited for ${name} and nothing was entered. Nothing was kept.` };
    }

    if (value === "") return { result: `The user cancelled. ${name} was not kept.` };
    const tag = vault.tagOf(name, value, await $.clock.now());

    $.ui.toast(`${name} kept for this session`);

    return { result: entered(name, tag, value.length) };
  }).catch(($, _e, next) => {
    $.ui.log(`${PLUGIN}: request_secret failed: ${next.error.kind}`);

    return { result: `${PLUGIN} failed before anything was kept. Nothing was written.` };
  });

  on("ui.render", { component: "Pane", requestId: "secret-pane" }, ($, e, next) =>
    pending === null || e.surface === "mobile" ? next(e) : drawBox($, e, pending),
  );

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) =>
    pending === null || !pending.isInBand || e.surface === "mobile"
      ? next(e)
      : drawBox($, e, pending),
  );

  on("ui.close", (_$, e, next) => {
    // A close before Enter is a cancel; one after it (the person's Escape in the poll's window, or the hook's own) changes nothing.
    if (e.id === PANE && pending !== null && !pending.isInBand && pending.answer === undefined) {
      pending.answer = "";
    }

    return next(e);
  }).catch((_$, e, next) => next(e));

  // The permission is decided on the command as it runs, value in: when the session would ask, the
  // mod asks instead, the placeholder on show, so no dialog and no "always allow" rule carries the value.
  on("tool.check", { tool: "Bash" }, async ($, e, next) => {
    const command = shellCommand(e.input);

    if (command === null || vault.isEmpty()) return next(e);
    const shown = vault.hide(command);

    if (shown === command) return next(e);
    const verdict = await next(e);

    if (verdict.decision !== "ask") return verdict;

    const choice = await $.ui
      .ask(`${PLUGIN}: run this command, the placeholder standing for the kept value?\n${shown}`, [
        RUN,
        SKIP,
      ])
      .catch(() => SKIP);

    return choice === RUN
      ? {
          decision: "allow",
          reason: `${PLUGIN}: the person approved the command, its placeholder on show`,
        }
      : { decision: "deny", reason: `${PLUGIN}: the person refused the command` };
  }).catch((_$, e, next) => {
    const command = shellCommand(e.input);

    if (command === null || vault.isEmpty() || vault.hide(command) === command) return next(e);

    return {
      decision: "deny",
      reason: `${PLUGIN}: could not put this command to the person, so it is refused`,
    };
  });

  on("tool.call", { tool: ["Bash", "Read"] }, async ($, e, next) => {
    if (vault.isEmpty()) return next(e);
    const hide = (text: string) => vault.hide(text);
    let input = e;
    let handed: readonly string[] = [];

    if (e.tool === "Bash") {
      const restored = vault.restore(e.command);

      handed = restored.handed;

      if (handed.length > 0) {
        const why = refusal(e.command, e.run_in_background === true, handed, vault.tagFor);

        if (why !== undefined) return { deny: why };
        input = { ...e, command: restored.text };
      }
    }

    const ran = await next(input);

    if (ran.deny !== undefined) return { deny: hide(ran.deny) };

    if (handed.length > 0) {
      $.ui.notice(e.tool_use_id, `${PLUGIN}: ${handed.length} value(s) put in and hidden again`);
    }

    return hidden(ran, hide);
  }).catch((_$, e, next) => {
    if (vault.isEmpty()) return next(e);

    return { deny: next.called ? WITHHELD : NOT_RUN };
  });

  on("prompt.submit", ($, e, next) => {
    if (vault.isEmpty()) return next(e);
    const text = vault.hide(e.text);

    if (text === e.text) return next(e);
    $.ui.toast(`${PLUGIN}: hid a kept value from the prompt`);

    return next({ ...e, text });
  }).catch((_$, e, next) => {
    if (next.called || vault.isEmpty()) return next(e);

    return { drop: `${PLUGIN}: could not check this prompt for a kept value, so it was not sent.` };
  });
};
