import type { EngineInterface, Register } from "claude-code";

import { engineExtensions } from "../../extensions/engine.ts";
import { type Band, liveBand, lostBand } from "./band.ts";
import type { EngineContext, EngineExtension } from "./extension.ts";
import type { Host } from "./host.ts";
import { checkVerdict, lockFailed, lockVerdict } from "./lock.ts";
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
import { editedPath, type GateWire, sessionId, type StageWire } from "./parse.ts";
import { landed } from "./place.ts";
import { submitPlan, submitResult } from "./relay.ts";
import { completed, NO_TURN, ownOf, prompted, started, type Turns } from "./turn.ts";

const START_SKILL = "vellum:start";

const STOP_SKILL = "vellum:stop";

const SUBMIT = {
  name: "submit",
  description:
    "Submit plan.md from the vellum working directory for review in the browser, before the turn ends. The turn's end submits it anyway, but only when its text changed; after changes were requested, this tool also records an unchanged plan.md as the next version. Answers with the version under review. Refused, with the reason, outside a vellum planning session (entered by /vellum:start), when plan.md is missing, when the plan is approved, or while a grill is open.",
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
    status: (text) => $.ui.status(text),
    invalidate: () => $.ui.invalidate("ui.render"),
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

/** The extensions whose `segment` threw in a mode: a failure is logged once per mode, not at each line. */
const segmentFailures = new WeakMap<Live, Set<string>>();

/** A segment that throws is left out: no extension may take the band away. */
function segmentOf(host: Host, live: Live, extension: EngineExtension): string | null {
  try {
    return extension.segment?.(contextOf(host, live, extension)) ?? null;
  } catch (cause) {
    const failed = segmentFailures.get(live) ?? new Set<string>();

    if (!failed.has(extension.id)) host.log(`${extension.id} failed on segment: ${String(cause)}`);
    segmentFailures.set(live, failed.add(extension.id));

    return null;
  }
}

const SEPARATOR = " │ ";

export const register: Register = (on) => {
  let state: State = { kind: "idle" };

  // Where each mode's server last said the plan stands, keyed by the mode: a new way in starts with none.
  const stages = new WeakMap<Live, StageWire>();

  function bandOf(host: Host): Band | null {
    if (state.kind === "idle") return null;

    if (state.kind === "lost") return lostBand(state.session.server);
    const { live } = state;
    const segments = engineExtensions.map((extension) => segmentOf(host, live, extension));

    return liveBand(live.session.server, stages.get(live) ?? null, segments);
  }

  // What `ui.render` draws; `redraw` alone writes it, so a line that changed nothing redraws nothing.
  let band: Band | null = null;

  function redraw(host: Host): void {
    const next = bandOf(host);

    if (JSON.stringify(next) === JSON.stringify(band)) return;
    band = next;
    host.invalidate();
  }

  /**
   * Every write of `state`: the band follows it, from one place. Leaving a live mode ends its
   * server, and leaving a mode's tenure stops its follower: the module owns its child, and what a
   * left mode's server would still say reaches nobody.
   */
  function become(host: Host, next: State): void {
    const was = state;
    state = next;

    if (was.kind === "live" && (next.kind !== "live" || next.live !== was.live)) {
      was.live.child.end();
    }

    const tenure = tenureOf(was);

    if (tenure !== null && tenure !== tenureOf(next)) tenure.follower.stop();
    redraw(host);
  }

  const settle: Settle = async (host, id) => {
    if (sessionOf(state)?.id !== id) return;
    turns = NO_TURN;
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

    turns = NO_TURN;
    become(host, next);
  };

  const staged: Staged = async (host, live, stage) => {
    stages.set(live, stage);
    await handed(host, live, "staged", (extension, context) => extension.staged?.(context));
    redraw(host);
  };

  const wiring: Wiring = { settle, staged, revive, current: (from) => state === from };

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

    if (state.kind === "live") {
      await handed(host, state.live, "closing", (extension, context) =>
        extension.closing?.(context),
      );
    }

    turns = NO_TURN;
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
    turns = NO_TURN;
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

  // Matched, never open: an unmatched `tool.call` hook wraps every tool call of every agent in
  // the session, and a worktree-isolated agent's shell loses its working directory inside it.
  // The literal is the registry's tools and refusals, held equal to it by `register.spec.ts`.
  on(
    "tool.call",
    // @ts-expect-error -- the generated contract's tool names predate AskUserQuestion, and a RegExp in the list runs the hook for every tool call in a live session.
    { tool: ["mcp__vellum__grill_suggest", "mcp__vellum__grill_ask", "AskUserQuestion"] },
    async ($, e, next) => {
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
    },
  );

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
