import type {
  AgentInfo,
  AgentSpawnArgs,
  AgentSpawnResult,
  FsStat,
  HookStream,
  HttpInit,
  HttpResponse,
  ProcessSpawnChunk,
  ProcessSpawnRequest,
  ProcessSpawnResult,
  PromptSubmitResult,
  TimerCall,
  ToolCallArgs,
  ToolCallResult,
} from "claude-code";

/**
 * The engine as a hook bound it from its `$`, each member spelled `$.noun.event(...)` there.
 *
 * The loader follows `$` only into a function declared in the file that registers the hook,
 * so every other file of the module takes this instead: "$ is followed only into a function
 * declared in this same file, never across an import; $ is always spelled $.noun.event(...)
 * at the call site".
 */
export type Host = {
  sessionId: () => Promise<string>;

  cwd: () => Promise<string>;

  /** `$.session.root()`: where the session started; a shell `cd` does not move it. */
  root: () => Promise<string>;

  /** `$.fs.stat(path, { resolve: true })`: `realPath` is where the path lands, and a missing path rejects. */
  stat: (path: string) => Promise<FsStat>;

  readonly pluginRoot: string;

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the plugin store keeps whatever a plugin put in it; `unknown` is the engine's own result type (`ResultOf['store.get']`), and `parse.ts` is what reads it.
  storeGet: (key: string) => Promise<unknown>;

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the store takes any JSON value, as `$.store.set` does; the module's own records are typed where they are built.
  storeSet: (key: string, value: unknown) => Promise<void>;

  storeDelete: (key: string) => Promise<void>;

  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>;

  /**
   * `$.process.spawn`: the child lives as long as its stream is read, and dies with the module.
   * Spawned from `session.start`, `skill.prompt` or a timer, never from a `tool.call`, whose
   * Escape ends the child with the call.
   */
  spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult>;

  every: TimerCall;

  after: TimerCall;

  /** `$.clock.now()`: milliseconds since the epoch, as the engine's clock reads them. */
  now: () => Promise<number>;

  submitPrompt: (text: string) => Promise<PromptSubmitResult>;

  /**
   * `$.agent.spawn`: resolves once the subagent started, in the background. A subagent this
   * module spawns steps past every hook of vellum's but `turn.complete`, which carries its final
   * text under the `agentId` this answers.
   */
  spawnAgent: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>;

  listAgents: () => Promise<AgentInfo[]>;

  /**
   * `$.tool.call(call)`: a tool of the session run by the module. The module's own hooks step past
   * it, as its spawned agents do.
   */
  callTool: (call: ToolCallArgs) => Promise<ToolCallResult>;

  status: (text: string | undefined) => void;

  /** `$.ui.invalidate("ui.render")`: the engine asks the band again. */
  invalidate: () => void;

  log: (text: string) => void;

  /** `$.env.get("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR")` */
  projectCwdFlag: () => Promise<string | undefined>;

  /** `$.env.set("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR", value)`; `undefined` unsets it. */
  setProjectCwdFlag: (value: string | undefined) => Promise<void>;
};
