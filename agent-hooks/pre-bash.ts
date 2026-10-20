import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Approval, LandingProfile } from "./config.ts";
import { ConfigError, configPath, loadApprovals, loadLanding, loadProvenance } from "./config.ts";
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
import type { Transcript, Trigger } from "./provenance.ts";
import {
  agentTrailersIn,
  classify,
  commitMessageOf,
  factTriggerOf,
  factsOf,
  latestTypedText,
  provenanceTrailers,
  readTranscript,
  takesTrailers,
  trailersOf,
  transcriptPathOf,
} from "./provenance.ts";
import { git as runGit } from "./scope.ts";
import { landedMark, loadMark, saveMark } from "./state.ts";

export type GuardVerdict =
  | { readonly kind: "allow" }
  /** Passes; `systemMessage`, shown to the user. */
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "deny"; readonly reason: string }
  /** Runs `updatedInput`, the tool input with its command rewritten; `notes`, when any, shown to the user. */
  | {
      readonly kind: "rewrite";
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- tool_input is the harness's per-tool shape, handed back whole as updatedInput with only its command changed.
      readonly updatedInput: Readonly<Record<string, unknown>>;
      readonly notes: string | null;
    };

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
  /** Runs the provenance classifier; the tests pass a fake. */
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
    const transcript = readTranscript(input.transcriptPath, false, input.promptId);

    return input.promptId !== undefined && !transcript.holdsPrompt
      ? { kind: "unreadable", why: "the transcript does not hold this turn's prompt yet: retry" }
      : { kind: "read", text: latestTypedText(transcript) };
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

/** Where a commit's trailers go in the line, and the trailers. */
type Stamp = { readonly offset: number; readonly trailers: Promise<Trailers> };

type Trailers = readonly (readonly [string, string])[];

type Provenance = { readonly command: string; readonly notes: readonly string[] };

type TriggerRead = { readonly trigger: Trigger; readonly note: string | null };

/** What a line stamped so far in one checkout: the trigger of its first new commit, the trailers of its last one. */
type Stamped = { readonly first: Promise<TriggerRead>; readonly latest: Promise<Trailers> };

/**
 * The line with provenance trailers at the end of each `git commit` it runs as written in a repository whose profile
 * asks for them, and a note for each such commit it could not stamp. A new commit names its trigger and its
 * session, and moves the agent's commit mark in its checkout, once per checkout and line; an amend that writes a new
 * message keeps the `Agent-*` trailers of the commit it replaces; a commit that keeps its message, or makes none, is
 * left as written.
 */
async function withProvenance(
  command: string,
  cwd: string,
  input: Input,
  now: number,
  deadline: Deadline,
  runner: Runner,
): Promise<Provenance> {
  const notes = new Set<string>();
  const stamps: Stamp[] = [];
  const checkouts = new Map<string, Stamped>();
  const session = stateKey(input);
  let transcript: TranscriptRead | null = null;
  let trailersTaken: boolean | null = null;

  for (const commit of commitsOf(command, cwd)) {
    const written = commitMessageOf(commit.git.args, commit.heredoc);
    const dir = commit.cwd ?? (isAbsoluteLocation(commit.git.location) ? "/" : null);

    if (written.form === "kept") {
      continue;
    }

    if (dir === null) {
      const here = rootOf(cwd, []);

      if (here !== null && keyRead(here, loadProvenance).kind === "read") {
        notes.add(
          `agent-hooks: no provenance trailer: an earlier ${commit.lost ?? "cd"} leaves the commit's directory unknown`,
        );
      }

      continue;
    }

    const root = rootOf(dir, commit.git.location);
    const read = root === null ? null : keyRead(root, loadProvenance);

    if (root === null || read === null || read.kind === "absent") {
      continue;
    }

    if (read.kind === "unreadable") {
      notes.add(`agent-hooks: no provenance trailer: ${read.error}`);
      continue;
    }

    trailersTaken ??= takesTrailers(git(dir, [], ["--version"]) ?? "");

    if (!trailersTaken) {
      notes.add(
        "agent-hooks: no provenance trailer: this git has no --trailer, which came with 2.32",
      );
      continue;
    }

    const earlier = checkouts.get(root);

    if (written.form === "amend") {
      const kept =
        earlier?.latest ??
        Promise.resolve(
          agentTrailersIn(
            git(dir, commit.git.location, ["log", "-1", "--format=%(trailers:only,unfold)"]) ?? "",
          ),
        );

      stamps.push({ offset: commit.offset, trailers: kept });
      continue;
    }

    transcript ??= transcriptOf(input);

    if (transcript.kind === "unreadable") {
      notes.add(`agent-hooks: no provenance trailer: ${transcript.why}`);
      continue;
    }

    const first =
      earlier?.first.then(followingOf) ??
      triggerAt(
        root,
        transcript.transcript,
        written.message ?? messageFileOf(command, commit, dir, written.file, notes),
        input,
        now,
        deadline,
        runner,
      );

    const trailers = first.then((found) => {
      if (found.note !== null) {
        notes.add(found.note);
      }

      return provenanceTrailers(found.trigger, session);
    });

    checkouts.set(root, { first: earlier?.first ?? first, latest: trailers });
    stamps.push({ offset: commit.offset, trailers });
  }

  const written = await Promise.all(
    stamps.map(async (stamp) => ({ offset: stamp.offset, text: trailersOf(await stamp.trailers) })),
  );

  return {
    command: written
      .toSorted((left, right) => right.offset - left.offset)
      .reduce(
        (line, stamp) => `${line.slice(0, stamp.offset)}${stamp.text}${line.slice(stamp.offset)}`,
        command,
      ),
    notes: [...notes],
  };
}

