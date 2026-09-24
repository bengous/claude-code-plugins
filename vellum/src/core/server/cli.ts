#!/usr/bin/env bun

import { parseArgs } from "node:util";

import { EXIT_WORKDIR_GONE, startServer, WorkdirGone } from "./adapters/http/serve.ts";
import { parseWipDir } from "./domain/paths.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string" },
    project: { type: "string" },
    workdir: { type: "string" },
    port: { type: "string" },
    token: { type: "string" },
    existing: { type: "boolean" },
  },
});

const [command] = positionals;

const { session, project, workdir } = values;

if (
  command !== "serve" ||
  session === undefined ||
  project === undefined ||
  workdir === undefined
) {
  console.error(
    "usage: cli.ts serve --session <id> --project <dir> --workdir <dir> [--port <n> --token <t>] [--existing]",
  );
  process.exit(2);
}

const dir = parseWipDir(workdir);

if (!dir.ok) {
  console.error(dir.error);
  process.exit(2);
}

// The hooks module reads this process's stdout, one `ServerLine` per line: nothing else goes there.
await startServer({
  project,
  workdir: dir.value,
  port: Number(values.port ?? 0),
  token: values.token,
  existing: values.existing === true,
  announce: (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  },
}).catch((cause: unknown) => {
  if (!(cause instanceof WorkdirGone)) throw cause;
  console.error(cause.message);
  process.exit(EXIT_WORKDIR_GONE);
});
