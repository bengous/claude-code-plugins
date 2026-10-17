import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { LandingProfile } from "./config.ts";
import { ConfigError, configPath, loadProfile } from "./config.ts";
import type { Deadline } from "./exec.ts";
import { deadlineIn } from "./exec.ts";
import {
  githubSlugOf,
  pullRequestOf,
  repoFactsOf,
  slugOfPullRequest,
  slugOfRepoOption,
} from "./github.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import type { GhCommand, GitCommand, PackageScript, PushTarget, ReleaseScript } from "./landing.ts";
import {
  isReleaseCreate,
  profiledMergeRefusal,
  profiledPushRefusal,
  publicMergeRefusal,
  publicPushRefusal,
  pushOf,
  releaseRefusal,
  resolveTargets,
  unreadableProfileRefusal,
  unresolvedRefusal,
} from "./landing.ts";
import type { Door, Vocabulary } from "./mentions.ts";
import { assess, findMentions, mentionsGit, mentionsPackageManager } from "./mentions.ts";
import { git as runGit } from "./scope.ts";

export type GuardVerdict =
  | { readonly kind: "allow" }
  /** Passes; `systemMessage`, shown to the user. */
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "deny"; readonly reason: string };

const ALLOW: GuardVerdict = { kind: "allow" };

type ProfileRead =
  | { readonly kind: "profiled"; readonly landing: LandingProfile; readonly landScript: boolean }
  | { readonly kind: "default" }
  /** A config file whose profile cannot be read: the guard refuses every door there. */
  | { readonly kind: "unreadable"; readonly error: string };

const DEFAULT: ProfileRead = { kind: "default" };

/** Below the 30 s timeout `hooks/hooks.json` gives pre-bash, so the hook answers before Claude Code cuts it. */
export const PRE_BASH_DEADLINE_MS = 25_000;

/** How deep a package script that runs another one is read: past it, a loop of scripts stops being followed. */
const MAX_SCRIPT_DEPTH = 4;

type GuardContext = {
  readonly sessionId: string;
  readonly now: number;
  readonly deadline: Deadline;
};

export type PreBashOptions = {
  readonly now?: number;
  /** Overrides PRE_BASH_DEADLINE_MS for the tests. */
  readonly deadlineMs?: number;
};

function git(cwd: string, location: readonly string[], args: readonly string[]): string | null {
  return runGit(cwd, [...location, ...args])?.trim() ?? null;
}

/**
 * The top of the work tree a git invocation acts on. With `--git-dir` and no `--work-tree`, git takes the cwd as the
 * work tree, so the root is the one that holds the common dir.
 */
function rootOf(cwd: string, location: readonly string[]): string | null {
  if (!existsSync(cwd)) {
    return null;
  }

  if (location.includes("--git-dir") && !location.includes("--work-tree")) {
    const common = git(cwd, location, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

    return common !== null && path.basename(common) === ".git" ? path.dirname(common) : null;
  }

  return git(cwd, location, ["rev-parse", "--show-toplevel"]);
}

function profileOf(root: string): ProfileRead {
  if (!existsSync(configPath(root))) {
    return DEFAULT;
  }

  try {
    const { landing } = loadProfile(root);

    return landing === null
      ? DEFAULT
      : {
          kind: "profiled",
          landing,
          landScript: existsSync(path.join(root, "scripts", "land.ts")),
        };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { kind: "unreadable", error: error.message };
    }

    throw error;
  }
}

function refusal(reason: string | null): GuardVerdict {
  return reason === null ? ALLOW : { kind: "deny", reason };
}

/** The remote a push without one goes to, in git's order: the branch's pushRemote, remote.pushDefault, its remote. */
function defaultRemote(cwd: string, location: readonly string[], branch: string | null): string {
  const keys = [
    ...(branch === null ? [] : [`branch.${branch}.pushRemote`]),
    "remote.pushDefault",
    ...(branch === null ? [] : [`branch.${branch}.remote`]),
  ];

  for (const key of keys) {
    const value = git(cwd, location, ["config", "--get", key]);

    if (value !== null && value !== "") {
      return value;
    }
  }

  return "origin";
}

