import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { serverExtensions } from "../../../../extensions/server.ts";
import type { Route, ServerContext } from "../../../extension.ts";
import index from "../../../page/index.html";
import { Review } from "../../app/review.ts";
import type { WipDir } from "../../domain/paths.ts";
import { REVIEW_DIR } from "../../domain/workspace.ts";
import { openInBrowser } from "../browser.ts";
import { watchFiles } from "../fs.ts";
import { createHandler } from "./routes.ts";

/**
 * When the server gives up: `expire` runs once nothing has kept it for `graceMs`. A tab keeps it
 * no longer than `tabHoldMs` past the last heartbeat: a `/clear` or a revive on another port
 * leaves a server its module never beats again, and the reviewer's tab still listens to it.
 */
export type Watchdog = {
  readonly graceMs: number;
  readonly tabHoldMs: number;
  readonly periodMs: number;
  readonly expire: () => void;
};

export type ServeOptions = {
  readonly project: string;
  readonly workdir: WipDir;
  /** Taken meanwhile: another port is bound, under a new token. */
  readonly port: number;
  /** The token a revived server keeps, so the reviewer's tab finds its page again. */
  readonly token?: string | undefined;
  /** A revived server never creates its directory: an approval may have renamed it. */
  readonly existing?: boolean;
  readonly watchdog?: Watchdog;
};

export class WorkdirGone extends Error {}

export const EXIT_WORKDIR_GONE = 3;

export type Started = {
  readonly server: Bun.Server<undefined>;
  readonly token: string;
  readonly url: string;
  /** Stops the server and its watchdog; for tests, which share one process. */
  readonly stop: () => void;
};

const WATCHDOG: Watchdog = {
  graceMs: 90_000,
  tabHoldMs: 15 * 60_000,
  periodMs: 5_000,
  expire: () => process.exit(0),
};

/**
 * `extensions/html/frame.ts` for the sandboxed mockups, built once: the page bundle never loads it.
 * An IIFE, since a classic `<script>` shares the mockup's global scope: the default ESM output
 * has no wrapper, and its minified names would collide with the mockup's own (`_`, `a`, `r`).
 */
async function buildFrameScript(): Promise<string> {
  // TODO: the one place the core names an extension by path; an extension should hand the
  // server its own script once a server half can carry one.
  const entry = join(import.meta.dir, "../../../../extensions/html/frame.ts");
  const built = await Bun.build({ entrypoints: [entry], minify: true, format: "iife" });
  const output = built.outputs[0];

  if (output === undefined) throw new Error(`no output building ${entry}`);

  return await output.text();
}

/** Every extension's routes under its own prefix, so no two extensions can claim one path. */
function extensionRoutes(context: ServerContext): ReadonlyMap<string, Route> {
  return new Map(
    serverExtensions.flatMap((extension) =>
      Object.entries(extension.routes?.(context) ?? {}).map(([key, route]) => {
        const [method, name] = key.split(" ");

        return [`${method} /api/x/${extension.id}/${name}`, route] as const;
      }),
    ),
  );
}

function isPortTaken(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE";
}

export async function startServer(options: ServeOptions): Promise<Started> {
  if (options.existing === true && !existsSync(join(options.project, options.workdir))) {
    throw new WorkdirGone(`${options.workdir} is gone`);
  }

  await mkdir(join(options.project, options.workdir, REVIEW_DIR), { recursive: true });
  const frameScript = await buildFrameScript();

  const review = new Review({
    project: options.project,
    workdir: options.workdir,
    extensions: serverExtensions,
  });

  // The page hears of every file Claude writes; the approval renames the directory, and there the watch ends.
  const unwatch = watchFiles(options.project, options.workdir, () => void review.notify());

  review.subscribe((workspace) => {
    if (workspace.kind === "approved") unwatch();
  });

  let lastHeartbeat = Date.now();
  let url = "";

  const context = {
    project: options.project,
    review,
    frameScript,
    extensionRoutes: extensionRoutes(review.context),
    openBrowser: () => openInBrowser(url),
    heartbeat: () => {
      lastHeartbeat = Date.now();
    },
  };

  const bind = (port: number, token: string) => {
    const handler = createHandler({ ...context, token });

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 0,
      development: false,
      routes: { [`/t/${token}/`]: index },
      fetch: handler.handle,
    });

    return { server, token, handler };
  };

  const bound = ((): ReturnType<typeof bind> => {
    try {
      return bind(options.port, options.token ?? crypto.randomUUID());
    } catch (cause) {
      if (!isPortTaken(cause)) throw cause;

      // The stream's URL carries the token, so whoever took the port reads it from every tab
      // that reconnects: the kept token goes with the kept port.
      return bind(0, crypto.randomUUID());
    }
  })();

  const { server, token, handler } = bound;
  url = `http://127.0.0.1:${server.port}/t/${token}/`;
  const { graceMs, tabHoldMs, periodMs, expire } = options.watchdog ?? WATCHDOG;

  // The module's heartbeat keeps the server; a reviewer's tab does too, for a while.
  const watchdog = setInterval(() => {
    const silent = Date.now() - lastHeartbeat;

    if (silent > graceMs && (handler.openStreams() === 0 || silent > tabHoldMs)) expire();
  }, periodMs);

  return {
    server,
    token,
    url,
    stop: () => {
      unwatch();
      clearInterval(watchdog);
      server.stop(true);
    },
  };
}
