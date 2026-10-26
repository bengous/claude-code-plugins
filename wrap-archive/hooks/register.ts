import type { EngineInterface, PromptSubmitInput, Register, TurnCompleteInput } from "claude-code";
import { atom, read, update } from "claude-code";

const phaseState = atom({ plugin: "wrap-archive", key: "phase" } as const, "idle");

const promptState = atom({ plugin: "wrap-archive", key: "prompt" } as const, null);

const isProbedState = atom({ plugin: "wrap-archive", key: "isProbed" } as const, false);

const DESKTOP_SESSION_SERVER = "ccd_session_mgmt";

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

const DONE_VERDICT = /^done[.!]?$/iu;

let judge: AbortController | undefined;

let isArchiving = false;

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
    const result = await $.mcp.call(DESKTOP_SESSION_SERVER, "get_session", { session_id: "self" });

    return !result.isError;
  } catch {
    // A session the app does not run has no such server: the call rejects, naming it.
    return false;
  }
}

// `judge` is set before the first await, so a person's prompt landing during any of them withdraws this run.
async function evaluate($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const controller = new AbortController();

  judge = controller;
  const isWithdrawn = () => judge !== controller;

  try {
    if ((await read($, phaseState)) !== "idle" || isWithdrawn()) return;
    const prompt = await read($, promptState);

    if (prompt === null || isWithdrawn()) return;

    if (!(await read($, isProbedState))) {
      await update($, isProbedState, () => true);

      if (!(await isArchiveReachable($))) {
        await update($, phaseState, () => "inert");

        return;
      }
    }

    if (isWithdrawn()) return;
    await update($, phaseState, () => "judging");

    const verdict = await $.model.complete(
      {
        model: JUDGE_MODEL,
        system: JUDGE_SYSTEM,
        prompt: judgePrompt(prompt, e.answer),
        effort: "low",
        maxTokens: JUDGE_MAX_TOKENS,
        timeoutMs: JUDGE_TIMEOUT_MS,
      },
      { signal: controller.signal },
    );

    if (isWithdrawn()) return;
    const isDone = verdict.isAnswered && DONE_VERDICT.test(verdict.text.trim());

    await update($, phaseState, (phase) =>
      phase === "judging" ? (isDone ? "offering" : "idle") : phase,
    );

    if (!verdict.isAnswered && verdict.reason === "api-error") {
      $.ui.status(
        `wrap-archive: the judge failed (${verdict.error}, status ${String(verdict.status)})`,
      );
    }
  } finally {
    if (judge === controller) judge = undefined;
  }
}

async function evaluateReporting($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  try {
    await evaluate($, e);
  } catch (error) {
    $.ui.status(`wrap-archive: ${String(error)}`);
  }
}

function contentText(content: readonly { type: string; text?: string }[]): string {
  return content
    .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
    .join(" ")
    .trim();
}

async function archive($: EngineInterface): Promise<void> {
  if (isArchiving) return;
  isArchiving = true;

  try {
    await update($, phaseState, () => "quiet");

    const result = await $.mcp.call(DESKTOP_SESSION_SERVER, "archive_session", {
      session_id: "self",
      reason: "wrap-archive: task finished",
    });

    // The app answers before it stops an archived session, so its words show either way, a refusal's too.
    $.ui.status(`wrap-archive: ${contentText(result.content) || "the session was not archived"}`);
  } catch (error) {
    $.ui.status(`wrap-archive: the archive call failed: ${String(error)}`);
  } finally {
    isArchiving = false;
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

      // Typed over a running turn, the prompt joins the request that turn answers.
      await update($, promptState, (prompt) =>
        e.turnId !== undefined && prompt !== null ? `${prompt}\n\n${e.text}` : e.text,
      );
      $.ui.status(undefined);
    } else if (e.turnId === undefined) {
      await update($, promptState, () => null);
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
    if (e.props.hasSurvey || e.props.isWorking || (await read($, phaseState)) !== "offering")
      return next(e);
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
