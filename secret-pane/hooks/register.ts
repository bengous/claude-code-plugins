import type { EngineInterface, Register, ToolCallResult } from "claude-code";

import { restoreCommand } from "./shell.ts";
import { createVault, entered, mergeTyped, PLUGIN, VARIABLE_NAME, walkStrings } from "./vault.ts";

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

const PANE_ROWS = 7;

/** The tools whose stored record can hold a command's output or a file's text. */
type Reader = "Bash" | "Read" | "Edit" | "NotebookEdit" | "Monitor" | "GetTask" | "LSP";

const RESTORE_RULES = [
  "Write the placeholder as a whole single-quoted word, in one command or one pipe of two:",
  "printf '%s' '<placeholder>' | gh secret set NAME --repo org/repo, or curl --oauth2-bearer '<placeholder>' https://...",
  "A command is refused when a placeholder stands anywhere else or is no placeholder of this session; when it holds ; & && || $ ( ) a backtick, a new line or a second pipe;",
  "when it goes through a wrapper (sh, bash, env, xargs, sudo...), a git command that writes history, or a gh command other than gh secret; and when it runs in the background.",
].join(" ");

const DESCRIPTION = [
  "Asks the user for a secret (an API key, a token, a password) in a masked box beside the transcript, so the value never enters the conversation.",
  "Answers the variable name and a placeholder of the form [secret-pane:NAME:xxxxxxxx], which becomes the real value inside a Bash command; the value is hidden again in everything that comes back.",
  RESTORE_RULES,
  "No other tool restores a placeholder. The value lives in this session's memory only: the mod writes nothing to disk, and a new session or /clear asks the user again.",
  "Use it in place of asking the user to paste a secret into the chat.",
].join(" ");

const WITHHELD = `${PLUGIN}: could not check this result for a kept value, so the result was withheld. Narrow the call (head, grep, offset) and retry.`;

const NOT_RUN = `${PLUGIN}: could not put the kept value into this command, so it was not run.`;

const BLOCK_WITHHELD = `[${PLUGIN} withheld this text: the check for a kept value failed]`;

const RUN = "Run it";

const SKIP = "Don't run it";

type Pending = {
  readonly name: string;
  readonly reason: string;
  value: string;
  error: string | null;
  answer: string | undefined;
  isInBand: boolean;
};

let pending: Pending | null = null;

const vault = createVault();

/** Each command restored for a call in flight, mapped to the command as Claude wrote it. */
const asWritten = new Map<string, string>();

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

function answerText(name: string, tag: string, length: number): string {
  return [
    `The user entered ${name} (${length} characters). The value is kept in this session's memory; you can't see it. Its placeholder: ${tag}.`,
    RESTORE_RULES,
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
          const merged = mergeTyped(p.value, drawn, DOT);

          p.value = merged ?? "";
          p.error =
            merged === null
              ? "an edit in the middle of the field cannot be read: the field was emptied, paste the value again"
              : null;
          $.ui.invalidate("ui.render");
        },
        onSubmit: () => {
          if (p.isInBand && p.value.trim() === "") {
            p.answer = "";

            return;
          }

          const kept = entered(p.value);

          if (kept.kind === "kept") p.answer = kept.value;
          else p.error = kept.why;
          $.ui.invalidate("ui.render");
        },
      }),
      ...(p.error === null ? [] : [Text({ color: "yellow", children: p.error })]),
      Text({
        dimColor: true,
        children: `${count}Enter saves · ${focusHint} · Claude never sees the value`,
      }),
    ],
  });
}

/** Every text a row carries the model reads, with each kept value hidden; the row itself when none was. */
function hiddenContent<B extends { readonly type: string }>(
  content: readonly B[],
  hide: (text: string) => string,
): B[] {
  return content.map((block) => {
    if (block.type !== "text" && block.type !== "tool_result") return block;

    // SAFETY: a text block's and a tool_result's content are plain data, and walkStrings keeps their shape.
    return walkStrings(block, hide) as B;
  });
}

