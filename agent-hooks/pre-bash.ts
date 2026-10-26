import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Fault, Judgment } from "./commit-judge.ts";
import { commitMessageOf, judge, judgeRefusal } from "./commit-judge.ts";
import type { Approval, CommitMessagesMode, LandingProfile } from "./config.ts";
import {
  ConfigError,
  configPath,
  loadApprovals,
  loadCommitMessages,
  loadLanding,
} from "./config.ts";
import type { Deadline, Runner } from "./exec.ts";
import { deadlineIn, run } from "./exec.ts";
import {
  githubSlugOf,
  pullRequestOf,
  repoFactsOf,
  slugOfPullRequest,
  slugOfRepoOption,
} from "./github.ts";
import type { Input } from "./hook.ts";
import { heartbeat, parseInput, stateKey } from "./hook.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import type {
  GhCommand,
  GitCommand,
  HumanMessage,
  PackageScript,
  PushTarget,
  ReleaseScript,
} from "./landing.ts";
import {
  dispatchRefusal,
  isReleaseCreate,
  labelRefusal,
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
import type { CommitInvocation, Door, Vocabulary } from "./mentions.ts";
import {
  assess,
  commitsOf,
  findMentions,
  isAbsoluteLocation,
  mentionsGh,
  mentionsGit,
  mentionsPackageManager,
} from "./mentions.ts";
import { git as runGit, sha256 } from "./scope.ts";
import { loadRefused, saveRefused } from "./state.ts";
import { readHuman } from "./transcript.ts";

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
  /** Where the hook's command runs: a door that names its repository is judged there too, wherever the line went. */
  readonly cwd: string;
  /** The human's latest typed message, read from the transcript the first time a gated door asks. */
  readonly human: () => HumanMessage;
};

export type PreBashOptions = {
  readonly now?: number;
  /** Overrides PRE_BASH_DEADLINE_MS for the tests. */
  readonly deadlineMs?: number;
  /** Runs the commit judge; the tests pass a fake. */
  readonly runner?: Runner;
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

/** A profile key of the repo file at `root`: absent with the file or the key, or unreadable, its error named. */
type KeyRead<T> =
  | { readonly kind: "read"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly error: string };

function keyRead<T>(root: string, load: (root: string) => T | null): KeyRead<T> {
  if (!existsSync(configPath(root))) {
    return { kind: "absent" };
  }

  try {
    const value = load(root);

    return value === null ? { kind: "absent" } : { kind: "read", value };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { kind: "unreadable", error: error.message };
    }

    throw error;
  }
}

