import type { On } from "claude-code";
import { mock, type MockClock } from "claude-code/testing";

import type { ChannelLineWire } from "../parse.ts";
import { engineBand } from "./band.ts";
import { type Child, children, type Spawn } from "./children.ts";
import { CWD } from "./cwd.ts";
import { disk, type Entries } from "./disk.ts";
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
 * another plugin refuses the next prompt, `cwd` what `$.session.cwd()` answers, `refuseCwd` the reason `$.session.cwd()` fails, and
 * `refuseStore` the reason a store write fails. `children` are the servers the module spawned,
 * and `channel` the file their channel keeps on disk.
 */
export type World = {
  id: string;
  drop: string | undefined;
  /** While set, a prompt's call resolves only once it does: the prompt waits for a running turn. */
  hold: (() => Promise<void>) | undefined;
  cwd: string;
  /** What `$.session.root()` answers: where the session started, whatever `cd` Claude ran. */
  root: string;
  /** The reason `$.env.get` fails, while set. */
  refuseEnv: string | undefined;
  refuseCwd: string | undefined;
  refuseStore: string | undefined;
  readonly clock: MockClock;
  readonly paths: string[];
  readonly children: Child[];
  readonly channel: ChannelLineWire[];
  readonly prompts: string[];
  readonly statuses: (string | undefined)[];
  readonly logs: string[];
  readonly tools: string[];
  readonly commands: string[];
  readonly store: Map<string, unknown>;
  /** The session's environment as `$.env` reads it; `$.env.set` writes here. */
  readonly env: Map<string, string>;
  /** Every `$.env.set`, in order: `value` absent unsets. */
  readonly envWrites: { readonly name: string; readonly value: string | undefined }[];
};

export type WorldOptions = {
  routes?: Record<string, Route>;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- what the store holds across a reload, as the engine types it (`ResultOf['store.get']` is `unknown`).
  stored?: Readonly<Record<string, unknown>>;
  spawn?: Spawn;
  channel?: readonly ChannelLineWire[];
  disk?: Entries;
  env?: Readonly<Record<string, string>>;
};

export function world(on: On, options: WorldOptions = {}): World {
  const tools: string[] = [];
  const commands: string[] = [];
  const channel = [...(options.channel ?? [])];

  const built: World = {
    id: SESSION_ID,
    drop: undefined,
    hold: undefined,
    cwd: CWD,
    root: CWD,
    refuseEnv: undefined,
    refuseCwd: undefined,
    refuseStore: undefined,
    clock: mock.clock(on),
    paths: liveServer(on, channel, options.routes),
    children: children(on, options.spawn),
    channel,
    prompts: prompts(
      on,
      () => built.drop,
      () => built.hold?.() ?? Promise.resolve(),
    ),
    statuses: statuses(on),
    logs: logs(on),
    tools,
    commands,
    store: store(on, options.stored, () => built.refuseStore),
    env: new Map(Object.entries(options.env ?? {})),
    envWrites: [],
  };

  skillText(on);
  engineBand(on);
  disk(on, options.disk);

  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("session.id", () => ({ value: built.id }));
  on("session.cwd", () =>
    built.refuseCwd === undefined ? { value: built.cwd } : { deny: built.refuseCwd },
  );

  on("env.get", (_, e) =>
    built.refuseEnv === undefined ? { value: built.env.get(e.name) } : { deny: built.refuseEnv },
  );
  on("session.root", () => ({ value: built.root }));

  on("env.set", (_, e) => {
    built.envWrites.push({ name: e.name, value: e.value });

    if (e.value === undefined) built.env.delete(e.name);
    else built.env.set(e.name, e.value);

    return { value: undefined };
  });

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
