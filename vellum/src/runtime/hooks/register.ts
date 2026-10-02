import type { EngineInterface, Register } from "claude-code";

import { gateAtTurnEnd, SUBMIT, submitPlan, submitResult } from "../../review/hooks.ts";
import { type Band, liveBand, lostBand } from "./band.ts";
import type { EngineContext, EngineExtension, ToolContext } from "./extension.ts";
import type { Host } from "./host.ts";
import { checkVerdict, lockFailed, lockVerdict, SHELLS, shellVerdict } from "./lock.ts";
import {
  close,
  connect,
  discard,
  type Live,
  restore,
  type Revive,
  revived,
  sessionOf,
  type Settle,
  type Staged,
  type State,
  suspend,
  tenureOf,
  type Wiring,
} from "./mode.ts";
import {
  type DrawnWire,
  editedPath,
  type GateWire,
  sessionId,
  shellCall,
  type StateWire,
} from "./parse.ts";
import { landed } from "./place.ts";
import type { Claim } from "./relay.ts";
import { engineExtensions } from "./slices.ts";
import { completed, NO_TURN, ownOf, prompted, replied, started, type Turns } from "./turn.ts";

const START_SKILL = "vellum:start";

const STOP_SKILL = "vellum:stop";

// Kept small on purpose: a tool's schema rides in every request.
const STATE = {
  name: "state",
  description:
    "Where the vellum planning session stands, read on demand: the plan's stage and whether plan.md holds a text no version has, each part of the review (grill, proposal, plan review) and what holds it, then each event refused now with its reason. No input. Refused outside a vellum planning session.",
  inputSchema: { type: "object" },
};

/** The session as `mcp__vellum__state` prints it: the stage and `plan.md`, one line per region, then what is refused now. */
function stateResult(state: StateWire): string {
  const { stage } = state;
  const where = "version" in stage ? `${stage.kind} v${stage.version}` : stage.kind;

  const refused = state.refused.map(
    ({ event, effect, reason }) => `  ${event} (${effect}): ${reason}`,
  );

  return [
    `workspace: ${where} · plan.md: ${state.planText}`,
    ...state.lines,
    refused.length === 0 ? "refused now: none" : "refused now:",
    ...refused,
  ].join("\n");
}

const NOT_PLANNING = "no vellum planning in progress; run /vellum:start";

/** What Claude reads when a call that waited for the reviewer failed: the answer comes all the same. */
const ANSWER_BY_PROMPT =
  "The reviewer's answer will arrive as a prompt, once they send it. End your turn.";

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
    root: () => $.session.root(),
    stat: (path) => $.fs.stat(path, { resolve: true }),
    pluginRoot: $.plugin.root,
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeDelete: (key) => $.store.delete(key),
    fetch: (url, init) => $.http.fetch(url, init),
    spawn: (request) => $.process.spawn(request),
    every: (ms, fn) => $.clock.every(ms, fn),
    after: (ms, fn) => $.clock.after(ms, fn),
    now: () => $.clock.now(),
    submitPrompt: (text) => $.prompt.submit({ text }),
    spawnAgent: (args) => $.agent.spawn(args),
    listAgents: () => $.agent.list(),
    callTool: (call) => $.tool.call(call),
    status: (text) => $.ui.status(text),
    invalidate: () => $.ui.invalidate("ui.render"),
    log: (text) => $.ui.log(text),
    projectCwdFlag: () => $.env.get("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"),
    setProjectCwdFlag: (value) => $.env.set("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR", value),
  };
}

const SEPARATOR = " │ ";

function contextOf(host: Host, live: Live, extension: EngineExtension): EngineContext {
  return { host, live, api: live.server.extension(extension.id) };
}

/** Whether the state holds a session whose variable vellum set: `live` or `lost`, as the lock reads it. */
function pinned(state: State): boolean {
  return sessionOf(state)?.pinnedCwd === true;
}

