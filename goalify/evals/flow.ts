import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type EvalCase,
  type JudgeVerdict,
  type Score,
  judgePrompt,
  judgeSchema,
  judgeScores,
  lineScores,
} from "./grade.ts";

const EVALS_DIR = import.meta.dirname;

const PLUGIN_DIR = resolve(EVALS_DIR, "..");

const JUDGE_MODEL = "claude-opus-5-5";

type Usage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
};

type Turn = {
  readonly role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  readonly content: string;
  readonly name?: string;
};

type ModelUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUSD: number;
};

type ToolInput = {
  readonly [argument: string]: ToolInput | readonly ToolInput[] | string | number | boolean | null;
};

type ContentBlock = {
  readonly type: "text" | "tool_use" | "tool_result" | "thinking";
  readonly text?: string;
  readonly name?: string;
  readonly input?: ToolInput;
  readonly content?: string | ContentBlock[];
};

function textOf(content: string | ContentBlock[]): string {
  return Array.isArray(content) ? JSON.stringify(content, null, 2) : content;
}

type StreamEvent = {
  readonly type: "system" | "assistant" | "user" | "result" | "rate_limit_event";
  readonly subtype?: string;
  readonly message?: { readonly content?: string | ContentBlock[] };
  readonly result?: string;
  readonly structured_output?: JudgeVerdict;
  readonly stop_reason?: string;
  readonly num_turns?: number;
  readonly usage?: Partial<Usage>;
  readonly modelUsage?: Record<string, ModelUsage>;
  readonly is_error?: boolean;
};

type ClaudeRun = {
  readonly result: string;
  readonly structured: JudgeVerdict | undefined;
  readonly model: string;
  readonly usage: Usage;
  readonly stopReason: string;
  readonly transcript: readonly Turn[];
  readonly toolCalls: number;
  readonly numTurns: number;
};

type Ctx = { readonly model?: string; readonly variant: string };

export type RunResult = {
  readonly output: string;
  readonly transcript: readonly Turn[];
  readonly model: string;
  readonly usage: Usage;
  readonly stop_reason: string;
  readonly tool_calls: number;
  readonly num_turns: number;
};

export type Perf = { readonly tool_calls: number; readonly num_turns: number };

export type Grade = {
  readonly grade: Record<string, Score>;
  readonly explanation: Record<string, string>;
  readonly judge_model: string;
  readonly judge_usage: Usage;
};

function usageOf(partial: Partial<Usage> | undefined): Usage {
  return {
    input_tokens: partial?.input_tokens ?? 0,
    output_tokens: partial?.output_tokens ?? 0,
    cache_read_input_tokens: partial?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: partial?.cache_creation_input_tokens ?? 0,
  };
}

function servedModel(
  modelUsage: Record<string, ModelUsage> | undefined,
  requested: string,
): string {
  const models = Object.keys(modelUsage ?? {});

  return models.find((model) => model === requested) ?? models[0] ?? requested;
}

function blocksOf(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (content === undefined) return [];

  if (Array.isArray(content)) return content;

  return [{ type: "text", text: textOf(content) }];
}

function turnsOf(event: StreamEvent): readonly Turn[] {
  const turns: Turn[] = [];

  for (const block of blocksOf(event.message?.content)) {
    if (event.type === "assistant" && block.type === "text" && block.text) {
      turns.push({ role: "assistant", content: block.text });
    } else if (event.type === "assistant" && block.type === "tool_use") {
      turns.push({
        role: "tool_call",
        name: block.name ?? "tool",
        content: JSON.stringify(block.input ?? {}, null, 2),
      });
    } else if (event.type === "user" && block.type === "tool_result") {
      turns.push({ role: "tool_result", content: textOf(block.content ?? "") });
    } else if (event.type === "user" && block.type === "text" && block.text) {
      turns.push({ role: "user", content: block.text });
    }
  }

  return turns;
}

