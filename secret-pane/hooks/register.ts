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

const PANE_ROWS = 6;

const DESCRIPTION = [
  "Asks the user for a secret (an API key, a token, a password) in a masked box beside the transcript, so the value never enters the conversation.",
  "Answers the variable name and a placeholder of the form [secret-pane:NAME:xxxxxxxx].",
  "A placeholder written in a Bash command becomes the real value when the command runs and is hidden again in the command's output; it stays a placeholder in a command that commits, tags or posts to GitHub (git commit, gh issue, gh pr, gh api), and in every other tool.",
  "The value lives in this session's memory only: nothing is written to disk, and a new session asks the user again.",
  "Use it in place of asking the user to paste a secret into the chat.",
].join(" ");

const WITHHELD = `${PLUGIN}: could not check this result for the secret it was handed, so the result was withheld. Narrow the command (head, grep) and retry.`;

type Pending = {
  readonly name: string;
  readonly reason: string;
  value: string;
  answer: string | undefined;
  isInBand: boolean;
};

let pending: Pending | null = null;

const vault = createVault();

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- a tool argument is the model's own, `unknown` as the engine hands it; this read IS the boundary. */
function argument(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

type BashAnswer = Exclude<ToolCallResult<"Bash">, { deny: string }>;

type BashErrored = Extract<ToolCallResult<"Bash">, { isError: true }>;

type BashAnswered = Exclude<BashAnswer, BashErrored>;

/** The tool's answer with the values it was handed hidden again, and without `ref`: core would read its own messages verbatim with it. */
function hidden(ran: BashAnswer, hide: (text: string) => string): ToolCallResult<"Bash"> {
  if (ran.isError === true) {
    const errored: BashErrored = { isError: true, result: walkStrings(ran.result, hide) };

    if (ran.text !== undefined) errored.text = hide(ran.text);

    if (ran.context !== undefined) errored.context = ran.context.map(hide);

    return errored;
  }

  // SAFETY: `walkStrings` keeps a plain value's shape and rewrites its strings alone, and Bash's record is plain data.
  const result = walkStrings(ran.result, hide) as BashAnswered["result"];
  const answered: BashAnswered = { result };

  if (ran.context !== undefined) answered.context = ran.context.map(hide);

  return answered;
}

function entered(name: string, tag: string, length: number): string {
  return [
    `The user entered ${name} (${length} characters). The value is kept in this session's memory; you can't see it.`,
    `Write the placeholder ${tag} in a Bash command: it becomes the real value when the command runs and is hidden again in the output.`,
    `It is not restored in a command that commits, tags or posts to GitHub, nor in any other tool. A command that reads the value on stdin takes printf '%s' '${tag}' | <command>.`,
  ].join(" ");
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

    if ((await $.session.surfaces()).length === 0) {
      return {
        result: `${PLUGIN} needs an interactive session to collect ${name}: nobody can type into the box here.`,
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

    const deadline = (await $.clock.now()) + WAIT_MS;

    while (
      request.answer === undefined &&
      !next.signal.aborted &&
      (await $.clock.now()) < deadline
    ) {
      await $.process.run(POLL);
    }

    const value = request.answer;

    pending = null;
    await $.ui.close({ id: PANE });
    $.ui.invalidate("ui.render");

    if (value === undefined) {
      return { result: `${PLUGIN} waited for ${name} and nothing was entered. Nothing was kept.` };
    }

    if (value === "") return { result: `The user cancelled. ${name} was not kept.` };
    const tag = vault.tagOf(name, value, await $.clock.now());

    $.ui.toast(`${name} kept for this session`);

    return { result: entered(name, tag, value.length) };
  }).catch(($, _e, next) => {
    pending = null;
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
    if (e.id === PANE && pending !== null && !pending.isInBand) pending.answer = "";

    return next(e);
  }).catch((_$, e, next) => next(e));

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (vault.isEmpty() || publishes(e.command)) return next(e);
    const { text: command, handed } = vault.restore(e.command);

    if (handed.length === 0) return next(e);
    const active = handed.find((value) => isShellActive(value));

    if (active !== undefined) {
      return {
        deny: `${PLUGIN}: ${vault.hide(active, [active])} holds characters the shell reads as code, so it was not put into Bash. Write it to a file with the Write tool and have the command read the file instead.`,
      };
    }

    const hide = (text: string) => vault.hide(text, handed);
    const ran = await next({ ...e, command });

    if (ran.deny !== undefined) return { deny: hide(ran.deny) };
    $.ui.notice(e.tool_use_id, `${PLUGIN}: ${handed.length} value(s) put in and hidden again`);

    return hidden(ran, hide);
  }).catch((_$, e, next) => {
    if (vault.isEmpty()) return next(e);

    return next.called
      ? { deny: WITHHELD }
      : { deny: `${PLUGIN}: could not put the secret into this command, so it was not run.` };
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
