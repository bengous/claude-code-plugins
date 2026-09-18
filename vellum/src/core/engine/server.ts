import type { HttpInit, HttpResponse } from "claude-code";

import type { ExtensionApi } from "./extension.ts";
import type { Host } from "./host.ts";
import type { ServerInfo } from "./mode.ts";
import {
  type GateWire,
  parseGate,
  parseJson,
  parsePending,
  parseServerInfo,
  type PendingWire,
  type ProjectDir,
  type SessionId,
  type Workdir,
} from "./parse.ts";

// Well under the hook's own budget: the way in also probes and reads the store before it starts.
const START_TIMEOUT_MS = 5_000;

/**
 * What a submit does with a `plan.md` whose text is the version under review: `record` opens
 * a new version after a feedback, as the model's explicit call means it; `keep` never does.
 */
export type Unchanged = "record" | "keep";

/** The review server's client: every route, the token header and the page's address. */
export type ReviewServer = {
  readonly info: ServerInfo;
  readonly url: string;
  alive: () => Promise<boolean>;
  gate: (unchanged: Unchanged) => Promise<GateWire>;
  pending: () => Promise<PendingWire>;
  open: () => Promise<void>;
  heartbeat: () => Promise<void>;
  extension: (id: string) => ExtensionApi;
};

function api(host: Host, info: ServerInfo, path: string, init?: HttpInit): Promise<HttpResponse> {
  return host.fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: { "x-vellum-token": info.token, "content-type": "application/json" },
  });
}

export function reach(host: Host, info: ServerInfo): ReviewServer {
  // `open` and `heartbeat` are told, not asked: a server that misses one is found dead by
  // `alive` on the next way in, and a rejection here would only kill the poll that raised it.
  const told = (path: string): Promise<void> =>
    api(host, info, path, { method: "POST" }).then(
      () => {},
      () => {},
    );

  return {
    info,
    url: `http://127.0.0.1:${info.port}/t/${info.token}/`,
    alive: () =>
      api(host, info, "/api/review").then(
        (response) => response.ok,
        () => false,
      ),
    gate: (unchanged) =>
      api(host, info, "/api/gate", { method: "POST", body: JSON.stringify({ unchanged }) }).then(
        parseGate,
      ),
    pending: () => api(host, info, "/api/pending").then((response) => parsePending(response.text)),
    open: () => told("/api/open"),
    heartbeat: () => told("/api/heartbeat"),
    extension: (id) => ({
      get: (path) => api(host, info, `/api/x/${id}/${path}`),
      post: (path, json) => api(host, info, `/api/x/${id}/${path}`, { method: "POST", body: json }),
    }),
  };
}

/** Spawns the detached server on the working directory; `null` when the launcher could not. */
export async function start(
  host: Host,
  id: SessionId,
  project: ProjectDir,
  workdir: Workdir,
): Promise<ReviewServer | null> {
  const argv = [
    "bun",
    `${host.pluginRoot}/src/core/server/cli.ts`,
    "start",
    "--session",
    id,
    "--project",
    project,
    "--workdir",
    workdir,
  ];

  try {
    const run = await host.run(argv, { timeoutMs: START_TIMEOUT_MS });

    if (run.exitCode === 0) {
      const info = parseServerInfo(parseJson(run.stdout));

      return info === null ? null : reach(host, info);
    }

    host.log(`the review server did not start: ${run.stderr.trim()}`);
  } catch (cause) {
    host.log(`the review server did not start: ${String(cause)}`);
  }

  return null;
}
