import type { EngineInterface, HttpInit, HttpResponse, Register, Timer } from "claude-code";

type ServerInfo = { readonly port: number; readonly token: string; readonly pid: number };

/** What `$.store` keeps under `session:<id>`, so a reloaded module finds its server again. */
type Session = { readonly server: ServerInfo; readonly workdir: string };

type Pending =
  | { readonly kind: "none" }
  | { readonly kind: "feedback"; readonly version: number; readonly path: string }
  | { readonly kind: "approved"; readonly version: number };

type PlanInput = { readonly plan: string; readonly planFilePath: string };

/** A reachable review server and the timer that keeps it alive. */
type Live = { readonly session: Session; readonly heartbeat: Timer };

/**
 * Everything the module can be in. `drafting`: the server runs, no plan waits. `reviewing`:
 * a plan waits in the browser, polled. `approved`: the browser approved and Claude was asked
 * to call ExitPlanMode again.
 */
type State =
  | { readonly kind: "idle" }
  | { readonly kind: "drafting"; readonly live: Live }
  | {
      readonly kind: "reviewing";
      readonly live: Live;
      readonly version: number;
      readonly poll: Timer;
    }
  | { readonly kind: "approved"; readonly live: Live; readonly version: number };

const SKILL = "vellum:plan";

const POLL_MS = 1_000;

const HEARTBEAT_MS = 30_000;

const START_TIMEOUT_MS = 10_000;

let state: State = { kind: "idle" };

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- the block below IS the boundary parser the rules ask for: `tool_input`, `$.store` values and the server's JSON arrive as `unknown`, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlanInput(input: unknown): input is PlanInput {
  return (
    isRecord(input) && typeof input.plan === "string" && typeof input.planFilePath === "string"
  );
}

function parseServerInfo(value: unknown): ServerInfo | null {
  return isRecord(value) &&
    typeof value.port === "number" &&
    typeof value.token === "string" &&
    typeof value.pid === "number"
    ? { port: value.port, token: value.token, pid: value.pid }
    : null;
}

function parseSession(value: unknown): Session | null {
  const server = isRecord(value) ? parseServerInfo(value.server) : null;

  return server !== null && isRecord(value) && typeof value.workdir === "string"
    ? { server, workdir: value.workdir }
    : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parsePending(text: string): Pending {
  const value = parseJson(text);

  if (!isRecord(value) || typeof value.version !== "number") return { kind: "none" };

  if (value.kind === "approved") return { kind: "approved", version: value.version };

  if (value.kind === "feedback" && typeof value.path === "string") {
    return { kind: "feedback", version: value.version, path: value.path };
  }

  return { kind: "none" };
}

function parseVersion(text: string): number | null {
  const value = parseJson(text);

  return isRecord(value) && typeof value.version === "number" ? value.version : null;
}

function parseFinalized(text: string): string | null {
  const value = parseJson(text);

  return isRecord(value) && typeof value.plan === "string" ? value.plan : null;
}

function parseFinalizeError(text: string): string {
  const value = parseJson(text);
  const workspace = isRecord(value) ? value.workspace : null;

  return isRecord(workspace) && typeof workspace.finalizeError === "string"
    ? workspace.finalizeError
    : "the plan was not approved in the browser";
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening */

function api(
  $: EngineInterface,
  server: ServerInfo,
  path: string,
  init?: HttpInit,
): Promise<HttpResponse> {
  return $.http.fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: { "x-vellum-token": server.token, "content-type": "application/json" },
  });
}

async function alive($: EngineInterface, server: ServerInfo): Promise<boolean> {
  try {
    return (await api($, server, "/api/review")).ok;
  } catch {
    return false;
  }
}

function reviewUrl(server: ServerInfo): string {
  return `http://127.0.0.1:${server.port}/t/${server.token}/`;
}

function feedbackPrompt(pending: Extract<Pending, { kind: "feedback" }>): string {
  return `Plan review v${pending.version}: changes requested. Read ${pending.path}, revise the plan, then call ExitPlanMode.`;
}

function approvedPrompt(version: number): string {
  return `Plan v${version} was approved in the browser. Call ExitPlanMode again with the same plan.`;
}

function keepAlive($: EngineInterface, session: Session): Live {
  const heartbeat = $.clock.every(HEARTBEAT_MS, () => {
    void api($, session.server, "/api/heartbeat", { method: "POST" }).catch(() => {});
  });

  return { session, heartbeat };
}

async function startServer(
  $: EngineInterface,
  id: string,
  workdir: string,
): Promise<ServerInfo | null> {
  const argv = [
    "bun",
    `${$.plugin.root}/src/cli.ts`,
    "start",
    "--session",
    id,
    "--project",
    await $.session.cwd(),
    "--workdir",
    workdir,
  ];

  try {
    const run = await $.process.run(argv, { timeoutMs: START_TIMEOUT_MS });

    if (run.exitCode === 0) return parseServerInfo(parseJson(run.stdout));
    $.ui.log(`vellum: the review server did not start: ${run.stderr.trim()}`);
  } catch (cause) {
    $.ui.log(`vellum: the review server did not start: ${String(cause)}`);
  }

  return null;
}

/** The session `$.store` kept across a module reload, when its server still answers. */
async function restored($: EngineInterface, id: string): Promise<Live | null> {
  const stored = parseSession(await $.store.get(`session:${id}`));

  return stored !== null && (await alive($, stored.server)) ? keepAlive($, stored) : null;
}

