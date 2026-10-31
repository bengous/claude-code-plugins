import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type {
  CloudRow,
  ListState,
  OpenStep,
  Opened,
  OpenedEntry,
  Problem,
  RowEntry,
  RowState,
} from "../types";

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

const STEPS: readonly OpenStep[] = ["worktree", "teleport", "desktop"];

const STEP_LABEL: Readonly<Record<OpenStep, string>> = {
  worktree: "Creating a worktree…",
  teleport: "Copying the conversation…",
  desktop: "Opening in Desktop…",
};

const IDLE: ListState = { kind: "idle" };

const NO_ROWS: readonly CloudRow[] = [];

const NO_ROW_STATES: readonly RowEntry[] = [];

const NONE_OPENED: readonly OpenedEntry[] = [];

const sessions = atom({ plugin: "cloud-pull", key: "sessions" } as const, NO_ROWS);

const listState = atom({ plugin: "cloud-pull", key: "list" } as const, IDLE);

const rowStates = atom({ plugin: "cloud-pull", key: "rows" } as const, NO_ROW_STATES);

const openedSessions = atom({ plugin: "cloud-pull", key: "opened" } as const, NONE_OPENED);

const repoName = atom({ plugin: "cloud-pull", key: "repoName" } as const, "");

/** A failure the pane can explain: what failed, what to do about it, and the raw cause. */
class Failure extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail === "" ? problem.headline : problem.detail);
    this.problem = problem;
  }
}

/** A cloud session as the API answers it, before the list keeps those of this repository that run in Anthropic's cloud. */
type ApiSession = CloudRow & { readonly environmentKind: string | null };

/** What a resumed session's start reads back: the cloud session it came from. */
type Pulled = {
  cloudSessionId: string;
  title: string;
  model: string | undefined;
  effort: string | undefined;
  isAnnounced: boolean;
};

const pulledKey = (cwd: string) => `pulled:${cwd}`;

const openedKey = (cloudSessionId: string) => `opened:${cloudSessionId}`;

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

function parseOpened(value: unknown): Opened | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const at = textOf(value["at"]);
  const localSessionId = textOf(value["localSessionId"]);
  const worktree = textOf(value["worktree"]);

  return at === undefined || localSessionId === undefined || worktree === undefined
    ? undefined
    : { at, localSessionId, worktree };
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

function parseSessions(value: unknown): ApiSession[] {
  const data: unknown = isObject(value) ? value["data"] : undefined;

  if (!Array.isArray(data)) {
    throw new Failure({
      headline: "The cloud sessions API changed",
      fix: "Its answer no longer has the shape cloud-pull reads. Check for a cloud-pull update.",
      detail: "no `data` list in the answer of GET /v1/sessions",
    });
  }

  return data.flatMap((one) => parseSession(one) ?? []);
}

/** The local session id the headless teleport wrote, from its JSON result; a failed run names why. */
function teleportResult(output: string): string {
  const events: unknown = JSON.parse(output);
  const last: unknown = Array.isArray(events) ? events.at(-1) : undefined;
  const localId = isObject(last) ? textOf(last["session_id"]) : undefined;

  if (!isObject(last) || last["is_error"] === true || localId === undefined) {
    throw new Failure({
      headline: "The teleport failed",
      fix: "Try again; if it keeps failing, run claude --teleport in a terminal to see why.",
      detail: isObject(last) ? (textOf(last["result"]) ?? output.slice(-300)) : output.slice(-300),
    });
  }

  return localId;
}

const readPulled = async ($: EngineInterface, cwd: string) =>
  parsePulled(await $.store.get(pulledKey(cwd)));

const readOpened = async ($: EngineInterface, cloudSessionId: string) =>
  parseOpened(await $.store.get(openedKey(cloudSessionId)));

// A caught value is `unknown` by the language: this reads it once, as the pane's problem.
const problemOf = (error: unknown): Problem =>
  error instanceof Failure
    ? error.problem
    : {
        headline: "Something went wrong",
        fix: "",
        detail: error instanceof Error ? error.message : String(error),
      };

/** A `.catch` that names what failed and what to do, keeping the raw cause as the detail. */
const explainAs =
  (headline: string, fix: string) =>
  (error: unknown): never => {
    throw new Failure({
      headline,
      fix,
      detail: error instanceof Error ? error.message : String(error),
    });
  };