async function runClaude(
  args: readonly string[],
  prompt: string,
  cwd: string,
  requested: string,
): Promise<ClaudeRun> {
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--model",
      requested,
      "--output-format",
      "stream-json",
      "--verbose",
      ...args,
      prompt,
    ],
    { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const transcript: Turn[] = [{ role: "user", content: prompt }];
  let result: StreamEvent | undefined;
  let toolCalls = 0;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // SAFETY: each line of `claude -p --output-format stream-json` is one event of the Claude Code SDK message stream, read for the fields named in StreamEvent.
    const event = JSON.parse(line) as StreamEvent;

    if (event.type === "result") result = event;
    const turns = turnsOf(event);

    toolCalls += turns.filter((turn) => turn.role === "tool_call").length;
    transcript.push(...turns);
  }

  if (result === undefined) {
    throw new Error(`claude exited ${exitCode} with no result line: ${stderr.slice(0, 500)}`);
  }

  if (result.is_error === true || result.subtype !== "success") {
    throw new Error(
      `claude result ${result.subtype ?? "unknown"}: ${(result.result ?? "").slice(0, 500)}`,
    );
  }

  return {
    result: result.result ?? "",
    structured: result.structured_output,
    model: servedModel(result.modelUsage, requested),
    usage: usageOf(result.usage),
    stopReason: result.stop_reason ?? "end_turn",
    transcript,
    toolCalls,
    numTurns: result.num_turns ?? 0,
  };
}

function caseCwd(evalCase: EvalCase): Promise<string> {
  if (evalCase.cwd === "empty") return mkdtemp(join(tmpdir(), `goalify-eval-${evalCase.id}-`));

  return Promise.resolve(evalCase.cwd.replace(/^~(?=\/)/u, homedir()));
}

export async function loadCases(): Promise<EvalCase[]> {
  const text = await readFile(join(EVALS_DIR, "cases.json"), "utf8");
  // SAFETY: cases.json is written by hand in this directory, one EvalCase per entry, and reviewed with the inputs.
  const cases = JSON.parse(text) as EvalCase[];
  const only = process.env.GOALIFY_EVAL_CASES;

  if (only === undefined || only === "") return cases;
  const wanted = new Set(only.split(","));

  return cases.filter((evalCase) => wanted.has(evalCase.id));
}

export async function runCase(evalCase: EvalCase, ctx: Ctx): Promise<RunResult> {
  if (ctx.model === undefined)
    throw new Error("--model is required: the served-model check needs a requested id");

  const run = await runClaude(
    ["--plugin-dir", PLUGIN_DIR, "--permission-mode", "plan"],
    `/goalify:goalify ${evalCase.input}`,
    await caseCwd(evalCase),
    ctx.model,
  );

  return {
    output: run.result,
    transcript: run.transcript,
    model: run.model,
    usage: run.usage,
    stop_reason: run.stopReason,
    tool_calls: run.toolCalls,
    num_turns: run.numTurns,
  };
}

class JudgeError extends Error {
  readonly judge_model: string;
  readonly judge_usage: Usage;

  constructor(message: string, run: ClaudeRun) {
    super(message);
    this.judge_model = run.model;
    this.judge_usage = run.usage;
  }
}

export async function gradeCase(evalCase: EvalCase, run: RunResult): Promise<Grade> {
  const line = lineScores(run.output, evalCase.expected);

  const judge = await runClaude(
    ["--restricted", "--json-schema", JSON.stringify(judgeSchema(evalCase.expected))],
    judgePrompt(evalCase, run.output),
    EVALS_DIR,
    JUDGE_MODEL,
  );

  if (judge.structured === undefined)
    throw new JudgeError("judge returned no structured output", judge);

  const judged = judgeScores(evalCase.expected, judge.structured);

  return {
    grade: { ...line, ...judged.grade },
    explanation: judged.explanation,
    judge_model: judge.model,
    judge_usage: judge.usage,
  };
}

export function perfFrom(run: RunResult): Perf {
  return { tool_calls: run.tool_calls, num_turns: run.num_turns };
}