export const register: Register = (on) => {
  let state: State = { kind: "idle" };

  // Reset wherever the mode leaves `live`, and ignored outside it: see `turn.ts`.
  let turns: Turns = NO_TURN;

  function forgetTurns(): void {
    turns = NO_TURN;
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

  /** The extensions end what they started in the session, while the mode is live and its server answers. */
  async function closing(host: Host, live: Live): Promise<void> {
    await handed(host, live, "closing", (extension, context) => extension.closing?.(context));
  }

  // What each mode's server last said the band draws, keyed by the mode: a new way in starts with none.
  const stages = new WeakMap<Live, DrawnWire>();

  function bandOf(): Band | null {
    if (state.kind === "idle") return null;

    if (state.kind === "lost") return lostBand(state.session.server);

    return liveBand(state.live.session.server, stages.get(state.live) ?? null);
  }

  // What `ui.render` draws; `redraw` alone writes it, so a line that changed nothing redraws nothing.
  let band: Band | null = null;

  function redraw(host: Host): void {
    const next = bandOf();

    if (JSON.stringify(next) === JSON.stringify(band)) return;
    band = next;
    host.invalidate();
  }

  /**
   * Every write of `state`: the band follows it, from one place. Leaving a live mode ends its
   * server, and a follower the next state no longer holds is stopped: the module owns its child,
   * and what a left mode's server would still say reaches nobody. A follower, not a tenure, is
   * compared: a revival carries the same follower in a new tenure, its ends counted anew.
   * While the state holds a session vellum pinned, every shell command starts at the project's
   * root; the variable goes as the last such state leaves, and one the person set stays theirs.
   */
  function become(host: Host, next: State): void {
    const was = state;
    state = next;

    if (pinned(next) !== pinned(was)) {
      const value = pinned(next) ? "1" : undefined;

      host.setProjectCwdFlag(value).catch((cause: unknown) => {
        host.log(
          `the project's working directory was not ${value === undefined ? "released" : "pinned"}: ${String(cause)}`,
        );
      });
    }

    if (was.kind === "live" && (next.kind !== "live" || next.live !== was.live)) {
      was.live.child.end();
    }

    const follower = tenureOf(was)?.follower;

    if (follower !== undefined && follower !== tenureOf(next)?.follower) follower.stop();
    redraw(host);
  }

  const settle: Settle = async (host, id) => {
    if (state.kind === "live" && state.live.session.id === id) await closing(host, state.live);

    // Checked after `closing`: a way into another session meanwhile keeps its mode.
    if (sessionOf(state)?.id !== id) return;
    forgetTurns();
    become(host, await close(host, state));
  };

  const revive: Revive = async (host, from, how) => {
    if (state !== from) return;
    const next = await revived(host, from, () => state === from, wiring, how);

    if (next === null) return;

    // The mode was left while the revival wrote its record: the revived server is not taken.
    if (state !== from) {
      discard(next);

      return;
    }

    forgetTurns();
    become(host, next);
  };

  const staged: Staged = async (host, live, drawn) => {
    stages.set(live, drawn);
    await handed(host, live, "staged", (extension, context) => extension.staged?.(context));
    redraw(host);
  };

  const wiring: Wiring = { settle, staged, revive, current: (from) => state === from };

  // The waits of the extensions' tool calls, by the call's id, and the calls that failed while
  // waiting: their `.catch` answers Claude that the answer comes as a prompt.
  const waits = new Map<string, Claim>();
  const failedWaiting = new Set<string>();

  on("session.start", async ($, e, next) => {
    await $.tool.register(SUBMIT);
    await $.tool.register(STATE);

    for (const { tool } of EXTENSION_TOOLS) {
      await $.tool.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    const host = hostOf($);
    become(host, await restore(host, state, wiring));

    return next(e);
  });

  on("skill.prompt", { skill: START_SKILL }, async ($, e, next) => {
    const host = hostOf($);
    become(host, await connect(host, state, wiring));
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

    if (state.kind === "live") await closing(host, state.live);
    forgetTurns();
    become(host, await close(host, state));
    const result = await next(e);

    return { text: `${result.text}\n\n${line}` };
  });

  // The deterministic way the mode ends when the session forgets it: a `/clear` mints a new
  // session id, so the old heartbeat would run on until the next way in noticed.
  on("command.run", { command: ["clear", "resume"] }, async ($, e, next) => {
    const result = await next(e);

    const session = sessionOf(state);

    if (session === null) return result;
    const host = hostOf($);
    const left = e.command === "clear" || sessionId(await host.sessionId()) !== session.id;

    if (!left) return result;
    forgetTurns();
    become(host, suspend(host, state));

    return result;
  });

  // The mode's one place in the terminal: the status line keeps a failure alone. A survey holds
  // the band over any plugin, and the person may collapse it.
  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (band === null || e.props.hasSurvey) return next(e);
    const { Box, Text, Link } = $.ui.resolve(e);
    const separator = () => Text({ dimColor: true, children: SEPARATOR });

    return Box({
      flexDirection: "row",
      children: [
        Text({ children: "vellum" }),
        ...band.segments.flatMap((segment) => [
          separator(),
          Text({ dimColor: true, children: segment }),
        ]),
        separator(),
        Link({ href: band.href, label: "Review page ↗" }),
      ],
    });
  });

  on("tool.check", async ($, e, next) => {
    const session = sessionOf(state);

    if (session === null) return next(e);
    const call = SHELLS.has(e.tool) ? shellCall(e.tool, e.input) : null;
    const moved = call === null ? null : shellVerdict(call, session.workdir);

    if (moved?.kind === "deny") return { decision: "deny", reason: moved.reason };
    // ponytail: the lock reads the file tools only, so a shell command the session's own flow
    // approves still writes anywhere; a command classifier is the upgrade if that ever bites.
    const path = editedPath(e.tool, e.input);

    if (path === null) return checkVerdict(e.tool, await next(e));
    const verdict = lockVerdict(path, session.workdir, await landed(hostOf($), session, path));

    if (verdict.kind === "deny") return { decision: "deny", reason: verdict.reason };

    if (verdict.kind === "allow") return { decision: "allow" };

    return checkVerdict(e.tool, await next(e));
  }).catch((_, e, next) => (state.kind === "idle" ? next(e) : lockFailed(next.error.kind)));

  on("tool.call", { tool: "mcp__vellum__submit" }, async ($) => {
    if (state.kind === "idle") return { deny: NOT_PLANNING };

    if (state.kind === "lost") return { deny: UNREACHABLE.error };

    return submitResult(await submitPlan(hostOf($), state.live, "record").catch(() => UNREACHABLE));
  });

  // Read on demand, never joined to a relay (D10): the reasons Claude meets arrive with each refusal.
  on("tool.call", { tool: "mcp__vellum__state" }, async () => {
    if (state.kind === "idle") return { deny: NOT_PLANNING };

    if (state.kind === "lost") return { deny: UNREACHABLE.error };
    const read = await state.live.server.state().catch(() => UNREACHABLE);

    return "error" in read ? { deny: read.error } : { result: stateResult(read) };
  });

  // Matched, never open: an unmatched `tool.call` hook wraps every tool call of every agent in
  // the session, and a worktree-isolated agent's shell loses its working directory inside it.
  // The literal is the registry's tools and refusals, held equal to it by `register.spec.ts`.
  // A call that waits ends its wait however it ends; one the engine gave up on (a throw, an
  // overrun, Escape) answers from `.catch`, and what it held reaches Claude through the channel.
  on(
    "tool.call",
    { tool: ["mcp__vellum__grill_ask", "mcp__vellum__propose", "AskUserQuestion"] },
    async ($, e, next) => {
      const name = e.tool;
      const owned = EXTENSION_TOOLS.find(({ tool }) => `mcp__vellum__${tool.name}` === name);

      if (owned !== undefined) {
        if (state.kind === "idle") return { deny: NOT_PLANNING };

        if (state.kind === "lost") return { deny: UNREACHABLE.error };
        const { live } = state;
        const { tool, extension } = owned;
        const id = e.tool_use_id;

        const context: ToolContext = {
          ...contextOf(hostOf($), live, extension),
          waiting: () => {
            if (tool.awaits !== undefined && !waits.has(id)) {
              waits.set(id, live.tenure.follower.claim(tool.awaits));
            }
          },
        };

        try {
          const answer = await tool.call(context, e);

          if ("deny" in answer) return { deny: answer.deny };

          // An Escape that landed as the answer came: the result reaches nobody, the entry goes.
          if ("returns" in answer && !next.signal.aborted) {
            waits.get(id)?.returned(answer.returns);
            turns = replied(turns);
          }

          return { result: answer.result };
        } catch (cause) {
          // Escape calls no `.catch` (hook-runtime.md): only a failure it will hear is remembered.
          if (waits.has(id) && !next.signal.aborted) failedWaiting.add(id);
          throw cause;
        } finally {
          waits.get(id)?.close();
          waits.delete(id);
        }
      }

      if (state.kind !== "live") return next(e);

      const refusal = engineExtensions
        .map((extension) => extension.refuses?.[name])
        .find((reason) => reason !== undefined);

      return refusal === undefined ? next(e) : { deny: refusal };
    },
  ).catch((_, e, next) => {
    const id = e.tool_use_id;
    // Still open after an overrun: the hook's code may run on, and what it returns late is not heard.
    const overrun = waits.get(id);
    overrun?.close();
    waits.delete(id);

    if (overrun !== undefined || failedWaiting.delete(id)) return { result: ANSWER_BY_PROMPT };
    const name: string = e.tool;

    if (!EXTENSION_TOOLS.some(({ tool }) => `mcp__vellum__${tool.name}` === name)) return next(e);

    return {
      deny: `vellum failed on ${name} (${next.error.message ?? next.error.kind}); retry the call`,
    };
  });

  // Vellum's own relays come through here too: `$.prompt.submit` skips the calling hook alone.
  // The server already wrote what they carry, so an extension never hears of them.
  on("prompt.submit", async ($, e, next) => {
    const own = e.origin.kind === "plugin" && e.origin.name === "vellum";

    // Before `next`: it resolves once the prompt entered, and its turn may have started by then.
    if (state.kind === "live") turns = prompted(turns, e.text, own);
    else forgetTurns();

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
  // feedback, so a turn that answered a question opens no version; the explicit tool does. A
  // refusal (a hold, the plan approved) is the server's to journal: Claude hears of a hold once it
  // ends, through the notice, never here.
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);

    if (state.kind !== "live") return result;
    const host = hostOf($);
    const { agentId } = e;

    // A subagent's end is its answer to whoever spawned it; the turns and the gate are the main loop's.
    if (agentId !== undefined) {
      await handed(host, state.live, "agentAnswered", (extension, context) =>
        extension.agentAnswered?.(context, { agentId, text: e.answer, reason: e.reason }),
      );

      return result;
    }

    const own = ownOf(turns, e.turnId);
    turns = completed(turns, e.turnId);

    if (e.reason === "answer") await gateAtTurnEnd(host, state.live);

    await handed(host, state.live, "answered", (extension, context) =>
      extension.answered?.(context, { text: e.answer, reason: e.reason, own }),
    );

    return result;
  });
};