/* oxlint-enable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

async function callApi($: EngineInterface, path: string, method = "GET"): Promise<string> {
  const auth = await $.session.authorize();

  if (auth === null) {
    throw new Failure({
      headline: "Not signed in to claude.ai",
      fix: "Run /login with your claude.ai account, then Refresh.",
      detail: "this session has no first-party credential",
    });
  }

  const init = { method, headers: API_HEADERS, auth: auth.handle };

  const response = await $.http.fetch(
    `${API}${path}`,
    method === "GET" ? init : { ...init, body: "{}" },
  );

  if (!response.ok) {
    throw new Failure({
      headline:
        response.status === 404
          ? "The cloud sessions API refused the request"
          : "claude.ai didn't answer",
      fix:
        response.status === 404
          ? "The undocumented API cloud-pull uses may have changed. Check for a cloud-pull update."
          : `claude.ai answered ${response.status}. Try again in a moment.`,
      detail: `${method} /v1/sessions${path}: ${response.status} ${response.text.slice(0, 200)}`,
    });
  }

  return response.text;
}

async function run(
  $: EngineInterface,
  argv: readonly string[],
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

/** `owner/name` of a GitHub remote in any of its spellings, lowercase; undefined for any other host. */
function githubSlug(url: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(url);

  return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase();
}

/** This session's repository: its main checkout and its GitHub slug. */
async function localRepo($: EngineInterface) {
  const repo = await $.session.repo();
  const slug = repo?.remote === null || repo === null ? undefined : githubSlug(repo.remote);

  if (repo === null || slug === undefined) {
    throw new Failure({
      headline: "This session isn't in a GitHub repository",
      fix: "Run /cloud-pull from a session whose folder is a clone of the cloud session's repository.",
      detail: repo === null ? "no git repository" : `origin is ${repo.remote ?? "missing"}`,
    });
  }

  return { root: repo.root, slug };
}

