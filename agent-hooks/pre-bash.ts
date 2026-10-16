import { existsSync } from "node:fs";
import path from "node:path";

import type { LandingProfile } from "./config.ts";
import { ConfigError, configPath, loadProfile } from "./config.ts";
import {
  githubSlugOf,
  pullRequestOf,
  repoFactsOf,
  slugOfPullRequest,
  slugOfRepoOption,
} from "./github.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import type { GhCommand, GitCommand, ReleaseScript } from "./landing.ts";
import {
  ghCommandOf,
  gitCommandOf,
  profiledMergeRefusal,
  profiledPushRefusal,
  publicMergeRefusal,
  publicPushRefusal,
  pushOf,
  releaseRefusal,
  releaseScriptOf,
  resolveTargets,
  unreadableProfileRefusal,
} from "./landing.ts";
import type { Invocation } from "./shell.ts";
import { invocationsOf } from "./shell.ts";

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

type GuardContext = { readonly sessionId: string; readonly now: number };

function git(cwd: string, location: readonly string[], args: readonly string[]): string | null {
  // Without an explicit env Bun.spawnSync reuses the process's original environ and ignores the GIT_* scrub of tests.
  const proc = Bun.spawnSync(["git", ...location, ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
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

  const facts = await repoFactsOf(slug, context.sessionId, cwd, context.now);

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
  const name = command.kind === "release-create" ? "gh release create" : "gh pr merge";

  if (profile.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(profile.error, name));
  }

  if (command.kind === "release-create") {
    return profile.kind === "profiled" ? refusal(releaseRefusal(name, profile.landing)) : ALLOW;
  }

  const pr = await pullRequestOf(cwd, command.selector, command.repo);

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

  const facts = await repoFactsOf(slug, context.sessionId, cwd, context.now);

  return facts.kind === "failed"
    ? note(
        `agent-hooks: could not read whether ${slug} is public (${facts.why}): the merge went unchecked`,
      )
    : refusal(publicMergeRefusal(pr.value, facts.value, slug));
}

function judgeReleaseScript(cwd: string, release: ReleaseScript): GuardVerdict {
  const root = rootOf(path.dirname(path.resolve(cwd, release.script)), []);
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

function judge(invocation: Invocation, context: GuardContext): Promise<GuardVerdict> {
  const gitCommand = gitCommandOf(invocation.argv);

  if (gitCommand !== null) {
    return gitCommand.subcommand === "push"
      ? judgePush(invocation.cwd, gitCommand, context)
      : Promise.resolve(ALLOW);
  }

  const ghCommand = ghCommandOf(invocation.argv);

  if (ghCommand !== null) {
    return judgeGh(invocation.cwd, ghCommand, context);
  }

  const release = releaseScriptOf(invocation.argv, invocation.cwd);

  return Promise.resolve(
    release === null || release.dryRun ? ALLOW : judgeReleaseScript(invocation.cwd, release),
  );
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
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the hook payload arrives as parsed JSON from stdin; this function is where it is narrowed.
export async function runPreBash(payload: unknown, now = Date.now()): Promise<string | null> {
  const toolInput = isRecord(payload) ? recordField(payload, "tool_input") : undefined;
  const command = toolInput === undefined ? undefined : stringField(toolInput, "command");

  if (!isRecord(payload) || command === undefined) {
    return null;
  }

  const context = { sessionId: stringField(payload, "session_id") ?? "", now };
  const cwd = stringField(payload, "cwd") ?? process.cwd();

  try {
    const verdicts: GuardVerdict[] = [];

    for (const invocation of invocationsOf(command, cwd)) {
      verdicts.push(await judge(invocation, context));
    }

    return encodeGuard(combine(verdicts));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return encodeGuard({
      kind: "note",
      text: `agent-hooks: pre-bash crashed (${message}): the command went unchecked`,
    });
  }
}