/** The remote branch `@{push}` names, `refs/remotes/<remote>/<branch>` read back to `<branch>`; null when unresolved. */
function pushBranch(cwd: string, location: readonly string[]): string | null {
  const ref = git(cwd, location, ["rev-parse", "--symbolic-full-name", "@{push}"]);
  const remotes = git(cwd, location, ["remote"])?.split("\n") ?? [];

  const remote = remotes
    .filter((name) => name !== "" && ref?.startsWith(`refs/remotes/${name}/`) === true)
    .toSorted((left, right) => right.length - left.length)
    .at(0);

  return ref === null || remote === undefined ? null : ref.slice(`refs/remotes/${remote}/`.length);
}

function remoteUrl(cwd: string, location: readonly string[], remote: string): string | null {
  return (
    git(cwd, location, ["remote", "get-url", "--push", remote]) ??
    (/[:/]/u.test(remote) ? remote : null)
  );
}

function note(text: string): GuardVerdict {
  return { kind: "note", text };
}

async function judgePush(
  cwd: string,
  command: GitCommand,
  context: GuardContext,
): Promise<GuardVerdict> {
  const push = pushOf(command.args);
  const root = push === null ? null : rootOf(cwd, command.location);

  if (push === null || root === null) {
    return ALLOW;
  }

  const branch = git(cwd, command.location, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

  const targets = resolveTargets(push.targets, {
    current: branch,
    push: pushBranch(cwd, command.location),
  });

  if (targets.length === 0) {
    return ALLOW;
  }

  const profile = profileOf(root);

  if (profile.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(profile.error, "git push"));
  }

  if (profile.kind === "profiled") {
    return refusal(profiledPushRefusal(targets, profile.landing, profile.landScript));
  }

  const url = remoteUrl(
    cwd,
    command.location,
    push.remote ?? defaultRemote(cwd, command.location, branch),
  );

  const slug = url === null ? null : githubSlugOf(url);

  if (slug === null) {
    return ALLOW;
  }

  const facts = await repoFactsOf(slug, context.sessionId, cwd, context.deadline, context.now);

  return facts.kind === "failed"
    ? note(
        `agent-hooks: could not read whether ${slug} is public (${facts.why}): the push went unchecked`,
      )
    : refusal(publicPushRefusal(targets, facts.value, slug));
}

/** Whether `gh --repo <repo>` names the repository the origin remote of `cwd` points to. */
function isOriginOf(cwd: string, repo: string): boolean {
  const origin = remoteUrl(cwd, [], "origin");
  const originSlug = origin === null ? null : githubSlugOf(origin);
  const named = slugOfRepoOption(repo);

  return originSlug !== null && named?.toLowerCase() === originSlug.toLowerCase();
}

async function judgeGh(
  cwd: string,
  command: GhCommand,
  context: GuardContext,
): Promise<GuardVerdict> {
  const root = rootOf(cwd, []);
  const own = command.repo === null || isOriginOf(cwd, command.repo);
  const profile = root === null || !own ? DEFAULT : profileOf(root);
  const name = isReleaseCreate(command) ? "gh release create" : "gh pr merge";

  if (profile.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(profile.error, name));
  }

  if (isReleaseCreate(command)) {
    return profile.kind === "profiled" ? refusal(releaseRefusal(name, profile.landing)) : ALLOW;
  }

  const selector = command.positionals[0] ?? null;
  const pr = await pullRequestOf(cwd, selector, command.repo, context.deadline);

  if (pr.kind === "failed") {
    return note(
      `agent-hooks: could not read the pull request gh pr merge names (${pr.why}): the merge went unchecked`,
    );
  }

  if (profile.kind === "profiled") {
    return refusal(profiledMergeRefusal(pr.value, profile.landing, profile.landScript));
  }

  const slug = slugOfPullRequest(pr.value.url);

  if (slug === null) {
    return ALLOW;
  }

  const facts = await repoFactsOf(slug, context.sessionId, cwd, context.deadline, context.now);

  return facts.kind === "failed"
    ? note(
        `agent-hooks: could not read whether ${slug} is public (${facts.why}): the merge went unchecked`,
      )
    : refusal(publicMergeRefusal(pr.value, facts.value, slug));
}

