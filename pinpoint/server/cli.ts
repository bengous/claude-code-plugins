#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { PINPOINT_DIR } from "../shared/wire.ts";
import { sessionFiles } from "./files.ts";
import { startServer } from "./serve.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string" },
    root: { type: "string" },
    port: { type: "string" },
    token: { type: "string" },
  },
});

const [command] = positionals;

const { session, root } = values;

if (command !== "serve" || session === undefined || root === undefined) {
  console.error("usage: cli.ts serve --session <id> --root <dir> [--port <n> --token <t>]");
  process.exit(2);
}

const dir = join(homedir(), PINPOINT_DIR);

const files = sessionFiles(dir, session);

/** Ends the process, its registry entry removed first: the Vite plugin must not point at a dead port. */
function leave(): void {
  void files.removeEntry().finally(() => process.exit(0));
}

process.on("SIGTERM", leave);

process.on("SIGINT", leave);

// The hooks module reads this process's stdout, one `ServerLine` per line: nothing else goes there.
await startServer({
  dir,
  session,
  root,
  port: Number(values.port ?? 0),
  token: values.token,
  announce: (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  },
  closed: () => process.exit(0),
  // The module beats every 15 s: a `claude` killed hard leaves no signal, only this silence.
  watchdog: { graceMs: 60_000, periodMs: 5_000, expire: leave },
});
