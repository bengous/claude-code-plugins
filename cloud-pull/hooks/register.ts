import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { CloudRow, PullState } from "../types";

const PULL = "cloud-pull";

const PANE = "cloud-pull";

const API = "https://api.anthropic.com/v1/sessions";

/**
 * The headers Claude Code itself sends to the cloud sessions API; the API is undocumented.
 * The engine replaces a lowercase `anthropic-beta` when it adds the credential, dropping `ccr-byoc` (the API then answers 404); this casing survives.
 */
const API_HEADERS = {
  "anthropic-version": "2023-06-01",
  "Anthropic-Beta": "oauth-2025-04-20,ccr-byoc-2025-07-29",
};

const LIST_LIMIT = 50;

const TELEPORT_TIMEOUT_MS = 5 * 60_000;

const SESSION_ID = /^session_[A-Za-z0-9]+$/u;

const NO_ROWS: readonly CloudRow[] = [];

const IDLE: PullState = { kind: "idle" };

const sessions = atom({ plugin: "cloud-pull", key: "sessions" } as const, NO_ROWS);

const pullState = atom({ plugin: "cloud-pull", key: "state" } as const, IDLE);

/** A cloud session as the API answers it, before the list keeps those of this repository that run in Anthropic's cloud. */
type ApiSession = CloudRow & { readonly environmentKind: string | null };

type Pulled = {
  cloudSessionId: string;
  title: string;
  model: string | undefined;
  effort: string | undefined;
  isAnnounced: boolean;
};

const storeKey = (cwd: string) => `pulled:${cwd}`;

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- the cloud sessions API, the teleport's JSON output and the plugin store all hand untyped JSON: these readers ARE the boundary, and nothing past them sees it untyped. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown) => (typeof value === "string" ? value : undefined);

function parsePulled(value: unknown): Pulled | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const cloudSessionId = textOf(value["cloudSessionId"]);
  const title = textOf(value["title"]);

  if (cloudSessionId === undefined || title === undefined) {
    return undefined;
  }

  return {
    cloudSessionId,
    title,
    model: textOf(value["model"]),
    effort: textOf(value["effort"]),
    isAnnounced: value["isAnnounced"] === true,
  };
}

function parseSession(value: unknown): ApiSession | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const id = textOf(value["id"]);
  const context = isObject(value["session_context"]) ? value["session_context"] : {};
  const sources: unknown[] = Array.isArray(context["sources"]) ? context["sources"] : [];

  const repository = sources.find(
    (source) => isObject(source) && source["type"] === "git_repository",
  );

  const repoUrl = isObject(repository) ? textOf(repository["url"]) : undefined;

  if (id === undefined || repoUrl === undefined) {
    return undefined;
  }

  return {
    id,
    title: textOf(value["title"]) ?? id,
    status: textOf(value["session_status"]) ?? "unknown",
    updatedAt: textOf(value["updated_at"]) ?? "",
    repoUrl,
    model: textOf(context["model"]) ?? null,
    effort: textOf(context["effort_level"]) ?? null,
    environmentKind: textOf(value["environment_kind"]) ?? null,
  };
}

const parseSessions = (value: unknown): ApiSession[] => {
  const data: unknown = isObject(value) ? value["data"] : undefined;

  return Array.isArray(data) ? data.flatMap((one) => parseSession(one) ?? []) : [];
};

function localSessionId(output: string) {
  const events: unknown = JSON.parse(output);
  const last: unknown = Array.isArray(events) ? events.at(-1) : undefined;

  return isObject(last) ? textOf(last["session_id"]) : undefined;
}

const readPulled = async ($: EngineInterface, cwd: string) =>
  parsePulled(await $.store.get(storeKey(cwd)));
/* oxlint-enable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

async function callApi($: EngineInterface, path: string, method = "GET"): Promise<string> {
  const auth = await $.session.authorize();

  if (auth === null) {
    throw new Error("no claude.ai sign-in in this session: the cloud sessions API needs one");
  }

  const init = { method, headers: API_HEADERS, auth: auth.handle };

  const response = await $.http.fetch(
    `${API}${path}`,
    method === "GET" ? init : { ...init, body: "{}" },
  );

  if (!response.ok) {
    throw new Error(
      `cloud sessions API answered ${response.status} for ${method} ${path}: ${response.text.slice(0, 300)}`,
    );
  }

  return response.text;
}

async function fetchCloudSession($: EngineInterface, id: string): Promise<CloudRow> {
  const session = parseSession(JSON.parse(await callApi($, `/${id}`)));

  if (session === undefined) {
    throw new Error(`cloud session ${id} has no git repository: nothing to check out locally`);
  }

  return session;
}

async function run(
  $: EngineInterface,
  argv: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<string> {
  const result = await $.process.run(argv, timeoutMs === undefined ? { cwd } : { cwd, timeoutMs });

  if (result.exitCode !== 0) {
    throw new Error(
      `${argv.slice(0, 3).join(" ")} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return result.stdout.trim();
}

const repoSlug = (url: string) =>
  url
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "")
    .toLowerCase();

/** The main checkout of the repository this session runs in, and its origin as a comparable slug. */
async function localRepo($: EngineInterface) {
  const cwd = await $.session.cwd();

  const common = await run(
    $,
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );

  const path = common.replace(/\/\.git$/u, "");
  const origin = await run($, ["git", "remote", "get-url", "origin"], path);

  return { path, origin, slug: repoSlug(origin) };
}

