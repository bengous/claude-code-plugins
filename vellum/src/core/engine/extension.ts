import type { HttpResponse, PromptOrigin, ToolSpec } from "claude-code";

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

export type EngineExtension = {
  readonly id: string;
  readonly tools?: readonly ExtensionTool[];
  /** Tools denied while live, by the engine's tool name, with the reason the model reads. */
  readonly refuses?: Readonly<Record<string, string>>;
  /** Every prompt that enters while live, but the ones vellum itself submits. */
  readonly prompted?: (context: EngineContext, prompt: Prompted) => Promise<void>;
  /** The main loop's turn only, after the core's own gate. */
  readonly answered?: (context: EngineContext, turn: Answered) => Promise<void>;
  /**
   * Each time the server says the review changed, a `stage` line, while live: what the extension
   * reads again for its segment. A throw is logged and the next extension runs.
   */
  readonly staged?: (context: EngineContext) => Promise<void>;
  /** `/vellum:stop`, the one end the module causes: an approval is closed on the server. */
  readonly closing?: (context: EngineContext) => Promise<void>;
  /**
   * What the band above the prompt says for this extension while live, after the plan and
   * before the link; `null` says nothing. Asked after each `stage` line and each transition of the
   * mode, never at a draw: it answers from what its `staged` read, never from the server. A throw
   * leaves it out of the band, logged once per mode.
   */
  readonly segment?: (context: EngineContext) => string | null;
};