/**
 * The message in the file `-F` names, read where git reads it, after its `-C`. None when the line writes the file
 * before the commit, which the hook runs ahead of: the file still holds an older message. None when it is not there
 * or too large, and a note when it cannot be read.
 */
function messageFileOf(
  line: string,
  commit: CommitInvocation,
  dir: string,
  file: string | null,
  notes: Set<string>,
): string | null {
  if (file === null || line.slice(0, commit.start).includes(file)) {
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
    notes.add(
      `agent-hooks: the classifier saw no message: ${resolved} cannot be read (${message})`,
    );

    return null;
  }
}

/** A message file past this size is not a commit message the classifier needs whole. */
const MESSAGE_FILE_BYTES = 64 * 1024;

/**
 * The trigger of a commit after the first one a line makes in the same checkout: nothing reached the agent between
 * them, so it continues the first's review, and is the agent's own otherwise.
 */
function followingOf(first: TriggerRead): TriggerRead {
  return { trigger: first.trigger === "review" ? "review" : "self", note: null };
}

type TranscriptRead =
  | { readonly kind: "read"; readonly transcript: Transcript }
  | { readonly kind: "unreadable"; readonly why: string };

/** The agent's own transcript, or why it cannot be read. */
function transcriptOf(input: Input): TranscriptRead {
  if (input.transcriptPath === undefined) {
    return { kind: "unreadable", why: "the hook received no transcript_path" };
  }

  const file = transcriptPathOf(input.transcriptPath, input.sessionId, input.agentId);

  try {
    return {
      kind: "read",
      transcript: readTranscript(file, input.agentId !== undefined, input.promptId),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { kind: "unreadable", why: `the transcript ${file} cannot be read (${message})` };
  }
}

/**
 * The trigger of the agent's commit in `checkout`: `review` when Haiku reads in the facts that it applies a review,
 * else what the facts alone say since the agent's last commit that landed there. Moves the agent's commit mark there
 * to the hook's start.
 */
async function triggerAt(
  checkout: string,
  transcript: Transcript,
  message: string | null,
  input: Input,
  now: number,
  deadline: Deadline,
  runner: Runner,
): Promise<TriggerRead> {
  const key = stateKey(input);
  const subagent = input.agentId !== undefined;
  const head = git(checkout, [], ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const mark = landedMark(loadMark(key, checkout), head);
  const fact = factTriggerOf(transcript, mark, input.promptId, subagent);

  try {
    saveMark(key, checkout, { at: now, promptId: input.promptId ?? null, head, previous: mark });
  } catch (error) {
    console.error(
      `agent-hooks: commit mark not saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const answer = await classify(factsOf(transcript, mark, message, subagent), deadline, runner);

  return answer.kind === "answered"
    ? { trigger: answer.review ? "review" : fact, note: null }
    : {
        trigger: fact,
        note: `agent-hooks: the provenance classifier gave no answer (${answer.why}): Agent-Trigger comes from the transcript's facts alone`,
      };
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

    case "rewrite": {
      const specific = { hookEventName: "PreToolUse", updatedInput: verdict.updatedInput };

      return JSON.stringify(
        verdict.notes === null
          ? { hookSpecificOutput: specific }
          : { hookSpecificOutput: specific, systemMessage: verdict.notes },
      );
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

    const verdict =
      (await Promise.race([judgeLine(command, cwd, context, 0), pastDeadline(deadline)])) ??
      note(
        `agent-hooks: pre-bash ran past its ${deadlineMs} ms deadline: the command went unchecked`,
      );

    if (verdict.kind === "deny" || input === null || toolInput === undefined) {
      return encodeGuard(verdict);
    }

    return encodeGuard(
      stamped(
        verdict,
        await provenanceOf(command, cwd, input, now, deadline, options.runner ?? run),
        toolInput,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return encodeGuard(
      note(`agent-hooks: pre-bash crashed (${message}): the command went unchecked`),
    );
  }
}

/** `withProvenance`, whose crash costs the commit its trailers and never the guard's verdict. */
async function provenanceOf(
  command: string,
  cwd: string,
  input: Input,
  now: number,
  deadline: Deadline,
  runner: Runner,
): Promise<Provenance> {
  try {
    return await withProvenance(command, cwd, input, now, deadline, runner);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return { command, notes: [`agent-hooks: provenance crashed (${message}): no trailer`] };
  }
}

/** The guard's verdict with the provenance trailers: a rewrite when a commit got some, its notes beside the guard's. */
function stamped(
  verdict: GuardVerdict,
  provenance: Provenance,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- tool_input is the harness's per-tool shape, handed back whole as updatedInput with only its command changed.
  toolInput: Readonly<Record<string, unknown>>,
): GuardVerdict {
  const notes = [...(verdict.kind === "note" ? [verdict.text] : []), ...provenance.notes];
  const text = notes.length === 0 ? null : notes.join("\n");

  if (provenance.command !== stringField(toolInput, "command")) {
    return {
      kind: "rewrite",
      updatedInput: { ...toolInput, command: provenance.command },
      notes: text,
    };
  }

  return text === null ? ALLOW : note(text);
}

async function pastDeadline(deadline: Deadline): Promise<null> {
  await Bun.sleep(deadline.remaining());

  return null;
}
