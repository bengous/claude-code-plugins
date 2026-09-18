import type { EngineInterface, Register } from "claude-code";

import { engineExtensions } from "../../extensions/engine.ts";
import type { EngineContext, EngineExtension } from "./extension.ts";
import type { Host } from "./host.ts";
import { checkVerdict, lockFailed, lockVerdict } from "./lock.ts";
import {
  close,
  connect,
  type Live,
  restore,
  type Revive,
  revived,
  sessionOf,
  type Settle,
  type State,
  suspend,
  type Ticks,
  type Wiring,
} from "./mode.ts";
import { editedPath, type GateWire, sessionId } from "./parse.ts";
import { submitPlan, submitResult } from "./relay.ts";
import { completed, NO_TURN, ownOf, prompted, started, type Turns } from "./turn.ts";

const START_SKILL = "vellum:start";

const STOP_SKILL = "vellum:stop";

const SUBMIT = {
  name: "submit",
  description:
    "Submit plan.md from the vellum working directory for review in the browser. Call it once the plan and its artifacts are ready; the answer says whether to end your turn.",
  inputSchema: { type: "object" },
};

const NOT_PLANNING = "no vellum planning in progress; run /vellum:start";

const EXTENSION_TOOLS = engineExtensions.flatMap((extension) =>
  (extension.tools ?? []).map((tool) => ({ extension, tool })),
);

const UNREACHABLE: GateWire = {
  error: "the vellum review server is not answering; run /vellum:start again",
};

/**
 * Binds this dispatch's `$`. Every call is spelled here, the one place the loader follows it;
 * a timer a transition starts keeps the host it was given, as a closure over `$` would.
 */
function hostOf($: EngineInterface): Host {
  return {
    sessionId: () => $.session.id(),
    cwd: () => $.session.cwd(),
    pluginRoot: $.plugin.root,
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeDelete: (key) => $.store.delete(key),
    fetch: (url, init) => $.http.fetch(url, init),
    run: (argv, init) => $.process.run(argv, init),
    every: (ms, fn) => $.clock.every(ms, fn),
    submitPrompt: (text) => $.prompt.submit({ text }),
    status: (text) => $.ui.status(text),
    log: (text) => $.ui.log(text),
  };
}

function contextOf(host: Host, live: Live, extension: EngineExtension): EngineContext {
  return { host, live, api: live.server.extension(extension.id) };
}

/**
 * Hands one event to every extension, in registry order. An extension that throws is logged
 * and the next one runs: no extension may stop the core's own hook, or another extension.
 */
async function handed(
  host: Host,
  live: Live,
  event: string,
  hand: (extension: EngineExtension, context: EngineContext) => Promise<void> | undefined,
): Promise<void> {
  for (const extension of engineExtensions) {
    try {
      await hand(extension, contextOf(host, live, extension));
    } catch (cause) {
      host.log(`${extension.id} failed on ${event}: ${String(cause)}`);
    }
  }
}

const ticks: Ticks = (host, live) =>
  handed(host, live, "tick", (extension, context) => extension.tick?.(context));