/** A ref `gh api` moves, judged as the push it is: by the profile when it names the cwd's repository. */
async function judgeApiRef(
  cwd: string,
  targets: readonly PushTarget[],
  repo: string | null,
  context: GuardContext,
): Promise<GuardVerdict> {
  const root = rootOf(cwd, []);
  const own = repo === null || isOriginOf(cwd, repo);
  const profile = root === null || !own ? DEFAULT : profileOf(root);

  if (profile.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(profile.error, "gh api"));
  }

  if (profile.kind === "profiled") {
    return refusal(profiledPushRefusal(targets, profile.landing, profile.landScript));
  }

  const origin = remoteUrl(cwd, [], "origin");

  const slug =
    repo === null ? (origin === null ? null : githubSlugOf(origin)) : slugOfRepoOption(repo);

  if (slug === null) {
    return ALLOW;
  }

  const facts = await repoFactsOf(slug, context.sessionId, cwd, context.deadline, context.now);

  return facts.kind === "failed"
    ? note(
        `agent-hooks: could not read whether ${slug} is public (${facts.why}): the gh api call went unchecked`,
      )
    : refusal(publicPushRefusal(targets, facts.value, slug));
}

function judgeReleaseScript(release: ReleaseScript): GuardVerdict {
  const root = rootOf(path.dirname(release.path), []);
  const profile = root === null ? DEFAULT : profileOf(root);

  switch (profile.kind) {
    case "unreadable": {
      return refusal(unreadableProfileRefusal(profile.error, release.script));
    }

    case "profiled": {
      return refusal(releaseRefusal(release.script, profile.landing));
    }

    case "default": {
      return ALLOW;
    }

    default: {
      const unreachable: never = profile;
      throw new Error(`unhandled profile: ${JSON.stringify(unreachable)}`);
    }
  }
}

type Manifest = { readonly dir: string; readonly scripts: ReadonlyMap<string, string> };

/** The nearest `package.json` from `dir` up and its scripts, as a package manager finds it; no scripts when it does not parse. */
function manifestOf(dir: string): Manifest | null {
  for (let current = dir; ; current = path.dirname(current)) {
    const file = path.join(current, "package.json");

    if (existsSync(file)) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return { dir: current, scripts: new Map() };
      }

      const scripts = (isRecord(parsed) ? recordField(parsed, "scripts") : undefined) ?? {};

      return {
        dir: current,
        scripts: new Map(
          Object.keys(scripts).flatMap((name) => {
            const command = stringField(scripts, name);

            return command === undefined ? [] : [[name, command] as const];
          }),
        ),
      };
    }

    if (path.dirname(current) === current) {
      return null;
    }
  }
}

/** The commands a package script runs, with its pre and post scripts, in the order a package manager runs them. */
function scriptCommands(script: PackageScript, manifest: Manifest): string[] {
  return [`pre${script.name}`, script.name, `post${script.name}`].flatMap((name) => {
    const command = manifest.scripts.get(name);

    if (command === undefined) {
      return [];
    }

    return [name === script.name ? [command, ...script.args].join(" ") : command];
  });
}

const NO_VOCABULARY: Vocabulary = {
  gitAliases: new Set(),
  doorScriptNames: new Set(),
  doorScriptsAt: () => new Set(),
  profiledAt: () => true,
};

