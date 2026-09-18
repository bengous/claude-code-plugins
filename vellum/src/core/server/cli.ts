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

if (session === undefined || project === undefined || workdir === undefined) {
  console.error(
    "usage: cli.ts start|serve --session <id> --project <dir> --workdir <dir> [--port <n> --token <t>] [--existing]",
  );
  process.exit(2);
}

if (command === "serve") {
  const dir = parseWipDir(workdir);

  if (!dir.ok) {
    console.error(dir.error);
    process.exit(2);
  }

  const started = await startServer({
    project,
    workdir: dir.value,
    port: Number(values.port ?? 0),
    token: values.token,
    existing: values.existing === true,
  }).catch((cause: unknown) => {
    if (!(cause instanceof WorkdirGone)) throw cause;
    console.error(cause.message);
    process.exit(EXIT_WORKDIR_GONE);
  });

  console.log(
    JSON.stringify({ port: started.server.port, token: started.token, pid: process.pid }),
  );
} else if (command === "start") {
  const child = Bun.spawn(["bun", import.meta.path, "serve", ...process.argv.slice(3)], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  while (!buffered.includes("\n")) {
    const { value, done } = await reader.read();

    if (done) {
      console.error("vellum serve exited before announcing its port");
      process.exit((await child.exited) === EXIT_WORKDIR_GONE ? EXIT_WORKDIR_GONE : 1);
    }

    buffered += decoder.decode(value);
  }

  reader.releaseLock();
  child.unref();
  console.log(buffered.slice(0, buffered.indexOf("\n")));
  process.exit(0);
} else {
  console.error(`unknown command: ${command ?? "(none)"}`);
  process.exit(2);
}