export const register: Register = (on) => {
  let state: State = { kind: "idle" };

  const settle: Settle = async (host, from) => {
    if (state !== from) return;
    turns = NO_TURN;
    state = await close(host, from);
  };

  const revive: Revive = async (host, from) => {
    if (state !== from) return;
    const next = await revived(host, from, () => state === from, wiring);

    if (next === null) return;
    turns = NO_TURN;
    state = next;
  };

  const wiring: Wiring = { settle, ticks, revive };

  // Reset wherever the mode leaves `live`, and ignored outside it: see `turn.ts`.
  let turns: Turns = NO_TURN;

  on("session.start", async ($, e, next) => {
    await $.tool.register(SUBMIT);

    for (const { tool } of EXTENSION_TOOLS) {
      await $.tool.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    state = await restore(hostOf($), state, wiring);

    return next(e);
  });

  on("skill.prompt", { skill: START_SKILL }, async ($, e, next) => {
    state = await connect(hostOf($), state, wiring);
    const result = await next(e);

    if (state.kind !== "live") return result;
    // The page opens on the way in, so the reviewer can comment on the artifacts before v1.
    void state.live.server.open();

    // The reviewer reads the link here: `$.ui.log` does not show in the transcript, so the
    // skill is the deterministic channel the module owns.
    const lines = `Working directory: ${state.live.session.workdir}\nReview page: ${state.live.server.url}`;

    return { text: `${result.text}\n\n${lines}` };
  });

  // The way out is a skill, not `$.command.register`: a registered command takes the global
  // namespace, and `disable-model-invocation` keeps this one the reviewer's to run.
  on("skill.prompt", { skill: STOP_SKILL }, async ($, e, next) => {
    const session = sessionOf(state);

    const line =
      session === null
        ? "no vellum planning in progress"
        : `vellum planning closed; ${session.workdir} is kept`;

    const host = hostOf($);

    if (state.kind === "live") {
      await handed(host, state.live, "closing", (extension, context) =>
        extension.closing?.(context),
      );
    }

    turns = NO_TURN;
    state = await close(host, state);
    const result = await next(e);

    return { text: `${result.text}\n\n${line}` };
  });

  // The deterministic way the mode ends when the session forgets it: a `/clear` mints a new
  // session id, so the old poll and heartbeat would run on until the next way in noticed.
  on("command.run", { command: ["clear", "resume"] }, async ($, e, next) => {
    const result = await next(e);

    const session = sessionOf(state);

    if (session === null) return result;
    const host = hostOf($);
    const left = e.command === "clear" || sessionId(await host.sessionId()) !== session.id;

    if (!left) return result;
    turns = NO_TURN;
    state = suspend(host, state);

    return result;
  });

  on("tool.check", async ($, e, next) => {
    const session = sessionOf(state);

    if (session === null) return next(e);
    // ponytail: the lock reads the file tools only, so a shell command the session's own flow
    // approves still writes anywhere; a command classifier is the upgrade if that ever bites.
    const path = editedPath(e.tool, e.input);

    if (path === null) return checkVerdict(e.tool, await next(e));
    const { project, workdir } = session;
    const verdict = lockVerdict(path, await $.session.cwd(), project, workdir);

    if (verdict.kind === "deny") return { decision: "deny", reason: verdict.reason };

    if (verdict.kind === "allow") return { decision: "allow" };

    return checkVerdict(e.tool, await next(e));
  }).catch((_, e, next) => (state.kind === "idle" ? next(e) : lockFailed(next.error.kind)));

  on("tool.call", { tool: "mcp__vellum__submit" }, async ($) => {
    if (state.kind === "idle") return { deny: NOT_PLANNING };

    if (state.kind === "lost") return { deny: UNREACHABLE.error };

    return submitResult(await submitPlan(hostOf($), state.live, "record").catch(() => UNREACHABLE));
  });

  // The extensions' tools and refusals share the one unmatched hook the engine allows: a
  // matcher must be a literal written in this file, and an extension's tool name is not one.
  on("tool.call", async ($, e, next) => {
    // The generated contract's tool names predate AskUserQuestion, so the name is read as a string.
    const name: string = e.tool;
    const owned = EXTENSION_TOOLS.find(({ tool }) => `mcp__vellum__${tool.name}` === name);

    if (owned !== undefined) {
      if (state.kind === "idle") return { deny: NOT_PLANNING };

      if (state.kind === "lost") return { deny: UNREACHABLE.error };

      return await owned.tool.call(contextOf(hostOf($), state.live, owned.extension), e);
    }

    if (state.kind !== "live") return next(e);

    const refusal = engineExtensions
      .map((extension) => extension.refuses?.[name])
      .find((reason) => reason !== undefined);

    return refusal === undefined ? next(e) : { deny: refusal };
  });

  // Vellum's own relays come through here too: `$.prompt.submit` skips the calling hook alone.
  // The server already wrote what they carry, so an extension never hears of them.
  on("prompt.submit", async ($, e, next) => {
    const own = e.origin.kind === "plugin" && e.origin.name === "vellum";
    // Before `next`: it resolves once the prompt entered, and its turn may have started by then.
    turns = state.kind === "live" ? prompted(turns, e.text, own) : NO_TURN;

    if (state.kind === "live" && !own) {
      await handed(hostOf($), state.live, "prompted", (extension, context) =>
        extension.prompted?.(context, { text: e.text, origin: e.origin }),
      );
    }

    return next(e);
  });

  on("turn.start", (_, e, next) => {
    turns = state.kind === "live" ? started(turns, e.text, e.turnId) : NO_TURN;

    return next(e);
  });

  // The turn's end is the deterministic submit: the reviewer sees each new plan.md the moment
  // Claude hands back, and never has to ask for one. An unchanged text is kept, even after a
  // feedback, so a turn that answered a question opens no version; the explicit tool does.
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);

    if (state.kind !== "live" || e.agentId !== undefined) return result;
    const host = hostOf($);
    const own = ownOf(turns, e.turnId);
    turns = completed(turns, e.turnId);

    if (e.reason === "answer") await submitPlan(host, state.live, "keep").catch(() => UNREACHABLE);

    await handed(host, state.live, "answered", (extension, context) =>
      extension.answered?.(context, { text: e.answer, reason: e.reason, own }),
    );

    return result;
  });
};
