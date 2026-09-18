import type { HttpResponse, PromptOrigin, ToolSpec } from "claude-code";

import type { Host } from "./host.ts";
import type { Live } from "./mode.ts";

/**
 * The engine half of an extension. Claude Code takes one hooks module per plugin and one
 * unmatched hook per event, so an extension never calls `on(...)`: `register.ts` keeps every
 * event and calls these handlers, each handed a `Host`, never `$`.
 */

export type ToolAnswer = { readonly result: string } | { readonly deny: string };

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

export type ExtensionTool = {
  /** Registered as `mcp__vellum__<name>`; starts with the extension's id. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: NonNullable<ToolSpec["inputSchema"]>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` is the tool call as the engine hands it, the model's own arguments; the extension's `parse.ts` is the boundary that reads it.
  readonly call: (context: EngineContext, input: unknown) => Promise<ToolAnswer>;
};

export type Prompted = { readonly text: string; readonly origin: PromptOrigin };

/** `own`: a vellum relay started the turn, so its text answers the reviewer, not the terminal. */
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
  /** Once per poll while live, after the core's relay; a throw is logged and the poll goes on. */
  readonly tick?: (context: EngineContext) => Promise<void>;
  /** `/vellum:stop`, the one end the module causes: an approval is closed on the server. */
  readonly closing?: (context: EngineContext) => Promise<void>;
};