/** The git aliases, read from git's own config at `cwd`, whose expansion pushes: `push`, or a `!` command that does. */
function doorAliases(cwd: string): Set<string> {
  const listing = existsSync(cwd) ? git(cwd, [], ["config", "--get-regexp", "^alias\\."]) : null;
  const doors = new Set<string>();

  for (const line of listing?.split("\n") ?? []) {
    const match = /^alias\.(\S+)\s+(.*)$/u.exec(line);
    const [, name, value = ""] = match ?? [];
    const expansion = value.startsWith("!") ? value.slice(1) : `git ${value}`;

    if (name !== undefined && findMentions(expansion, NO_VOCABULARY).length > 0) {
      doors.add(name);
    }
  }

  return doors;
}

/** The scripts of `manifest` that open a door, directly or through another such script. */
function doorScriptsIn(manifest: Manifest, gitAliases: ReadonlySet<string>): Set<string> {
  const doors = new Set<string>();

  for (let changed = true; changed;) {
    changed = false;

    for (const [name, command] of manifest.scripts) {
      const vocabulary = { ...NO_VOCABULARY, gitAliases, doorScriptNames: doors };

      if (!doors.has(name) && findMentions(command, vocabulary).length > 0) {
        doors.add(name);
        changed = true;
      }
    }
  }

  return doors;
}

/** Whether the repository around `dir` has a profile, or one the guard cannot read, which guards its doors too. */
function profiledAt(dir: string): boolean {
  const root = existsSync(dir) ? rootOf(dir, []) : null;

  return root !== null && profileOf(root).kind !== "default";
}

