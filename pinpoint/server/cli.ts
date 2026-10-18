#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { targetOf } from "../shared/target.ts";
import { DEV_PORTS } from "./apps.ts";
import { sessionFiles } from "./files.ts";
import { startServer } from "./serve.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string" },
    root: { type: "string" },
    port: { type: "string" },
    token: { type: "string" },
    target: { type: "string" },
  },
});

const [command] = positionals;

const { session, root } = values;

const dir = join(homedir(), ".claude", "pinpoint");

if (command === "clean" && session !== undefined) {
  await sessionFiles(dir, session).removeAll();
  process.exit(0);
}

const target = values.target === undefined ? null : targetOf(values.target);

if (
  command !== "serve" ||
  session === undefined ||
  root === undefined ||
  (values.target !== undefined && target === null)
) {
  console.error(
    "usage: cli.ts serve --session <id> --root <dir> [--port <n> --token <t>] [--target <http(s) url>] | cli.ts clean --session <id>",
  );
  process.exit(2);
}

// The hooks module reads this process's stdout, one `ServerLine` per line: nothing else goes there.
await startServer({
  dir,
  session,
  root,
  port: Number(values.port ?? 0),
  token: values.token,
  target,
  ports: DEV_PORTS,
  announce: (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  },
  closed: () => process.exit(0),
  // The module beats every 15 s: a `claude` killed hard leaves no signal, only this silence.
  watchdog: { graceMs: 60_000, periodMs: 5_000, expire: () => process.exit(0) },
});
