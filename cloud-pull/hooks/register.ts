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

/** Set on the headless runs the plugin starts (a teleport, the hub's creation), so that process, which loads this plugin too, skips the cloud lookup. */
const TELEPORT_ENV = "CLOUD_PULL_TELEPORT";

const HUB_TITLE = "☁ Cloud sessions";

const HUB_KEY = "hub";

/** Nobody works in the hub: a message typed there by mistake should cost the least. */
const HUB_MODEL = "claude-haiku-5-5";

const HUB_MODEL_ATTEMPTS = 5;

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

const isHub = atom({ plugin: "cloud-pull", key: "isHub" } as const, false);

const isBandHidden = atom({ plugin: "cloud-pull", key: "isBandHidden" } as const, false);

/** A failure the pane can explain: what failed, what to do about it, and the raw cause. */
class Failure extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail === "" ? problem.headline : problem.detail);
    this.problem = problem;
  }
}

/** A cloud session as the API answers it, before the list keeps those that run in Anthropic's cloud and places them in a local clone. */
type ApiSession = Omit<CloudRow, "repo" | "checkout"> & { readonly environmentKind: string | null };

/** The computer's hub session: the one session that lists the cloud sessions of every repository. */
type Hub = { sessionId: string; cwd: string };

/** Where this session opens cloud sessions: one repository's clone, or in the hub every clone on this computer. */
type Scope = { only: string | undefined; clones: ReadonlyMap<string, string> };

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

function parseHub(value: unknown): Hub | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const sessionId = textOf(value["sessionId"]);
  const cwd = textOf(value["cwd"]);

  return sessionId === undefined || cwd === undefined ? undefined : { sessionId, cwd };
}

