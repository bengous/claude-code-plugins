import type { HttpResponse, PromptOrigin, ToolSpec, TurnCompleteReason } from "claude-code";

import type {
  AnswerOf,
  BodyOf,
  Json,
  Parser,
  Plugs,
  PostOf,
  PostRoute,
  Undeclared,
} from "../plugs.ts";
import type { Host } from "./host.ts";
import type { Live } from "./mode.ts";
import type { ChannelEntryWire } from "./parse.ts";

/**
 * The engine half of an extension. Claude Code takes one hooks module per plugin and one
 * unmatched hook per event, so an extension never calls `on(...)`: `register.ts` keeps every
 * event and calls these handlers, each handed a `Host`, never `$`.
 */

export type ToolAnswer =
  | { readonly result: string }
  /** The result is the channel's entry `returns`, which the follower then never relays. */
  | { readonly result: string; readonly returns: number }
  | { readonly deny: string };

/** The extension's own routes on the review server, `/api/x/<id>/<path>`, token header set. */
export type ExtensionApi = {
  get: (path: string) => Promise<HttpResponse>;
  /** `json` is the body, serialized: the extension types it in its own `protocol.ts`. */
  post: (path: string, json: string) => Promise<HttpResponse>;
};

export type EngineContext = {
  readonly host: Host;
  readonly live: Live;
  readonly api: ExtensionApi;
};

/**
 * A call of an extension's tool. `waiting` says the call now waits for the reviewer: from then
 * on the follower holds each entry the tool `awaits` until the call answers, and a call that
 * fails answers Claude that the reviewer's answer comes as a prompt, never a permission prompt.
 */
export type ToolContext = EngineContext & { readonly waiting: () => void };

export type ExtensionTool = {
  /** Registered as `mcp__vellum__<name>`, one name per tool across the extensions (`register.spec.ts`). */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: NonNullable<ToolSpec["inputSchema"]>;
  /** The entries a call that waits may return as its result: `grill_ask`, the batch that closes its round; `propose`, the answer to it. */
  readonly awaits?: (entry: ChannelEntryWire) => boolean;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` is the tool call as the engine hands it, the model's own arguments; the extension's `parse.ts` is the boundary that reads it.
  readonly call: (context: ToolContext, input: unknown) => Promise<ToolAnswer>;
};

export type Prompted = { readonly text: string; readonly origin: PromptOrigin };

/**
 * `own`: a vellum relay started the turn, or a waiting tool returned the reviewer's entry in it,
 * so its text answers the reviewer, not the terminal.
 */
export type Answered = {
  readonly text: string;
  readonly reason: string;
  readonly own: boolean;
};

/** A subagent's turn, as its `turn.complete` carries it: `agentId` is the one `Host.spawnAgent` answered. */
export type AgentAnswered = {
  readonly agentId: string;
  readonly text: string;
  readonly reason: TurnCompleteReason;
};

export type EngineExtension = {
  readonly id: string;
  readonly tools?: readonly ExtensionTool[];
  /** Tools denied while live, by the engine's tool name, with the reason the model reads. */
  readonly refuses?: Readonly<Record<string, string>>;
  /** Every prompt that enters while live, but the ones vellum itself submits. */
  readonly prompted?: (context: EngineContext, prompt: Prompted) => Promise<void>;
  /** The main loop's turn only, after the core's own gate. */
  readonly answered?: (context: EngineContext, turn: Answered) => Promise<void>;
  /** A subagent's turn, any subagent's, while live: each half tells its own agents from the rest; `review` reads its run off the server. */
  readonly agentAnswered?: (context: EngineContext, turn: AgentAnswered) => Promise<void>;
  /**
   * Each time the server says the review changed, a `stage` line, while live: what the extension
   * reads again to act on it. A throw is logged and the next extension runs.
   */
  readonly staged?: (context: EngineContext) => Promise<void>;
  /**
   * The mode closes, by `/vellum:stop` or by the approval (`settle`), while the server still
   * answers: what the extension must end in the session, it ends here. What the approval must
   * close on the server is closed there, by the server half's `approved`, module alive or not.
   */
  readonly closing?: (context: EngineContext) => Promise<void>;
};

/** The engine events a half may listen to, each handed the half's own context `C`. */
export type Listeners<C> = {
  readonly prompted: (context: C, prompt: Prompted) => Promise<void>;
  readonly answered: (context: C, turn: Answered) => Promise<void>;
  readonly agentAnswered: (context: C, turn: AgentAnswered) => Promise<void>;
  readonly staged: (context: C) => Promise<void>;
  readonly closing: (context: C) => Promise<void>;
};

export type Listen = keyof Listeners<EngineContext>;

/**
 * What a slice's route answered the hooks half: the answer its plugs declare, read by the route's
 * own parser in `answers`; or the status, the text and, when the route refused, why.
 */
export type Posted<A> =
  | { readonly ok: true; readonly answer: A }
  | {
      readonly ok: false;
      readonly status: number;
      readonly text: string;
      readonly reason: string | null;
    };

/** One parser per route the hooks half posts, reading the answer its plugs declare; `null` for a route that answers nothing (204). */
export type Answers<P extends Plugs> = {
  readonly [Route in P["hooks"]["posts"]]: AnswerOf<P["server"], Route> extends null
    ? null
    : Parser<AnswerOf<P["server"], Route>>;
};

/** A slice's client of its own server half: a route its plugs let it post, with the body they declare, answering the answer they declare. */
export type SlicePost<P extends Plugs> = <Route extends P["hooks"]["posts"]>(
  route: Route,
  body: BodyOf<P["server"], Route>,
) => Promise<Posted<AnswerOf<P["server"], Route>>>;

export type HooksContext<P extends Plugs> = {
  readonly host: Host;
  readonly live: Live;
  readonly post: SlicePost<P>;
  /**
   * What a call of the half's in this mode waited on and heard nothing back for, taken:
   * `undefined` once the wait ended. A listener reads it at the turn's end, as a turn cut short
   * leaves it.
   */
  readonly unanswered: () => string | undefined;
};

/**
 * A call's wait for the reviewer: `route` posted with `body`, held by the server under the
 * engine's 30 s cut, again and again until `settle` answers what the call returns. `mark` names
 * what the call waits on, kept until the wait ends, so a turn cut short reads it back
 * (`unanswered`). A post that fails is asked again at once up to `attempts` times, so a `$` call
 * stays in flight and the hook's budget never runs: after a crash the second one usually reaches
 * the revived server. One that fails every time throws, and the core's `.catch` answers Claude
 * that the reviewer's answer comes as a prompt.
 */
export type Hold<P extends Plugs, Route extends P["hooks"]["posts"]> = {
  readonly mark: string;
  readonly route: Route;
  readonly body: BodyOf<P["server"], Route>;
  readonly attempts: 1 | 2;
  /** What the call returns once the wait ended, `null` while it is still open. */
  readonly settle: (answer: AnswerOf<P["server"], Route>) => ToolAnswer | null;
};

/** What a slice's tool call is handed: its half's context, and the wait for the reviewer. */
export type ToolCallContext<P extends Plugs> = HooksContext<P> & {
  readonly waitFor: <Route extends P["hooks"]["posts"]>(
    hold: Hold<P, Route>,
  ) => Promise<ToolAnswer>;
};

/** A tool of a slice, registered under its key in `tools` as `mcp__vellum__<key>`. */
export type HooksTool<C> = {
  readonly description: string;
  readonly inputSchema: NonNullable<ToolSpec["inputSchema"]>;
  /**
   * The entries of the channel a call that waits may return as its result, which the follower
   * holds for it: `"own"` for the text entries of its own slice.
   */
  readonly awaits?: "own" | ((entry: ChannelEntryWire) => boolean);
  readonly call: (
    context: C,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` is the tool call as the engine hands it, the model's own arguments; the slice's `parse.ts` is the boundary that reads it.
    input: unknown,
  ) => Promise<ToolAnswer>;
};