function forget(): void {
  vault.clear();
  asWritten.clear();
  pending = null;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    forget();
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

  // A /clear ends the conversation with no session.start after it: the values go with it.
  on("session.end", (_$, e, next) => {
    forget();

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
      error: null,
      answer: undefined,
      isInBand: false,
    };

    pending = request;

    try {
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
          { timeoutMs: 10_000 },
        );
      }

      const poll = (await $.env.get("OS")) === "Windows_NT" ? POLL_WINDOWS : POLL;
      const deadline = (await $.clock.now()) + WAIT_MS;

      while (
        request.answer === undefined &&
        !next.signal.aborted &&
        (await $.clock.now()) < deadline
      ) {
        await $.process.run(poll);
      }
    } finally {
      // Whatever ends the wait, an Escape of the call included (it skips the hook with no `.catch`), the slot and the box go.
      if (pending === request) pending = null;
      await $.ui.close({ id: PANE }).catch(() => {});
      $.ui.invalidate("ui.render");
    }

    const value = request.answer;

    if (value === undefined) {
      return { result: `${PLUGIN} waited for ${name} and nothing was entered. Nothing was kept.` };
    }

    if (value === "") return { result: `The user cancelled. ${name} was not kept.` };
    const tag = vault.tagOf(name, value, await $.clock.now());

    $.ui.toast(`${name} kept for this session`);

    return { result: answerText(name, tag, value.length) };
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

  // The permission is decided on the command as it runs, value in. On a real call the mod restored,
  // an ask is put to the person by the mod, the command as Claude wrote it on show: no dialog and no
  // "always allow" rule carries the value, and in auto mode the classifier never reads it.
  on("tool.check", { tool: "Bash" }, async ($, e, next) => {
    const command = shellCommand(e.input);

    const written =
      e.tool_use_id === undefined || command === null ? undefined : asWritten.get(command);

    if (written === undefined) return next(e);
    const verdict = await next(e);

    if (verdict.decision !== "ask") return verdict;

    const choice = await $.ui
      .ask(`${PLUGIN}: run this command? Each placeholder stands for a kept value.\n${written}`, [
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

    if (command === null || !asWritten.has(command)) return next(e);

    return {
      decision: "deny",
      reason: `${PLUGIN}: could not put this command to the person, so it is refused`,
    };
  });

  on(
    "tool.call",
    { tool: ["Bash", "Read", "Edit", "NotebookEdit", "Monitor", "GetTask", "LSP"] },
    async (_$, e, next) => {
      let input = e;
      let restoredCommand: string | null = null;

      // An empty vault still reads the command: a placeholder of an earlier session would run as text.
      if (e.tool === "Bash") {
        const restoration = restoreCommand(e.command, vault.valueOf);

        if (restoration.kind === "refused") {
          return {
            deny: `${PLUGIN}: the command was not run: ${restoration.why}. ${RESTORE_RULES}`,
          };
        }

        if (restoration.kind === "restored") {
          if (e.run_in_background === true) {
            return {
              deny: `${PLUGIN}: the command was not run: a background command's output is written to disk and read back past the mod. Run it in the foreground.`,
            };
          }

          restoredCommand = restoration.command;
          asWritten.set(restoredCommand, e.command);
          input = { ...e, command: restoredCommand };
        }
      }

      if (vault.isEmpty()) return next(input);
      let changed = false;

      const hide = (text: string) => {
        const out = vault.hide(text);

        if (out !== text) changed = true;

        return out;
      };

      try {
        const ran = await next(input);

        if (ran.deny !== undefined) {
          const deny = hide(ran.deny);

          return changed ? { deny } : ran;
        }

        const answer = hidden(ran, hide);

        return changed ? answer : ran;
      } finally {
        if (restoredCommand !== null) asWritten.delete(restoredCommand);
      }
    },
  ).catch((_$, e, next) => {
    const carriesTag = e.tool === "Bash" && e.command.includes("[secret-pane:");

    if (vault.isEmpty() && !carriesTag) return next(e);

    return { deny: next.called ? WITHHELD : NOT_RUN };
  });

  // The net under every door a text reaches the model by: a tool's result, a task's notification,
  // a hook's context, a prompt. Only a row's text blocks and tool_result content may be rewritten.
  on("session.append", (_$, e, next) => {
    if (vault.isEmpty()) return next(e);
    let changed = false;

    const hide = (text: string) => {
      const out = vault.hide(text);

      if (out !== text) changed = true;

      return out;
    };

    const content = hiddenContent(e.message.content, hide);

    return changed ? next({ ...e, message: { ...e.message, content } }) : next(e);
  }).catch((_$, e, next) => {
    if (next.called || vault.isEmpty()) return next(e);

    const content = hiddenContent(e.message.content, () => BLOCK_WITHHELD);

    return next({ ...e, message: { ...e.message, content } });
  });

  on("prompt.submit", ($, e, next) => {
    if (vault.isEmpty()) return next(e);
    const text = vault.hide(e.text);
    const context = e.context?.map((block) => vault.hide(block));

    const contextChanged =
      context !== undefined && context.some((block, at) => block !== e.context?.[at]);

    if (text === e.text && !contextChanged) return next(e);
    $.ui.toast(`${PLUGIN}: hid a kept value from the prompt`);

    return next(context === undefined ? { ...e, text } : { ...e, text, context });
  }).catch((_$, e, next) => {
    if (next.called || vault.isEmpty()) return next(e);

    return { drop: `${PLUGIN}: could not check this prompt for a kept value, so it was not sent.` };
  });
};