/** `owner/name` → the folders Claude Code has run in for it: the `githubRepoPaths` index of `~/.claude.json`, which `--teleport` reads too. */
function parseRepoPaths(value: unknown): Map<string, string[]> {
  const index = isObject(value) ? value["githubRepoPaths"] : undefined;

  if (!isObject(index)) {
    return new Map();
  }

  return new Map(
    Object.entries(index).map(([slug, paths]) => [
      slug.toLowerCase(),
      Array.isArray(paths) ? paths.flatMap((path) => textOf(path) ?? []) : [],
    ]),
  );
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

/** The local session id a headless run wrote, from its JSON result; a failed run names why. */
function headlessSessionId(output: string, failure: Omit<Problem, "detail">): string {
  const events: unknown = JSON.parse(output);
  const last: unknown = Array.isArray(events) ? events.at(-1) : undefined;
  const localId = isObject(last) ? textOf(last["session_id"]) : undefined;

  if (!isObject(last) || last["is_error"] === true || localId === undefined) {
    throw new Failure({
      ...failure,
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
  options: { readonly timeoutMs?: number; readonly env?: Record<string, string> } = {},
): Promise<string> {
  const result = await $.process.run(argv, { cwd, ...options });

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

const isMainCheckout = ($: EngineInterface, path: string) =>
  $.fs.stat(`${path}/.git`).then(
    (git) => git.kind === "dir",
    () => false,
  );

/** The main checkout of each GitHub repository Claude Code has run in on this computer; worktrees and vanished folders are skipped. */
async function localClones($: EngineInterface): Promise<Map<string, string>> {
  const home = (await $.env.get("CLAUDE_CONFIG_DIR")) ?? (await $.env.get("HOME"));
  const config = `${home ?? "~"}/.claude.json`;

  const index = parseRepoPaths(
    JSON.parse(
      await $.fs
        .read(config)
        .catch(
          explainAs(
            "Couldn't read Claude Code's list of local clones",
            `cloud-pull finds your clones in ${config}.`,
          ),
        ),
    ),
  );

  const clones = await Promise.all(
    [...index].map(async ([slug, paths]) => {
      const mains = await Promise.all(paths.map((path) => isMainCheckout($, path)));
      const main = paths.find((_, at) => mains[at]);

      return main === undefined ? [] : [[slug, main] as const];
    }),
  );

  return new Map(clones.flat());
}

async function scopeOf($: EngineInterface): Promise<Scope> {
  if (await read($, isHub)) {
    return { only: undefined, clones: await localClones($) };
  }

  const repo = await localRepo($);
  await update($, repoName, () => repo.slug.split("/").at(-1) ?? repo.slug);

  return { only: repo.slug, clones: new Map([[repo.slug, repo.root]]) };
}

function rowsIn(scope: Scope, all: readonly ApiSession[]): CloudRow[] {
  return all.flatMap(({ environmentKind: _kind, ...session }) => {
    const slug = githubSlug(session.repoUrl);

    if (scope.only !== undefined && slug !== scope.only) {
      return [];
    }

    const checkout = slug === undefined ? undefined : scope.clones.get(slug);

    return [{ ...session, repo: slug ?? session.repoUrl, checkout: checkout ?? null }];
  });
}

async function listCloudSessions($: EngineInterface): Promise<CloudRow[]> {
  const scope = await scopeOf($);
  const all = parseSessions(JSON.parse(await callApi($, `?limit=${LIST_LIMIT}`)));

  return rowsIn(
    scope,
    all.filter(
      (session) => session.environmentKind === "anthropic_cloud" && session.status !== "archived",
    ),
  ).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

  if (cloud.checkout === null) {
    throw new Failure({
      headline: `${cloud.repo} isn't cloned on this computer`,
      fix: `Clone ${cloud.repoUrl}, open it once in Claude Code, then Refresh.`,
      detail: "no main checkout of it in the githubRepoPaths of ~/.claude.json",
    });
  }

  const worktree = `${cloud.checkout}/.claude/worktrees/cloud-${cloud.id.slice(-8).toLowerCase()}-${Date.now().toString(36)}`;
  await run($, ["git", "worktree", "add", "--detach", worktree], cloud.checkout).catch(
    explainAs("Couldn't create a worktree", "Git refused; the detail below says why."),
  );

  await onStep("teleport");
  // /rename as the whole prompt: a slash command makes the CLI write the session without a model turn, and Desktop takes the name as the session's title.
  const rename = `/rename ${cloud.title.replaceAll(/\s+/gu, " ")}`;

  const output = await run(
    $,
    ["claude", "--teleport", cloud.id, "-p", rename, "--output-format", "json"],
    worktree,
    { timeoutMs: TELEPORT_TIMEOUT_MS, env: { [TELEPORT_ENV]: "1" } },
  ).catch(
    explainAs(
      "The teleport failed",
      "Try again; if it keeps failing, run claude --teleport in a terminal to see why.",
    ),
  );

  const localSessionId = headlessSessionId(output, {
    headline: "The teleport failed",
    fix: "Try again; if it keeps failing, run claude --teleport in a terminal to see why.",
  });

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

/**
 * Puts the hub on the cheapest model through Desktop's own tool: an imported session takes Desktop's default model whatever `-p` ran on.
 * Desktop may still be importing the session, so a refusal is tried again; the last one is said, never thrown: the hub works on any model.
 */
async function pinHubModel($: EngineInterface, sessionId: string): Promise<string> {
  let reason = "";

  for (let attempt = 0; attempt < HUB_MODEL_ATTEMPTS; attempt += 1) {
    const done = await $.tool.call({
      tool: "mcp__ccd_session_mgmt__set_session_model",
      session_id: `local_${sessionId}`,
      model: HUB_MODEL,
      consent: `The user typed /cloud-pull hub, which puts the hub session "${HUB_TITLE}" on ${HUB_MODEL}.`,
    });

    if (!("deny" in done) && done.isError !== true) {
      return "";
    }

    reason = ("deny" in done ? done.deny : done.text) ?? "no reason given";
    await $.clock.sleep(1000);
  }

  return ` It runs on Desktop's default model: pick Haiku in its model menu (${reason.slice(0, 200)}).`;
}

/** Opens the computer's hub in Desktop, creating it first: beside this repository's clone, or in this folder outside a repository. */
async function openHub($: EngineInterface): Promise<string> {
  const known = parseHub(await $.store.get(HUB_KEY));

  if (known !== undefined) {
    await openInDesktop($, resumeLink(known.sessionId, known.cwd), known.cwd, HUB_TITLE);

    return `Opened the hub "${HUB_TITLE}" in Desktop.${await pinHubModel($, known.sessionId)}`;
  }

  const repo = await $.session.repo();
  const cwd = repo === null ? await $.session.cwd() : repo.root.replace(/[\\/][^\\/]+[\\/]?$/u, "");

  // /rename as the whole prompt writes the session with no model turn, under that title.
  const output = await run(
    $,
    ["claude", "-p", `/rename ${HUB_TITLE}`, "--output-format", "json"],
    cwd,
    { env: { [TELEPORT_ENV]: "1" } },
  ).catch(explainAs("Couldn't create the hub", "Try again; the detail below says why."));

  const sessionId = headlessSessionId(output, {
    headline: "Couldn't create the hub",
    fix: "Try again; the detail below says why.",
  });

  const hub: Hub = { sessionId, cwd };
  await $.store.set(HUB_KEY, hub);
  await openInDesktop($, resumeLink(sessionId, cwd), cwd, HUB_TITLE);

  return `Created the hub "${HUB_TITLE}" in ${cwd} and opened it in Desktop. Move it to a sidebar section to keep it at hand.${await pinHubModel($, sessionId)}`;
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

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: "Cloud sessions", closeOnEscape: true });
  void refresh($);
}

async function pressBand($: EngineInterface) {
  if (!(await read($, isHub))) {
    await update($, isBandHidden, () => true);
  }

  await openPane($);
}

/** The lookup behind the band: a failure only hides the band, and goes to the debug log; the pane shows it in full. */
async function detectCloudSessions($: EngineInterface) {
  try {
    const rows = await listCloudSessions($);
    await update($, sessions, () => rows);
  } catch (error) {
    const problem = problemOf(error);
    $.ui.log(`cloud-pull: no cloud lookup at start: ${problem.headline} (${problem.detail})`, {
      to: "debug",
    });
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

/** Rows grouped by repository, in the order of each repository's most recent row (rows come newest first). */
function groupsOf(rows: readonly CloudRow[]): CloudRow[][] {
  const groups = new Map<string, CloudRow[]>();

  for (const row of rows) {
    groups.set(row.repo, [...(groups.get(row.repo) ?? []), row]);
  }

  return [...groups.values()];
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
        "List this repository's cloud sessions, continue one here as a local Desktop session, or open the hub that lists them all",
      argumentHint: "[session_id | hub]",
    });
    const result = await next(e);

    if ((await $.env.get("CLOUD_PULL_TELEPORT")) === "1") {
      return result;
    }

    const hub = parseHub(await $.store.get(HUB_KEY));
    const isThisHub = hub?.sessionId === (await $.session.id());
    await update($, isHub, () => isThisHub);

    if (isThisHub) {
      void openPane($);

      return result;
    }

    // A session past its first prompt is busy with its own task: the band leaves it alone.
    if ((await $.session.turns()) > 1) {
      await update($, isBandHidden, () => true);
    }

    void detectCloudSessions($);
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

  // The engine raises this before the prompt joins the transcript: a session with one prompt already is past its first.
  on("prompt.submit", async ($, e, next) => {
    if (e.command === undefined && e.isMeta !== true && (await $.session.turns()) >= 1) {
      await update($, isBandHidden, () => true);
    }

    return next(e);
  });

  on("classic.SessionStart", async ($, e, next) => {
    const started = await next(e);

    if (e.source === "clear") {
      await update($, isBandHidden, () => false);
    }

    return started;
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
      await openPane($);

      return {};
    }

    if (id === "hub") {
      try {
        return { text: await openHub($) };
      } catch (error) {
        const problem = problemOf(error);

        return { text: `cloud-pull: ${problem.headline}. ${problem.fix} (${problem.detail})` };
      }
    }

    if (!SESSION_ID.test(id)) {
      return {
        text: "Usage: /cloud-pull to list, /cloud-pull <session_id> (the id in claude.ai/code/<session_id>), or /cloud-pull hub.",
      };
    }

    try {
      const api = parseSessions(JSON.parse(`{"data":[${await callApi($, `/${id}`)}]}`));

      if (api.length === 0) {
        return { text: `cloud-pull: ${id} has no git repository, nothing to check out locally.` };
      }

      const cloud = rowsIn(await scopeOf($), api).at(0);

      if (cloud === undefined) {
        return { text: `cloud-pull: ${id} is in ${api[0]?.repoUrl}; run it from a session there.` };
      }

      const opened = await pull($, cloud, async () => {});

      return { text: `Opened "${cloud.title}" in Desktop, in ${opened.worktree}.` };
    } catch (error) {
      const problem = problemOf(error);

      return { text: `cloud-pull: ${problem.headline}. ${problem.fix} (${problem.detail})` };
    }
  });

  on("ui.close", async ($, e, next) => {
    const closed = await next(e);

    if (e.id === PANE) {
      $.ui.invalidate("ui.render");
    }

    return closed;
  });

  // One quiet door, while the pane is not drawn: always in the hub; in a repository, while it has cloud sessions, until its first prompt is answered, used or closed.
  // The engine's record of the pane, not a value of the module's: an unasked pane can be placed after its open answered, as in the hub, once Desktop's surface attaches.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const others = await next(e);
    const rows = await read($, sessions);
    const hub = await read($, isHub);
    const isPaneDrawn = (await $.ui.panes()).some((pane) => pane.id === PANE && pane.isPlaced);

    const isHidden = isPaneDrawn || (!hub && (rows.length === 0 || (await read($, isBandHidden))));

    if (isHidden) {
      return others;
    }

    const { Box, Text, Button } = $.ui.resolve(e);

    return Box({
      flexDirection: "column",
      children: [
        others,
        Box({
          flexDirection: "row",
          alignItems: "center",
          gap: "sm",
          children: [
            Button({
              key: "continue-cloud",
              plain: true,
              onPress: () => void pressBand($),
              children: [
                Text({ dimColor: true, children: "☁ " }),
                hub ? "Cloud sessions" : "Continue cloud sessions",
                rows.length > 0 &&
                  Text({ dimColor: true, tabular: true, children: ` · ${rows.length}` }),
              ],
            }),
            !hub &&
              Button({
                key: "dismiss-cloud",
                role: "dismiss",
                label: "Hide",
                plain: true,
                dimColor: true,
                onPress: () => void update($, isBandHidden, () => true),
              }),
          ],
        }),
      ],
    });
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e);
    const rows = await read($, sessions);
    const list = await read($, listState);
    const states = await read($, rowStates);
    const opened = await read($, openedSessions);
    const repo = await read($, repoName);
    const hub = await read($, isHub);

    const home = await $.env.get("HOME");
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
                row.checkout !== null &&
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

    const groupOf = (group: readonly CloudRow[]) => {
      const [first] = group;

      const where =
        first?.checkout === null || first === undefined
          ? "Not cloned here"
          : home !== undefined && first.checkout.startsWith(`${home}/`)
            ? `~${first.checkout.slice(home.length)}`
            : first.checkout;

      return Box({
        key: `repo:${first?.repo ?? ""}`,
        flexDirection: "column",
        gap: "sm",
        children: [
          Box({
            flexDirection: "row",
            gap: "sm",
            children: [
              Text({ size: "footnote", weight: "medium", children: first?.repo ?? "" }),
              Text({ size: "footnote", dimColor: true, wrap: "truncate-start", children: where }),
            ],
          }),
          ...group.map((row) => rowOf(row)),
        ],
      });
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
          Text({
            weight: "medium",
            children: hub ? "No cloud sessions" : `No cloud sessions for ${repo}`,
          }),
          Text({
            size: "footnote",
            dimColor: true,
            children: hub
              ? "Sessions you start on claude.ai/code show up here."
              : "Sessions you start on claude.ai/code for this repository show up here.",
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
              children: `${rows.length} cloud session${rows.length === 1 ? "" : "s"}${hub ? "" : ` in ${repo}`}`,
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
        ...(hub ? groupsOf(rows).map((group) => groupOf(group)) : rows.map((row) => rowOf(row))),
      ],
    });
  });
};