async function listCloudSessions($: EngineInterface): Promise<CloudRow[]> {
  const repo = await localRepo($);
  await update($, repoName, () => repo.slug.split("/").at(-1) ?? repo.slug);
  const all = parseSessions(JSON.parse(await callApi($, `?limit=${LIST_LIMIT}`)));

  return all
    .filter(
      (session) =>
        session.environmentKind === "anthropic_cloud" &&
        session.status !== "archived" &&
        githubSlug(session.repoUrl) === repo.slug,
    )
    .map(({ environmentKind: _kind, ...row }) => row)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Opens a `claude://` link in Claude Desktop with the platform's own opener. */
async function openInDesktop($: EngineInterface, url: string, cwd: string, title: string) {
  const fallback = `Open Desktop, type /resume and pick "${title}".`;
  const uname = await $.process.run(["uname", "-s"], { cwd }).catch(() => {});
  const system = uname?.exitCode === 0 ? uname.stdout.trim() : "Windows";

  if (system === "Darwin") {
    await run($, ["open", url], cwd);

    return;
  }

  if (system === "Windows") {
    await run($, ["cmd", "/c", "start", "", url], cwd);

    return;
  }

  // xdg-open exits 0 even when nothing handles the scheme: ask for the handler first, as the CLI's /desktop does.
  const handler = await $.process
    .run(["xdg-mime", "query", "default", "x-scheme-handler/claude"], { cwd })
    .catch(() => {});

  if (handler === undefined || handler.stdout.trim() === "") {
    throw new Failure({
      headline: "Claude Desktop isn't registered for claude:// links",
      fix: fallback,
      detail: "xdg-mime has no handler for x-scheme-handler/claude",
    });
  }

  await run($, ["xdg-open", url], cwd).catch(
    explainAs("Couldn't hand the session to Desktop", fallback),
  );
}

const resumeLink = (localSessionId: string, cwd: string) =>
  `claude://resume?session=${encodeURIComponent(localSessionId)}&cwd=${encodeURIComponent(cwd)}`;

async function pull(
  $: EngineInterface,
  cloud: CloudRow,
  onStep: (step: OpenStep) => Promise<void>,
): Promise<Opened> {
  await onStep("worktree");
  const repo = await localRepo($);

  if (repo.slug !== githubSlug(cloud.repoUrl)) {
    throw new Failure({
      headline: "This session is in another repository",
      fix: `Run /cloud-pull from a session in ${cloud.repoUrl}.`,
      detail: `this session's repository is ${repo.slug}`,
    });
  }

  const worktree = `${repo.root}/.claude/worktrees/cloud-${cloud.id.slice(-8).toLowerCase()}-${Date.now().toString(36)}`;
  await run($, ["git", "worktree", "add", "--detach", worktree], repo.root).catch(
    explainAs("Couldn't create a worktree", "Git refused; the detail below says why."),
  );

  await onStep("teleport");
  // /rename as the whole prompt: a slash command makes the CLI write the session without a model turn, and Desktop takes the name as the session's title.
  const rename = `/rename ${cloud.title.replaceAll(/\s+/gu, " ")}`;

  const output = await run(
    $,
    ["claude", "--teleport", cloud.id, "-p", rename, "--output-format", "json"],
    worktree,
    TELEPORT_TIMEOUT_MS,
  ).catch(
    explainAs(
      "The teleport failed",
      "Try again; if it keeps failing, run claude --teleport in a terminal to see why.",
    ),
  );

  const localSessionId = teleportResult(output);

  const pulled: Pulled = {
    cloudSessionId: cloud.id,
    title: cloud.title,
    model: cloud.model ?? undefined,
    effort: cloud.effort ?? undefined,
    isAnnounced: false,
  };

  await $.store.set(pulledKey(worktree), pulled);

  await onStep("desktop");
  await openInDesktop($, resumeLink(localSessionId, worktree), worktree, cloud.title);
  const opened: Opened = { at: new Date().toISOString(), localSessionId, worktree };
  await $.store.set(openedKey(cloud.id), opened);

  return opened;
}

async function setRow($: EngineInterface, id: string, state: RowState | undefined) {
  await update($, rowStates, (entries) => [
    ...entries.filter((entry) => entry.id !== id),
    ...(state === undefined ? [] : [{ id, state }]),
  ]);
}

async function setOpened($: EngineInterface, id: string, opened: Opened) {
  await update($, openedSessions, (entries) => [
    ...entries.filter((entry) => entry.id !== id),
    { id, opened },
  ]);
}

async function refresh($: EngineInterface) {
  await update($, listState, (): ListState => ({ kind: "loading" }));

  try {
    const rows = await listCloudSessions($);

    const opened = await Promise.all(
      rows.map(async (row) => ({ id: row.id, opened: await readOpened($, row.id) })),
    );

    await update($, sessions, () => rows);
    await update($, openedSessions, () =>
      opened.flatMap((entry) =>
        entry.opened === undefined ? [] : [{ id: entry.id, opened: entry.opened }],
      ),
    );
    await update($, listState, () => IDLE);
  } catch (error) {
    await update($, listState, (): ListState => ({ kind: "error", problem: problemOf(error) }));
  }
}

async function openRow($: EngineInterface, row: CloudRow) {
  const states = await read($, rowStates);

  if (states.some((entry) => entry.state.kind === "opening")) {
    return;
  }

  try {
    const opened = await pull($, row, (step) => setRow($, row.id, { kind: "opening", step }));
    await setOpened($, row.id, opened);
    await setRow($, row.id, { kind: "opened" });
  } catch (error) {
    await setRow($, row.id, { kind: "error", action: "open", problem: problemOf(error) });
  }
}

async function openAgain($: EngineInterface, row: CloudRow, opened: Opened) {
  try {
    await openInDesktop(
      $,
      resumeLink(opened.localSessionId, opened.worktree),
      opened.worktree,
      row.title,
    );
  } catch (error) {
    await setRow($, row.id, { kind: "error", action: "open", problem: problemOf(error) });
  }
}

async function archiveRow($: EngineInterface, row: CloudRow) {
  try {
    await callApi($, `/${row.id}/archive`, "POST");
    await update($, sessions, (rows) => rows.filter((one) => one.id !== row.id));
    await setRow($, row.id, undefined);
    $.ui.toast(`Archived "${row.title}" in the cloud.`);
  } catch (error) {
    const problem = problemOf(error);

    await setRow($, row.id, {
      kind: "error",
      action: "archive",
      problem: {
        ...problem,
        headline: `Couldn't archive "${row.title}"`,
        fix: problem.fix || "It is still on claude.ai. Try again.",
      },
    });
  }
}

function ago(iso: string, now: number) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

  if (Number.isNaN(minutes)) {
    return "";
  }

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  return minutes < 24 * 60
    ? `${Math.round(minutes / 60)}h ago`
    : `${Math.round(minutes / 1440)}d ago`;
}

