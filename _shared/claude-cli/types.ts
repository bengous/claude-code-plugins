/**
 * TypeScript types for the Claude CLI SDK.
 * Designed for programmatic Claude agent spawning within hooks.
 */

/**
 * Hook input received via stdin from Claude Code hooks.
 * Common fields are always present; event-specific fields vary by hook type.
 */
export interface HookInput {
  /** Unique session identifier */
  session_id: string;
  /** Path to the session transcript file */
  transcript_path: string;
  /** Current working directory */
  cwd: string;
  /** Permission mode: "ask" or "allow" */
  permission_mode: "ask" | "allow";
  /** Name of the hook event */
  hook_event_name: string;
  /** Tool name (PreToolUse, PostToolUse) */
  tool_name?: string;
  /** Tool input parameters (PreToolUse) */
  tool_input?: Record<string, unknown>;
  /** Tool execution result (PostToolUse) */
  tool_result?: Record<string, unknown>;
  /** User's submitted prompt (UserPromptSubmit) */
  user_prompt?: string;
  /** Stop reason (SubagentStop) */
  reason?: string;
}

/**
 * Model aliases supported by Claude CLI.
 */
export type ModelAlias = "opus" | "sonnet" | "haiku";

/**
 * Permission modes for agent execution.
 */
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "delegate"
  | "dontAsk";

/**
 * Options for spawning a Claude agent.
 */
export interface SpawnOptions {
  /** The prompt/task for the agent (required) */
  prompt: string;
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Session ID to resume (omit for fresh session) */
  sessionId?: string;
  /** Model to use */
  model?: ModelAlias;
  /** Tools to allow (whitelist) */
  allowedTools?: string[];
  /** Tools to deny (blacklist) */
  disallowedTools?: string[];
  /** Append to system prompt (preserves Claude Code defaults) */
  systemPrompt?: string;
  /** Maximum agentic turns before stopping */
  maxTurns?: number;
  /** Permission mode for the session */
  permissionMode?: PermissionMode;
  /** JSON Schema for structured output validation */
  jsonSchema?: object;
  /** Timeout in milliseconds (default: 55000, under 60s hook limit) */
  timeout?: number;
  /** Maximum USD to spend (API users only) */
  maxBudgetUsd?: number;
  /** Use specific session ID (must be valid UUID) */
  newSessionId?: string;
  /** Disable session persistence */
  noSessionPersistence?: boolean;
}

/**
 * Successful agent execution result.
 */
export interface AgentSuccess {
  ok: true;
  /** The agent's response text */
  result: string;
  /** Session ID (for resumption) */
  sessionId: string;
  /** Total cost in USD */
  totalCostUsd: number;
  /** Total execution time in milliseconds */
  durationMs: number;
  /** Number of agentic turns taken */
  numTurns: number;
  /** Unique message identifier */
  uuid: string;
}

/**
 * Failed agent execution result.
 */
export interface AgentFailure {
  ok: false;
  /** Error description */
  error: string;
  /** Process exit code */
  exitCode: number;
  /** Stderr output */
  stderr: string;
  /** Signal that killed the process (e.g., "SIGTERM", "SIGKILL") */
  signalCode?: string;
  /** Whether the process was killed due to timeout */
  timedOut?: boolean;
}

/**
 * Agent execution result (discriminated union).
 * Use `result.ok` to narrow the type.
 *
 * @example
 * ```typescript
 * const result = spawn({ prompt: "..." });
 * if (result.ok) {
 *   console.log(result.result);  // AgentSuccess
 * } else {
 *   console.error(result.error); // AgentFailure
 * }
 * ```
 */
export type AgentResult = AgentSuccess | AgentFailure;

/**
 * Raw JSON output from Claude CLI with --output-format json.
 * @internal
 */
export interface CliJsonOutput {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  uuid: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    server_tool_use: {
      web_search_requests: number;
      web_fetch_requests: number;
    };
    service_tier: string;
  };
  modelUsage: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      webSearchRequests: number;
      costUSD: number;
      contextWindow: number;
      maxOutputTokens: number;
    }
  >;
  permission_denials: string[];
}