async function started($: EngineInterface, id: string, workdir: string): Promise<Live | null> {
  const server = await startServer($, id, workdir);

  if (server === null) return null;
  const session = { server, workdir };
  await $.store.set(`session:${id}`, session);

  return keepAlive($, session);
}

function stopTimers(): void {
  if (state.kind === "idle") return;
  state.live.heartbeat.cancel();

  if (state.kind === "reviewing") state.poll.cancel();
}

/**
 * Reaches a server, in order: the current one when it answers, the one `$.store` kept, a new
 * one. A server that stopped answering takes its review with it: the state is `drafting`
 * again, or `idle` when nothing starts.
 */
async function connect($: EngineInterface): Promise<Live | null> {
  const id = await $.session.id();
  const current = state.kind === "idle" ? null : state.live;

  if (current !== null && (await alive($, current.session.server))) return current;
  stopTimers();
  const date = new Date().toISOString().slice(0, 10);
  const workdir = current?.session.workdir ?? `plans/${date}/wip-${id.slice(0, 8)}/`;
  const live = (await restored($, id)) ?? (await started($, id, workdir));
  state = live === null ? { kind: "idle" } : { kind: "drafting", live };

  return live;
}

/** The server of a hook that starts none: the current one, or the stored one after a reload. */
async function attached($: EngineInterface): Promise<Live | null> {
  if (state.kind !== "idle") return state.live;
  const live = await restored($, await $.session.id());

  if (live !== null) state = { kind: "drafting", live };

  return live;
}

async function close($: EngineInterface): Promise<void> {
  await $.store.delete(`session:${await $.session.id()}`);
  stopTimers();
  state = { kind: "idle" };
  $.ui.status(undefined);
}

/**
 * Polls the server once a second until the browser decides, then submits one prompt. The poll
 * stops once the prompt entered; a prompt dropped by another plugin or a failed submit is logged
 * and the poll goes on, so the decision is retried on the next tick.
 */
function review($: EngineInterface, live: Live, version: number): void {
  if (state.kind === "reviewing") state.poll.cancel();
  let submitting = false;

  const poll = $.clock.every(POLL_MS, () => {
    if (submitting) return;

    void api($, live.session.server, "/api/pending")
      .then(async (response) => {
        const pending = parsePending(response.text);

        if (pending.kind === "none") return;
        submitting = true;

        const text =
          pending.kind === "approved" ? approvedPrompt(pending.version) : feedbackPrompt(pending);

        const result = await $.prompt.submit({ text });

        if (result.drop !== undefined) {
          $.ui.log(`vellum: the review prompt was dropped: ${result.drop}`);
          submitting = false;

          return;
        }

        poll.cancel();

        if (state.kind === "reviewing" && state.poll === poll) {
          state =
            pending.kind === "approved"
              ? { kind: "approved", live, version: pending.version }
              : { kind: "drafting", live };
        }

        $.ui.status(undefined);
      })
      .catch((cause: unknown) => {
        $.ui.log(`vellum: the review poll failed: ${String(cause)}`);
        submitting = false;
      });
  });

  state = { kind: "reviewing", live, version, poll };
  $.ui.status(`plan v${version} under review`);
  $.ui.log(`vellum: plan v${version} under review at ${reviewUrl(live.session.server)}`);
}

export const register: Register = (on) => {
  // A fresh environment on every load; spelled out so a test that calls register twice starts clean.
  state = { kind: "idle" };

  on("skill.prompt", { skill: SKILL }, async ($, e, next) => {
    const live = await connect($);
    const result = await next(e);

    if (live === null) return result;

    if (state.kind === "reviewing") {
      void api($, live.session.server, "/api/open", { method: "POST" }).catch(() => {});
    }

    return { text: `${result.text}\n\nWorking directory: ${live.session.workdir}` };
  });

  on("classic.PermissionRequest", { tool_name: "ExitPlanMode" }, async ($, e, next) => {
    if (e.agent_id !== undefined || !isPlanInput(e.tool_input)) return next(e);
    const live = await attached($);

    if (live === null) return next(e);
    const { server } = live.session;

    if (state.kind === "approved") {
      const { version } = state;

      const response = await api($, server, "/api/finalize", {
        method: "POST",
        body: JSON.stringify({ version }),
      }).catch((): HttpResponse | null => null);

      if (response === null) return next(e);
      const plan = response.ok ? parseFinalized(response.text) : null;

      if (plan === null) {
        review($, live, version);

        return {
          decision: {
            behavior: "deny",
            message: `Vellum could not finalize the plan: ${parseFinalizeError(response.text)}. The review stays open in the browser; end your turn.`,
          },
        };
      }

      await close($);

      return {
        decision: {
          behavior: "allow",
          updatedInput: { ...e.tool_input, plan },
          updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
        },
      };
    }

    const gated = await api($, server, "/api/gate", {
      method: "POST",
      body: JSON.stringify({ plan: e.tool_input.plan, planFilePath: e.tool_input.planFilePath }),
    }).catch((): HttpResponse | null => null);

    const version = gated?.ok === true ? parseVersion(gated.text) : null;

    if (version === null) return next(e);
    review($, live, version);

    return {
      decision: {
        behavior: "deny",
        message: `Plan v${version} is open for review in the browser. End your turn; the review arrives as a new prompt.`,
      },
    };
  });
};