const DIRECTORY_WORD =
  /(?:^|[\s;&|(])(?:cd|pushd|--cwd|--prefix|--dir|-C)[\s=]+("[^"]*"|'[^']*'|[^\s;&|)]+)/gu;

/** The directories a line can reach: `cwd`, the targets of its `cd`, `--cwd`, `--prefix` and `-C`, and their parents. */
function reachableDirs(command: string, cwd: string): string[] {
  const named = [...command.matchAll(DIRECTORY_WORD)].map((match) =>
    path.resolve(cwd, (match[1] ?? "").replaceAll(/^["']|["']$/gu, "")),
  );

  return [...new Set([cwd, ...named].flatMap((dir) => ancestorsOf(dir)))];
}

function ancestorsOf(dir: string): string[] {
  const parent = path.dirname(dir);

  return parent === dir ? [dir] : [dir, ...ancestorsOf(parent)];
}

/** `read` once per directory: a line asks the same directory for each of its mentions. */
function memoized<T>(read: (dir: string) => T): (dir: string) => T {
  const known = new Map<string, T>();

  return (dir) => {
    const cached = known.get(dir);

    if (cached !== undefined) {
      return cached;
    }

    const value = read(dir);
    known.set(dir, value);

    return value;
  };
}

function vocabularyOf(command: string, cwd: string): Vocabulary {
  const gitAliases = mentionsGit(command) ? doorAliases(cwd) : new Set<string>();

  const scriptsOfManifest = memoized((dir) => {
    const manifest = manifestOf(dir);

    return manifest === null ? new Set<string>() : doorScriptsIn(manifest, gitAliases);
  });

  const doorScriptsAt = (dir: string): ReadonlySet<string> =>
    scriptsOfManifest(manifestOf(dir)?.dir ?? dir);

  const doorScriptNames = mentionsPackageManager(command)
    ? new Set(reachableDirs(command, cwd).flatMap((dir) => [...doorScriptsAt(dir)]))
    : new Set<string>();

  return { gitAliases, doorScriptNames, doorScriptsAt, profiledAt: memoized(profiledAt) };
}

function judgeDoor(door: Door, context: GuardContext, depth: number): Promise<GuardVerdict> {
  switch (door.kind) {
    case "push": {
      return judgePush(door.cwd, door.git, context);
    }

    case "merge":
    case "release-create": {
      return judgeGh(door.cwd, door.gh, context);
    }

    case "release-script": {
      return Promise.resolve(judgeReleaseScript(door.release));
    }

    case "api-ref": {
      return judgeApiRef(door.cwd, door.targets, door.repo, context);
    }

    case "script": {
      const manifest = manifestOf(door.script.cwd);

      if (manifest === null || depth >= MAX_SCRIPT_DEPTH) {
        return Promise.resolve(ALLOW);
      }

      return Promise.all(
        scriptCommands(door.script, manifest).map((command) =>
          judgeLine(command, manifest.dir, context, depth + 1),
        ),
      ).then(combine);
    }

    default: {
      const unreachable: never = door;
      throw new Error(`unhandled door: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Judges one Bash line: a door mention the guard cannot resolve is refused with the explicit form it can; each
 * resolved door is judged by the profile of its repository, or the public default.
 */
async function judgeLine(
  command: string,
  cwd: string,
  context: GuardContext,
  depth: number,
): Promise<GuardVerdict> {
  const { doors, unresolved } = assess(command, cwd, vocabularyOf(command, cwd));
  const first = unresolved[0];

  if (first !== undefined) {
    return refusal(unresolvedRefusal(first.kind, first.why));
  }

  return combine(await Promise.all(doors.map((door) => judgeDoor(door, context, depth))));
}

/** The first refusal among the verdicts, else their notes joined, else an allow. */
export function combine(verdicts: readonly GuardVerdict[]): GuardVerdict {
  const denied = verdicts.find((verdict) => verdict.kind === "deny");

  if (denied !== undefined) {
    return denied;
  }

  const notes = verdicts.flatMap((verdict) => (verdict.kind === "note" ? [verdict.text] : []));

  return notes.length === 0 ? ALLOW : { kind: "note", text: notes.join("\n") };
}

/** The PreToolUse wire shape of a verdict, null for an allow. */
export function encodeGuard(verdict: GuardVerdict): string | null {
  switch (verdict.kind) {
    case "allow": {
      return null;
    }

    case "note": {
      return JSON.stringify({ systemMessage: verdict.text });
    }

    case "deny": {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason,
        },
      });
    }

    default: {
      const unreachable: never = verdict;
      throw new Error(`unhandled verdict: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The landing guard on a Bash tool call, in any repository: refuses the one-way doors the repository's
 * `profile.landing` derives, or, without one, a push or a merge to the default branch of a public repository.
 * Returns the line to print, or null. Never throws: a crash lets the command through with a note.
 */
export async function runPreBash(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the hook payload arrives as parsed JSON from stdin; this function is where it is narrowed.
  payload: unknown,
  options: PreBashOptions = {},
): Promise<string | null> {
  const toolInput = isRecord(payload) ? recordField(payload, "tool_input") : undefined;
  const command = toolInput === undefined ? undefined : stringField(toolInput, "command");

  if (!isRecord(payload) || command === undefined) {
    return null;
  }

  const now = options.now ?? Date.now();
  const deadlineMs = options.deadlineMs ?? PRE_BASH_DEADLINE_MS;
  const deadline = deadlineIn(deadlineMs, now);
  const context = { sessionId: stringField(payload, "session_id") ?? "", now, deadline };
  const cwd = stringField(payload, "cwd") ?? process.cwd();

  try {
    const verdict = await Promise.race([
      judgeLine(command, cwd, context, 0),
      pastDeadline(deadline),
    ]);

    return encodeGuard(
      verdict ??
        note(
          `agent-hooks: pre-bash ran past its ${deadlineMs} ms deadline: the command went unchecked`,
        ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return encodeGuard(
      note(`agent-hooks: pre-bash crashed (${message}): the command went unchecked`),
    );
  }
}

async function pastDeadline(deadline: Deadline): Promise<null> {
  await Bun.sleep(deadline.remaining());

  return null;
}
