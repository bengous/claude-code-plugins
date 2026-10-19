#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { targetOf } from "../shared/target.ts";
import { DEV_PORTS } from "./apps.ts";
import { openInBrowser } from "./browser.ts";
import { sessionFiles } from "./files.ts";
import { startServer } from "./serve.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string" },
    root: { type: "string" },
    relayed: { type: "string" },
    "keep-days": { type: "string" },
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

/**
 * A count as typed on the command line, `null` when it is not a whole number. Any safe integer
 * reads back: the module checks its counts with `Number.isSafeInteger`, which `String` writes as
 * plain digits.
 */
function countOf(text: string | undefined): number | null {
  const count = text !== undefined && /^\d+$/u.test(text) ? Number(text) : null;

  return count !== null && Number.isSafeInteger(count) ? count : null;
}

const target = values.target === undefined ? null : targetOf(values.target);

const relayed = countOf(values.relayed);

const keepDays = values["keep-days"] === undefined ? null : countOf(values["keep-days"]);

if (
  command !== "serve" ||
  session === undefined ||
  root === undefined ||
  relayed === null ||
  (values["keep-days"] !== undefined && (keepDays === null || keepDays < 1)) ||
  (values.target !== undefined && target === null)
) {
  console.error(
    "usage: cli.ts serve --session <id> --root <dir> --relayed <n> [--keep-days <n ≥ 1>] [--port <n> --token <t>] [--target <http(s) url>] | cli.ts clean --session <id>",
  );
  process.exit(2);
}

// The hooks module reads this process's stdout, one `ServerLine` per line: nothing else goes there.
await startServer({
  dir,
  session,
  root,
  relayed,
  keepDays,
  port: Number(values.port ?? 0),
  token: values.token,
  target,
  ports: DEV_PORTS,
  announce: (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  },
  closed: () => process.exit(0),
  open: openInBrowser,
  // The module beats every 15 s: a `claude` killed hard leaves no signal, only this silence.
  watchdog: { graceMs: 60_000, periodMs: 5_000, expire: () => process.exit(0) },
});