/** `claude-haiku-5-5` and `high` read as Desktop writes them: `Haiku 5.5, high effort`. */
function modelLabel(row: CloudRow) {
  const parts = (row.model ?? "").replace(/^claude-/u, "").split("-");
  const [family, ...version] = parts;

  const model =
    family === undefined || family === ""
      ? "Model unknown"
      : `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join(".")}`.trim();

  return row.effort === null ? model : `${model}, ${row.effort} effort`;
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

const isEffort = (value: string | undefined): value is Effort =>
  value !== undefined && EFFORTS.includes(value);

export const register: Register = (on) => {
  /** The cloud session's effort, held on the main loop's requests of a resumed session until the person picks one with /effort. */
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
        `☁️ → 💻 Continued from the cloud session "${record.title}" (${record.model ?? "model unknown"}, effort ${record.effort ?? "unknown"}). The history was copied; the cloud session is unchanged. Earlier prompts are not in the up-arrow history.`,
      );
      await $.store.set(pulledKey(e.cwd), { ...record, isAnnounced: true });
    }

    return result;
  });

  on("turn.step", async function* ($, e, next) {
    // A subagent's request keeps the effort its own definition sets.
    if (pinnedEffort === undefined || e.agentId !== undefined) {
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
      await $.store.set(pulledKey(cwd), { ...record, effort: undefined });
    }

    return next(e);
  });

  on("command.run", { command: PULL }, async ($, e) => {
    const id = e.args.trim();

    if (id === "") {
      await $.ui.open({ id: PANE, title: "Cloud sessions", closeOnEscape: true });
      void refresh($);

      return {};
    }

    if (!SESSION_ID.test(id)) {
      return {
        text: "Usage: /cloud-pull to list, or /cloud-pull <session_id> (the id in claude.ai/code/<session_id>).",
      };
    }

    try {
      const cloud = parseSessions(JSON.parse(`{"data":[${await callApi($, `/${id}`)}]}`)).at(0);

      if (cloud === undefined) {
        return { text: `cloud-pull: ${id} has no git repository, nothing to check out locally.` };
      }

      const opened = await pull($, cloud, async () => {});

      return { text: `Opened "${cloud.title}" in Desktop, in ${opened.worktree}.` };
    } catch (error) {
      const problem = problemOf(error);

      return { text: `cloud-pull: ${problem.headline}. ${problem.fix} (${problem.detail})` };
    }
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e);
    const rows = await read($, sessions);
    const list = await read($, listState);
    const states = await read($, rowStates);
    const opened = await read($, openedSessions);
    const repo = await read($, repoName);
    const now = Date.now();
    const isLoading = list.kind === "loading";
    const isOpening = states.some((entry) => entry.state.kind === "opening");

    const problemBlock = (problem: Problem, actions: ReturnType<typeof Button>[]) =>
      Box({
        flexDirection: "column",
        gap: "xs",
        children: [
          Text({ weight: "medium", color: "error", children: problem.headline }),
          problem.fix !== "" && Text({ size: "footnote", children: problem.fix }),
          Text({
            size: "caption",
            mono: true,
            dimColor: true,
            wrap: "truncate-end",
            children: problem.detail,
          }),
          Box({ flexDirection: "row", gap: "sm", children: actions }),
        ],
      });

    const titleLine = (
      row: CloudRow,
      trailing: ReturnType<typeof Text> | ReturnType<typeof Button> | false,
    ) =>
      Box({
        flexDirection: "row",
        alignItems: "center",
        gap: "md",
        children: [
          Box({
            flexGrow: 1,
            flexShrink: 1,
            children: [Text({ weight: "medium", wrap: "truncate-end", children: row.title })],
          }),
          trailing,
        ],
      });

    const rowOf = (row: CloudRow) => {
      const state = states.find((entry) => entry.id === row.id)?.state;
      const done = opened.find((entry) => entry.id === row.id)?.opened;

      const children = (() => {
        switch (state?.kind) {
          case "opening": {
            const reached = STEPS.indexOf(state.step) + 1;

            return [
              titleLine(row, Text({ size: "footnote", dimColor: true, children: "Opening…" })),
              Box({
                flexDirection: "row",
                gap: "sm",
                children: [
                  Text({ size: "footnote", color: "claude", children: "●".repeat(reached) }),
                  Text({
                    size: "footnote",
                    dimColor: true,
                    children: "○".repeat(STEPS.length - reached),
                  }),
                  Text({ size: "footnote", children: STEP_LABEL[state.step] }),
                ],
              }),
            ];
          }

          case "opened":
            return [
              titleLine(row, false),
              Text({
                size: "footnote",
                color: "success",
                children: "✓ Opened in a new session on this computer",
              }),
              Text({
                size: "footnote",
                dimColor: true,
                children: "Archive the cloud session? The local session has the full history.",
              }),
              Box({
                flexDirection: "row",
                alignItems: "center",
                gap: "sm",
                children: [
                  Button({
                    key: `archive:${row.id}`,
                    label: "Archive",
                    variant: "primary",
                    onPress: () => void archiveRow($, row),
                  }),
                  Button({
                    key: `keep:${row.id}`,
                    label: "Keep",
                    variant: "secondary",
                    onPress: () => void setRow($, row.id, undefined),
                  }),
                  Box({ flexGrow: 1 }),
                  Link({ href: `https://claude.ai/code/${row.id}`, label: "View on claude.ai" }),
                ],
              }),
              Text({
                size: "caption",
                dimColor: true,
                children: `Didn't open? In Desktop, type /resume and pick "${row.title}".`,
              }),
            ];
          case "error":
            return [
              titleLine(row, false),
              problemBlock(state.problem, [
                Button({
                  key: `retry:${row.id}`,
                  label: "Try again",
                  variant: "secondary",
                  onPress: () =>
                    void (state.action === "open" ? openRow($, row) : archiveRow($, row)),
                }),
                Button({
                  key: `dismiss:${row.id}`,
                  label: "Dismiss",
                  plain: true,
                  dimColor: true,
                  onPress: () => void setRow($, row.id, undefined),
                }),
              ]),
            ];
          case undefined:
            return [
              titleLine(
                row,
                Button({
                  key: `open:${row.id}`,
                  label: done === undefined ? "Open locally" : "Open again",
                  variant: "secondary",
                  dimColor: true,
                  hover: { dimColor: false },
                  onPress: () => {
                    if (isOpening) {
                      return;
                    }

                    void (done === undefined ? openRow($, row) : openAgain($, row, done));
                  },
                }),
              ),
              Box({
                flexDirection: "row",
                gap: "sm",
                children: [
                  row.status === "running" &&
                    Text({ size: "footnote", color: "success", children: "Running" }),
                  Text({ size: "footnote", dimColor: true, children: modelLabel(row) }),
                  Text({
                    size: "footnote",
                    dimColor: true,
                    tabular: true,
                    children: ago(row.updatedAt, now),
                  }),
                  done !== undefined &&
                    Text({
                      size: "footnote",
                      dimColor: true,
                      children: `· opened here ${ago(done.at, now)}`,
                    }),
                ],
              }),
            ];
        }
      })();

      return Box({ key: row.id, flexDirection: "column", gap: "xs", children });
    };

    const refreshButton = Button({
      key: "refresh",
      label: isLoading ? "Refreshing…" : "Refresh",
      plain: true,
      dimColor: true,
      onPress: () => {
        if (!isLoading) {
          void refresh($);
        }
      },
    });

    if (isLoading && rows.length === 0) {
      return Text({ size: "footnote", dimColor: true, children: "Loading cloud sessions…" });
    }

    if (list.kind !== "error" && rows.length === 0) {
      return Box({
        flexDirection: "column",
        gap: "sm",
        paddingY: "lg",
        children: [
          Text({ weight: "medium", children: `No cloud sessions for ${repo}` }),
          Text({
            size: "footnote",
            dimColor: true,
            children: "Sessions you start on claude.ai/code for this repository show up here.",
          }),
          Box({
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            children: [
              Link({ href: "https://claude.ai/code", label: "Open claude.ai/code" }),
              refreshButton,
            ],
          }),
        ],
      });
    }

    return Box({
      flexDirection: "column",
      gap: "md",
      children: [
        Box({
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          children: [
            Text({
              size: "footnote",
              dimColor: true,
              children: `${rows.length} cloud session${rows.length === 1 ? "" : "s"} in ${repo}`,
            }),
            refreshButton,
          ],
        }),
        list.kind === "error" &&
          problemBlock(list.problem, [
            Button({
              key: "retry-list",
              label: "Try again",
              variant: "secondary",
              onPress: () => void refresh($),
            }),
          ]),
        ...rows.map((row) => rowOf(row)),
      ],
    });
  });
};