async function listCloudSessions($: EngineInterface): Promise<CloudRow[]> {
  const repo = await localRepo($);
  const all = parseSessions(JSON.parse(await callApi($, `?limit=${LIST_LIMIT}`)));

  return all
    .filter(
      (session) =>
        session.environmentKind === "anthropic_cloud" &&
        session.status !== "archived" &&
        repoSlug(session.repoUrl) === repo.slug,
    )
    .map(({ environmentKind: _kind, ...row }) => row)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function pull($: EngineInterface, cloud: CloudRow): Promise<string> {
  const repo = await localRepo($);

  if (repo.slug !== repoSlug(cloud.repoUrl)) {
    throw new Error(
      `this session's repository is ${repo.origin}, the cloud session's is ${cloud.repoUrl}: run /cloud-pull from a session in that repository`,
    );
  }

  const worktree = `${repo.path}/.claude/worktrees/cloud-${cloud.id.slice(-8).toLowerCase()}-${Date.now().toString(36)}`;
  await run($, ["git", "worktree", "add", "--detach", worktree], repo.path);

  // /rename as the whole prompt: a slash command makes the CLI write the session without a model turn, and Desktop takes the name as the session's title.
  const rename = `/rename ${cloud.title.replaceAll(/\s+/gu, " ")}`;

  const output = await run(
    $,
    ["claude", "--teleport", cloud.id, "-p", rename, "--output-format", "json"],
    worktree,
    TELEPORT_TIMEOUT_MS,
  );

  const localId = localSessionId(output);

  if (localId === undefined) {
    throw new Error("the teleport ended without a local session id");
  }

  const record: Pulled = {
    cloudSessionId: cloud.id,
    title: cloud.title,
    model: cloud.model ?? undefined,
    effort: cloud.effort ?? undefined,
    isAnnounced: false,
  };

  await $.store.set(storeKey(worktree), record);
  await run($, ["xdg-open", `claude://resume?session=${localId}`], worktree);

  return worktree;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value is `unknown` by the language: this reads it once, for the pane's message.
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function refresh($: EngineInterface) {
  await update($, pullState, (): PullState => ({ kind: "loading" }));

  try {
    const rows = await listCloudSessions($);
    await update($, sessions, () => rows);
    await update($, pullState, (): PullState => IDLE);
  } catch (error) {
    await update($, pullState, (): PullState => ({ kind: "error", text: failure(error) }));
  }
}

async function pullFromPane($: EngineInterface, row: CloudRow) {
  const state = await read($, pullState);

  if (state.kind === "pulling") {
    return;
  }

  await update($, pullState, (): PullState => ({ kind: "pulling", id: row.id, title: row.title }));

  try {
    const worktree = await pull($, row);
    await update($, pullState, (): PullState => ({
      kind: "opened",
      id: row.id,
      title: row.title,
      worktree,
    }));
  } catch (error) {
    await update($, pullState, (): PullState => ({ kind: "error", text: failure(error) }));
  }
}

async function archive($: EngineInterface, id: string, title: string) {
  try {
    await callApi($, `/${id}/archive`, "POST");
    await update($, sessions, (rows) => rows.filter((row) => row.id !== id));
    await update($, pullState, (): PullState => ({ kind: "archived", title }));
  } catch (error) {
    await update($, pullState, (): PullState => ({ kind: "error", text: failure(error) }));
  }
}

function age(iso: string, now: number) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

  if (Number.isNaN(minutes)) {
    return "";
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  return minutes < 24 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}

const shortModel = (model: string | null) => (model ?? "model ?").replace(/^claude-/u, "");

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

const isEffort = (value: string | undefined): value is Effort =>
  value !== undefined && EFFORTS.includes(value);

export const register: Register = (on) => {
  /** The cloud session's effort, held on every request of a resumed session until the person picks one with /effort. */
  let pinnedEffort: Effort | undefined;
  let isEffortShown = false;

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: PULL,
      description:
        "List this repository's cloud sessions, or continue one here as a local Desktop session",
      argumentHint: "[session_id]",
    });
    const result = await next(e);
    // The headless teleport starts in the same worktree, before /cloud-pull writes the record: it finds none.
    const record = await readPulled($, e.cwd);

    if (record === undefined) {
      return result;
    }

    if (isEffort(record.effort)) {
      pinnedEffort = record.effort;
    }

    if (!record.isAnnounced) {
      $.ui.log(
        `☁️ → 💻 Continued from the cloud session "${record.title}" (${record.model ?? "model unknown"}, effort ${record.effort ?? "unknown"}). History copied by teleport; the cloud session is unchanged.`,
      );
      await $.store.set(storeKey(e.cwd), { ...record, isAnnounced: true });
    }

    return result;
  });

  on("turn.step", async function* ($, e, next) {
    if (pinnedEffort === undefined) {
      return yield* next(e);
    }

    if (e.effort !== pinnedEffort && !isEffortShown) {
      isEffortShown = true;
      $.ui.log(
        `cloud-pull: effort ${pinnedEffort} from the cloud session (the picker shows ${String(e.effort)}); /effort takes it back.`,
      );
    }

    return yield* next({ ...e, effort: pinnedEffort });
  });

  on("command.run", { command: "effort" }, async ($, e, next) => {
    pinnedEffort = undefined;
    const cwd = await $.session.cwd();
    const record = await readPulled($, cwd);

    if (record !== undefined) {
      await $.store.set(storeKey(cwd), { ...record, effort: undefined });
    }

    return next(e);
  });

  on("command.run", { command: PULL }, async ($, e) => {
    const id = e.args.trim();

    if (id === "") {
      await $.ui.open({ id: PANE, title: "Cloud sessions" });
      void refresh($);

      return {};
    }

    if (!SESSION_ID.test(id)) {
      return {
        text: "Usage: /cloud-pull to list, or /cloud-pull <session_id> (the id in claude.ai/code/<session_id>).",
      };
    }

    try {
      const cloud = await fetchCloudSession($, id);

      return { text: `Opened "${cloud.title}" in Desktop, in ${await pull($, cloud)}.` };
    } catch (error) {
      return { text: `cloud-pull failed: ${failure(error)}` };
    }
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const rows = await read($, sessions);
    const state = await read($, pullState);
    const now = Date.now();
    const isBusy = state.kind === "pulling" || state.kind === "loading";

    const rowOf = (row: CloudRow) =>
      Box({
        key: row.id,
        flexDirection: "column",
        children: [
          Text({ weight: "semibold", children: row.title }),
          Text({
            dimColor: true,
            children: `${row.status} · ${age(row.updatedAt, now)} · ${shortModel(row.model)}${row.effort === null ? "" : ` ${row.effort}`}`,
          }),
          Box({
            flexDirection: "row",
            children: [
              Button({
                key: `open:${row.id}`,
                label:
                  state.kind === "pulling" && state.id === row.id ? "Opening…" : "Open locally",
                variant: "primary",
                onPress: () => {
                  if (!isBusy) {
                    void pullFromPane($, row);
                  }
                },
              }),
            ],
          }),
        ],
      });

    const outcome = () => {
      switch (state.kind) {
        case "pulling":
          return [
            Text({ dimColor: true, children: `Teleporting "${state.title}" into a new worktree…` }),
          ];
        case "opened":
          return [
            Text({ children: `✓ "${state.title}" is open in Desktop.` }),
            Text({ dimColor: true, children: state.worktree }),
            Text({ children: "Archive the cloud session?" }),
            Box({
              flexDirection: "row",
              gap: 1,
              children: [
                Button({
                  key: `archive:${state.id}`,
                  label: "Archive",
                  onPress: () => void archive($, state.id, state.title),
                }),
                Button({
                  key: "keep",
                  label: "Keep it",
                  onPress: () => void update($, pullState, (): PullState => IDLE),
                }),
              ],
            }),
          ];
        case "archived":
          return [Text({ dimColor: true, children: `"${state.title}" archived in the cloud.` })];
        case "error":
          return [Text({ color: "error", children: state.text })];
        case "idle":
        case "loading":
          return [];
      }
    };

    return Box({
      flexDirection: "column",
      gap: 1,
      children: [
        Box({
          flexDirection: "row",
          gap: 1,
          alignItems: "center",
          children: [
            Button({ key: "refresh", label: "Refresh", onPress: () => void refresh($) }),
            state.kind === "loading" && Text({ dimColor: true, children: "Loading…" }),
          ],
        }),
        rows.length === 0 &&
          state.kind !== "loading" &&
          Text({ dimColor: true, children: "No open cloud session for this repository." }),
        ...rows.map((row) => rowOf(row)),
        ...outcome(),
      ],
    });
  });
};
