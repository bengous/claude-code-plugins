import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { serverPlugins } from "../../../plugins/server.ts";
import index from "../../../ui/index.html";
import { Review } from "../../app/review.ts";
import type { WipDir } from "../../domain/paths.ts";
import { REVIEW_DIR } from "../../domain/workspace.ts";
import { openInBrowser } from "../browser.ts";
import { createHandler } from "./routes.ts";

export type ServeOptions = {
  readonly project: string;
  readonly workdir: WipDir;
  readonly port: number;
};

export type Started = {
  readonly server: Bun.Server<undefined>;
  readonly token: string;
  readonly url: string;
  /** Stops the server and its watchdog; for tests, which share one process. */
  readonly stop: () => void;
};

export const HEARTBEAT_GRACE_MS = 90_000;

const WATCHDOG_PERIOD_MS = 5_000;

export async function startServer(options: ServeOptions): Promise<Started> {
  await mkdir(join(options.project, options.workdir, REVIEW_DIR), { recursive: true });
  const token = crypto.randomUUID();

  const review = new Review({
    project: options.project,
    workdir: options.workdir,
    plugins: serverPlugins,
  });

  let lastHeartbeat = Date.now();
  let url = "";

  const handler = createHandler({
    token,
    project: options.project,
    review,
    openBrowser: () => openInBrowser(url),
    heartbeat: () => {
      lastHeartbeat = Date.now();
    },
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 0,
    development: false,
    routes: { [`/t/${token}/`]: index },
    fetch: handler,
  });

  url = `http://127.0.0.1:${server.port}/t/${token}/`;

  const watchdog = setInterval(() => {
    if (Date.now() - lastHeartbeat > HEARTBEAT_GRACE_MS) process.exit(0);
  }, WATCHDOG_PERIOD_MS);

  return {
    server,
    token,
    url,
    stop: () => {
      clearInterval(watchdog);
      server.stop(true);
    },
  };
}