/**
 * What a slice's `hooks.ts` fills: one tool per name its plugs declare, one listener per engine
 * event they declare, a parser per route they let it post, and nothing else. A route it posts
 * that the server does not declare is a property no half can fill.
 */
export type HooksHalf<P extends Plugs> = {
  readonly id: P["id"];
  readonly tools: ContractTools<P>;
  readonly answers: Answers<P>;
} & Pick<Listeners<HooksContext<P>>, P["hooks"]["listens"]> & {
    readonly [Unheard in Exclude<Listen, P["hooks"]["listens"]>]?: Undeclared<
      `${Unheard} is not declared in contract.ts: add it to hooks.listens`,
      Listeners<HooksContext<P>>[Unheard]
    >;
  } & {
    readonly [
      Stray in Exclude<P["hooks"]["posts"], PostOf<P["server"]>>
    ]: Undeclared<`${Stray} is in hooks.posts of contract.ts, not in its routes: declare the route`>;
  } & Denying<P>;

/** The tools of `hooks.tools` in the slice's `contract.ts`, each registered as `mcp__vellum__<name>`: no other. */
export type ContractTools<P extends Plugs> = {
  readonly [Name in P["hooks"]["tools"]]: HooksTool<ToolCallContext<P>>;
};

/** The engine's tools the half denies while the mode is live, each with the reason the model reads. */
type Denying<P extends Plugs> = [P["hooks"]["denies"]] extends [never]
  ? {
      readonly refuses?: Undeclared<
        "refuses is not declared in contract.ts: add the tools to hooks.denies",
        Readonly<Record<string, string>>
      >;
    }
  : { readonly refuses: { readonly [Tool in P["hooks"]["denies"]]: string } };

/** A hooks half with its plugs forgotten, as `engineExtension` takes it: every `HooksHalf` is one. */
export type ErasedContext = {
  readonly host: Host;
  readonly live: Live;
  readonly post: (route: PostRoute, body: Json) => Promise<Posted<never>>;
  readonly unanswered: () => string | undefined;
};

export type ErasedHold = {
  readonly mark: string;
  readonly route: PostRoute;
  readonly body: Json;
  readonly attempts: 1 | 2;
  readonly settle: (answer: never) => ToolAnswer | null;
};

export type ErasedToolContext = ErasedContext & {
  readonly waitFor: (hold: ErasedHold) => Promise<ToolAnswer>;
};

export type ErasedHooks = {
  readonly id: string;
  readonly tools: { readonly [name: string]: HooksTool<ErasedToolContext> };
  readonly answers: { readonly [route: string]: Parser<Json> | null };
  readonly refuses?: { readonly [tool: string]: string };
} & Partial<Listeners<ErasedContext>>;
