import type {
  EngineInterface,
  PromptSubmitInput,
  Register,
  ToolCallResult,
  TurnCompleteInput,
} from "claude-code";
import { atom, read, update } from "claude-code";

import type { Phase, RecordedPrompt } from "../types/index.d.ts";

const IDLE: Phase = "idle";

const NO_PROMPT: RecordedPrompt | null = null;

const phaseState = atom({ plugin: "wrap-archive", key: "phase" } as const, IDLE);

const promptState = atom({ plugin: "wrap-archive", key: "prompt" } as const, NO_PROMPT);

const isProbedState = atom({ plugin: "wrap-archive", key: "isProbed" } as const, false);

// The desktop app's session tools, as `$.mcp.call` names their server.
const APP_SERVER = "ccd_session_mgmt";

const ARCHIVE_TOOL = `mcp__${APP_SERVER}__archive_session`;

const CONSENT =
  'The user pressed "Archive" on the wrap-archive band "Task finished?" to archive this session.';

const JUDGE_MODEL = "haiku";

const JUDGE_TIMEOUT_MS = 20_000;

const JUDGE_MAX_TOKENS = 8;

const JUDGED_CHARACTERS = 4000;

const JUDGE_SYSTEM = [
  "You judge whether a coding assistant's task is finished, from the user's request and the assistant's final answer.",
  "Reply with exactly one word: done or not_done.",
  "done: the answer delivers what the request asked for and leaves nothing pending.",
  "not_done: the answer asks the user a question, presents a plan awaiting approval, proposes a follow-up or next step, reports partial work or a failure, or you cannot tell.",
].join("\n");

let judge: AbortController | undefined;

function isPersons(e: PromptSubmitInput): boolean {
  return (e.origin.kind === "composer" || e.origin.kind === "bridge") && e.isMeta !== true;
}

function judgePrompt(prompt: string, answer: string): string {
  return [
    "<request>",
    prompt.slice(0, JUDGED_CHARACTERS),
    "</request>",
    "<answer>",
    answer.slice(0, JUDGED_CHARACTERS),
    "</answer>",
  ].join("\n");
}

async function isArchiveReachable($: EngineInterface): Promise<boolean> {
  try {
    const result = await $.mcp.call(APP_SERVER, "get_session", { session_id: "self" });

    return !result.isError;
  } catch {
    // A session the app does not run has no such server: the call rejects, naming it.
    return false;
  }
}

async function evaluate($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  if ((await read($, phaseState)) !== "idle") return;
  const prompt = await read($, promptState);

  if (prompt === null || !prompt.isPersons) return;

  if (!(await read($, isProbedState))) {
    await update($, isProbedState, () => true);

    if (!(await isArchiveReachable($))) {
      await update($, phaseState, () => "inert");

      return;
    }
  }

  const controller = new AbortController();

  judge = controller;
  await update($, phaseState, () => "judging");

  const verdict = await $.model.complete(
    {
      model: JUDGE_MODEL,
      system: JUDGE_SYSTEM,
      prompt: judgePrompt(prompt.text, e.answer),
      effort: "low",
      maxTokens: JUDGE_MAX_TOKENS,
      timeoutMs: JUDGE_TIMEOUT_MS,
    },
    { signal: controller.signal },
  );

  if (judge !== controller) return;
  judge = undefined;
  const isDone = verdict.isAnswered && verdict.text.trim() === "done";

  await update($, phaseState, (phase) =>
    phase === "judging" ? (isDone ? "offering" : "idle") : phase,
  );

  if (!verdict.isAnswered && verdict.reason === "api-error") {
    $.ui.status(
      `wrap-archive: the judge failed (${verdict.error}, status ${String(verdict.status)})`,
    );
  }
}

async function evaluateReporting($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  try {
    await evaluate($, e);
  } catch (error) {
    $.ui.status(`wrap-archive: ${String(error)}`);
  }
}

function archiveText(result: ToolCallResult): string {
  if (result.deny !== undefined) return `the archive call was refused: ${result.deny}`;

  return result.text?.trim() || "the session was not archived";
}

async function archive($: EngineInterface): Promise<void> {
  try {
    // `consent` puts the press in the run's context as the person's request: the auto-mode classifier refuses a call it finds none for.
    const result = await $.tool.call({
      tool: ARCHIVE_TOOL,
      session_id: "self",
      reason: "wrap-archive: task finished",
      consent: CONSENT,
    });

    // The app answers before it stops an archived session, so its words show either way, a refusal's too.
    await update($, phaseState, () => "quiet");
    $.ui.status(`wrap-archive: ${archiveText(result)}`);
  } catch (error) {
    await update($, phaseState, () => "quiet");
    $.ui.status(`wrap-archive: the archive call failed: ${String(error)}`);
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    // A reload drops the judge this module started, along with its AbortController.
    await update($, phaseState, (phase) => (phase === "judging" ? "idle" : phase));

    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (isPersons(e)) {
      judge?.abort();
      judge = undefined;
      await update($, phaseState, (phase) => (phase === "inert" ? phase : "idle"));
      await update($, promptState, () => ({ text: e.text, isPersons: true }));
      $.ui.status(undefined);
    } else if (e.turnId === undefined) {
      await update($, promptState, () => ({ text: "", isPersons: false }));
    }

    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);

    // Detached, so the judge never holds the end of the turn.
    if (e.agentId === undefined && e.reason === "answer") void evaluateReporting($, e);

    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, phaseState)) !== "offering") return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);

    const band = Box({
      flexDirection: "row",
      gap: 1,
      children: [
        Text({ children: ["Task finished?"] }),
        Button({ key: "archive", label: "Archive", variant: "primary", onPress: () => archive($) }),
        Button({
          key: "keep",
          label: "Keep",
          onPress: () => update($, phaseState, (phase) => (phase === "offering" ? "quiet" : phase)),
        }),
      ],
    });

    // The band is shared: what the mods after this one draw stays below the offer.
    return Box({ flexDirection: "column", children: [band, await next(e)] });
  });
};