function profileOf(root: string): ProfileRead {
  const read = keyRead(root, loadLanding);

  switch (read.kind) {
    case "read": {
      return {
        kind: "profiled",
        landing: read.value,
        landScript: existsSync(path.join(root, "scripts", "land.ts")),
      };
    }

    case "absent": {
      return DEFAULT;
    }

    case "unreadable": {
      return { kind: "unreadable", error: read.error };
    }

    default: {
      const unreachable: never = read;
      throw new Error(`unhandled profile read: ${JSON.stringify(unreachable)}`);
    }
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

/** The workflow file a dispatch selector names: its file, its path, or the `name:` its file declares at top level. */
function workflowOf(
  selector: string,
  workflows: readonly Approval[],
  root: string,
): Approval | undefined {
  const wanted = selector.toLowerCase();

  return workflows.find((workflow) => {
    const file = path.join(root, ".github", "workflows", workflow.name);

    const declared = existsSync(file)
      ? /^name:\s*(["']?)(.*?)\1\s*(?:#.*)?$/mu.exec(readFileSync(file, "utf8"))?.[2]
      : undefined;

    return [workflow.name, `.github/workflows/${workflow.name}`, declared]
      .filter((name) => name !== undefined)
      .some((name) => name.toLowerCase() === wanted);
  });
}

/**
 * A workflow dispatch or a label added, judged by profile.approvals when it names the cwd's repository: a gated one
 * passes only on the human's latest typed message.
 */
function judgeGated(
  door: Door & { readonly kind: "dispatch" | "label" },
  context: GuardContext,
): GuardVerdict {
  const { repo } = door;

  const dir = (repo === null ? [door.cwd] : [door.cwd, context.cwd]).find(
    (candidate) => repo === null || (existsSync(candidate) && isOriginOf(candidate, repo)),
  );

  const root = dir === undefined ? null : rootOf(dir, []);
  const read = root === null ? null : keyRead(root, loadApprovals);
  const name = door.kind === "dispatch" ? "a workflow dispatch" : "a label";

  if (read?.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(read.error, name, "approvals"));
  }

  if (read?.kind !== "read" || root === null) {
    return ALLOW;
  }

  if (door.kind === "dispatch") {
    const workflow = workflowOf(door.workflow, read.value.workflows, root);

    if (workflow === undefined && /^\d+$/u.test(door.workflow) && read.value.workflows.length > 0) {
      return refusal(
        `agent-hooks: the guard cannot tell which workflow the id ${door.workflow} names. ` +
          `Name it by its file: gh workflow run <file>.yml.`,
      );
    }

    return workflow === undefined ? ALLOW : refusal(dispatchRefusal(workflow, context.human()));
  }

  const wanted = new Set(door.labels.map((label) => label.toLowerCase()));
  const label = read.value.labels.find((entry) => wanted.has(entry.name.toLowerCase()));

  return label === undefined ? ALLOW : refusal(labelRefusal(label, door.prs, context.human()));
}

/**
 * The human's latest typed message, read from the session's own transcript, a subagent's included: its lead's and its
 * own messages are not the human's. Unreadable while the transcript does not hold the turn's prompt yet.
 */
function humanOf(input: Input | null): HumanMessage {
  if (input?.transcriptPath === undefined) {
    return { kind: "unreadable", why: "the hook received no transcript_path" };
  }

  try {
    const human = readHuman(input.transcriptPath, input.promptId);

    return input.promptId !== undefined && !human.holdsPrompt
      ? { kind: "unreadable", why: "the transcript does not hold this turn's prompt yet: retry" }
      : { kind: "read", text: human.latestTyped };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      kind: "unreadable",
      why: `the transcript ${input.transcriptPath} cannot be read (${message})`,
    };
  }
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
  approvals: false,
};

/** The git aliases, read from git's own config at `cwd`, whose expansion pushes: `push`, or a `!` command that does. */
function doorAliases(cwd: string, approvals: boolean): Set<string> {
  const listing = existsSync(cwd) ? git(cwd, [], ["config", "--get-regexp", "^alias\\."]) : null;
  const doors = new Set<string>();

  for (const line of listing?.split("\n") ?? []) {
    const match = /^alias\.(\S+)\s+(.*)$/u.exec(line);
    const [, name, value = ""] = match ?? [];
    const expansion = value.startsWith("!") ? value.slice(1) : `git ${value}`;

    if (name !== undefined && findMentions(expansion, { ...NO_VOCABULARY, approvals }).length > 0) {
      doors.add(name);
    }
  }

  return doors;
}

/** The scripts of `manifest` that open a door, directly or through another such script. */
function doorScriptsIn(
  manifest: Manifest,
  gitAliases: ReadonlySet<string>,
  approvals: boolean,
): Set<string> {
  const doors = new Set<string>();

  for (let changed = true; changed;) {
    changed = false;

    for (const [name, command] of manifest.scripts) {
      const vocabulary = { ...NO_VOCABULARY, gitAliases, doorScriptNames: doors, approvals };

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

/** `cwd` and the targets of the line's `cd`, `--cwd`, `--prefix` and `-C`. */
function namedDirs(command: string, cwd: string): string[] {
  const named = [...command.matchAll(DIRECTORY_WORD)].map((match) =>
    path.resolve(cwd, (match[1] ?? "").replaceAll(/^["']|["']$/gu, "")),
  );

  return [...new Set([cwd, ...named])];
}

/** The directories a line can reach: the ones it names, and their parents. */
function reachableDirs(command: string, cwd: string): string[] {
  return [...new Set(namedDirs(command, cwd).flatMap((dir) => ancestorsOf(dir)))];
}

/** Whether the repository around `dir` declares profile.approvals, or a file whose approvals the guard cannot read. */
function approvalsAt(dir: string): boolean {
  const root = existsSync(dir) ? rootOf(dir, []) : null;

  return root !== null && keyRead(root, loadApprovals).kind !== "absent";
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
  const approvals = mentionsGh(command) && namedDirs(command, cwd).some((dir) => approvalsAt(dir));
  const gitAliases = mentionsGit(command) ? doorAliases(cwd, approvals) : new Set<string>();

  const scriptsOfManifest = memoized((dir) => {
    const manifest = manifestOf(dir);

    return manifest === null ? new Set<string>() : doorScriptsIn(manifest, gitAliases, approvals);
  });

  const doorScriptsAt = (dir: string): ReadonlySet<string> =>
    scriptsOfManifest(manifestOf(dir)?.dir ?? dir);

  const doorScriptNames = mentionsPackageManager(command)
    ? new Set(reachableDirs(command, cwd).flatMap((dir) => [...doorScriptsAt(dir)]))
    : new Set<string>();

  return {
    gitAliases,
    doorScriptNames,
    doorScriptsAt,
    profiledAt: memoized(profiledAt),
    approvals,
  };
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

    case "dispatch":
    case "label": {
      return Promise.resolve(judgeGated(door, context));
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

/** A commit of the line whose message goes to the judge, and the judge's answer once it comes. */
type Judged = {
  readonly message: string;
  readonly hash: string;
  readonly judgment: Promise<Judgment>;
};

/**
 * Records the judge's refusals and gives its verdict. Called only once the landing guard let the line through: a
 * refusal the agent never saw must not let the same message pass unjudged later.
 */
type Settle = () => GuardVerdict;

/** What `git diff` lists for the commits of one line in one checkout: read once, before the line runs. */
function filesOf(dir: string, location: readonly string[], takes: "staged" | "worktree"): string[] {
  const args =
    takes === "staged" ? ["diff", "--cached", "--name-only"] : ["diff", "--name-only", "HEAD"];

  return (git(dir, location, args) ?? "").split("\n").filter(Boolean);
}

/**
 * Has Haiku judge the message of each `git commit` the line runs as written in a repository whose profile asks for
 * it: refused when a message tells how the change came about or how it was checked. A message once refused to this
 * agent passes unjudged from then on: the refusal holds once, and a rerun that fails later (a red pre-commit, a
 * denied prompt) is not refused again. A commit that keeps its message, makes none, or whose message the line does
 * not show, is not judged; a judge that gives no answer lets the commit through with a note.
 */
async function judgeCommits(
  command: string,
  cwd: string,
  input: Input,
  deadline: Deadline,
  runner: Runner,
): Promise<Settle> {
  const notes = new Set<string>();
  const key = stateKey(input);
  let refusedBefore: readonly string[] | null = null;
  const judged: Judged[] = [];
  const profiles = new Map<string, KeyRead<CommitMessagesMode> | null>();
  const filesByCheckout = new Map<string, string[]>();

  for (const commit of commitsOf(command, cwd)) {
    const written = commitMessageOf(commit.git.args, commit.heredoc, commit);
    const dir = commit.cwd ?? (isAbsoluteLocation(commit.git.location) ? "/" : null);

    if (written.form === "kept") {
      continue;
    }

    if (dir === null) {
      const here = rootOf(cwd, []);

      if (here !== null && keyRead(here, loadCommitMessages).kind === "read") {
        notes.add(
          `agent-hooks: a commit went unjudged: an earlier ${commit.lost ?? "cd"} leaves its directory unknown`,
        );
      }

      continue;
    }

    const checkout = `${dir}\u0000${commit.git.location.join("\u0000")}`;

    if (!profiles.has(checkout)) {
      const root = rootOf(dir, commit.git.location);
      profiles.set(checkout, root === null ? null : keyRead(root, loadCommitMessages));
    }

    const read = profiles.get(checkout) ?? null;

    if (read === null || read.kind === "absent") {
      continue;
    }

    if (read.kind === "unreadable") {
      notes.add(`agent-hooks: a commit went unjudged: ${read.error}`);
      continue;
    }

    if (written.opaque) {
      notes.add(UNSEEN_MESSAGE);
      continue;
    }

    const message = written.message ?? messageFileOf(command, commit, dir, written.file, notes);

    if (message === null || message === "") {
      continue;
    }

    const hash = sha256(message);
    refusedBefore ??= loadRefused(key);

    if (refusedBefore.includes(hash)) {
      continue;
    }

    if (deadline.remaining() === 0) {
      notes.add("agent-hooks: a commit went unjudged: no time left before the hook's deadline");
      continue;
    }

    const filesKey = `${checkout}\u0000${written.takes}`;
    const files = filesByCheckout.get(filesKey) ?? filesOf(dir, commit.git.location, written.takes);
    filesByCheckout.set(filesKey, files);
    judged.push({ message, hash, judgment: judge(message, files, deadline, runner) });
  }

  const refused: { message: string; hash: string; faults: readonly Fault[] }[] = [];

  for (const { message, hash, judgment } of judged) {
    const answer = await judgment;

    if (answer.kind === "failed") {
      notes.add(`agent-hooks: the commit judge gave no answer (${answer.why}): the commit passed`);
    } else if (answer.faults.length > 0) {
      refused.push({ message, hash, faults: answer.faults });
    }
  }

  return () => settled(key, refusedBefore ?? [], refused, notes);
}

function settled(
  key: string,
  refusedBefore: readonly string[],
  refused: readonly { message: string; hash: string; faults: readonly Fault[] }[],
  notes: ReadonlySet<string>,
): GuardVerdict {
  const noted = [...notes];

  if (refused.length === 0) {
    return noted.length === 0 ? ALLOW : note(noted.join("\n"));
  }

  try {
    saveRefused(key, [...new Set([...refusedBefore, ...refused.map(({ hash }) => hash)])]);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);

    // A refusal its rerun cannot get past would refuse a legitimate message forever.
    return note(
      [
        ...noted,
        `agent-hooks: the commit judge refused a message but could not save the refusal (${why}): the commit passed`,
      ].join("\n"),
    );
  }

  return refusal([judgeRefusal(refused), ...noted].join("\n"));
}

const UNSEEN_MESSAGE =
  "agent-hooks: a commit went unjudged: part of its message is known only once the line runs";

/**
 * The message in the file `-F` names, read where git reads it, after its `-C`. None, with a note, when the line names
 * the file's name before the commit, under any spelling of its path: the hook runs ahead of the line, so the file may
 * still hold an older message. None when it is not there or too large, and a note when it cannot be read.
 */
function messageFileOf(
  line: string,
  commit: CommitInvocation,
  dir: string,
  file: string | null,
  notes: Set<string>,
): string | null {
  if (file === null) {
    return null;
  }

  if (line.slice(0, commit.start).includes(path.basename(file))) {
    notes.add(UNSEEN_MESSAGE);

    return null;
  }

  const gitDir = commit.git.location.reduce(
    (current, value, index) =>
      index % 2 === 1 && commit.git.location[index - 1] === "-C"
        ? path.resolve(current, value)
        : current,
    dir,
  );

  const resolved = path.resolve(gitDir, file);

  try {
    return existsSync(resolved) && statSync(resolved).size <= MESSAGE_FILE_BYTES
      ? readFileSync(resolved, "utf8").trim()
      : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.add(`agent-hooks: a commit went unjudged: ${resolved} cannot be read (${message})`);

    return null;
  }
}

/** A message file past this size is not a commit message the judge needs whole. */
const MESSAGE_FILE_BYTES = 64 * 1024;

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
  const now = options.now ?? Date.now();
  const deadlineMs = options.deadlineMs ?? PRE_BASH_DEADLINE_MS;
  const deadline = deadlineIn(deadlineMs, now);

  try {
    const input = isRecord(payload) ? parseInput(payload) : null;

    if (input !== null) {
      heartbeat(input);
    }

    const toolInput = isRecord(payload) ? recordField(payload, "tool_input") : undefined;
    const command = toolInput === undefined ? undefined : stringField(toolInput, "command");

    if (!isRecord(payload) || command === undefined) {
      return null;
    }

    let human: HumanMessage | null = null;

    const context: GuardContext = {
      sessionId: stringField(payload, "session_id") ?? "",
      cwd: stringField(payload, "cwd") ?? process.cwd(),
      now,
      deadline,
      human: () => {
        human ??= humanOf(input);

        return human;
      },
    };

    const cwd = stringField(payload, "cwd") ?? process.cwd();

    const judging =
      input === null ? null : judgeCommitsOf(command, cwd, input, deadline, options.runner ?? run);

    const verdict =
      (await Promise.race([judgeLine(command, cwd, context, 0), pastDeadline(deadline)])) ??
      note(
        `agent-hooks: pre-bash ran past its ${deadlineMs} ms deadline: the command went unchecked`,
      );

    if (verdict.kind === "deny" || judging === null) {
      return encodeGuard(verdict);
    }

    return encodeGuard(combine([verdict, (await judging)()]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return encodeGuard(
      note(`agent-hooks: pre-bash crashed (${message}): the command went unchecked`),
    );
  }
}

/**
 * `judgeCommits`, started beside the landing guard so Haiku's wait overlaps the guard's lookups. Its crash lets the
 * commits through with a note and never costs the guard's verdict.
 */
async function judgeCommitsOf(
  command: string,
  cwd: string,
  input: Input,
  deadline: Deadline,
  runner: Runner,
): Promise<Settle> {
  try {
    const settle = await judgeCommits(command, cwd, input, deadline, runner);

    return () => {
      try {
        return settle();
      } catch (error) {
        return judgeCrashed(error instanceof Error ? error.message : String(error));
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return () => judgeCrashed(message);
  }
}

function judgeCrashed(message: string): GuardVerdict {
  return note(`agent-hooks: the commit judge crashed (${message}): the commit passed`);
}

async function pastDeadline(deadline: Deadline): Promise<null> {
  await Bun.sleep(deadline.remaining());

  return null;
}
