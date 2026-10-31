import type { EngineInterface, Register } from "claude-code";

const PULL = "cloud-pull";

/** Run as the whole prompt of the headless teleport: a slash command makes the CLI write the session without a model turn. */
const MARK = "cloud-pull-mark";

const API = "https://api.anthropic.com/v1/sessions";

/**
 * The headers Claude Code itself sends to the cloud sessions API; the API is undocumented.
 * The engine replaces a lowercase `anthropic-beta` when it adds the credential, dropping `ccr-byoc` (the API then answers 404); this casing survives.
 */
const API_HEADERS = {
  "anthropic-version": "2023-06-01",
  "Anthropic-Beta": "oauth-2025-04-20,ccr-byoc-2025-07-29",
};

const TELEPORT_TIMEOUT_MS = 5 * 60_000;

const SESSION_ID = /^session_[A-Za-z0-9]+$/u;

type CloudSession = {
  id: string;
  title: string;
  model: string | undefined;
  effort: string | undefined;
  repoUrl: string;
};

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

const readPulled = async ($: EngineInterface, cwd: string) =>
  parsePulled(await $.store.get(storeKey(cwd)));
/* oxlint-enable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

async function fetchCloudSession($: EngineInterface, id: string): Promise<CloudSession> {
  const auth = await $.session.authorize();

  if (auth === null) {
    throw new Error("no claude.ai sign-in in this session: the cloud sessions API needs one");
  }

  const response = await $.http.fetch(`${API}/${id}`, { headers: API_HEADERS, auth: auth.handle });

  if (!response.ok) {
    throw new Error(
      `cloud sessions API answered ${response.status} for ${id}: ${response.text.slice(0, 300)}`,
    );
  }

  const body: unknown = JSON.parse(response.text);

  const context =
    isObject(body) && isObject(body["session_context"]) ? body["session_context"] : {};

  const sources: unknown[] = Array.isArray(context["sources"]) ? context["sources"] : [];

  const repository = sources.find(
    (source) => isObject(source) && source["type"] === "git_repository",
  );

  const repoUrl = isObject(repository) ? textOf(repository["url"]) : undefined;

  if (repoUrl === undefined) {
    throw new Error(`cloud session ${id} has no git repository: nothing to check out locally`);
  }

  return {
    id,
    title: (isObject(body) ? textOf(body["title"]) : undefined) ?? id,
    model: textOf(context["model"]),
    effort: textOf(context["effort_level"]),
    repoUrl,
  };
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

async function pull($: EngineInterface, id: string): Promise<string> {
  const cloud = await fetchCloudSession($, id);
  const cwd = await $.session.cwd();
  const top = await run($, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  const repo = top.replace(/\/\.git$/u, "");
  const origin = await run($, ["git", "remote", "get-url", "origin"], repo);

  if (repoSlug(origin) !== repoSlug(cloud.repoUrl)) {
    throw new Error(
      `this session's repository is ${origin}, the cloud session's is ${cloud.repoUrl}: run /cloud-pull from a session in that repository`,
    );
  }

  const worktree = `${repo}/.claude/worktrees/cloud-${id.slice(-8).toLowerCase()}-${Date.now().toString(36)}`;
  await run($, ["git", "worktree", "add", "--detach", worktree], repo);

  const output = await run(
    $,
    ["claude", "--teleport", id, "-p", `/${MARK}`, "--output-format", "json"],
    worktree,
    TELEPORT_TIMEOUT_MS,
  );

  const events: unknown = JSON.parse(output);
  const last: unknown = Array.isArray(events) ? events.at(-1) : undefined;
  const localId = isObject(last) ? textOf(last["session_id"]) : undefined;

  if (localId === undefined) {
    throw new Error("the teleport ended without a local session id");
  }

  const record: Pulled = {
    cloudSessionId: cloud.id,
    title: cloud.title,
    model: cloud.model,
    effort: cloud.effort,
    isAnnounced: false,
  };

  await $.store.set(storeKey(worktree), record);
  await run($, ["xdg-open", `claude://resume?session=${localId}`], worktree);

  return `Opened "${cloud.title}" in Desktop, in ${worktree}.`;
}

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
      description: "Continue a cloud session here as a local Desktop session",
      argumentHint: "<session_id>",
    });
    await $.command.register({
      name: MARK,
      description: "Used by /cloud-pull while it teleports; shows nothing",
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

  on("command.run", { command: MARK }, () => ({}));

  on("command.run", { command: PULL }, async ($, e) => {
    const id = e.args.trim();

    if (!SESSION_ID.test(id)) {
      return { text: "Usage: /cloud-pull <session_id>, the id from claude.ai/code/<session_id>." };
    }

    try {
      return { text: await pull($, id) };
    } catch (error) {
      return {
        text: `cloud-pull failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
};
