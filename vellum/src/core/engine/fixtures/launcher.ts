import type { On, ProcessRunResult } from "claude-code";

import { SERVER } from "./server.ts";

/** What `$.process.run` answers: a launcher that started, or one that could not. */
export type Launch = { value: ProcessRunResult } | { deny: string };

export const STARTED: Launch = {
  value: { exitCode: 0, stdout: `${JSON.stringify(SERVER)}\n`, stderr: "" },
};

export const EXIT_WORKDIR_GONE: Launch = { value: { exitCode: 3, stdout: "", stderr: "gone" } };

/** Answers each run by its rank, from 1, so a test can let the first start and refuse a revival. */
export type Launcher = (run: number) => Launch | Promise<Launch>;

export function launcher(on: On, launch: Launcher = () => STARTED): (readonly string[])[] {
  const runs: (readonly string[])[] = [];

  on("process.run", async (_, e) => {
    runs.push(e.argv);

    return await launch(runs.length);
  });

  return runs;
}
