import type { On } from "claude-code";
import { mock, type MockClock } from "claude-code/testing";

import { CWD } from "./cwd.ts";
import { type Launcher, launcher } from "./launcher.ts";
import { liveServer, type Route } from "./live-server.ts";
import { logs } from "./logs.ts";
import { prompts } from "./prompts.ts";
import { SESSION_ID } from "./session-id.ts";
import { skillText } from "./skill-text.ts";
import { statuses } from "./statuses.ts";
import { store } from "./store.ts";

/**
 * What the module finds beneath it, and what it did there. `id` is what
 * `$.session.id()` answers, so assigning it is a `/clear`; `drop` is the reason
 * another plugin refuses the next prompt, `refuseCwd` the reason `$.session.cwd()` fails, and
 * `refuseStore` the reason a store write fails.
 */
export type World = {
  id: string;
  drop: string | undefined;
  refuseCwd: string | undefined;
  refuseStore: string | undefined;
  readonly clock: MockClock;
  readonly paths: string[];
  readonly runs: (readonly string[])[];
  readonly prompts: string[];
  readonly statuses: (string | undefined)[];
  readonly logs: string[];
  readonly tools: string[];
  readonly commands: string[];
  readonly store: Map<string, unknown>;
};

export type WorldOptions = {
  routes?: Record<string, Route>;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- what the store holds across a reload, as the engine types it (`ResultOf['store.get']` is `unknown`).
  stored?: Readonly<Record<string, unknown>>;
  launch?: Launcher;
};

export function world(on: On, options: WorldOptions = {}): World {
  const tools: string[] = [];
  const commands: string[] = [];

  const built: World = {
    id: SESSION_ID,
    drop: undefined,
    refuseCwd: undefined,
    refuseStore: undefined,
    clock: mock.clock(on),
    paths: liveServer(on, options.routes),
    runs: launcher(on, options.launch),
    prompts: prompts(on, () => built.drop),
    statuses: statuses(on),
    logs: logs(on),
    tools,
    commands,
    store: store(on, options.stored, () => built.refuseStore),
  };

  skillText(on);

  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("session.id", () => ({ value: built.id }));
  on("session.cwd", () =>
    built.refuseCwd === undefined ? { value: CWD } : { deny: built.refuseCwd },
  );

  on("tool.register", (_, e) => {
    tools.push(e.name);

    return { value: { tool: `mcp__vellum__${e.name}` } };
  });

  on("command.register", (_, e) => {
    commands.push(e.name);

    return { value: { command: e.name } };
  });

  return built;
}
